import { createHardwareBridgeProvider } from "./providers/hardwareBridge";
import { createKaspiumProvider } from "./providers/kaspium";
import { createKastleProvider } from "./providers/kastle";
import { createGhostProvider } from "./providers/ghost";
import { createKaswareProvider } from "./providers/kasware";
import { loadManagedWallet, signMessage as managedSignMessage } from "./KaspaWalletManager";
import {
  ALLOWED_ADDRESS_PREFIXES,
  ALL_KASPA_ADDRESS_PREFIXES,
  DEFAULT_NETWORK,
  ENFORCE_WALLET_NETWORK,
  GHOST_CONNECT_TIMEOUT_MS,
  KASPIUM_DEEP_LINK_SCHEME,
  KASTLE_RAW_TX_ENABLED,
  KASTLE_RAW_TX_MANUAL_JSON_PROMPT_ENABLED,
  KASTLE_TX_BUILDER_URL,
  NETWORK_LABEL,
  WALLET_CALL_TIMEOUT_MS,
  WALLET_SEND_TIMEOUT_MS,
  buildKastleRawTxJson,
  formatKasAmountString,
  getKaswareProvider,
  getKastleCachedAccountAddress,
  getKastleProvider,
  getKastleRawTxJsonBuilderBridge,
  ghostInvoke,
  isAddressPrefixCompatible,
  isLikelyTxid,
  kastleNetworkIdForCurrentProfile,
  normalizeKaspaAddress,
  normalizeOutputList,
  normalizeWalletError,
  parseAnyTxid,
  parseKaswareBalance,
  parseKaswareTxid,
  probeGhostProviders,
  promptForTxidIfNeeded,
  resolveKaspaNetwork,
  setKastleAccountCacheAddress,
  toSompi,
  withTimeout,
} from "./walletAdapterInternals";

const kaswareProvider = createKaswareProvider({
  getKaswareProvider,
  withTimeout,
  WALLET_CALL_TIMEOUT_MS,
  WALLET_SEND_TIMEOUT_MS,
  resolveKaspaNetwork,
  DEFAULT_NETWORK,
  normalizeKaspaAddress,
  ALL_KASPA_ADDRESS_PREFIXES,
  ALLOWED_ADDRESS_PREFIXES,
  ENFORCE_WALLET_NETWORK,
  NETWORK_LABEL,
  isAddressPrefixCompatible,
  normalizeWalletError,
  parseKaswareBalance,
  parseKaswareTxid,
  isLikelyTxid,
  toSompi,
});

const kastleProvider = createKastleProvider({
  getKastleProvider,
  withTimeout,
  WALLET_CALL_TIMEOUT_MS,
  WALLET_SEND_TIMEOUT_MS,
  resolveKaspaNetwork,
  DEFAULT_NETWORK,
  normalizeKaspaAddress,
  ALL_KASPA_ADDRESS_PREFIXES,
  ALLOWED_ADDRESS_PREFIXES,
  ENFORCE_WALLET_NETWORK,
  NETWORK_LABEL,
  isAddressPrefixCompatible,
  normalizeWalletError,
  toSompi,
  parseAnyTxid,
  isLikelyTxid,
  KASTLE_RAW_TX_ENABLED,
  KASTLE_TX_BUILDER_URL,
  KASTLE_RAW_TX_MANUAL_JSON_PROMPT_ENABLED,
  getKastleRawTxJsonBuilderBridge,
  buildKastleRawTxJson,
  normalizeOutputList,
  kastleNetworkIdForCurrentProfile,
  setKastleAccountCacheAddress,
  getKastleCachedAccountAddress,
});

const kaspiumProvider = createKaspiumProvider({
  normalizeKaspaAddress,
  ALLOWED_ADDRESS_PREFIXES,
  DEFAULT_NETWORK,
  KASPIUM_DEEP_LINK_SCHEME,
  isLikelyTxid,
});

const hardwareBridgeProvider = createHardwareBridgeProvider({
  normalizeKaspaAddress,
  ALLOWED_ADDRESS_PREFIXES,
  DEFAULT_NETWORK,
  normalizeOutputList,
  isLikelyTxid,
});

const ghostProvider = createGhostProvider({
  resolveKaspaNetwork,
  DEFAULT_NETWORK,
  normalizeKaspaAddress,
  ALL_KASPA_ADDRESS_PREFIXES,
  ALLOWED_ADDRESS_PREFIXES,
  ENFORCE_WALLET_NETWORK,
  NETWORK_LABEL,
  isAddressPrefixCompatible,
  normalizeWalletError,
  withTimeout,
  GHOST_CONNECT_TIMEOUT_MS,
  WALLET_SEND_TIMEOUT_MS,
  ghostInvoke,
  probeGhostProviders,
  formatKasAmountString,
  parseAnyTxid,
  promptForTxidIfNeeded,
  normalizeOutputList,
});

function getForgeOSProvider(): any | null {
  try {
    const provider = typeof window !== "undefined" ? (window as any).forgeos : undefined;
    return provider?.isForgeOS ? provider : null;
  } catch {
    return null;
  }
}

const FORGEOS_BRIDGE_SENTINEL = "__forgeos__" as const;
const FORGEOS_BRIDGE_TIMEOUT_MS = 120_000;
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
  const raw = ENV?.[name];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  return Math.min(max, Math.max(min, rounded));
}

const STRICT_EXTENSION_AUTH_CONNECT = readBoolEnv(
  "VITE_FORGEOS_STRICT_EXTENSION_AUTH_CONNECT",
  true,
);
const FORGEOS_CONNECT_TIMEOUT_MS = readIntEnv(
  "VITE_FORGEOS_CONNECT_TIMEOUT_MS",
  18_000,
  3_000,
  120_000,
);
const FORGEOS_CONNECT_TIMEOUT_MESSAGE =
  "Forge-OS connect timed out. Open the extension popup, unlock your wallet, and approve the site connection.";
const FORGEOS_BRIDGE_SITE_HINT =
  "Supported web origins: forge-os.xyz, *.forge-os.xyz, forgeos.xyz, gryszzz.github.io/Forge-OS, and localhost.";

function currentOriginLabel(): string {
  try {
    return typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "unknown";
  } catch {
    return "unknown";
  }
}

export type ForgeOSTransportType = "provider" | "bridge" | "managed" | "none";

export interface ForgeOSBridgeStatus {
  providerInjected: boolean;
  bridgeReachable: boolean;
  managedWalletPresent: boolean;
  transport: ForgeOSTransportType;
}

type ForgeBridgePendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const forgeBridgePending = new Map<string, ForgeBridgePendingRequest>();
let forgeBridgeListenerAttached = false;
type ForgeOSConnectResult = { address: string; network: string; provider: "forgeos" };
let forgeConnectInFlight: Promise<ForgeOSConnectResult> | null = null;

function ensureForgeBridgeListener(): void {
  if (forgeBridgeListenerAttached || typeof window === "undefined") return;
  window.addEventListener("message", (ev: any) => {
    if (ev?.source !== window) return;
    const msg = ev?.data as Record<string, unknown> | undefined;
    if (!msg?.[FORGEOS_BRIDGE_SENTINEL]) return;
    const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
    if (!requestId) return;
    if (!("result" in msg) && !("error" in msg)) return;

    const pending = forgeBridgePending.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    forgeBridgePending.delete(requestId);

    if (msg.error) {
      pending.reject(new Error(String(msg.error)));
      return;
    }
    pending.resolve(msg.result);
  });
  forgeBridgeListenerAttached = true;
}

function bridgeRequest(
  type: string,
  extra?: Record<string, unknown>,
  timeoutMs: number = FORGEOS_BRIDGE_TIMEOUT_MS,
): Promise<any> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Forge-OS bridge unavailable outside browser context."));
  }
  ensureForgeBridgeListener();
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      forgeBridgePending.delete(requestId);
      reject(new Error("Forge-OS: bridge request timed out"));
    }, Math.max(250, timeoutMs));

    forgeBridgePending.set(requestId, { resolve, reject, timer });
    window.postMessage(
      {
        [FORGEOS_BRIDGE_SENTINEL]: true,
        type,
        requestId,
        ...(extra ?? {}),
      },
      "*",
    );
  });
}

function normalizeForgeOSConnectError(err: unknown): Error {
  const message = String((err as Error)?.message ?? err ?? "Forge-OS connect failed.");
  if (message.toLowerCase().includes("timed out")) {
    return new Error(FORGEOS_CONNECT_TIMEOUT_MESSAGE);
  }
  return err instanceof Error ? err : new Error(message);
}

async function waitForForgeOSBridge(timeoutMs = 2_500): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const deadline = Date.now() + Math.max(250, timeoutMs);
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const result = await bridgeRequest(
        "FORGEOS_BRIDGE_PING",
        undefined,
        Math.min(700, Math.max(250, remaining)),
      );
      if (result?.bridgeReady) return true;
    } catch {}

    if (remaining <= 300) break;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

function createForgeOSBridgeProvider() {
  return {
    isForgeOS: true as const,
    version: "1.0.0-bridge",
    async connect(): Promise<{ address: string; network: string } | null> {
      try {
        if (typeof window !== "undefined") {
          window.postMessage({ [FORGEOS_BRIDGE_SENTINEL]: true, type: "FORGEOS_OPEN_POPUP" }, "*");
        }
        return await bridgeRequest("FORGEOS_CONNECT", undefined, FORGEOS_CONNECT_TIMEOUT_MS);
      } catch (err) {
        throw normalizeForgeOSConnectError(err);
      }
    },
    async signMessage(message: string): Promise<string> {
      return bridgeRequest("FORGEOS_SIGN", { message });
    },
    openExtension(): void {
      if (typeof window === "undefined") return;
      window.postMessage({ [FORGEOS_BRIDGE_SENTINEL]: true, type: "FORGEOS_OPEN_POPUP" }, "*");
    },
    disconnect(): void {},
  };
}

async function resolveForgeOSTransport(
  providerTimeoutMs: number,
  bridgeTimeoutMs: number,
): Promise<any | null> {
  const current = getForgeOSProvider();
  if (current?.isForgeOS) return current;

  // Prefer bridge path first: it works even when MAIN-world injector is blocked.
  if (await waitForForgeOSBridge(bridgeTimeoutMs)) {
    return createForgeOSBridgeProvider();
  }

  const lateProvider = await waitForForgeOSProvider(providerTimeoutMs);
  if (lateProvider?.isForgeOS) return lateProvider;

  // Final short retry for delayed bridge startup.
  if (await waitForForgeOSBridge(Math.min(1_200, bridgeTimeoutMs))) {
    return createForgeOSBridgeProvider();
  }

  return null;
}

async function waitForForgeOSProvider(timeoutMs = 2500): Promise<any | null> {
  const current = getForgeOSProvider();
  if (current) return current;
  if (typeof window === "undefined") return null;

  return new Promise((resolve) => {
    let done = false;
    const finish = (provider: any | null) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timeout);
      window.removeEventListener("forgeos#initialized", onInitialized as EventListener);
      resolve(provider);
    };
    const onInitialized = () => finish(getForgeOSProvider());

    window.addEventListener("forgeos#initialized", onInitialized as EventListener);

    const poll = window.setInterval(() => {
      const provider = getForgeOSProvider();
      if (provider) finish(provider);
    }, 75);

    const timeout = window.setTimeout(() => {
      finish(getForgeOSProvider());
    }, Math.max(250, timeoutMs));
  });
}

export const WalletAdapter = {
  detect() {
    let kasware: any;
    let kastle: any;
    let forgeos: any;
    try {
      kasware = typeof window !== "undefined" ? (window as any).kasware : undefined;
      kastle = typeof window !== "undefined" ? (window as any).kastle : undefined;
      forgeos = typeof window !== "undefined" ? (window as any).forgeos : undefined;
    } catch {
      kasware = undefined;
      kastle = undefined;
      forgeos = undefined;
    }
    return {
      kasware: !!kasware,
      kastle: !!kastle,
      forgeos: !!forgeos?.isForgeOS,
      ghost: false,
      kaspium: true,
      kaswareMethods: kasware
        ? {
            requestAccounts: typeof kasware.requestAccounts === "function",
            getNetwork: typeof kasware.getNetwork === "function",
            getBalance: typeof kasware.getBalance === "function",
            signMessage: typeof kasware.signMessage === "function",
            sendKaspa: typeof kasware.sendKaspa === "function",
          }
        : null,
      kastleMethods: kastle
        ? {
            connect: typeof kastle.connect === "function",
            getAccount: typeof kastle.getAccount === "function",
            request: typeof kastle.request === "function",
            sendKaspa: typeof kastle.sendKaspa === "function",
            signMessage: typeof kastle.signMessage === "function",
            signAndBroadcastTx: typeof kastle.signAndBroadcastTx === "function",
          }
        : null,
    };
  },

  async probeForgeOSBridgeStatus(timeoutMs = 900): Promise<ForgeOSBridgeStatus> {
    const providerInjected = !!getForgeOSProvider();
    const managedWalletPresent = !!loadManagedWallet()?.address;
    const bridgeReachable = await waitForForgeOSBridge(timeoutMs).catch(() => false);
    const transport: ForgeOSTransportType =
      providerInjected ? "provider"
      : bridgeReachable ? "bridge"
      : managedWalletPresent ? "managed"
      : "none";

    return {
      providerInjected,
      bridgeReachable,
      managedWalletPresent,
      transport,
    };
  },

  async connectKasware() {
    return kaswareProvider.connect();
  },

  async connectKastle() {
    return kastleProvider.connect();
  },

  async connectForgeOS() {
    if (forgeConnectInFlight) return forgeConnectInFlight;

    const connectPromise = (async (): Promise<ForgeOSConnectResult> => {
      // Try extension provider first (page-provider.ts injects window.forgeos)
      const provider = await resolveForgeOSTransport(3000, 1500);
      let providerConnectError: Error | null = null;
      if (provider?.isForgeOS) {
        try {
          const wallet = await provider.connect();
          if (wallet?.address) {
            return { address: wallet.address, network: wallet.network, provider: "forgeos" };
          }
        } catch (err) {
          providerConnectError = normalizeForgeOSConnectError(err);
        }
      }
      if (STRICT_EXTENSION_AUTH_CONNECT) {
        if (providerConnectError) throw providerConnectError;
        throw new Error(
          `Forge-OS extension-auth connect is required in this environment. Current origin: ${currentOriginLabel()}. Reload the extension, refresh this page, and enable extension Site access for this domain. ${FORGEOS_BRIDGE_SITE_HINT}`,
        );
      }
      // Fallback: read managed wallet directly from localStorage (no extension needed)
      const managed = loadManagedWallet();
      if (managed?.address) {
        return { address: managed.address, network: managed.network, provider: "forgeos" };
      }
      if (providerConnectError) throw providerConnectError;
      throw new Error(
        `No Forge-OS wallet bridge detected on this tab (origin: ${currentOriginLabel()}). Reload the extension, refresh this page, and enable extension Site access for this domain. ${FORGEOS_BRIDGE_SITE_HINT}`,
      );
    })();

    forgeConnectInFlight = connectPromise;
    try {
      return await connectPromise;
    } finally {
      if (forgeConnectInFlight === connectPromise) {
        forgeConnectInFlight = null;
      }
    }
  },

  connectKaspium(address: string) {
    return kaspiumProvider.connect(address);
  },

  async getKaswareBalance() {
    return kaswareProvider.getBalance();
  },

  async sendKasware(toAddress: string, amountKas: number) {
    return kaswareProvider.send(toAddress, amountKas);
  },

  async sendKastle(toAddress: string, amountKas: number) {
    return kastleProvider.send(toAddress, amountKas);
  },

  canKastleSignAndBroadcastRawTx() {
    return kastleProvider.canSignAndBroadcastRawTx();
  },

  canKastleMultiOutputRawTxPath() {
    return kastleProvider.canMultiOutputRawTxPath();
  },

  async sendKastleRawTx(outputs: Array<{ to: string; amount_kas: number }>, purpose?: string) {
    return kastleProvider.sendRawTx(outputs, purpose);
  },

  async sendKaspium(toAddress: string, amountKas: number, note?: string) {
    return kaspiumProvider.send(toAddress, amountKas, note);
  },

  async sendGhost(toAddress: string, amountKas: number) {
    return ghostProvider.send(toAddress, amountKas);
  },

  async sendGhostOutputs(outputs: Array<{ to: string; amount_kas: number }>, purpose?: string) {
    return ghostProvider.sendOutputs(outputs, purpose);
  },

  async signMessageKasware(message: string) {
    return kaswareProvider.signMessage(message);
  },

  async signMessageKastle(message: string) {
    return kastleProvider.signMessage(message);
  },

  async signMessageForgeOS(message: string) {
    // Try extension provider first
    const provider = await resolveForgeOSTransport(1500, 1200);
    if (provider?.isForgeOS) {
      return provider.signMessage(message);
    }
    // Fallback: sign locally with managed wallet phrase
    const managed = loadManagedWallet();
    if (managed?.phrase) {
      return managedSignMessage(managed.phrase, message, {
        mnemonicPassphrase: managed.mnemonicPassphrase,
        derivation: managed.derivation,
      });
    }
    throw new Error("No Forge-OS wallet found for signing.");
  },

  supportsNativeMultiOutput(provider: string) {
    const normalized = String(provider || "").toLowerCase();
    if (normalized === "kastle") return kastleProvider.canMultiOutputRawTxPath();
    return false;
  },

  async connectHardwareBridge(provider: "tangem" | "onekey", address: string) {
    return hardwareBridgeProvider.connect(provider, address);
  },

  async sendHardwareBridge(
    provider: string,
    toAddress: string,
    amountKas: number,
    note?: string,
    outputs?: Array<{ to: string; amount_kas: number }>
  ) {
    return hardwareBridgeProvider.send(provider, toAddress, amountKas, note, outputs);
  }
};
