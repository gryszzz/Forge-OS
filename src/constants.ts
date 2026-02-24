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

export const MAINNET_TREASURY_LOCK_ADDRESS =
  "kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85";

const MAINNET_TREASURY_RAW =
  env.VITE_TREASURY_ADDRESS_MAINNET || MAINNET_TREASURY_LOCK_ADDRESS;
const TESTNET_TREASURY_RAW =
  env.VITE_TREASURY_ADDRESS_TESTNET || "kaspatest:qpqz2vxj23kvh0m73ta2jjn2u4cv4tlufqns2eap8mxyyt0rvrxy6ejkful67";
const MAINNET_TREASURY = requireKaspaAddress(MAINNET_TREASURY_RAW, ["kaspa"], "VITE_TREASURY_ADDRESS_MAINNET");
const TESTNET_TREASURY = requireKaspaAddress(TESTNET_TREASURY_RAW, ["kaspatest"], "VITE_TREASURY_ADDRESS_TESTNET");
if (MAINNET_TREASURY !== MAINNET_TREASURY_LOCK_ADDRESS) {
  throw new Error(
    `Mainnet treasury address is pinned and must be ${MAINNET_TREASURY_LOCK_ADDRESS}.`
  );
}

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
export const TREASURY_FEE_ONCHAIN_ENABLED =
  String(env.VITE_TREASURY_FEE_ONCHAIN_ENABLED || "true").toLowerCase() !== "false";
export const RESERVE  = 0.50;
// Kaspa mainnet fee rate is 10 sompi/gram (up from the historical 1 sompi/gram).
// A typical 1-in 2-out tx is ~1500 grams → 15 000 sompi ≈ 0.00015 KAS.
// We round up to 0.001 KAS to ensure faster inclusion and account for larger txs.
export const NET_FEE  = 0.001;
// Explicit fee-rate constant used by wallet providers that accept it (e.g. Kasware v2+).
export const KASPA_FEE_RATE_SOMPI_PER_GRAM = 10;
export const CONF_THRESHOLD = 0.75;
export const FREE_CYCLES_PER_DAY = Number(env.VITE_FREE_CYCLES_PER_DAY || 9999);
export const BILLING_UPGRADE_URL = String(env.VITE_BILLING_UPGRADE_URL || "").trim();
export const BILLING_CONTACT = String(env.VITE_BILLING_CONTACT || "").trim();
export const AUTO_CYCLE_SECONDS = Number(env.VITE_AUTO_CYCLE_SECONDS || 120);
export const LIVE_EXECUTION_DEFAULT = String(env.VITE_LIVE_EXECUTION_DEFAULT || "false").toLowerCase() === "true";
export const PNL_REALIZED_MIN_CONFIRMATIONS = Math.max(
  1,
  Math.round(Number(env.VITE_PNL_REALIZED_MIN_CONFIRMATIONS || 1))
);

function parseJsonObjectEnv(raw: string | undefined, label: string) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object.");
    }
    return parsed as Record<string, any>;
  } catch (err: any) {
    throw new Error(`Invalid ${label}: ${String(err?.message || err || "json_parse_error")}`);
  }
}

const DEFAULT_PNL_REALIZED_CONFIRMATION_POLICY = {
  base: PNL_REALIZED_MIN_CONFIRMATIONS,
  byAction: {
    REDUCE: Math.max(PNL_REALIZED_MIN_CONFIRMATIONS, PNL_REALIZED_MIN_CONFIRMATIONS + 1),
    REBALANCE: Math.max(PNL_REALIZED_MIN_CONFIRMATIONS, PNL_REALIZED_MIN_CONFIRMATIONS + 1),
  },
  byRisk: {
    HIGH: Math.max(PNL_REALIZED_MIN_CONFIRMATIONS, PNL_REALIZED_MIN_CONFIRMATIONS + 1),
  },
  amountTiersKas: [] as Array<{ minAmountKas: number; minConfirmations: number }>,
};

const PNL_REALIZED_CONFIRMATION_POLICY_RAW = parseJsonObjectEnv(
  env.VITE_PNL_REALIZED_CONFIRMATION_POLICY_JSON,
  "VITE_PNL_REALIZED_CONFIRMATION_POLICY_JSON"
);
export const PNL_REALIZED_CONFIRMATION_POLICY = PNL_REALIZED_CONFIRMATION_POLICY_RAW
  ? {
      ...DEFAULT_PNL_REALIZED_CONFIRMATION_POLICY,
      ...PNL_REALIZED_CONFIRMATION_POLICY_RAW,
      byAction: {
        ...DEFAULT_PNL_REALIZED_CONFIRMATION_POLICY.byAction,
        ...(typeof PNL_REALIZED_CONFIRMATION_POLICY_RAW.byAction === "object" &&
        !Array.isArray(PNL_REALIZED_CONFIRMATION_POLICY_RAW.byAction)
          ? PNL_REALIZED_CONFIRMATION_POLICY_RAW.byAction
          : {}),
      },
      byRisk: {
        ...DEFAULT_PNL_REALIZED_CONFIRMATION_POLICY.byRisk,
        ...(typeof PNL_REALIZED_CONFIRMATION_POLICY_RAW.byRisk === "object" &&
        !Array.isArray(PNL_REALIZED_CONFIRMATION_POLICY_RAW.byRisk)
          ? PNL_REALIZED_CONFIRMATION_POLICY_RAW.byRisk
          : {}),
      },
      amountTiersKas: Array.isArray(PNL_REALIZED_CONFIRMATION_POLICY_RAW.amountTiersKas)
        ? PNL_REALIZED_CONFIRMATION_POLICY_RAW.amountTiersKas
        : DEFAULT_PNL_REALIZED_CONFIRMATION_POLICY.amountTiersKas,
    }
  : DEFAULT_PNL_REALIZED_CONFIRMATION_POLICY;

export const RECEIPT_CONSISTENCY_CONFIRM_TS_TOLERANCE_MS = Math.max(
  0,
  Number(env.VITE_RECEIPT_CONSISTENCY_CONFIRM_TS_TOLERANCE_MS || 15000)
);
export const RECEIPT_CONSISTENCY_FEE_KAS_TOLERANCE = Math.max(
  0,
  Number(env.VITE_RECEIPT_CONSISTENCY_FEE_KAS_TOLERANCE || 0.001)
);
export const RECEIPT_CONSISTENCY_SLIPPAGE_KAS_TOLERANCE = Math.max(
  0,
  Number(env.VITE_RECEIPT_CONSISTENCY_SLIPPAGE_KAS_TOLERANCE || 0.02)
);
export const RECEIPT_CONSISTENCY_REPEAT_ALERT_THRESHOLD = Math.max(
  2,
  Math.round(Number(env.VITE_RECEIPT_CONSISTENCY_REPEAT_ALERT_THRESHOLD || 3))
);
export const RECEIPT_CONSISTENCY_DEGRADE_MIN_CHECKS = Math.max(
  1,
  Math.round(Number(env.VITE_RECEIPT_CONSISTENCY_DEGRADE_MIN_CHECKS || 6))
);
export const RECEIPT_CONSISTENCY_DEGRADE_MISMATCH_RATE_PCT = Math.max(
  0,
  Math.min(100, Number(env.VITE_RECEIPT_CONSISTENCY_DEGRADE_MISMATCH_RATE_PCT || 20))
);
export const RECEIPT_CONSISTENCY_BLOCK_AUTO_APPROVE_ON_DEGRADED =
  String(env.VITE_RECEIPT_CONSISTENCY_BLOCK_AUTO_APPROVE_ON_DEGRADED || "true").toLowerCase() !== "false";

export const CALIBRATION_GUARDRAILS_ENABLED =
  String(env.VITE_CALIBRATION_GUARDRAILS_ENABLED || "true").toLowerCase() !== "false";
export const CALIBRATION_MIN_SAMPLES = Math.max(
  1,
  Math.round(Number(env.VITE_CALIBRATION_MIN_SAMPLES || 12))
);
export const CALIBRATION_BRIER_WARN = Math.max(0, Number(env.VITE_CALIBRATION_BRIER_WARN || 0.24));
export const CALIBRATION_BRIER_CRITICAL = Math.max(
  CALIBRATION_BRIER_WARN,
  Number(env.VITE_CALIBRATION_BRIER_CRITICAL || 0.34)
);
export const CALIBRATION_EV_CAL_ERROR_WARN_PCT = Math.max(
  0,
  Number(env.VITE_CALIBRATION_EV_CAL_ERROR_WARN_PCT || 2.0)
);
export const CALIBRATION_EV_CAL_ERROR_CRITICAL_PCT = Math.max(
  CALIBRATION_EV_CAL_ERROR_WARN_PCT,
  Number(env.VITE_CALIBRATION_EV_CAL_ERROR_CRITICAL_PCT || 5.0)
);
export const CALIBRATION_REGIME_HIT_MIN_PCT = Math.max(
  0,
  Math.min(100, Number(env.VITE_CALIBRATION_REGIME_HIT_MIN_PCT || 55))
);
export const CALIBRATION_REGIME_HIT_CRITICAL_PCT = Math.max(
  0,
  Math.min(CALIBRATION_REGIME_HIT_MIN_PCT, Number(env.VITE_CALIBRATION_REGIME_HIT_CRITICAL_PCT || 46))
);
export const CALIBRATION_SIZE_MULTIPLIER_WARN = Math.max(
  0,
  Math.min(1, Number(env.VITE_CALIBRATION_SIZE_MULTIPLIER_WARN || 0.85))
);
export const CALIBRATION_SIZE_MULTIPLIER_DEGRADED = Math.max(
  0,
  Math.min(CALIBRATION_SIZE_MULTIPLIER_WARN, Number(env.VITE_CALIBRATION_SIZE_MULTIPLIER_DEGRADED || 0.6))
);
export const CALIBRATION_SIZE_MULTIPLIER_CRITICAL = Math.max(
  0,
  Math.min(CALIBRATION_SIZE_MULTIPLIER_DEGRADED, Number(env.VITE_CALIBRATION_SIZE_MULTIPLIER_CRITICAL || 0.35))
);
export const CALIBRATION_AUTO_APPROVE_DISABLE_HEALTH_BELOW = Math.max(
  0,
  Math.min(1, Number(env.VITE_CALIBRATION_AUTO_APPROVE_DISABLE_HEALTH_BELOW || 0.4))
);
export const CALIBRATION_AUTO_APPROVE_DISABLE_MIN_SIZE_REDUCTION_PCT = Math.max(
  0,
  Math.min(0.95, Number(env.VITE_CALIBRATION_AUTO_APPROVE_DISABLE_MIN_SIZE_REDUCTION_PCT || 0.1))
);

if (!Number.isFinite(FEE_RATE) || FEE_RATE < 0) {
  throw new Error("Invalid VITE_FEE_RATE. Expected a non-negative numeric value.");
}

if (!Number.isFinite(TREASURY_SPLIT) || TREASURY_SPLIT < 0 || TREASURY_SPLIT > 1) {
  throw new Error("Invalid VITE_TREASURY_SPLIT. Expected a value between 0 and 1.");
}

export const TREASURY_FEE_KAS = Number((FEE_RATE * TREASURY_SPLIT).toFixed(6));

// High-Frequency Trading Configuration
export const HF_MODE = String(env.VITE_HF_MODE || "false").toLowerCase() === "true";
export const HF_MIN_CYCLE_SECONDS = 15;  // Minimum cycle time for high-frequency
export const HF_MAX_CYCLES_PER_HOUR = 240;  // Max 1 cycle every 15 seconds
export const HF_PROFIT_TARGET_PCT = Number(env.VITE_HF_PROFIT_TARGET_PCT || 0.5);  // 0.5% profit target
export const HF_STOP_LOSS_PCT = Number(env.VITE_HF_STOP_LOSS_PCT || 2.0);  // 2% stop loss
export const HF_MIN_TRADE_SIZE_KAS = Number(env.VITE_HF_MIN_TRADE_SIZE_KAS || 1);  // Minimum trade size
export const HF_MAX_DAILY_TRADES = Number(env.VITE_HF_MAX_DAILY_TRADES || 100);  // Max trades per day

if (!Number.isFinite(FREE_CYCLES_PER_DAY) || FREE_CYCLES_PER_DAY < 1) {
  throw new Error("Invalid VITE_FREE_CYCLES_PER_DAY. Expected an integer >= 1.");
}

if (!Number.isFinite(AUTO_CYCLE_SECONDS) || AUTO_CYCLE_SECONDS < HF_MIN_CYCLE_SECONDS) {
  throw new Error(`Invalid VITE_AUTO_CYCLE_SECONDS. Expected a numeric value >= ${HF_MIN_CYCLE_SECONDS}.`);
}

if (!Number.isFinite(PNL_REALIZED_MIN_CONFIRMATIONS) || PNL_REALIZED_MIN_CONFIRMATIONS < 1) {
  throw new Error("Invalid VITE_PNL_REALIZED_MIN_CONFIRMATIONS. Expected an integer >= 1.");
}
