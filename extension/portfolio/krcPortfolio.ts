import { resolveTokenFromAddress } from "../swap/tokenResolver";
import type { KaspaTokenStandard, SwapCustomToken } from "../swap/types";
import type {
  KrcCandlePoint,
  KrcChainStatsSnapshot,
  KrcMarketSnapshot,
  KrcPortfolioToken,
} from "./types";

const ENV = (import.meta as any)?.env ?? {};

const HOLDINGS_TTL_DEFAULT_MS = 10_000;
const PRICE_TTL_DEFAULT_MS = 1_500;
const CHAIN_TTL_DEFAULT_MS = 30_000;
const CANDLES_TTL_DEFAULT_MS = 30_000;
const KRC_CANDLE_FETCH_LIMIT_DEFAULT = 120;
const KRC721_CANDLE_FETCH_LIMIT_DEFAULT = 360;
const KRC_CANDLE_POINT_MAX_DEFAULT = 120;
const KRC721_CANDLE_POINT_MAX_DEFAULT = 360;
const PREFETCH_MAX_AGE_MS = 5 * 60_000;
const PREFETCH_MAX_ENTRIES = 6;
const PREFETCH_STORAGE_KEY = "forgeos.krc.prefetch.v1";
const REQUEST_TIMEOUT_MS = 3_500;
const HOT_TOKEN_LIMIT = 24;

const endpointHealth = new Map<
  string,
  {
    score: number;
    failures: number;
    backoffUntil: number;
  }
>();

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  usedAt: number;
};

const holdingsCache = new Map<string, CacheEntry<Array<{ address: string; standard: KaspaTokenStandard; balanceRaw: string }>>>();
const marketCache = new Map<string, CacheEntry<KrcMarketSnapshot | null>>();
const chainCache = new Map<string, CacheEntry<KrcChainStatsSnapshot | null>>();
const candlesCache = new Map<string, CacheEntry<KrcCandlePoint[]>>();

function parseCsvEnv(name: string): string[] {
  const raw = String(ENV?.[name] ?? "").trim();
  if (!raw) return [];
  return [...new Set(raw.split(/[,\s]+/).map((value) => value.trim().replace(/\/+$/, "")).filter(Boolean))];
}

function parseIntEnv(name: string, fallback: number): number {
  const value = Number(ENV?.[name]);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function holdingsTtlMs(): number {
  return clamp(parseIntEnv("VITE_KRC_HOLDINGS_TTL_MS", HOLDINGS_TTL_DEFAULT_MS), 5_000, 15_000);
}

function priceTtlMs(): number {
  return clamp(parseIntEnv("VITE_KRC_PRICE_TTL_MS", PRICE_TTL_DEFAULT_MS), 1_000, 2_000);
}

function chainTtlMs(): number {
  return clamp(parseIntEnv("VITE_KRC_CHAIN_TTL_MS", CHAIN_TTL_DEFAULT_MS), 15_000, 60_000);
}

function candlesTtlMs(): number {
  return clamp(parseIntEnv("VITE_KRC_CANDLES_TTL_MS", CANDLES_TTL_DEFAULT_MS), 15_000, 60_000);
}

function candleFetchLimit(standard: KaspaTokenStandard): number {
  const generic = parseIntEnv("VITE_KRC_CANDLE_FETCH_LIMIT", KRC_CANDLE_FETCH_LIMIT_DEFAULT);
  if (standard === "krc721") {
    return clamp(
      parseIntEnv("VITE_KRC721_CANDLE_FETCH_LIMIT", parseIntEnv("VITE_KRC_CANDLE_FETCH_LIMIT", KRC721_CANDLE_FETCH_LIMIT_DEFAULT)),
      30,
      2_400,
    );
  }
  return clamp(generic, 30, 2_400);
}

function candlePointMax(standard: KaspaTokenStandard): number {
  const generic = parseIntEnv("VITE_KRC_CANDLE_POINT_MAX", KRC_CANDLE_POINT_MAX_DEFAULT);
  if (standard === "krc721") {
    return clamp(
      parseIntEnv("VITE_KRC721_CANDLE_POINT_MAX", parseIntEnv("VITE_KRC_CANDLE_POINT_MAX", KRC721_CANDLE_POINT_MAX_DEFAULT)),
      20,
      2_400,
    );
  }
  return clamp(generic, 20, 2_400);
}

function networkBucket(network: string): "MAINNET" | "TN10" | "TN11" | "TN12" {
  if (network === "testnet-10") return "TN10";
  if (network === "testnet-11") return "TN11";
  if (network === "testnet-12") return "TN12";
  return "MAINNET";
}

function indexerEndpoints(network: string): string[] {
  const bucket = networkBucket(network);
  const explicit = parseCsvEnv("VITE_KRC_INDEXER_ENDPOINTS");
  const scoped = parseCsvEnv(`VITE_KRC_INDEXER_${bucket}_ENDPOINTS`);
  const kasplexScoped = parseCsvEnv(`VITE_KASPA_KASPLEX_${bucket}_API_ENDPOINTS`);
  const kasplex = parseCsvEnv("VITE_KASPA_KASPLEX_API_ENDPOINTS");
  return [...new Set([...explicit, ...scoped, ...kasplexScoped, ...kasplex])];
}

function marketEndpoints(network: string): string[] {
  const bucket = networkBucket(network);
  const explicit = parseCsvEnv("VITE_KRC_MARKET_ENDPOINTS");
  const scoped = parseCsvEnv(`VITE_KRC_MARKET_${bucket}_ENDPOINTS`);
  const fallback = indexerEndpoints(network);
  return [...new Set([...explicit, ...scoped, ...fallback])];
}

function candlesEndpoints(network: string): string[] {
  const bucket = networkBucket(network);
  const explicit = parseCsvEnv("VITE_KRC_CANDLES_ENDPOINTS");
  const scoped = parseCsvEnv(`VITE_KRC_CANDLES_${bucket}_ENDPOINTS`);
  const fallback = marketEndpoints(network);
  return [...new Set([...explicit, ...scoped, ...fallback])];
}

function getEndpointHealth(endpoint: string) {
  let state = endpointHealth.get(endpoint);
  if (!state) {
    state = { score: 100, failures: 0, backoffUntil: 0 };
    endpointHealth.set(endpoint, state);
  }
  return state;
}

function rankEndpoints(endpoints: string[]): string[] {
  const now = Date.now();
  const active: Array<{ endpoint: string; score: number }> = [];
  const backedOff: Array<{ endpoint: string; score: number; backoffUntil: number }> = [];
  for (const endpoint of endpoints) {
    const health = getEndpointHealth(endpoint);
    if (health.backoffUntil > now) backedOff.push({ endpoint, score: health.score, backoffUntil: health.backoffUntil });
    else active.push({ endpoint, score: health.score });
  }
  active.sort((a, b) => b.score - a.score);
  if (active.length > 0) return active.map((item) => item.endpoint);
  backedOff.sort((a, b) => a.backoffUntil - b.backoffUntil || b.score - a.score);
  return backedOff.slice(0, 1).map((item) => item.endpoint);
}

function markEndpointSuccess(endpoint: string, latencyMs: number) {
  const health = getEndpointHealth(endpoint);
  const latencyPenalty = Math.min(25, latencyMs / 200);
  health.score = clamp(Math.round(health.score + 10 - latencyPenalty), 0, 200);
  health.failures = 0;
  health.backoffUntil = 0;
}

function markEndpointFailure(endpoint: string, timeout = false) {
  const health = getEndpointHealth(endpoint);
  health.failures += 1;
  health.score = clamp(health.score - (timeout ? 30 : 18), 0, 200);
  const backoffMs = Math.min(30_000, 1_500 * Math.pow(2, Math.max(0, health.failures - 1)));
  health.backoffUntil = Date.now() + backoffMs;
}

function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  hit.usedAt = Date.now();
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number, maxEntries: number) {
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + ttlMs, usedAt: Date.now() });
  while (cache.size > maxEntries) {
    const first = cache.keys().next().value;
    if (typeof first !== "string") break;
    cache.delete(first);
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function looksLikeTokenAddress(value: string): boolean {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return true;
  return /^[a-zA-Z0-9:_-]{24,}$/.test(raw);
}

function normalizeAddress(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function parseBalanceRaw(input: unknown, fallbackForNft = "1"): string | null {
  if (typeof input === "bigint") return input > 0n ? input.toString() : null;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) return null;
    return Math.floor(input).toString();
  }
  if (typeof input === "string") {
    const raw = input.trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      try {
        const parsed = BigInt(raw);
        return parsed > 0n ? parsed.toString() : null;
      } catch {
        return null;
      }
    }
    if (/^\d+(\.\d+)?$/.test(raw)) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return Math.floor(n).toString();
    }
  }
  return fallbackForNft;
}

function extractObjects(raw: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const root = asObject(raw);
  if (!root) return out;
  out.push(root);
  for (const key of ["data", "result", "items", "tokens", "holdings", "balances", "collections"]) {
    const value = root[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const obj = asObject(item);
        if (obj) out.push(obj);
      }
    } else {
      const nested = asObject(value);
      if (nested) out.push(nested);
    }
  }
  return out;
}

function withTimeout(input: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(input, { method: "GET", signal: controller.signal }).finally(() => clearTimeout(timer));
}

function holdingsPaths(address: string, standard: KaspaTokenStandard): string[] {
  const encoded = encodeURIComponent(address);
  if (standard === "krc721") {
    return [
      `/addresses/${encoded}/krc721/tokens`,
      `/address/${encoded}/krc721/tokens`,
      `/krc721/address/${encoded}/tokens`,
      `/krc721/holders/${encoded}`,
      `/v1/addresses/${encoded}/krc721/tokens`,
    ];
  }
  return [
    `/addresses/${encoded}/krc20/balances`,
    `/address/${encoded}/krc20/balances`,
    `/krc20/address/${encoded}/balances`,
    `/krc20/holders/${encoded}`,
    `/v1/addresses/${encoded}/krc20/balances`,
  ];
}

function marketPaths(address: string, standard: KaspaTokenStandard): string[] {
  const encoded = encodeURIComponent(address);
  if (standard === "krc721") {
    return [
      `/krc721/collections/${encoded}/floor`,
      `/krc721/floor/${encoded}`,
      `/market/krc721/${encoded}`,
      `/v1/krc721/${encoded}/floor`,
    ];
  }
  return [
    `/krc20/tokens/${encoded}/price`,
    `/krc20/price/${encoded}`,
    `/market/krc20/${encoded}`,
    `/v1/krc20/${encoded}/price`,
  ];
}

function chainInfoPaths(address: string, standard: KaspaTokenStandard): string[] {
  const encoded = encodeURIComponent(address);
  if (standard === "krc721") {
    return [
      `/krc721/collections/${encoded}/stats`,
      `/krc721/stats/${encoded}`,
      `/v1/krc721/${encoded}/stats`,
      `/krc721/collections/${encoded}`,
    ];
  }
  return [
    `/krc20/tokens/${encoded}/stats`,
    `/krc20/stats/${encoded}`,
    `/v1/krc20/${encoded}/stats`,
    `/krc20/tokens/${encoded}`,
  ];
}

function candlePaths(address: string, standard: KaspaTokenStandard): string[] {
  const encoded = encodeURIComponent(address);
  const limit = candleFetchLimit(standard);
  if (standard === "krc721") {
    return [
      `/krc721/collections/${encoded}/candles?interval=1m&limit=${limit}`,
      `/krc721/candles/${encoded}?interval=1m&limit=${limit}`,
      `/market/krc721/${encoded}/candles?interval=1m&limit=${limit}`,
    ];
  }
  return [
    `/krc20/tokens/${encoded}/candles?interval=1m&limit=${limit}`,
    `/krc20/candles/${encoded}?interval=1m&limit=${limit}`,
    `/market/krc20/${encoded}/candles?interval=1m&limit=${limit}`,
  ];
}

function parseHoldings(raw: unknown, standard: KaspaTokenStandard): Array<{ address: string; standard: KaspaTokenStandard; balanceRaw: string }> {
  const rows = new Map<string, { address: string; standard: KaspaTokenStandard; balanceRaw: string }>();
  const candidates = extractObjects(raw);
  for (const candidate of candidates) {
    const address = pickString(candidate, [
      "tokenAddress",
      "address",
      "contractAddress",
      "contract",
      "id",
      "assetId",
      "collectionAddress",
    ]);
    if (!looksLikeTokenAddress(address)) continue;
    const resolvedStandard = String(candidate.standard ?? candidate.type ?? "").toLowerCase().includes("721")
      ? "krc721"
      : standard;
    const balanceRaw = parseBalanceRaw(
      candidate.balance
      ?? candidate.amount
      ?? candidate.quantity
      ?? candidate.tokenBalance
      ?? candidate.rawBalance
      ?? candidate.count,
      resolvedStandard === "krc721" ? "1" : null,
    );
    if (!balanceRaw) continue;
    const key = `${resolvedStandard}|${normalizeAddress(address)}`;
    const current = rows.get(key);
    if (!current) {
      rows.set(key, { address, standard: resolvedStandard, balanceRaw });
      continue;
    }
    try {
      const next = (BigInt(current.balanceRaw) + BigInt(balanceRaw)).toString();
      rows.set(key, { ...current, balanceRaw: next });
    } catch {
      rows.set(key, { ...current, balanceRaw });
    }
  }
  return [...rows.values()];
}

async function fetchFromEndpoint<T>(
  endpoint: string,
  paths: string[],
  parser: (raw: unknown) => T | null,
): Promise<T | null> {
  for (const path of paths) {
    const url = `${endpoint}${path}`;
    const started = Date.now();
    try {
      const res = await withTimeout(url);
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      if (!data) continue;
      const parsed = parser(data);
      if (parsed === null) continue;
      markEndpointSuccess(endpoint, Date.now() - started);
      return parsed;
    } catch (err) {
      const timeout = err instanceof Error && err.name === "AbortError";
      markEndpointFailure(endpoint, timeout);
    }
  }
  return null;
}

function formatUnits(raw: string, decimals: number): { display: string; approx: number } {
  try {
    const value = BigInt(raw);
    const base = 10n ** BigInt(Math.max(0, decimals));
    const whole = value / base;
    const frac = value % base;
    const fracStr = frac.toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
    const display = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
    const approx = Number(whole) + Number(frac) / Number(base);
    return { display, approx: Number.isFinite(approx) ? approx : 0 };
  } catch {
    return { display: raw, approx: 0 };
  }
}

function parseMarketSnapshot(raw: unknown, standard: KaspaTokenStandard, source: string): KrcMarketSnapshot | null {
  const now = Date.now();
  const candidates = extractObjects(raw);
  for (const candidate of candidates) {
    const price = pickNumber(candidate, ["priceUsd", "usdPrice", "price", "floorPriceUsd", "floorPrice"]);
    if (!Number.isFinite(price)) continue;
    const change24 = pickNumber(candidate, ["change24hPct", "change24h", "priceChange24hPct"]);
    return {
      priceUsd: Number(price),
      change24hPct: Number.isFinite(change24) ? Number(change24) : (standard === "krc721" ? null : 0),
      updatedAt: now,
      source,
    };
  }
  return null;
}

function parseChainStats(raw: unknown, source: string): KrcChainStatsSnapshot | null {
  const now = Date.now();
  const candidate = extractObjects(raw)[0];
  if (!candidate) return null;
  const holders = pickNumber(candidate, ["holders", "holderCount"]);
  const owners = pickNumber(candidate, ["owners", "ownerCount", "uniqueOwners"]);
  const supplyStr = pickString(candidate, ["supply", "totalSupply", "circulatingSupply"]);
  const txCount24h = pickNumber(candidate, ["txCount24h", "transactions24h", "tx24h"]);
  const sales24h = pickNumber(candidate, ["sales24h", "salesCount24h", "trades24h"]);
  const listedCount = pickNumber(candidate, ["listedCount", "listed", "listings", "activeListings"]);
  const collectionItems = pickNumber(candidate, ["collectionItems", "items", "itemCount"]);
  const volume24hUsd = pickNumber(candidate, ["volume24hUsd", "volumeUsd24h", "volume24h"]);
  const floorPriceUsd = pickNumber(candidate, ["floorPriceUsd", "floorPrice"]);
  const floorChange24hPct = pickNumber(candidate, ["floorChange24hPct", "floor24hChangePct", "floorChangePct24h", "floorChange24h"]);
  const marketCapUsd = pickNumber(candidate, ["marketCapUsd", "marketCap", "fdvUsd", "fullyDilutedValueUsd"]);
  if (
    holders === null
    && owners === null
    && !supplyStr
    && txCount24h === null
    && sales24h === null
    && listedCount === null
    && collectionItems === null
    && volume24hUsd === null
    && floorPriceUsd === null
    && floorChange24hPct === null
    && marketCapUsd === null
  ) return null;
  return {
    holders: Number.isFinite(holders) ? Number(holders) : null,
    owners: Number.isFinite(owners) ? Number(owners) : null,
    supply: supplyStr || null,
    txCount24h: Number.isFinite(txCount24h) ? Number(txCount24h) : null,
    sales24h: Number.isFinite(sales24h) ? Number(sales24h) : null,
    listedCount: Number.isFinite(listedCount) ? Number(listedCount) : null,
    collectionItems: Number.isFinite(collectionItems) ? Number(collectionItems) : null,
    volume24hUsd: Number.isFinite(volume24hUsd) ? Number(volume24hUsd) : null,
    floorPriceUsd: Number.isFinite(floorPriceUsd) ? Number(floorPriceUsd) : null,
    floorChange24hPct: Number.isFinite(floorChange24hPct) ? Number(floorChange24hPct) : null,
    marketCapUsd: Number.isFinite(marketCapUsd) ? Number(marketCapUsd) : null,
    updatedAt: now,
    source,
  };
}

function parseCandles(raw: unknown, standard: KaspaTokenStandard): KrcCandlePoint[] {
  const out: KrcCandlePoint[] = [];
  const tryPush = (entry: Record<string, unknown>) => {
    const ts = pickNumber(entry, ["ts", "timestamp", "time", "t"]);
    const value = pickNumber(entry, ["close", "priceUsd", "price", "floorPriceUsd", "value"]);
    const volume = pickNumber(entry, ["volumeUsd", "volume", "quoteVolumeUsd", "volUsd", "v"]);
    if (!Number.isFinite(ts) || !Number.isFinite(value)) return;
    out.push({
      ts: Math.floor(Number(ts)),
      valueUsd: Number(value),
      volumeUsd: Number.isFinite(volume) ? Number(volume) : null,
    });
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const obj = asObject(item);
      if (obj) tryPush(obj);
    }
  } else {
    const root = asObject(raw);
    if (!root) return [];
    for (const key of ["candles", "data", "items", "result"]) {
      const value = root[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        const obj = asObject(item);
        if (obj) tryPush(obj);
      }
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(-candlePointMax(standard));
}

async function fetchHoldingsForStandard(
  address: string,
  network: string,
  standard: KaspaTokenStandard,
): Promise<Array<{ address: string; standard: KaspaTokenStandard; balanceRaw: string }>> {
  const endpoints = rankEndpoints(indexerEndpoints(network));
  if (endpoints.length === 0) return [];
  for (const endpoint of endpoints) {
    const parsed = await fetchFromEndpoint(endpoint, holdingsPaths(address, standard), (raw) => {
      const holdings = parseHoldings(raw, standard);
      return holdings.length > 0 ? holdings : null;
    });
    if (parsed && parsed.length > 0) return parsed;
  }
  return [];
}

async function fetchMarket(address: string, standard: KaspaTokenStandard, network: string): Promise<KrcMarketSnapshot | null> {
  const key = `${network}|${standard}|${normalizeAddress(address)}`;
  const cached = cacheGet(marketCache, key);
  if (cached !== null) return cached;
  const endpoints = rankEndpoints(marketEndpoints(network));
  for (const endpoint of endpoints) {
    const parsed = await fetchFromEndpoint(endpoint, marketPaths(address, standard), (raw) =>
      parseMarketSnapshot(raw, standard, endpoint),
    );
    if (parsed) {
      cacheSet(marketCache, key, parsed, priceTtlMs(), 1024);
      return parsed;
    }
  }
  cacheSet(marketCache, key, null, priceTtlMs(), 1024);
  return null;
}

async function fetchChain(address: string, standard: KaspaTokenStandard, network: string): Promise<KrcChainStatsSnapshot | null> {
  const key = `${network}|${standard}|${normalizeAddress(address)}`;
  const cached = cacheGet(chainCache, key);
  if (cached !== null) return cached;
  const endpoints = rankEndpoints(indexerEndpoints(network));
  for (const endpoint of endpoints) {
    const parsed = await fetchFromEndpoint(endpoint, chainInfoPaths(address, standard), (raw) =>
      parseChainStats(raw, endpoint),
    );
    if (parsed) {
      cacheSet(chainCache, key, parsed, chainTtlMs(), 512);
      return parsed;
    }
  }
  cacheSet(chainCache, key, null, chainTtlMs(), 512);
  return null;
}

async function fetchCandles(
  address: string,
  standard: KaspaTokenStandard,
  network: string,
  fallbackPrice: number | null,
): Promise<KrcCandlePoint[]> {
  const key = `${network}|${standard}|${normalizeAddress(address)}`;
  const cached = cacheGet(candlesCache, key);
  if (cached !== null) return cached;
  const endpoints = rankEndpoints(candlesEndpoints(network));
  for (const endpoint of endpoints) {
    const parsed = await fetchFromEndpoint(endpoint, candlePaths(address, standard), (raw) => {
      const candles = parseCandles(raw, standard);
      return candles.length > 0 ? candles : null;
    });
    if (parsed && parsed.length > 0) {
      cacheSet(candlesCache, key, parsed, candlesTtlMs(), 256);
      return parsed;
    }
  }
  const now = Date.now();
  const fallbackValue = fallbackPrice && fallbackPrice > 0 ? fallbackPrice : 1;
  const synthetic = [
    { ts: now - 60_000, valueUsd: fallbackValue, volumeUsd: 0 },
    { ts: now, valueUsd: fallbackValue, volumeUsd: 0 },
  ];
  cacheSet(candlesCache, key, synthetic, candlesTtlMs(), 256);
  return synthetic;
}

async function fetchHoldings(address: string, network: string): Promise<Array<{ address: string; standard: KaspaTokenStandard; balanceRaw: string }>> {
  const key = `${network}|${normalizeAddress(address)}`;
  const cached = cacheGet(holdingsCache, key);
  if (cached !== null) return cached;
  const [krc20, krc721] = await Promise.all([
    fetchHoldingsForStandard(address, network, "krc20"),
    fetchHoldingsForStandard(address, network, "krc721"),
  ]);
  const merged = new Map<string, { address: string; standard: KaspaTokenStandard; balanceRaw: string }>();
  for (const holding of [...krc20, ...krc721]) {
    const rowKey = `${holding.standard}|${normalizeAddress(holding.address)}`;
    const current = merged.get(rowKey);
    if (!current) {
      merged.set(rowKey, holding);
      continue;
    }
    try {
      merged.set(rowKey, {
        ...current,
        balanceRaw: (BigInt(current.balanceRaw) + BigInt(holding.balanceRaw)).toString(),
      });
    } catch {
      merged.set(rowKey, holding);
    }
  }
  const holdings = [...merged.values()].slice(0, HOT_TOKEN_LIMIT);
  cacheSet(holdingsCache, key, holdings, holdingsTtlMs(), 128);
  return holdings;
}

export async function fetchKrcPortfolio(address: string, network: string): Promise<KrcPortfolioToken[]> {
  const normalizedAddress = String(address || "").trim();
  if (!normalizedAddress) return [];
  const holdings = await fetchHoldings(normalizedAddress, network);
  if (holdings.length === 0) return [];

  const items = await Promise.all(holdings.map(async (holding): Promise<KrcPortfolioToken | null> => {
    try {
      const token = await resolveTokenFromAddress(holding.address, holding.standard, network);
      const market = await fetchMarket(token.address, token.standard, network);
      const chain = await fetchChain(token.address, token.standard, network);
      const candles = await fetchCandles(token.address, token.standard, network, market?.priceUsd ?? chain?.floorPriceUsd ?? null);
      const formatted = formatUnits(holding.balanceRaw, token.decimals);
      const valueUsd = market?.priceUsd != null ? formatted.approx * market.priceUsd : null;

      return {
        key: `${token.standard}|${normalizeAddress(token.address)}`,
        token,
        standard: token.standard,
        balanceRaw: holding.balanceRaw,
        balanceDisplay: formatted.display,
        balanceApprox: formatted.approx,
        market,
        chain,
        candles,
        valueUsd,
        updatedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }));

  return items
    .filter((item): item is KrcPortfolioToken => item !== null)
    .sort((a, b) => {
      const aValue = a.valueUsd ?? -1;
      const bValue = b.valueUsd ?? -1;
      if (aValue !== bValue) return bValue - aValue;
      return b.balanceApprox - a.balanceApprox;
    });
}

type PrefetchEnvelope = {
  updatedAt: number;
  entries: KrcPortfolioToken[];
};

type PrefetchMap = Record<string, PrefetchEnvelope>;

function storageSession(): chrome.storage.SessionStorageArea | null {
  if (typeof chrome !== "undefined" && chrome.storage?.session) return chrome.storage.session;
  return null;
}

async function readPrefetchMap(): Promise<PrefetchMap> {
  const store = storageSession();
  if (!store) return {};
  const result = await store.get(PREFETCH_STORAGE_KEY);
  const raw = result?.[PREFETCH_STORAGE_KEY];
  if (!raw || typeof raw !== "object") return {};
  return raw as PrefetchMap;
}

async function writePrefetchMap(next: PrefetchMap): Promise<void> {
  const store = storageSession();
  if (!store) return;
  await store.set({ [PREFETCH_STORAGE_KEY]: next });
}

function prefetchKey(address: string, network: string): string {
  return `${network}|${normalizeAddress(address)}`;
}

export async function loadPrefetchedKrcPortfolio(address: string, network: string): Promise<KrcPortfolioToken[] | null> {
  const key = prefetchKey(address, network);
  const map = await readPrefetchMap();
  const envelope = map[key];
  if (!envelope) return null;
  if (Date.now() - envelope.updatedAt > PREFETCH_MAX_AGE_MS) return null;
  return Array.isArray(envelope.entries) ? envelope.entries : null;
}

export async function savePrefetchedKrcPortfolio(address: string, network: string, entries: KrcPortfolioToken[]): Promise<void> {
  const key = prefetchKey(address, network);
  const map = await readPrefetchMap();
  map[key] = { updatedAt: Date.now(), entries };
  const rows = Object.entries(map).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, PREFETCH_MAX_ENTRIES);
  await writePrefetchMap(Object.fromEntries(rows));
}

export async function prefetchKrcPortfolioForAddress(address: string, network: string): Promise<void> {
  const normalized = String(address || "").trim();
  if (!normalized) return;
  const entries = await fetchKrcPortfolio(normalized, network);
  await savePrefetchedKrcPortfolio(normalized, network, entries);
}

export function __clearKrcPortfolioCachesForTests(): void {
  holdingsCache.clear();
  marketCache.clear();
  chainCache.clear();
  candlesCache.clear();
  endpointHealth.clear();
}

export function __getKrcPortfolioConfigForTests(): {
  holdingsTtlMs: number;
  priceTtlMs: number;
  chainTtlMs: number;
  candlesTtlMs: number;
  krc20CandleFetchLimit: number;
  krc721CandleFetchLimit: number;
  krc20CandlePointMax: number;
  krc721CandlePointMax: number;
} {
  return {
    holdingsTtlMs: holdingsTtlMs(),
    priceTtlMs: priceTtlMs(),
    chainTtlMs: chainTtlMs(),
    candlesTtlMs: candlesTtlMs(),
    krc20CandleFetchLimit: candleFetchLimit("krc20"),
    krc721CandleFetchLimit: candleFetchLimit("krc721"),
    krc20CandlePointMax: candlePointMax("krc20"),
    krc721CandlePointMax: candlePointMax("krc721"),
  };
}

export function __parseKrcCandlesForTests(raw: unknown, standard: KaspaTokenStandard): KrcCandlePoint[] {
  return parseCandles(raw, standard);
}

export async function __fetchKrcMarketForTests(
  address: string,
  standard: KaspaTokenStandard,
  network: string,
): Promise<KrcMarketSnapshot | null> {
  return fetchMarket(address, standard, network);
}

export async function __fetchKrcCandlesForTests(
  address: string,
  standard: KaspaTokenStandard,
  network: string,
  fallbackPrice: number | null,
): Promise<KrcCandlePoint[]> {
  return fetchCandles(address, standard, network, fallbackPrice);
}
