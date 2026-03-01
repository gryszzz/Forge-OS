/// <reference path="../chrome.d.ts" />
import { EXTENSION_POPUP_WINDOW_HEIGHT, EXTENSION_POPUP_WINDOW_WIDTH } from "../popup/layout";
import { prefetchKrcPortfolioForAddress } from "../portfolio/krcPortfolio";
import { sanitizeAgentsSnapshot } from "../shared/agentSync";
import { fetchBalance } from "../network/kaspaClient";
import { loadPendingTxs, updatePendingTx } from "../tx/store";
import { recoverPendingSwapSettlements } from "../swap/swap";
import { getConnectedSites, NETWORK_STORAGE_KEY } from "../shared/storage";
import { UI_PATCH_PORT_NAME, type UiPatch, type UiPatchEnvelope } from "../shared/messages";
import {
  countOriginRequests,
  dropRequestsForTab,
  emptyPendingRequestState,
  enqueueConnectRequest,
  enqueueSignRequest,
  normalizePendingRequestState,
  pendingRequestCount,
  pruneExpiredRequests,
  requestOriginKey,
  resolveActiveConnectRequest,
  resolveActiveSignRequest,
  type PendingConnectRequest,
  type PendingRequestState,
  type PendingSignRequest,
} from "./pendingRequests";
// Forge-OS Extension — MV3 Background Service Worker
//
// Responsibilities:
//  1. Poll KAS balance every 60s and update the extension badge.
//  2. Receive sanitised wallet metadata from the content script (no phrase).
//  3. Manage the auto-lock alarm — set/cancel on behalf of the popup.
//  4. Notify the popup when the auto-lock fires (popup wipes its in-memory session).
//  5. Handle site connect requests: open extension popup for user approval,
//     forward approval/rejection back to the requesting tab.
//
// SECURITY: The service worker never receives, stores, or forwards mnemonic data.
// Wallet metadata stored here is address + network ONLY.

export {};

const BALANCE_ALARM = "forgeos-balance-poll";
const AUTOLOCK_ALARM = "forgeos-autolock";
const PENDING_SWEEP_ALARM = "forgeos-pending-sweep";
const KRC_PREFETCH_ALARM = "forgeos-krc-prefetch";

// Pending site-request queue hardening
const ENV = (import.meta as any)?.env ?? {};

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = ENV?.[name];
  if (typeof raw !== "string") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number(ENV?.[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const PENDING_REQUEST_TTL_MS = readIntEnv("VITE_EXT_PENDING_REQUEST_TTL_MS", 120_000, 30_000, 900_000);
const MAX_PENDING_PER_ORIGIN = readIntEnv("VITE_EXT_PENDING_PER_ORIGIN", 4, 1, 20);
const MAX_TOTAL_PENDING_REQUESTS = readIntEnv(
  "VITE_EXT_PENDING_TOTAL_MAX",
  40,
  MAX_PENDING_PER_ORIGIN,
  200,
);
const STRICT_PENDING_GLOBAL_ORDER = readBoolEnv("VITE_EXT_PENDING_STRICT_GLOBAL_ORDER", false);
// Keep popup-window fallback enabled by default so connect/sign prompts still
// open reliably when chrome.action.openPopup is denied in MV3 contexts.
const ENABLE_POPUP_WINDOW_FALLBACK = readBoolEnv("VITE_EXT_POPUP_WINDOW_FALLBACK", true);

const uiPatchPorts = new Set<chrome.runtime.Port>();

function broadcastUiPatches(patches: UiPatch[]): void {
  if (!patches.length || uiPatchPorts.size === 0) return;
  const payload: UiPatchEnvelope = {
    type: "FORGEOS_UI_PATCH",
    patches,
  };
  for (const port of uiPatchPorts) {
    try {
      port.postMessage(payload);
    } catch {
      // Ignore dead/disconnected ports.
    }
  }
}

// Storage keys (address + network only — no phrase)
const WALLET_META_KEY = "forgeos.wallet.meta.v2";
const AGENTS_KEY = "forgeos.session.agents.v2";

// Session storage keys for pending site approval requests
const PENDING_CONNECT_KEY = "forgeos.connect.pending";
const PENDING_SIGN_KEY = "forgeos.sign.pending";
const PENDING_CONNECT_QUEUE_KEY = "forgeos.connect.queue";
const PENDING_SIGN_QUEUE_KEY = "forgeos.sign.queue";

type WalletMeta = {
  address: string;
  network?: string;
};

function notifyAgentsUpdated(count: number): void {
  chrome.runtime.sendMessage({
    type: "FORGEOS_AGENTS_UPDATED",
    count: Math.max(0, Math.floor(count || 0)),
    updatedAt: Date.now(),
  }).catch(() => {});
}

function syncAgentsToStorage(rawAgents: unknown): boolean {
  const agents = sanitizeAgentsSnapshot(rawAgents);
  if (!agents) return false;
  chrome.storage.local.set({ [AGENTS_KEY]: agents.json });
  notifyAgentsUpdated(agents.count);
  return true;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Open the extension popup reliably.
 *
 * chrome.action.openPopup() was added in Chrome 127 and requires a user
 * gesture — called from a message listener it almost always fails.
 * Fallback: open popup/index.html as a standalone chrome.windows popup
 * (same dimensions as the toolbar popup). This is the standard MetaMask
 * pattern and works in both Chrome and Firefox.
 */
async function openExtensionPopup(): Promise<void> {
  const manifest = chrome.runtime.getManifest() as any;
  const popupPathRaw =
    manifest?.action?.default_popup ||
    manifest?.browser_action?.default_popup ||
    "extension/popup/index.html";
  const popupPath = String(popupPathRaw).replace(/^\/+/, "");
  const popupUrl = chrome.runtime.getURL(popupPath);
  const isPopupTabUrl = (tabUrl: string | undefined) =>
    typeof tabUrl === "string"
    && (
      tabUrl === popupUrl
      || tabUrl.startsWith(`${popupUrl}#`)
      || tabUrl.startsWith(`${popupUrl}?`)
    );

  // Reuse an already-open Forge-OS popup window if present.
  const windows = await chrome.windows.getAll({ populate: true });
  const existing = windows.find((win) =>
    (win.tabs ?? []).some((tab) => isPopupTabUrl(tab?.url))
  );
  if (existing?.id) {
    await chrome.windows.update(existing.id, { focused: true });
    return;
  }

  try {
    await chrome.action.openPopup();
    return;
  } catch { /* expected in most cases — fall through */ }

  if (!ENABLE_POPUP_WINDOW_FALLBACK) {
    throw new Error("Could not open Forge-OS popup automatically.");
  }

  // Fallback: open as a popup window sized for the scaled UI.
  await chrome.windows.create({
    url: popupUrl,
    type: "popup",
    width: EXTENSION_POPUP_WINDOW_WIDTH,
    height: EXTENSION_POPUP_WINDOW_HEIGHT,
    focused: true,
  });
}

async function openPopupForRemainingPending(state: PendingRequestState): Promise<void> {
  if (pendingRequestCount(state) <= 0) return;
  try {
    await openExtensionPopup();
  } catch {
    // Best effort only: requests remain queued and can still be completed
    // when the user opens the extension manually.
  }
}

async function getStoredWalletMeta(): Promise<WalletMeta | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(WALLET_META_KEY, (result) => {
      try {
        const raw = result[WALLET_META_KEY];
        if (!raw) return resolve(null);
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (typeof parsed?.address !== "string") return resolve(null);
        resolve({
          address: parsed.address,
          network: typeof parsed?.network === "string" ? parsed.network : "mainnet",
        });
      } catch {
        resolve(null);
      }
    });
  });
}

async function updateBadge(): Promise<void> {
  const meta = await getStoredWalletMeta();
  if (!meta?.address) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }

  try {
    const sompi = await fetchBalance(meta.address, meta.network ?? "mainnet");
    const kas = Number(sompi) / 1e8;
    const label =
      kas >= 1_000_000 ? `${(kas / 1_000_000).toFixed(1)}M`
      : kas >= 1_000   ? `${(kas / 1_000).toFixed(1)}K`
      : kas.toFixed(0);
    chrome.action.setBadgeText({ text: label });
    chrome.action.setBadgeBackgroundColor({ color: "#39DDB6" });
  } catch { /* non-fatal — badge stays as-is */ }
}

async function prefetchKrcPortfolioFromMeta(): Promise<void> {
  const meta = await getStoredWalletMeta();
  if (!meta?.address) return;
  const network = typeof meta.network === "string" && meta.network ? meta.network : "mainnet";
  await prefetchKrcPortfolioForAddress(meta.address, network);
}

function senderOrigin(sender: any): string | undefined {
  const tabUrl = sender?.tab?.url;
  if (typeof tabUrl !== "string") return undefined;
  try {
    return new URL(tabUrl).origin;
  } catch {
    return undefined;
  }
}

let pendingMutationChain: Promise<void> = Promise.resolve();

function queuePendingMutation(op: () => Promise<void>): void {
  pendingMutationChain = pendingMutationChain.then(op).catch(() => {});
}

function sendConnectResult(
  tabId: number,
  requestId: string,
  payload: { result?: { address: string; network: string }; error?: string },
): void {
  chrome.tabs.sendMessage(tabId, {
    type: "FORGEOS_CONNECT_RESULT",
    requestId,
    ...(payload.result ? { result: payload.result } : {}),
    ...(payload.error ? { error: payload.error } : {}),
  }).catch(() => {});
}

function sendSignResult(
  tabId: number,
  requestId: string,
  payload: { result?: string | null; error?: string },
): void {
  chrome.tabs.sendMessage(tabId, {
    type: "FORGEOS_SIGN_RESULT",
    requestId,
    ...(payload.result !== undefined ? { result: payload.result } : {}),
    ...(payload.error ? { error: payload.error } : {}),
  }).catch(() => {});
}

function applyStrictPendingOrdering(state: PendingRequestState): PendingRequestState {
  if (!STRICT_PENDING_GLOBAL_ORDER) return state;

  let activeConnect = state.activeConnect;
  let activeSign = state.activeSign;
  const connectQueue = [...state.connectQueue];
  const signQueue = [...state.signQueue];

  // Strict mode: only one active request at a time across connect + sign.
  if (activeConnect && activeSign) {
    if (activeConnect.createdAt <= activeSign.createdAt) {
      signQueue.unshift(activeSign);
      activeSign = null;
    } else {
      connectQueue.unshift(activeConnect);
      activeConnect = null;
    }
  }

  if (!activeConnect && !activeSign) {
    const nextConnect = connectQueue[0] ?? null;
    const nextSign = signQueue[0] ?? null;
    if (nextConnect && (!nextSign || nextConnect.createdAt <= nextSign.createdAt)) {
      activeConnect = connectQueue.shift() ?? null;
    } else if (nextSign) {
      activeSign = signQueue.shift() ?? null;
    }
  }

  return { activeConnect, activeSign, connectQueue, signQueue };
}

async function getPendingRequestState(): Promise<PendingRequestState> {
  const result = await chrome.storage.session.get([
    PENDING_CONNECT_KEY,
    PENDING_SIGN_KEY,
    PENDING_CONNECT_QUEUE_KEY,
    PENDING_SIGN_QUEUE_KEY,
  ]);
  const normalized = normalizePendingRequestState({
    activeConnect: result?.[PENDING_CONNECT_KEY],
    activeSign: result?.[PENDING_SIGN_KEY],
    connectQueue: result?.[PENDING_CONNECT_QUEUE_KEY],
    signQueue: result?.[PENDING_SIGN_QUEUE_KEY],
  });
  return applyStrictPendingOrdering(normalized);
}

async function setPendingRequestState(state: PendingRequestState): Promise<void> {
  const ordered = applyStrictPendingOrdering(state);
  const payload: Record<string, unknown> = {
    [PENDING_CONNECT_QUEUE_KEY]: ordered.connectQueue,
    [PENDING_SIGN_QUEUE_KEY]: ordered.signQueue,
  };
  if (ordered.activeConnect) payload[PENDING_CONNECT_KEY] = ordered.activeConnect;
  if (ordered.activeSign) payload[PENDING_SIGN_KEY] = ordered.activeSign;
  await chrome.storage.session.set(payload);

  const removeKeys: string[] = [];
  if (!ordered.activeConnect) removeKeys.push(PENDING_CONNECT_KEY);
  if (!ordered.activeSign) removeKeys.push(PENDING_SIGN_KEY);
  if (removeKeys.length) {
    await chrome.storage.session.remove(removeKeys);
  }
}

async function sweepExpiredPendingRequests(now: number = Date.now()): Promise<PendingRequestState> {
  const state = await getPendingRequestState();
  const swept = pruneExpiredRequests(state, now, PENDING_REQUEST_TTL_MS);
  const expiredTotal = swept.expiredConnect.length + swept.expiredSign.length;
  if (expiredTotal === 0) return swept.state;

  const nextState = applyStrictPendingOrdering(swept.state);
  await setPendingRequestState(nextState);
  await updatePendingBadge(nextState);

  for (const req of swept.expiredConnect) {
    sendConnectResult(req.tabId, req.requestId, { error: "Forge-OS: request timed out" });
  }
  for (const req of swept.expiredSign) {
    sendSignResult(req.tabId, req.requestId, { error: "Forge-OS: request timed out" });
  }

  return nextState;
}

async function dropPendingRequestsForClosedTab(tabId: number): Promise<PendingRequestState> {
  if (!Number.isFinite(tabId) || tabId <= 0) {
    return getPendingRequestState();
  }
  const state = await sweepExpiredPendingRequests();
  const dropped = dropRequestsForTab(state, tabId);
  const removedCount = dropped.removedConnect.length + dropped.removedSign.length;
  if (removedCount === 0) return dropped.state;

  await setPendingRequestState(dropped.state);
  await updatePendingBadge(dropped.state);
  for (const req of dropped.removedConnect) {
    sendConnectResult(req.tabId, req.requestId, {
      error: "Forge-OS: request cancelled because the requesting tab was closed.",
    });
  }
  for (const req of dropped.removedSign) {
    sendSignResult(req.tabId, req.requestId, {
      error: "Forge-OS: request cancelled because the requesting tab was closed.",
    });
  }
  return dropped.state;
}

async function updatePendingBadge(state?: PendingRequestState): Promise<void> {
  const current = state ?? await getPendingRequestState().catch(() => emptyPendingRequestState());
  const pendingCount = pendingRequestCount(current);
  if (pendingCount > 0) {
    chrome.action.setBadgeText({ text: pendingCount > 9 ? "9+" : String(pendingCount) });
    chrome.action.setBadgeBackgroundColor({ color: "#39DDB6" });
    return;
  }
  await updateBadge();
}

// ── Alarm management ─────────────────────────────────────────────────────────

function ensureBalanceAlarm(): void {
  chrome.alarms.get(BALANCE_ALARM, (alarm) => {
    if (!alarm) chrome.alarms.create(BALANCE_ALARM, { periodInMinutes: 1 });
  });
}

function ensurePendingSweepAlarm(): void {
  chrome.alarms.get(PENDING_SWEEP_ALARM, (alarm) => {
    if (!alarm) chrome.alarms.create(PENDING_SWEEP_ALARM, { delayInMinutes: 0.2, periodInMinutes: 1 });
  });
}

function ensureKrcPrefetchAlarm(): void {
  chrome.alarms.get(KRC_PREFETCH_ALARM, (alarm) => {
    if (!alarm) chrome.alarms.create(KRC_PREFETCH_ALARM, { delayInMinutes: 0.5, periodInMinutes: 1 });
  });
}

function scheduleAutoLock(minutes: number): void {
  chrome.alarms.clear(AUTOLOCK_ALARM, () => {
    chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: minutes });
  });
}

function cancelAutoLock(): void {
  chrome.alarms.clear(AUTOLOCK_ALARM);
}

// ── Extension lifecycle ───────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  ensureBalanceAlarm();
  ensurePendingSweepAlarm();
  ensureKrcPrefetchAlarm();
  updatePendingBadge().catch(() => {});
  prefetchKrcPortfolioFromMeta().catch(() => {});
  recoverPendingSwapSettlements().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureBalanceAlarm();
  ensurePendingSweepAlarm();
  ensureKrcPrefetchAlarm();
  updatePendingBadge().catch(() => {});
  prefetchKrcPortfolioFromMeta().catch(() => {});
  recoverPendingSwapSettlements().catch(() => {});
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== UI_PATCH_PORT_NAME) return;
  uiPatchPorts.add(port);
  port.onDisconnect.addListener(() => {
    uiPatchPorts.delete(port);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const nextNetwork = changes?.[NETWORK_STORAGE_KEY]?.newValue;
  if (typeof nextNetwork !== "string" || !nextNetwork) return;
  broadcastUiPatches([
    {
      type: "network",
      network: nextNetwork,
      updatedAt: Date.now(),
    },
  ]);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  queuePendingMutation(async () => {
    await dropPendingRequestsForClosedTab(tabId);
  });
});

// ── Alarm handler ─────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BALANCE_ALARM) {
    updatePendingBadge().catch(() => {});
    return;
  }

  if (alarm.name === PENDING_SWEEP_ALARM) {
    queuePendingMutation(async () => {
      await sweepExpiredPendingRequests();

      // B1: Expire BROADCASTING txs that have been stuck > 15 minutes
      const BROADCAST_TIMEOUT_MS = 15 * 60_000;
      const allTxs = await loadPendingTxs().catch(() => []);
      const stale = allTxs.filter(
        (tx) => tx.state === "BROADCASTING" && Date.now() - tx.builtAt > BROADCAST_TIMEOUT_MS,
      );
      for (const tx of stale) {
        await updatePendingTx({ ...tx, state: "FAILED", error: "CONFIRM_TIMEOUT: no confirmation in 15 minutes" }).catch(() => {});
      }

      // B5: Resume any in-flight swap settlements
      recoverPendingSwapSettlements().catch(() => {});
    });
    return;
  }

  if (alarm.name === KRC_PREFETCH_ALARM) {
    prefetchKrcPortfolioFromMeta().catch(() => {});
    return;
  }

  if (alarm.name === AUTOLOCK_ALARM) {
    chrome.runtime.sendMessage({ type: "AUTOLOCK_FIRED" }).catch(() => {});
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#888888" });
  }
});

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: any, sender: any) => {
  // ── Push agent snapshot sync (site -> extension) ─────────────────────────
  if (message?.type === "FORGEOS_SYNC_AGENTS") {
    if (syncAgentsToStorage(message?.agents)) {
      updatePendingBadge().catch(() => {});
    }
    return;
  }

  // ── Content script sync (address + network only, never phrase) ───────────
  if (message?.type === "FORGEOS_SYNC") {
    const updates: Record<string, unknown> = {};
    const agents = sanitizeAgentsSnapshot(message?.agents);
    if (agents) updates[AGENTS_KEY] = agents.json;
    if (message.wallet) {
      try {
        const meta = JSON.parse(message.wallet as string);
        const safe: Record<string, unknown> = {};
        if (typeof meta?.address === "string") safe.address = meta.address;
        if (typeof meta?.network === "string") safe.network = meta.network;
        if (safe.address) updates[WALLET_META_KEY] = JSON.stringify(safe);
      } catch { /* malformed message — ignore */ }
    }
    if (Object.keys(updates).length > 0) {
      chrome.storage.local.set(updates);
      if (agents) notifyAgentsUpdated(agents.count);
      updatePendingBadge().catch(() => {});
      prefetchKrcPortfolioFromMeta().catch(() => {});
    }
    return;
  }

  // ── Auto-lock scheduling ─────────────────────────────────────────────────
  if (message?.type === "SCHEDULE_AUTOLOCK") {
    scheduleAutoLock(typeof message.minutes === "number" ? message.minutes : 15);
    return;
  }

  if (message?.type === "CANCEL_AUTOLOCK") {
    cancelAutoLock();
    return;
  }

  // ── Open popup (simple, no connect flow) ────────────────────────────────
  if (message?.type === "FORGEOS_OPEN_POPUP") {
    openExtensionPopup().catch(() => {});
    return;
  }

  if (message?.type === "FORGEOS_PREFETCH_KRC") {
    prefetchKrcPortfolioFromMeta().catch(() => {});
    return;
  }

  // ── Site connect request: open popup for wallet approval ─────────────────
  if (message?.type === "FORGEOS_OPEN_FOR_CONNECT") {
    const tabId = sender?.tab?.id as number | undefined;
    if (!tabId) return;
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    if (!requestId) {
      sendConnectResult(tabId, requestId, { error: "Invalid connect request" });
      return;
    }

    const origin = senderOrigin(sender);
    const now = Date.now();

    // B6: Fast-path — origin already approved, respond immediately without popup
    getConnectedSites().then((sites) => {
      const existing = origin ? sites[origin] : null;
      if (existing) {
        sendConnectResult(tabId, requestId, {
          result: { address: existing.address, network: existing.network },
        });
        return;
      }

      // Not previously approved — enqueue for popup approval
      const originKey = requestOriginKey(origin);
      const request: PendingConnectRequest = { requestId, tabId, origin, createdAt: now };

      queuePendingMutation(async () => {
        let state = await sweepExpiredPendingRequests(now);
        if (pendingRequestCount(state) >= MAX_TOTAL_PENDING_REQUESTS) {
          sendConnectResult(tabId, requestId, { error: "Too many pending requests. Try again in a moment." });
          return;
        }
        if (countOriginRequests(state, originKey) >= MAX_PENDING_PER_ORIGIN) {
          sendConnectResult(tabId, requestId, { error: "Too many pending requests from this site. Wait for approval or timeout." });
          return;
        }
        const wasIdle = pendingRequestCount(state) === 0;
        state = enqueueConnectRequest(state, request);
        await setPendingRequestState(state);
        await updatePendingBadge(state);

        // Only force-open popup when transitioning from no pending requests.
        if (!wasIdle) return;

        try {
          await openExtensionPopup();
        } catch {
          const failed = resolveActiveConnectRequest(state, request.requestId);
          if (!failed.resolved) return;
          await setPendingRequestState(failed.state);
          await updatePendingBadge(failed.state);
          sendConnectResult(failed.resolved.tabId, failed.resolved.requestId, {
            error: "Could not open Forge-OS popup. Click the extension icon in your toolbar.",
          });
        }
      });
    }).catch(() => {
      // Storage read failed — fall through to normal approval queue
      const request: PendingConnectRequest = { requestId, tabId, origin, createdAt: now };
      queuePendingMutation(async () => {
        let state = await sweepExpiredPendingRequests(now);
        if (pendingRequestCount(state) >= MAX_TOTAL_PENDING_REQUESTS) {
          sendConnectResult(tabId, requestId, { error: "Too many pending requests. Try again in a moment." });
          return;
        }
        const wasIdle = pendingRequestCount(state) === 0;
        state = enqueueConnectRequest(state, request);
        await setPendingRequestState(state);
        await updatePendingBadge(state);
        if (!wasIdle) return;
        await openExtensionPopup().catch(() => {});
      });
    });
    return;
  }

  // ── Site sign request: open popup for signature approval ──────────────────
  if (message?.type === "FORGEOS_OPEN_FOR_SIGN") {
    const tabId = sender?.tab?.id as number | undefined;
    if (!tabId) return;
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    const signMessage = typeof message.message === "string" ? message.message : null;
    if (!requestId || signMessage === null) {
      sendSignResult(tabId, requestId, { error: "Invalid sign request" });
      return;
    }

    const now = Date.now();
    const origin = senderOrigin(sender);
    const originKey = requestOriginKey(origin);
    const request: PendingSignRequest = {
      requestId,
      tabId,
      origin,
      message: signMessage,
      createdAt: now,
    };

    queuePendingMutation(async () => {
      let state = await sweepExpiredPendingRequests(now);
      if (pendingRequestCount(state) >= MAX_TOTAL_PENDING_REQUESTS) {
        sendSignResult(tabId, requestId, { error: "Too many pending requests. Try again in a moment." });
        return;
      }
      if (countOriginRequests(state, originKey) >= MAX_PENDING_PER_ORIGIN) {
        sendSignResult(tabId, requestId, { error: "Too many pending requests from this site. Wait for approval or timeout." });
        return;
      }
      const wasIdle = pendingRequestCount(state) === 0;
      state = enqueueSignRequest(state, request);
      await setPendingRequestState(state);
      await updatePendingBadge(state);

      if (!wasIdle) return;

      try {
        await openExtensionPopup();
      } catch {
        const failed = resolveActiveSignRequest(state, request.requestId);
        if (!failed.resolved) return;
        await setPendingRequestState(failed.state);
        await updatePendingBadge(failed.state);
        sendSignResult(failed.resolved.tabId, failed.resolved.requestId, {
          error: "Could not open Forge-OS popup. Click the extension icon in your toolbar.",
        });
      }
    });
    return;
  }

  // ── Popup approved the connect request ──────────────────────────────────
  if (message?.type === "FORGEOS_CONNECT_APPROVE") {
    queuePendingMutation(async () => {
      const state = await sweepExpiredPendingRequests();
      const resolved = resolveActiveConnectRequest(
        state,
        typeof message.requestId === "string" ? message.requestId : undefined,
      );
      if (resolved.stale || !resolved.resolved) return;

      const address = typeof message.address === "string" ? message.address : "";
      const network = typeof message.network === "string" ? message.network : "";
      if (!address || !network) {
        sendConnectResult(resolved.resolved.tabId, resolved.resolved.requestId, {
          error: "Invalid connect approval payload",
        });
      } else {
        sendConnectResult(resolved.resolved.tabId, resolved.resolved.requestId, {
          result: { address, network },
        });
      }

      await setPendingRequestState(resolved.state);
      await updatePendingBadge(resolved.state);
      await openPopupForRemainingPending(resolved.state);
    });
    return;
  }

  // ── Popup rejected the connect request ──────────────────────────────────
  if (message?.type === "FORGEOS_CONNECT_REJECT") {
    queuePendingMutation(async () => {
      const state = await sweepExpiredPendingRequests();
      const resolved = resolveActiveConnectRequest(
        state,
        typeof message.requestId === "string" ? message.requestId : undefined,
      );
      if (resolved.stale || !resolved.resolved) return;

      sendConnectResult(resolved.resolved.tabId, resolved.resolved.requestId, {
        error: typeof message.error === "string" ? message.error : "Connection rejected by user",
      });

      await setPendingRequestState(resolved.state);
      await updatePendingBadge(resolved.state);
      await openPopupForRemainingPending(resolved.state);
    });
    return;
  }

  // ── Popup approved the sign request ─────────────────────────────────────
  if (message?.type === "FORGEOS_SIGN_APPROVE") {
    queuePendingMutation(async () => {
      const state = await sweepExpiredPendingRequests();
      const resolved = resolveActiveSignRequest(
        state,
        typeof message.requestId === "string" ? message.requestId : undefined,
      );
      if (resolved.stale || !resolved.resolved) return;

      const signature = typeof message.signature === "string" ? message.signature : "";
      sendSignResult(resolved.resolved.tabId, resolved.resolved.requestId, {
        result: signature || null,
        error: signature ? undefined : "Invalid signature payload",
      });

      await setPendingRequestState(resolved.state);
      await updatePendingBadge(resolved.state);
      await openPopupForRemainingPending(resolved.state);
    });
    return;
  }

  // ── Popup rejected the sign request ─────────────────────────────────────
  if (message?.type === "FORGEOS_SIGN_REJECT") {
    queuePendingMutation(async () => {
      const state = await sweepExpiredPendingRequests();
      const resolved = resolveActiveSignRequest(
        state,
        typeof message.requestId === "string" ? message.requestId : undefined,
      );
      if (resolved.stale || !resolved.resolved) return;

      sendSignResult(resolved.resolved.tabId, resolved.resolved.requestId, {
        error: typeof message.error === "string" ? message.error : "Signing rejected by user",
      });

      await setPendingRequestState(resolved.state);
      await updatePendingBadge(resolved.state);
      await openPopupForRemainingPending(resolved.state);
    });
    return;
  }
});
