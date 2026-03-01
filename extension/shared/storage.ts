// Typed chrome.storage.local wrappers.
// SECURITY: ManagedWallet no longer carries a phrase field.
// The mnemonic lives exclusively in the encrypted vault (forgeos.vault.v1).
// The content bridge syncs only non-sensitive metadata (address, network, agents).
import {
  DEFAULT_DISPLAY_CURRENCY,
  normalizeDisplayCurrency,
  type DisplayCurrency,
} from "./fiat";

const KEYS = {
  agents: "forgeos.session.agents.v2",
  activeAgent: "forgeos.session.activeAgent.v2",
  // Wallet address + network only — phrase is in the vault, never here
  walletMeta: "forgeos.wallet.meta.v2",
  network: "forgeos.network",
  lastProvider: "forgeos.wallet.lastProvider.mainnet",
  // Auto-lock settings (minutes)
  autoLockMinutes: "forgeos.autolock.minutes.v1",
  // Allow unlock persistence across popup closes (session-scoped only)
  persistUnlockSession: "forgeos.unlock.persist-session.v1",
  // Preferred fiat display currency for portfolio value
  displayCurrency: "forgeos.display.currency.v1",
  // Privacy preference: hide balances in popup wallet UI
  hidePortfolioBalances: "forgeos.privacy.hide-balances.v1",
  // Preferred RPC provider preset by network id
  kaspaRpcProviderPresetMap: "forgeos.kaspa.rpc-provider.v1",
  // Optional runtime Kaspa API endpoint override by network id
  customKaspaRpcMap: "forgeos.kaspa.custom-rpc.v1",
  // Optional per-network provider pool overrides (official/igra/kasplex)
  kaspaRpcPoolOverrideMap: "forgeos.kaspa.rpc-pool-overrides.v1",
  // Local node mode controls
  localNodeEnabled: "forgeos.local-node.enabled.v1",
  localNodeNetworkProfile: "forgeos.local-node.network-profile.v1",
  localNodeDataDir: "forgeos.local-node.data-dir.v1",
} as const;

export const NETWORK_STORAGE_KEY = KEYS.network;

const AUTO_LOCK_MIN = 1;
const AUTO_LOCK_MAX = 24 * 60; // 24h
const AUTO_LOCK_NEVER = -1;
const DEFAULT_KASPA_RPC_PROVIDER_PRESET = "official" as const;

export type KaspaRpcProviderPreset = "official" | "igra" | "kasplex" | "custom" | "local";
export type KaspaRpcPoolOverridePreset = "official" | "igra" | "kasplex";
export type LocalNodeNetworkProfile = "mainnet" | "testnet-10" | "testnet-11" | "testnet-12";

function normalizeAutoLockMinutes(raw: unknown): number {
  if (raw === AUTO_LOCK_NEVER) return AUTO_LOCK_NEVER;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 15;
  const rounded = Math.floor(raw);
  return Math.min(AUTO_LOCK_MAX, Math.max(AUTO_LOCK_MIN, rounded));
}

function chromeStorage(): chrome.storage.LocalStorageArea | null {
  if (typeof chrome !== "undefined" && chrome.storage) return chrome.storage.local;
  return null;
}

function normalizeKaspaRpcEndpoint(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return trimmed.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function normalizeKaspaRpcMap(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(k || "").trim();
    if (!key) continue;
    const endpoint = normalizeKaspaRpcEndpoint(v);
    if (!endpoint) continue;
    out[key] = endpoint;
  }
  return out;
}

function normalizeKaspaRpcPool(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const candidate of raw) {
    const endpoint = normalizeKaspaRpcEndpoint(candidate);
    if (!endpoint) continue;
    if (!out.includes(endpoint)) out.push(endpoint);
  }
  return out;
}

function normalizeKaspaRpcProviderPreset(raw: unknown): KaspaRpcProviderPreset {
  if (raw === "local") return "local";
  if (raw === "igra") return "igra";
  if (raw === "kasplex") return "kasplex";
  if (raw === "custom") return "custom";
  return DEFAULT_KASPA_RPC_PROVIDER_PRESET;
}

function normalizeLocalNodeNetworkProfile(raw: unknown): LocalNodeNetworkProfile {
  const v = String(raw || "").trim().toLowerCase().replace(/_/g, "-");
  if (v === "testnet-10" || v === "tn10") return "testnet-10";
  if (v === "testnet-11" || v === "tn11") return "testnet-11";
  if (v === "testnet-12" || v === "tn12") return "testnet-12";
  return "mainnet";
}

function normalizeKaspaRpcProviderPresetMap(
  raw: unknown,
): Record<string, KaspaRpcProviderPreset> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, KaspaRpcProviderPreset> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(k || "").trim();
    if (!key) continue;
    out[key] = normalizeKaspaRpcProviderPreset(v);
  }
  return out;
}

type KaspaRpcPoolOverrideEntry = Partial<Record<KaspaRpcPoolOverridePreset, string[]>>;

function normalizeKaspaRpcPoolOverrideMap(
  raw: unknown,
): Record<string, KaspaRpcPoolOverrideEntry> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, KaspaRpcPoolOverrideEntry> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const networkKey = String(k || "").trim();
    if (!networkKey || typeof v !== "object" || v === null) continue;
    const entryRaw = v as Record<string, unknown>;
    const entry: KaspaRpcPoolOverrideEntry = {};
    for (const preset of ["official", "igra", "kasplex"] as const) {
      const pool = normalizeKaspaRpcPool(entryRaw[preset]);
      if (pool.length > 0) entry[preset] = pool;
    }
    if (entry.official || entry.igra || entry.kasplex) {
      out[networkKey] = entry;
    }
  }
  return out;
}

// ── Agents ───────────────────────────────────────────────────────────────────

export async function getAgents(): Promise<unknown[]> {
  const store = chromeStorage();
  if (!store) return [];
  return new Promise((resolve) => {
    store.get(KEYS.agents, (result) => {
      try {
        const raw = result[KEYS.agents];
        if (!raw) return resolve([]);
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch { resolve([]); }
    });
  });
}

export async function setAgents(agents: unknown[]): Promise<void> {
  const store = chromeStorage();
  if (!store) return;
  return new Promise((resolve) => {
    store.set({ [KEYS.agents]: JSON.stringify(agents) }, resolve);
  });
}

export async function getActiveAgentId(): Promise<string> {
  const store = chromeStorage();
  if (!store) return "";
  return new Promise((resolve) => {
    store.get(KEYS.activeAgent, (result) => resolve(result[KEYS.activeAgent] || ""));
  });
}

// ── Wallet metadata (address + network ONLY — no phrase) ─────────────────────

/**
 * Non-sensitive wallet metadata stored in chrome.storage.local.
 * The mnemonic is NEVER included here — it lives in the encrypted vault.
 */
export interface WalletMeta {
  address: string;
  network: string;
}

export async function getWalletMeta(): Promise<WalletMeta | null> {
  const store = chromeStorage();
  if (!store) return null;
  return new Promise((resolve) => {
    store.get(KEYS.walletMeta, (result) => {
      try {
        const raw = result[KEYS.walletMeta];
        if (!raw) return resolve(null);
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        resolve(parsed?.address ? (parsed as WalletMeta) : null);
      } catch { resolve(null); }
    });
  });
}

export async function setWalletMeta(meta: WalletMeta): Promise<void> {
  const store = chromeStorage();
  if (!store) return;
  return new Promise((resolve) => {
    store.set({ [KEYS.walletMeta]: JSON.stringify(meta) }, resolve);
  });
}

export async function clearWalletMeta(): Promise<void> {
  const store = chromeStorage();
  if (!store) return;
  return new Promise((resolve) => {
    store.remove(KEYS.walletMeta, resolve);
  });
}

// ── Network ───────────────────────────────────────────────────────────────────

export async function getNetwork(): Promise<string> {
  const store = chromeStorage();
  if (!store) return "mainnet";
  return new Promise((resolve) => {
    store.get(KEYS.network, (result) => resolve(result[KEYS.network] || "mainnet"));
  });
}

export async function setNetwork(network: string): Promise<void> {
  const store = chromeStorage();
  if (!store) return;
  return new Promise((resolve) => {
    store.set({ [KEYS.network]: network }, resolve);
  });
}

// ── Auto-lock settings ────────────────────────────────────────────────────────

export async function getAutoLockMinutes(): Promise<number> {
  const store = chromeStorage();
  if (!store) return 15;
  return new Promise((resolve) => {
    store.get(KEYS.autoLockMinutes, (result) => {
      resolve(normalizeAutoLockMinutes(result[KEYS.autoLockMinutes]));
    });
  });
}

export async function setAutoLockMinutes(minutes: number): Promise<void> {
  const store = chromeStorage();
  if (!store) return;
  return new Promise((resolve) => {
    store.set({ [KEYS.autoLockMinutes]: normalizeAutoLockMinutes(minutes) }, resolve);
  });
}

export async function getPersistUnlockSession(): Promise<boolean> {
  const store = chromeStorage();
  if (!store) return false;
  return new Promise((resolve) => {
    store.get(KEYS.persistUnlockSession, (result) => {
      resolve(result[KEYS.persistUnlockSession] === true);
    });
  });
}

export async function setPersistUnlockSession(enabled: boolean): Promise<void> {
  const store = chromeStorage();
  if (!store) return;
  return new Promise((resolve) => {
    store.set({ [KEYS.persistUnlockSession]: enabled === true }, resolve);
  });
}

// ── Display currency settings ────────────────────────────────────────────────

export async function getDisplayCurrency(): Promise<DisplayCurrency> {
  const store = chromeStorage();
  if (!store) return DEFAULT_DISPLAY_CURRENCY;
  return new Promise((resolve) => {
    store.get(KEYS.displayCurrency, (result) => {
      resolve(normalizeDisplayCurrency(result[KEYS.displayCurrency]));
    });
  });
}

export async function setDisplayCurrency(currency: DisplayCurrency): Promise<void> {
  const store = chromeStorage();
  if (!store) return;
  return new Promise((resolve) => {
    store.set({ [KEYS.displayCurrency]: normalizeDisplayCurrency(currency) }, resolve);
  });
}

// ── Privacy settings ─────────────────────────────────────────────────────────

export async function getHidePortfolioBalances(): Promise<boolean> {
  const store = chromeStorage();
  if (!store) return false;
  return new Promise((resolve) => {
    store.get(KEYS.hidePortfolioBalances, (result) => {
      resolve(result[KEYS.hidePortfolioBalances] === true);
    });
  });
}

export async function setHidePortfolioBalances(hide: boolean): Promise<void> {
  const store = chromeStorage();
  if (!store) return;
  return new Promise((resolve) => {
    store.set({ [KEYS.hidePortfolioBalances]: hide === true }, resolve);
  });
}

// ── Custom Kaspa RPC endpoint overrides ─────────────────────────────────────

export async function getKaspaRpcProviderPresetMap(): Promise<Record<string, KaspaRpcProviderPreset>> {
  const store = chromeStorage();
  if (!store) return {};
  return new Promise((resolve) => {
    store.get(KEYS.kaspaRpcProviderPresetMap, (result) => {
      try {
        const raw = result[KEYS.kaspaRpcProviderPresetMap];
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        resolve(normalizeKaspaRpcProviderPresetMap(parsed));
      } catch {
        resolve({});
      }
    });
  });
}

export async function getKaspaRpcProviderPreset(network: string): Promise<KaspaRpcProviderPreset> {
  const key = String(network || "").trim();
  if (!key) return DEFAULT_KASPA_RPC_PROVIDER_PRESET;
  const map = await getKaspaRpcProviderPresetMap();
  return map[key] ?? DEFAULT_KASPA_RPC_PROVIDER_PRESET;
}

export async function setKaspaRpcProviderPreset(
  network: string,
  preset: KaspaRpcProviderPreset,
): Promise<void> {
  const store = chromeStorage();
  if (!store) return;
  const key = String(network || "").trim();
  if (!key) return;

  const map = await getKaspaRpcProviderPresetMap();
  map[key] = normalizeKaspaRpcProviderPreset(preset);

  return new Promise((resolve) => {
    store.set({ [KEYS.kaspaRpcProviderPresetMap]: JSON.stringify(map) }, resolve);
  });
}

export async function getCustomKaspaRpcMap(): Promise<Record<string, string>> {
  const store = chromeStorage();
  if (!store) return {};
  return new Promise((resolve) => {
    store.get(KEYS.customKaspaRpcMap, (result) => {
      try {
        const raw = result[KEYS.customKaspaRpcMap];
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        resolve(normalizeKaspaRpcMap(parsed));
      } catch {
        resolve({});
      }
    });
  });
}

export async function getCustomKaspaRpc(network: string): Promise<string | null> {
  const key = String(network || "").trim();
  if (!key) return null;
  const map = await getCustomKaspaRpcMap();
  return map[key] ?? null;
}

export async function setCustomKaspaRpc(network: string, endpoint: string | null): Promise<void> {
  const store = chromeStorage();
  if (!store) return;
  const key = String(network || "").trim();
  if (!key) return;

  const map = await getCustomKaspaRpcMap();

  if (endpoint === null || endpoint.trim() === "") {
    delete map[key];
  } else {
    const normalized = normalizeKaspaRpcEndpoint(endpoint);
    if (!normalized) throw new Error("INVALID_RPC_ENDPOINT");
    map[key] = normalized;
  }

  return new Promise((resolve) => {
    store.set({ [KEYS.customKaspaRpcMap]: JSON.stringify(map) }, resolve);
  });
}

export async function getKaspaRpcPoolOverrideMap(): Promise<Record<string, KaspaRpcPoolOverrideEntry>> {
  const store = chromeStorage();
  if (!store) return {};
  return new Promise((resolve) => {
    store.get(KEYS.kaspaRpcPoolOverrideMap, (result) => {
      try {
        const raw = result[KEYS.kaspaRpcPoolOverrideMap];
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        resolve(normalizeKaspaRpcPoolOverrideMap(parsed));
      } catch {
        resolve({});
      }
    });
  });
}

export async function getKaspaRpcPoolOverride(
  network: string,
  preset: KaspaRpcPoolOverridePreset,
): Promise<string[]> {
  const key = String(network || "").trim();
  if (!key) return [];
  const map = await getKaspaRpcPoolOverrideMap();
  return map[key]?.[preset] ? [...(map[key]?.[preset] || [])] : [];
}

export async function setKaspaRpcPoolOverride(
  network: string,
  preset: KaspaRpcPoolOverridePreset,
  endpoints: string[] | null,
): Promise<void> {
  const store = chromeStorage();
  if (!store) return;
  const key = String(network || "").trim();
  if (!key) return;

  const map = await getKaspaRpcPoolOverrideMap();
  const current = map[key] ? { ...map[key] } : {};
  const normalized = normalizeKaspaRpcPool(endpoints);

  if (normalized.length > 0) {
    current[preset] = normalized;
  } else {
    delete current[preset];
  }

  if (!current.official && !current.igra && !current.kasplex) {
    delete map[key];
  } else {
    map[key] = current;
  }

  return new Promise((resolve) => {
    store.set({ [KEYS.kaspaRpcPoolOverrideMap]: JSON.stringify(map) }, resolve);
  });
}

// ── Local node mode settings ────────────────────────────────────────────────

export async function getLocalNodeEnabled(): Promise<boolean> {
  const store = chromeStorage();
  if (!store) return false;
  return new Promise((resolve) => {
    store.get(KEYS.localNodeEnabled, (result) => {
      resolve(result[KEYS.localNodeEnabled] === true);
    });
  });
}

export async function setLocalNodeEnabled(enabled: boolean): Promise<void> {
  const store = chromeStorage();
  if (!store) return;
  return new Promise((resolve) => {
    store.set({ [KEYS.localNodeEnabled]: enabled === true }, resolve);
  });
}

export async function getLocalNodeNetworkProfile(): Promise<LocalNodeNetworkProfile> {
  const store = chromeStorage();
  if (!store) return "mainnet";
  return new Promise((resolve) => {
    store.get(KEYS.localNodeNetworkProfile, (result) => {
      resolve(normalizeLocalNodeNetworkProfile(result[KEYS.localNodeNetworkProfile]));
    });
  });
}

export async function setLocalNodeNetworkProfile(profile: string): Promise<void> {
  const store = chromeStorage();
  if (!store) return;
  const normalized = normalizeLocalNodeNetworkProfile(profile);
  return new Promise((resolve) => {
    store.set({ [KEYS.localNodeNetworkProfile]: normalized }, resolve);
  });
}

export async function getLocalNodeDataDir(): Promise<string | null> {
  const store = chromeStorage();
  if (!store) return null;
  return new Promise((resolve) => {
    store.get(KEYS.localNodeDataDir, (result) => {
      const raw = result[KEYS.localNodeDataDir];
      resolve(typeof raw === "string" && raw.trim() ? raw.trim() : null);
    });
  });
}

export async function setLocalNodeDataDir(pathValue: string | null): Promise<void> {
  const store = chromeStorage();
  if (!store) return;
  const normalized = typeof pathValue === "string" && pathValue.trim() ? pathValue.trim() : "";
  return new Promise((resolve) => {
    if (!normalized) {
      store.remove(KEYS.localNodeDataDir, resolve);
      return;
    }
    store.set({ [KEYS.localNodeDataDir]: normalized }, resolve);
  });
}

// ── Legacy shim ───────────────────────────────────────────────────────────────
// Kept for backward compatibility during migration. Remove after one release cycle.

/** @deprecated Use getWalletMeta() — phrase field is always undefined. */
export interface ManagedWallet {
  address: string;
  network: string;
  phrase?: never; // Explicitly forbidden — phrase lives in the vault only
}

/** @deprecated Use getWalletMeta(). */
export async function getManagedWallet(): Promise<ManagedWallet | null> {
  return getWalletMeta();
}

/** @deprecated Use setWalletMeta(). */
export async function setManagedWallet(data: Pick<ManagedWallet, "address" | "network">): Promise<void> {
  return setWalletMeta(data);
}

/** @deprecated Use resetWallet() from vault/vault.ts for a full wipe. */
export async function clearManagedWallet(): Promise<void> {
  return clearWalletMeta();
}

// ── Per-origin dApp allowlist (B6) ───────────────────────────────────────────

const CONNECTED_SITES_KEY = "forgeos.connected.sites.v1";

export interface ConnectedSite {
  address: string;
  network: string;
  connectedAt: number;
}

function localStoreForSites(): chrome.storage.LocalStorageArea {
  return chrome.storage.local;
}

export async function getConnectedSites(): Promise<Record<string, ConnectedSite>> {
  return new Promise((resolve) => {
    localStoreForSites().get(CONNECTED_SITES_KEY, (result) => {
      const raw = result?.[CONNECTED_SITES_KEY];
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        resolve(raw as Record<string, ConnectedSite>);
      } else {
        resolve({});
      }
    });
  });
}

export async function addConnectedSite(origin: string, site: ConnectedSite): Promise<void> {
  if (!origin) return;
  const sites = await getConnectedSites();
  sites[origin] = site;
  return new Promise((resolve) => {
    localStoreForSites().set({ [CONNECTED_SITES_KEY]: sites }, resolve);
  });
}

export async function removeConnectedSite(origin: string): Promise<void> {
  const sites = await getConnectedSites();
  delete sites[origin];
  return new Promise((resolve) => {
    localStoreForSites().set({ [CONNECTED_SITES_KEY]: sites }, resolve);
  });
}

export async function clearConnectedSites(): Promise<void> {
  return new Promise((resolve) => {
    localStoreForSites().remove(CONNECTED_SITES_KEY, resolve);
  });
}
