// Swap types — live-ready configuration surface for extension swap routing.
// Environment vars can still disable/override route behavior per deployment.

import type { TokenId } from "../tokens/types";

export type SwapRouteSource = "blocked" | "kaspa_native" | "evm_0x";
export type KaspaTokenStandard = "krc20" | "krc721";

export interface SwapCustomToken {
  address: string;
  standard: KaspaTokenStandard;
  symbol: string;
  name: string;
  decimals: number;
  logoUri: string;
}

export interface SwapRequest {
  tokenIn: TokenId;
  tokenOut: TokenId;
  amountIn: bigint;       // In token's smallest unit
  slippageBps: number;    // Basis points (50 = 0.5%)
  /** Optional custom KRC token output resolved from pasted token address. */
  customTokenOut?: SwapCustomToken | null;
}

export interface SwapQuote {
  tokenIn: TokenId;
  tokenOut: TokenId;
  amountIn: bigint;
  amountOut: bigint;      // Expected output after slippage
  priceImpact: number;    // Fraction (0.01 = 1%)
  fee: bigint;            // Protocol fee
  route: string[];        // DEX routing path
  validUntil: number;     // Unix ms — quote expires after this
  dexEndpoint: string;
  routeSource?: SwapRouteSource;
  transaction?: {
    to: string;
    data: string;
    value: string;
  };
  allowanceSpender?: string;
  rawQuote?: unknown;
  customTokenOut?: SwapCustomToken | null;
}

export interface SwapConfig {
  enabled: boolean;
  routeSource: SwapRouteSource;
  maxSlippageBps: number; // Hard cap — UI enforces this
  defaultSlippageBps: number;
  dexEndpoint: string | null;
  evmChainIdAllowlist: number[];
  requireExternalEvmSigner: boolean;
  zeroExQuoteEndpoint: string | null;
  zeroExApiKey: string;
  zeroExExpectedSettlerTo: string;
  zeroExExpectedAllowanceSpender: string;
  settlementRequiredConfirmations: number;
  settlementPollIntervalMs: number;
  settlementTimeoutMs: number;
}

const ENV = (import.meta as any)?.env ?? {};

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = ENV?.[name];
  if (typeof raw !== "string") return fallback;
  if (raw.trim().toLowerCase() === "true") return true;
  if (raw.trim().toLowerCase() === "false") return false;
  return fallback;
}

function readNumberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = ENV?.[name];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function readCsvIntEnv(name: string, fallback: number[]): number[] {
  const raw = String(ENV?.[name] ?? "").trim();
  if (!raw) return fallback;
  const parsed = raw
    .split(/[,\s]+/)
    .map((v: string) => Number(v))
    .filter((v: number) => Number.isInteger(v) && v > 0);
  const deduped = [...new Set(parsed)];
  return deduped.length ? deduped : fallback;
}

function readRouteSourceEnv(name: string, fallback: SwapRouteSource): SwapRouteSource {
  const raw = String(ENV?.[name] ?? "").trim().toLowerCase();
  if (raw === "kaspa_native" || raw === "evm_0x" || raw === "blocked") return raw;
  return fallback;
}

export const SWAP_CONFIG: SwapConfig = {
  enabled: readBooleanEnv("VITE_SWAP_ENABLED", true),
  routeSource: readRouteSourceEnv("VITE_SWAP_ROUTE_SOURCE", "kaspa_native"),
  maxSlippageBps: readNumberEnv("VITE_SWAP_MAX_SLIPPAGE_BPS", 500, 1, 2_000),
  defaultSlippageBps: readNumberEnv("VITE_SWAP_DEFAULT_SLIPPAGE_BPS", 50, 1, 2_000),
  dexEndpoint: String(ENV?.VITE_SWAP_DEX_ENDPOINT ?? "").trim() || null,
  evmChainIdAllowlist: readCsvIntEnv("VITE_SWAP_EVM_CHAIN_IDS", [1]),
  requireExternalEvmSigner: readBooleanEnv("VITE_SWAP_REQUIRE_EXTERNAL_EVM_SIGNER", true),
  zeroExQuoteEndpoint:
    String(ENV?.VITE_SWAP_ZEROX_QUOTE_ENDPOINT ?? "https://api.0x.org/swap/allowance-holder/quote").trim() || null,
  zeroExApiKey: String(ENV?.VITE_SWAP_ZEROX_API_KEY ?? "").trim(),
  zeroExExpectedSettlerTo: String(ENV?.VITE_SWAP_ZEROX_EXPECTED_SETTLER_TO ?? "").trim(),
  zeroExExpectedAllowanceSpender: String(ENV?.VITE_SWAP_ZEROX_EXPECTED_ALLOWANCE_SPENDER ?? "").trim(),
  settlementRequiredConfirmations: readNumberEnv("VITE_SWAP_SETTLEMENT_CONFIRMATIONS", 2, 1, 128),
  settlementPollIntervalMs: readNumberEnv("VITE_SWAP_SETTLEMENT_POLL_MS", 4_000, 500, 60_000),
  settlementTimeoutMs: readNumberEnv("VITE_SWAP_SETTLEMENT_TIMEOUT_MS", 240_000, 15_000, 3_600_000),
};
