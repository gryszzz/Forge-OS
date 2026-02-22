import { resolveKaspaNetwork } from "./kaspa/network";
import { normalizeKaspaAddress } from "./helpers";

const env = import.meta.env;

function runtimeNetworkOverride() {
  if (typeof window === "undefined") return "";
  const fromQuery = new URLSearchParams(window.location.search).get("network");
  if (fromQuery) return fromQuery;
  try {
    // Mainnet-first UX: ignore stale persisted network overrides from prior sessions.
    // Runtime switching is still supported via `?network=...` and the topbar selector.
    if (window.localStorage.getItem("forgeos.network")) {
      window.localStorage.removeItem("forgeos.network");
    }
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
  return "";
}

const RUNTIME_NETWORK_OVERRIDE = runtimeNetworkOverride();
const ACTIVE_NETWORK = RUNTIME_NETWORK_OVERRIDE || env.VITE_KAS_NETWORK || "mainnet";
export const NETWORK_PROFILE = resolveKaspaNetwork(ACTIVE_NETWORK);
export const DEFAULT_NETWORK = NETWORK_PROFILE.id;
const IS_TESTNET = DEFAULT_NETWORK.startsWith("testnet");
export const NETWORK_LABEL = RUNTIME_NETWORK_OVERRIDE
  ? NETWORK_PROFILE.label
  : (env.VITE_KAS_NETWORK_LABEL || NETWORK_PROFILE.label);
export const ALLOWED_ADDRESS_PREFIXES = NETWORK_PROFILE.addressPrefixes;

function parseCsv(raw: string | undefined) {
  return String(raw || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeEndpoint(url: string | undefined) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function pickByNetwork(mainnetValue: string | undefined, testnetValue: string | undefined, legacyValue: string | undefined) {
  const scopedValue = IS_TESTNET ? testnetValue : mainnetValue;
  return String(scopedValue || legacyValue || "").trim();
}

const KAS_API_SCOPED = pickByNetwork(env.VITE_KAS_API_MAINNET, env.VITE_KAS_API_TESTNET, env.VITE_KAS_API);
export const KAS_API = normalizeEndpoint(KAS_API_SCOPED || (IS_TESTNET ? "https://api-tn10.kaspa.org" : "https://api.kaspa.org"));

const KAS_API_FALLBACKS_SCOPED = pickByNetwork(
  env.VITE_KAS_API_FALLBACKS_MAINNET,
  env.VITE_KAS_API_FALLBACKS_TESTNET,
  env.VITE_KAS_API_FALLBACKS
);
export const KAS_API_FALLBACKS = parseCsv(KAS_API_FALLBACKS_SCOPED)
  .map((entry) => normalizeEndpoint(entry))
  .filter((entry) => entry && entry !== KAS_API);

const EXPLORER_SCOPED = pickByNetwork(
  env.VITE_KAS_EXPLORER_MAINNET,
  env.VITE_KAS_EXPLORER_TESTNET,
  env.VITE_KAS_EXPLORER
);
export const EXPLORER = normalizeEndpoint(
  EXPLORER_SCOPED || (IS_TESTNET ? "https://explorer-tn10.kaspa.org" : "https://explorer.kaspa.org")
);

export const KAS_WS_URL = pickByNetwork(env.VITE_KAS_WS_URL_MAINNET, env.VITE_KAS_WS_URL_TESTNET, env.VITE_KAS_WS_URL);
export const KASPIUM_DEEP_LINK_SCHEME = env.VITE_KASPIUM_DEEP_LINK_SCHEME || "kaspium://";
export const ENFORCE_WALLET_NETWORK = String(env.VITE_KAS_ENFORCE_WALLET_NETWORK || "true").toLowerCase() !== "false";
export const ACCUMULATE_ONLY = String(env.VITE_ACCUMULATE_ONLY || "true").toLowerCase() !== "false";

const KAS_API_ALL = [KAS_API, ...KAS_API_FALLBACKS]
  .map((value) => String(value || "").trim())
  .filter(Boolean);
const HAS_DUPLICATE_KAS_API_ENDPOINTS = new Set(KAS_API_ALL).size !== KAS_API_ALL.length;
if (HAS_DUPLICATE_KAS_API_ENDPOINTS) {
  throw new Error("Duplicate Kaspa API endpoints detected in VITE_KAS_API* configuration.");
}

function requireKaspaAddress(value: string, allowedPrefixes: string[], label: string) {
  try {
    return normalizeKaspaAddress(value, allowedPrefixes);
  } catch {
    throw new Error(`Invalid ${label}. Expected prefixes: ${allowedPrefixes.join(", ")}`);
  }
}

const MAINNET_TREASURY_RAW =
  env.VITE_TREASURY_ADDRESS_MAINNET || "kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85";
const TESTNET_TREASURY_RAW =
  env.VITE_TREASURY_ADDRESS_TESTNET || "kaspatest:qpqz2vxj23kvh0m73ta2jjn2u4cv4tlufqns2eap8mxyyt0rvrxy6ejkful67";
const MAINNET_TREASURY = requireKaspaAddress(MAINNET_TREASURY_RAW, ["kaspa"], "VITE_TREASURY_ADDRESS_MAINNET");
const TESTNET_TREASURY = requireKaspaAddress(TESTNET_TREASURY_RAW, ["kaspatest"], "VITE_TREASURY_ADDRESS_TESTNET");

const MAINNET_ACCUMULATION_RAW = env.VITE_ACCUMULATION_ADDRESS_MAINNET || MAINNET_TREASURY;
const TESTNET_ACCUMULATION_RAW = env.VITE_ACCUMULATION_ADDRESS_TESTNET || TESTNET_TREASURY;
const MAINNET_ACCUMULATION = requireKaspaAddress(
  MAINNET_ACCUMULATION_RAW,
  ["kaspa"],
  "VITE_ACCUMULATION_ADDRESS_MAINNET"
);
const TESTNET_ACCUMULATION = requireKaspaAddress(
  TESTNET_ACCUMULATION_RAW,
  ["kaspatest"],
  "VITE_ACCUMULATION_ADDRESS_TESTNET"
);

const DEMO_MAINNET_RAW = env.VITE_DEMO_ADDRESS_MAINNET || MAINNET_TREASURY;
const DEMO_TESTNET_RAW = env.VITE_DEMO_ADDRESS_TESTNET || TESTNET_TREASURY;
export const DEMO_ADDRESS_MAINNET = requireKaspaAddress(DEMO_MAINNET_RAW, ["kaspa"], "VITE_DEMO_ADDRESS_MAINNET");
export const DEMO_ADDRESS_TESTNET = requireKaspaAddress(DEMO_TESTNET_RAW, ["kaspatest"], "VITE_DEMO_ADDRESS_TESTNET");
export const DEMO_ADDRESS = IS_TESTNET ? DEMO_ADDRESS_TESTNET : DEMO_ADDRESS_MAINNET;

export const TREASURY = IS_TESTNET ? TESTNET_TREASURY : MAINNET_TREASURY;
export const ACCUMULATION_VAULT = IS_TESTNET ? TESTNET_ACCUMULATION : MAINNET_ACCUMULATION;
export const FEE_RATE = Number(env.VITE_FEE_RATE || 0.20);       // KAS per execution cycle
export const TREASURY_SPLIT = Number(env.VITE_TREASURY_SPLIT || 0.30); // 30% of fees to treasury
export const AGENT_SPLIT = Number((1 - TREASURY_SPLIT).toFixed(2));    // remaining % to agent pool
export const RESERVE  = 0.50;
export const NET_FEE  = 0.0002;
export const CONF_THRESHOLD = 0.75;
export const FREE_CYCLES_PER_DAY = Number(env.VITE_FREE_CYCLES_PER_DAY || 30);
export const BILLING_UPGRADE_URL = String(env.VITE_BILLING_UPGRADE_URL || "").trim();
export const BILLING_CONTACT = String(env.VITE_BILLING_CONTACT || "").trim();
export const AUTO_CYCLE_SECONDS = Number(env.VITE_AUTO_CYCLE_SECONDS || 120);
export const LIVE_EXECUTION_DEFAULT = String(env.VITE_LIVE_EXECUTION_DEFAULT || "false").toLowerCase() === "true";

if (!Number.isFinite(FEE_RATE) || FEE_RATE < 0) {
  throw new Error("Invalid VITE_FEE_RATE. Expected a non-negative numeric value.");
}

if (!Number.isFinite(TREASURY_SPLIT) || TREASURY_SPLIT < 0 || TREASURY_SPLIT > 1) {
  throw new Error("Invalid VITE_TREASURY_SPLIT. Expected a value between 0 and 1.");
}

if (!Number.isFinite(FREE_CYCLES_PER_DAY) || FREE_CYCLES_PER_DAY < 1) {
  throw new Error("Invalid VITE_FREE_CYCLES_PER_DAY. Expected an integer >= 1.");
}

if (!Number.isFinite(AUTO_CYCLE_SECONDS) || AUTO_CYCLE_SECONDS < 15) {
  throw new Error("Invalid VITE_AUTO_CYCLE_SECONDS. Expected a numeric value >= 15.");
}
