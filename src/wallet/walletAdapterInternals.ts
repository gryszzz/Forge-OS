import {
  ALLOWED_ADDRESS_PREFIXES,
  DEFAULT_NETWORK,
  ENFORCE_WALLET_NETWORK,
  KASPIUM_DEEP_LINK_SCHEME,
  NETWORK_LABEL,
} from "../constants";
import { fmt, normalizeKaspaAddress } from "../helpers";
import { isAddressPrefixCompatible, resolveKaspaNetwork } from "../kaspa/network";
import { walletError } from "../runtime/errorTaxonomy";

export const ALL_KASPA_ADDRESS_PREFIXES = ["kaspa", "kaspatest", "kaspadev", "kaspasim"];
export const WALLET_CALL_TIMEOUT_MS = 15000;
export const WALLET_SEND_TIMEOUT_MS = 45000;
export const GHOST_PROVIDER_SCAN_TIMEOUT_MS = 350;
export const GHOST_CONNECT_TIMEOUT_MS = 45000;
export const KASTLE_RAW_TX_ENABLED = String((import.meta as any)?.env?.VITE_KASTLE_RAW_TX_ENABLED || "false").toLowerCase() === "true";
export const KASTLE_RAW_TX_MANUAL_JSON_PROMPT_ENABLED =
  String((import.meta as any)?.env?.VITE_KASTLE_RAW_TX_MANUAL_JSON_PROMPT_ENABLED || "true").toLowerCase() !== "false";
export const KASTLE_TX_BUILDER_URL = String((import.meta as any)?.env?.VITE_KASTLE_TX_BUILDER_URL || "").trim();
export const KASTLE_TX_BUILDER_TOKEN = String((import.meta as any)?.env?.VITE_KASTLE_TX_BUILDER_TOKEN || "").trim();
export const KASTLE_TX_BUILDER_TIMEOUT_MS = Math.max(
  1000,
  Number((import.meta as any)?.env?.VITE_KASTLE_TX_BUILDER_TIMEOUT_MS || 12000)
);
export const KASTLE_TX_BUILDER_STRICT =
  String((import.meta as any)?.env?.VITE_KASTLE_TX_BUILDER_STRICT || "false").toLowerCase() === "true";
export const KASTLE_ACCOUNT_CACHE_TTL_MS = 60_000;

export { ALLOWED_ADDRESS_PREFIXES, DEFAULT_NETWORK, ENFORCE_WALLET_NETWORK, KASPIUM_DEEP_LINK_SCHEME, NETWORK_LABEL };
export { normalizeKaspaAddress, isAddressPrefixCompatible, resolveKaspaNetwork };

export type GhostProviderInfo = {
  id: string;
  name: string;
};

type GhostBridgeState = {
  provider: GhostProviderInfo;
  nextRequestId: number;
  connected: boolean;
  onEvent: (event: Event) => void;
  onDisconnect: () => void;
  pending: Map<
    number,
    {
      timer: ReturnType<typeof setTimeout>;
      resolve: (value: any) => void;
      reject: (reason?: any) => void;
    }
  >;
};

let ghostBridgeState: GhostBridgeState | null = null;
let ghostProviderProbeCache: { ts: number; providers: GhostProviderInfo[] } = { ts: 0, providers: [] };
let kastleAccountCache: { address: string; ts: number } = { address: "", ts: 0 };

export function toSompi(amountKas: number) {
  return Math.floor(Number(amountKas || 0) * 1e8);
}

export function parseKaswareBalance(payload: any) {
  const totalSompi = Number(payload?.total ?? payload?.confirmed ?? payload?.balance ?? 0);
  if (!Number.isFinite(totalSompi)) return "0.0000";
  return fmt(totalSompi / 1e8, 4);
}

export function parseKaswareTxid(payload: any) {
  if (typeof payload === "string") return payload;
  return payload?.txid || payload?.hash || payload?.transactionId || "";
}

export function isLikelyTxid(value: string) {
  return /^[a-fA-F0-9]{64}$/.test(String(value || "").trim());
}

export function formatKasAmountString(amountKas: number) {
  const fixed = Number(amountKas || 0).toFixed(8);
  return fixed.replace(/\.?0+$/, "") || "0";
}

export function kastleNetworkIdForCurrentProfile(): "mainnet" | "testnet-10" {
  const resolved = resolveKaspaNetwork(DEFAULT_NETWORK);
  return resolved.id === "mainnet" ? "mainnet" : "testnet-10";
}

export function getKastleRawTxJsonBuilderBridge() {
  if (typeof window === "undefined") return null;
  const candidate = (window as any).__FORGEOS_KASTLE_BUILD_TX_JSON__;
  return typeof candidate === "function" ? candidate : null;
}

export function normalizeOutputList(outputs: any[]) {
  if (!Array.isArray(outputs)) return [];
  return outputs
    .map((entry) => ({
      to: normalizeKaspaAddress(String(entry?.to || entry?.address || ""), ALLOWED_ADDRESS_PREFIXES),
      amount_kas: Number(Number(entry?.amount_kas ?? entry?.amount ?? 0).toFixed(8)),
    }))
    .filter((entry) => entry.to && entry.amount_kas > 0);
}

export function extractTxidDeep(value: any, depth = 0): string {
  if (depth > 4 || value == null) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isLikelyTxid(trimmed)) return trimmed;
    const rx =
      /"(?:transactionId|transaction_id|txid|hash|id)"\s*:\s*"([a-fA-F0-9]{64})"/.exec(trimmed) ||
      /([a-fA-F0-9]{64})/.exec(trimmed);
    return rx?.[1] || "";
  }
  if (typeof value !== "object") return "";
  const direct = [
    value.txid,
    value.hash,
    value.transactionId,
    value.transaction_id,
    value.id,
    value?.transaction?.txid,
    value?.transaction?.hash,
    value?.transaction?.transactionId,
    value?.transaction?.id,
  ];
  for (const candidate of direct) {
    const txid = extractTxidDeep(candidate, depth + 1);
    if (txid) return txid;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const txid = extractTxidDeep(item, depth + 1);
      if (txid) return txid;
    }
    return "";
  }
  for (const nested of Object.values(value)) {
    const txid = extractTxidDeep(nested, depth + 1);
    if (txid) return txid;
  }
  return "";
}

export function parseAnyTxid(payload: any) {
  return extractTxidDeep(payload);
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  }) as Promise<T>;
}

export function normalizeWalletError(err: any, context: string) {
  const msg = String(err?.message || err || "wallet_error");
  if (/user rejected|rejected|denied|cancel/i.test(msg)) {
    return walletError(new Error(`${context}: User rejected wallet request`), { context });
  }
  if (/timeout/i.test(msg)) {
    return walletError(new Error(`${context}: Wallet request timed out`), { context });
  }
  if (/not detected|not connected/i.test(msg)) {
    return walletError(new Error(`${context}: Wallet unavailable`), { context });
  }
  return walletError(new Error(`${context}: ${msg}`), { context });
}

export function getKaswareProvider() {
  if (typeof window === "undefined") {
    throw new Error("Browser wallet APIs unavailable outside browser environment");
  }
  const provider = (window as any).kasware;
  if (!provider) throw new Error("Kasware extension not detected. Install from kasware.org");
  return provider;
}

export function getKastleProvider() {
  if (typeof window === "undefined") {
    throw new Error("Browser wallet APIs unavailable outside browser environment");
  }
  const provider = (window as any).kastle;
  if (!provider) throw new Error("Kastle extension not detected. Install from kastle.cc");
  return provider;
}

export async function getKastleAccountAddress() {
  if (kastleAccountCache.address && Date.now() - kastleAccountCache.ts <= KASTLE_ACCOUNT_CACHE_TTL_MS) {
    return kastleAccountCache.address;
  }
  const w = getKastleProvider();
  let account = null as any;
  if (typeof w.getAccount === "function") {
    account = await withTimeout(Promise.resolve(w.getAccount()), WALLET_CALL_TIMEOUT_MS, "kastle_get_account_for_raw_tx");
  } else if (typeof w.request === "function") {
    account = await withTimeout(
      Promise.resolve(w.request("kas:get_account")),
      WALLET_CALL_TIMEOUT_MS,
      "kastle_request_get_account_for_raw_tx"
    );
  } else {
    throw new Error("Kastle provider missing getAccount()/request()");
  }
  const normalized = normalizeKaspaAddress(String(account?.address || account?.addresses?.[0] || ""), ALL_KASPA_ADDRESS_PREFIXES);
  kastleAccountCache = { address: normalized, ts: Date.now() };
  return normalized;
}

export function setKastleAccountCacheAddress(address: string) {
  kastleAccountCache = { address, ts: Date.now() };
}

export function getKastleCachedAccountAddress() {
  return kastleAccountCache.address;
}

async function buildKastleRawTxJsonViaBackend(
  outputs: Array<{ to: string; amount_kas: number }>,
  purpose?: string,
  fromAddressHint?: string
) {
  if (!KASTLE_TX_BUILDER_URL) return "";
  if (typeof fetch !== "function") throw new Error("Kastle tx builder requires fetch()");
  const hinted = String(fromAddressHint || "").trim();
  const fromAddress = hinted
    ? normalizeKaspaAddress(hinted, ALL_KASPA_ADDRESS_PREFIXES)
    : await getKastleAccountAddress();
  const networkId = kastleNetworkIdForCurrentProfile();

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), KASTLE_TX_BUILDER_TIMEOUT_MS) : null;
  try {
    const res = await fetch(KASTLE_TX_BUILDER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(KASTLE_TX_BUILDER_TOKEN ? { Authorization: `Bearer ${KASTLE_TX_BUILDER_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        wallet: "kastle",
        networkId,
        fromAddress,
        outputs: normalizeOutputList(outputs).map((o) => ({
          address: o.to,
          amountKas: Number(o.amount_kas),
        })),
        purpose: String(purpose || "").slice(0, 140),
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`kastle_tx_builder_${res.status}:${String(text || "").slice(0, 180)}`);
    const payload = text ? JSON.parse(text) : {};
    const txJson = typeof payload === "string" ? payload.trim() : String(payload?.txJson || payload?.result?.txJson || "").trim();
    if (!txJson) throw new Error("Kastle tx builder did not return txJson");
    return txJson;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function buildKastleRawTxJson(
  outputs: Array<{ to: string; amount_kas: number }>,
  purpose?: string,
  fromAddressHint?: string
) {
  const normalizedOutputs = normalizeOutputList(outputs);
  if (!normalizedOutputs.length) throw new Error("Kastle raw tx requires outputs");
  let backendError: any = null;

  if (KASTLE_TX_BUILDER_URL) {
    try {
      const txJson = await buildKastleRawTxJsonViaBackend(normalizedOutputs, purpose, fromAddressHint);
      if (txJson) return txJson;
    } catch (e: any) {
      backendError = e;
      if (KASTLE_TX_BUILDER_STRICT) throw e;
    }
  }

  const bridge = getKastleRawTxJsonBuilderBridge();
  if (bridge) {
    const txJson = await bridge({
      networkId: kastleNetworkIdForCurrentProfile(),
      outputs: normalizedOutputs,
      purpose: String(purpose || "").slice(0, 140),
    });
    if (typeof txJson !== "string" || !txJson.trim()) {
      throw new Error("Kastle raw tx builder bridge returned an empty txJson");
    }
    return txJson.trim();
  }

  if (!KASTLE_RAW_TX_MANUAL_JSON_PROMPT_ENABLED || typeof window === "undefined" || typeof window.prompt !== "function") {
    const suffix = backendError ? ` Backend builder error: ${String(backendError?.message || backendError).slice(0, 180)}` : "";
    throw new Error(
      `Kastle raw tx builder unavailable. Provide VITE_KASTLE_TX_BUILDER_URL, window.__FORGEOS_KASTLE_BUILD_TX_JSON__, or enable manual txJson prompt.${suffix}`
    );
  }

  const promptBody = [
    "KASTLE raw multi-output txJson required",
    "",
    "Forge.OS can call kastle.signAndBroadcastTx(networkId, txJson), but no automatic txJson builder is currently available in this runtime.",
    ...(backendError ? [`Builder error: ${String(backendError?.message || backendError).slice(0, 180)}`, ""] : []),
    "Paste a prebuilt txJson (serializeToSafeJSON) matching the outputs below.",
    "",
    `Network: ${kastleNetworkIdForCurrentProfile()}`,
    `Purpose: ${String(purpose || "").slice(0, 120) || "Forge.OS multi-output"}`,
    "Outputs:",
    ...normalizedOutputs.map((o, i) => `  ${i + 1}. ${o.to}  ${Number(o.amount_kas).toFixed(8)} KAS`),
  ].join("\n");
  const txJson = window.prompt(promptBody) || "";
  if (!txJson.trim()) throw new Error("Kastle raw tx cancelled: no txJson provided");
  return txJson.trim();
}

function isGhostProviderInfo(value: any): value is GhostProviderInfo {
  return Boolean(value && typeof value.id === "string" && typeof value.name === "string");
}

function ensureGhostBrowserContext() {
  if (typeof window === "undefined") {
    throw new Error("Ghost Wallet is only available in browser environments");
  }
  return window;
}

function clearGhostBridge(reason = "ghost_bridge_reset") {
  if (typeof window !== "undefined" && ghostBridgeState) {
    try {
      window.removeEventListener("kaspa:event", ghostBridgeState.onEvent as any);
      window.removeEventListener("kaspa:disconnect", ghostBridgeState.onDisconnect as any);
      window.dispatchEvent(new CustomEvent("kaspa:disconnect"));
    } catch {
      // Ignore bridge teardown failures.
    }
  }
  if (ghostBridgeState) {
    for (const pending of ghostBridgeState.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
  }
  ghostBridgeState = null;
}

export async function probeGhostProviders(timeoutMs = GHOST_PROVIDER_SCAN_TIMEOUT_MS): Promise<GhostProviderInfo[]> {
  const win = ensureGhostBrowserContext();
  const now = Date.now();
  if (now - ghostProviderProbeCache.ts < 1000 && ghostProviderProbeCache.providers.length) {
    return [...ghostProviderProbeCache.providers];
  }

  const providers = new Map<string, GhostProviderInfo>();
  const onProvider = (event: Event) => {
    const detail = (event as CustomEvent<any>).detail;
    if (!isGhostProviderInfo(detail)) return;
    providers.set(detail.id, { id: detail.id, name: detail.name });
  };
  win.addEventListener("kaspa:provider", onProvider as any);
  try {
    win.dispatchEvent(new CustomEvent("kaspa:requestProviders"));
  } catch {
    // If the event bridge is absent this will no-op.
  }

  await new Promise((resolve) => setTimeout(resolve, Math.max(50, timeoutMs)));
  win.removeEventListener("kaspa:provider", onProvider as any);

  const list = [...providers.values()];
  ghostProviderProbeCache = { ts: Date.now(), providers: list };
  return list;
}

function getActiveGhostBridge() {
  return ghostBridgeState;
}

async function ensureGhostBridgeConnected(): Promise<GhostBridgeState> {
  const win = ensureGhostBrowserContext();
  const existing = getActiveGhostBridge();
  if (existing?.connected) return existing;

  const providers = await probeGhostProviders();
  const provider = providers.find((p) => /ghost/i.test(String(p.name || ""))) || providers[0];
  if (!provider) {
    throw new Error("Ghost Wallet provider bridge not detected");
  }

  if (ghostBridgeState) clearGhostBridge("ghost_bridge_reconnect");

  const state: GhostBridgeState = {
    provider,
    nextRequestId: 1,
    connected: true,
    pending: new Map(),
    onEvent(event: Event) {
      const detail = (event as CustomEvent<any>).detail;
      if (!detail || typeof detail.id !== "number") return;
      const pending = state.pending.get(detail.id);
      if (!pending) return;
      state.pending.delete(detail.id);
      clearTimeout(pending.timer);
      if (detail.error) {
        pending.reject(new Error(String(detail.error)));
        return;
      }
      if (detail.data === false) {
        pending.reject(new Error("Ghost Wallet request was rejected"));
        return;
      }
      pending.resolve(detail.data);
    },
    onDisconnect() {
      clearGhostBridge("ghost_bridge_disconnected");
    },
  };

  win.addEventListener("kaspa:event", state.onEvent as any);
  win.addEventListener("kaspa:disconnect", state.onDisconnect as any);
  try {
    win.dispatchEvent(new CustomEvent("kaspa:connect", { detail: provider.id }));
  } catch (e) {
    win.removeEventListener("kaspa:event", state.onEvent as any);
    win.removeEventListener("kaspa:disconnect", state.onDisconnect as any);
    throw e;
  }
  ghostBridgeState = state;
  return state;
}

export async function ghostInvoke(method: "account" | "transact", params: any[], timeoutMs: number) {
  const win = ensureGhostBrowserContext();
  const state = await ensureGhostBridgeConnected();
  const id = state.nextRequestId++;
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`ghost_${String(method)}_timeout_${timeoutMs}ms`));
    }, timeoutMs);
    state.pending.set(id, { timer, resolve, reject });
    try {
      win.dispatchEvent(
        new CustomEvent("kaspa:invoke", {
          detail: {
            id,
            method,
            params,
          },
        })
      );
    } catch (e) {
      clearTimeout(timer);
      state.pending.delete(id);
      reject(e);
    }
  });
}

export async function promptForTxidIfNeeded(txid: string, promptLabel: string, rawPayload?: string) {
  if (txid && isLikelyTxid(txid)) return txid;
  if (typeof window === "undefined" || typeof window.prompt !== "function") {
    throw new Error(`${promptLabel} did not return a transaction id`);
  }
  const rawPreview = String(rawPayload || "").slice(0, 600);
  const pasted = window.prompt(
    `${promptLabel} did not return a clear txid. Paste the broadcast txid.\n\nRaw wallet response preview:\n${rawPreview}`
  );
  if (!pasted) throw new Error("Transaction not confirmed. No txid provided.");
  if (!isLikelyTxid(pasted.trim())) {
    throw new Error("Invalid txid format. Expected a 64-char hex transaction id.");
  }
  return pasted.trim();
}
