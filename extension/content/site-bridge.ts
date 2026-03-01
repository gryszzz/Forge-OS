/// <reference path="../chrome.d.ts" />
// Forge-OS Site Bridge — isolated-world content script injected on forge-os.xyz
//
// Responsibilities:
//  1. SYNC: Forward sanitised wallet metadata (address + network, NO phrase) to
//     the extension background via chrome.runtime.sendMessage.
//  2. RELAY: Bridge postMessages from page-provider.ts (MAIN world) to the
//     background service worker, and push responses back to the page.
//
// SECURITY:
//  • phrase is never forwarded — sanitiseWallet strips it before sync.
//  • signing approval is handled in the extension popup (vault session only).
//  • This script runs in the extension's isolated world (has chrome.runtime).
//    page-provider.ts runs in MAIN world (no chrome.runtime access).

// export {} makes this a module, preventing global variable collisions with
// other extension content scripts that also declare top-level const names.
import { emptyAgentsSnapshot, sanitizeAgentsSnapshot } from "../shared/agentSync";
export {};

const AGENTS_KEY = "forgeos.session.agents.v2";
const WALLET_KEY = "forgeos.managed.wallet.v1";

// Sentinel matching page-provider.ts — must be identical.
const S = "__forgeos__";

// ── Wallet sanitisation ───────────────────────────────────────────────────────

function sanitiseWallet(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null) return null;
    const safe: Record<string, unknown> = {};
    if (typeof obj.address === "string") safe.address = obj.address;
    if (typeof obj.network === "string") safe.network = obj.network;
    if (!safe.address) return null;
    return JSON.stringify(safe);
  } catch { return null; }
}

function sanitiseAgents(raw: unknown): { json: string; count: number } {
  return sanitizeAgentsSnapshot(raw) ?? emptyAgentsSnapshot();
}

// ── Metadata sync to background ───────────────────────────────────────────────

function sync(): void {
  try {
    const agents = sanitiseAgents(localStorage.getItem(AGENTS_KEY));
    const wallet = sanitiseWallet(localStorage.getItem(WALLET_KEY));
    chrome.runtime.sendMessage({ type: "FORGEOS_SYNC", agents: agents.json, wallet }).catch(() => {});
  } catch { /* content script must never throw */ }
}

sync();

window.addEventListener("storage", (e) => {
  if (e.key === AGENTS_KEY || e.key === WALLET_KEY) sync();
});

setInterval(sync, 10_000);

// ── postMessage relay: page (MAIN world) ↔ background ────────────────────────

window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const msg = ev.data as Record<string, any>;
  if (!msg?.[S]) return;

  // Lightweight bridge heartbeat for web-app fallback detection.
  if (msg.type === "FORGEOS_BRIDGE_PING") {
    const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
    window.postMessage({
      [S]: true,
      type: "FORGEOS_BRIDGE_PONG",
      requestId,
      result: {
        bridgeReady: true,
        transport: "content-script",
      },
    }, "*");
    return;
  }

  if (msg.type === "FORGEOS_AGENT_SNAPSHOT") {
    const agents = sanitiseAgents(msg.agents);
    chrome.runtime.sendMessage({
      type: "FORGEOS_SYNC_AGENTS",
      agents: agents.json,
      source: "push",
      updatedAt: Date.now(),
    }).catch(() => {});
    return;
  }

  // Just open popup (no connect flow)
  if (msg.type === "FORGEOS_OPEN_POPUP") {
    chrome.runtime.sendMessage({ type: "FORGEOS_OPEN_POPUP" }).catch(() => {});
    return;
  }

  // Connect via extension vault — background opens popup for approval
  if (msg.type === "FORGEOS_CONNECT") {
    const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
    if (!requestId) {
      window.postMessage({
        [S]: true,
        requestId,
        result: null,
        error: "Invalid connect request",
      }, "*");
      return;
    }

    // Best-effort explicit popup request before queueing connect approval.
    chrome.runtime.sendMessage({ type: "FORGEOS_OPEN_POPUP" }).catch(() => {});
    chrome.runtime.sendMessage({
      type: "FORGEOS_OPEN_FOR_CONNECT",
      requestId,
    }).catch((err: any) => {
      window.postMessage({
        [S]: true,
        requestId,
        result: null,
        error: err?.message ?? "Connection failed",
      }, "*");
    });
    return;
  }

  // Extension vault signing — request popup approval
  if (msg.type === "FORGEOS_SIGN") {
    const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
    const message = typeof msg.message === "string" ? msg.message : null;
    if (!requestId || message === null) {
      window.postMessage({
        [S]: true,
        requestId,
        result: null,
        error: "Invalid sign request",
      }, "*");
      return;
    }

    chrome.runtime.sendMessage({
      type: "FORGEOS_OPEN_FOR_SIGN",
      requestId,
      message,
    }).catch((err: any) => {
      window.postMessage({
        [S]: true,
        requestId,
        result: null,
        error: err?.message ?? "Signing failed",
      }, "*");
    });
    return;
  }
});

// Push connect/sign result from background back to page
chrome.runtime.onMessage.addListener((message: any) => {
  if (message?.type === "FORGEOS_CONNECT_RESULT" || message?.type === "FORGEOS_SIGN_RESULT") {
    window.postMessage({
      [S]: true,
      requestId: message.requestId,
      result: message.result ?? null,
      error: message.error ?? undefined,
    }, "*");
  }
});
