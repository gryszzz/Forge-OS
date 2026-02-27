import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...(import.meta as any).env };
const originalFetch = (globalThis as any).fetch;

function okJson(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
  } as Response;
}

describe("krc portfolio pipeline config and safety", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    (import.meta as any).env = { ...originalEnv };
    if (originalFetch) (globalThis as any).fetch = originalFetch;
    else delete (globalThis as any).fetch;
  });

  it("reads env knobs for KRC721 candle depth and fetch limits", async () => {
    vi.stubEnv("VITE_KRC721_CANDLE_FETCH_LIMIT", "540");
    vi.stubEnv("VITE_KRC721_CANDLE_POINT_MAX", "420");
    vi.stubEnv("VITE_KRC_CANDLE_FETCH_LIMIT", "150");
    vi.stubEnv("VITE_KRC_CANDLE_POINT_MAX", "90");

    const { __getKrcPortfolioConfigForTests } = await import("../../extension/portfolio/krcPortfolio");
    const config = __getKrcPortfolioConfigForTests();

    expect(config.krc20CandleFetchLimit).toBe(150);
    expect(config.krc20CandlePointMax).toBe(90);
    expect(config.krc721CandleFetchLimit).toBe(540);
    expect(config.krc721CandlePointMax).toBe(420);
  });

  it("keeps parsed KRC721 candles bounded by configured point max", async () => {
    vi.stubEnv("VITE_KRC721_CANDLE_POINT_MAX", "25");

    const { __parseKrcCandlesForTests } = await import("../../extension/portfolio/krcPortfolio");
    const raw = Array.from({ length: 37 }, (_, idx) => ({
      ts: idx + 1,
      close: idx + 0.5,
      volumeUsd: (idx + 1) * 10,
    }));

    const points = __parseKrcCandlesForTests(raw, "krc721");
    expect(points).toHaveLength(25);
    expect(points[0].ts).toBe(13);
    expect(points[24].ts).toBe(37);
    expect(points[0].volumeUsd).toBe(130);
  });

  it("respects price TTL by caching market responses until expiry", async () => {
    vi.stubEnv("VITE_KRC_MARKET_ENDPOINTS", "https://market.example");
    vi.stubEnv("VITE_KRC_PRICE_TTL_MS", "1000");

    const fetchMock = vi.fn().mockResolvedValue(okJson({ priceUsd: 1.25, change24hPct: 2.1 }));
    (globalThis as any).fetch = fetchMock;

    const {
      __clearKrcPortfolioCachesForTests,
      __fetchKrcMarketForTests,
    } = await import("../../extension/portfolio/krcPortfolio");

    __clearKrcPortfolioCachesForTests();

    const first = await __fetchKrcMarketForTests("krc20:cache-test", "krc20", "mainnet");
    const second = await __fetchKrcMarketForTests("krc20:cache-test", "krc20", "mainnet");

    expect(first?.priceUsd).toBe(1.25);
    expect(second?.priceUsd).toBe(1.25);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 1_001);
    const third = await __fetchKrcMarketForTests("krc20:cache-test", "krc20", "mainnet");
    expect(third?.priceUsd).toBe(1.25);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns safe synthetic candles when no endpoint data is available", async () => {
    vi.stubEnv("VITE_KRC_CANDLES_ENDPOINTS", "");
    vi.stubEnv("VITE_KRC_MARKET_ENDPOINTS", "");
    vi.stubEnv("VITE_KRC_INDEXER_ENDPOINTS", "");
    vi.stubEnv("VITE_KASPA_KASPLEX_API_ENDPOINTS", "");

    const fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;

    const {
      __clearKrcPortfolioCachesForTests,
      __fetchKrcCandlesForTests,
    } = await import("../../extension/portfolio/krcPortfolio");

    __clearKrcPortfolioCachesForTests();

    const candles = await __fetchKrcCandlesForTests("krc721:fallback-test", "krc721", "mainnet", 2.75);

    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(candles).toHaveLength(2);
    expect(candles[0].valueUsd).toBe(2.75);
    expect(candles[1].valueUsd).toBe(2.75);
    expect(candles[0].volumeUsd).toBe(0);
    expect(candles[1].volumeUsd).toBe(0);
  });
});
