// Phase 6 — Integration tests: Swap Gating (Phase 4)
// Tests feature-flag gating, request validation, quote short-circuit, slippage enforcement.
//
// Route is live by default; signer/session requirements are enforced at quote/execute time.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── getSwapGatingStatus ───────────────────────────────────────────────────────

describe("getSwapGatingStatus", () => {
  it("returns enabled by default when route source is live", async () => {
    const { getSwapGatingStatus } = await import("../../extension/swap/swap");
    const status = getSwapGatingStatus();
    expect(status.enabled).toBe(true);
    expect(status.reason).toBeNull();
  });

  it("returns disabled when route source is blocked", async () => {
    vi.stubEnv("VITE_SWAP_ROUTE_SOURCE", "blocked");
    const { getSwapGatingStatus } = await import("../../extension/swap/swap");
    const status = getSwapGatingStatus();
    expect(status.enabled).toBe(false);
    expect(status.reason).toMatch(/disabled/i);
  });
});

// ── validateSwapRequest ───────────────────────────────────────────────────────

describe("validateSwapRequest", () => {
  it("returns empty array for a fully valid kaspa-native request", async () => {
    vi.stubEnv("VITE_SWAP_DEX_ENDPOINT", "https://dex.example");
    const { validateSwapRequest } = await import("../../extension/swap/swap");
    const errs = validateSwapRequest({ tokenIn: "KAS", tokenOut: "USDC", amountIn: 1_000n, slippageBps: 50 });
    expect(errs).toEqual([]);
  });

  it("errors when tokenIn === tokenOut", async () => {
    const { validateSwapRequest } = await import("../../extension/swap/swap");
    const errs = validateSwapRequest({ tokenIn: "KAS", tokenOut: "KAS", amountIn: 1_000n, slippageBps: 50 });
    expect(errs.some((e) => /different/i.test(e))).toBe(true);
  });

  it("errors when kaspa-native endpoint is not configured", async () => {
    const { validateSwapRequest } = await import("../../extension/swap/swap");
    const errs = validateSwapRequest({ tokenIn: "KAS", tokenOut: "USDT", amountIn: 1_000n, slippageBps: 50 });
    expect(errs.some((e) => /DEX endpoint/i.test(e))).toBe(true);
  });

  it("errors when tokenIn is not KAS for kaspa-native route", async () => {
    vi.stubEnv("VITE_SWAP_DEX_ENDPOINT", "https://dex.example");
    const { validateSwapRequest } = await import("../../extension/swap/swap");
    const errs = validateSwapRequest({ tokenIn: "USDC", tokenOut: "KAS", amountIn: 1_000n, slippageBps: 50 });
    expect(errs.some((e) => /supports KAS as the input/i.test(e))).toBe(true);
  });

  it("errors when amountIn is zero", async () => {
    const { validateSwapRequest } = await import("../../extension/swap/swap");
    const errs = validateSwapRequest({ tokenIn: "KAS", tokenOut: "USDT", amountIn: 0n, slippageBps: 50 });
    expect(errs.some((e) => /greater than zero/i.test(e))).toBe(true);
  });

  it("errors when amountIn is negative", async () => {
    const { validateSwapRequest } = await import("../../extension/swap/swap");
    const errs = validateSwapRequest({ tokenIn: "KAS", tokenOut: "USDT", amountIn: -1n, slippageBps: 50 });
    expect(errs.some((e) => /greater than zero/i.test(e))).toBe(true);
  });

  it("errors when slippageBps exceeds maxSlippageBps (500)", async () => {
    const { validateSwapRequest } = await import("../../extension/swap/swap");
    const errs = validateSwapRequest({ tokenIn: "KAS", tokenOut: "USDT", amountIn: 1_000n, slippageBps: 600 });
    expect(errs.some((e) => /slippage/i.test(e))).toBe(true);
  });

  it("errors when slippageBps is negative", async () => {
    const { validateSwapRequest } = await import("../../extension/swap/swap");
    const errs = validateSwapRequest({ tokenIn: "KAS", tokenOut: "USDT", amountIn: 1_000n, slippageBps: -1 });
    expect(errs.some((e) => /slippage/i.test(e))).toBe(true);
  });

  it("accumulates multiple independent validation errors", async () => {
    const { validateSwapRequest } = await import("../../extension/swap/swap");
    const errs = validateSwapRequest({ tokenIn: "KAS", tokenOut: "KAS", amountIn: 0n, slippageBps: 9999 });
    // same-token + zero-amount + slippage-exceeded = at least 3
    expect(errs.length).toBeGreaterThanOrEqual(3);
  });
});

// ── getSwapQuote ──────────────────────────────────────────────────────────────

describe("getSwapQuote", () => {
  it("returns null immediately when feature is disabled (no network call)", async () => {
    vi.stubEnv("VITE_SWAP_ENABLED", "false");
    const { getSwapQuote } = await import("../../extension/swap/swap");
    const quote = await getSwapQuote({ tokenIn: "KAS", tokenOut: "USDT", amountIn: 1_000n, slippageBps: 50 });
    expect(quote).toBeNull();
  });
});

// ── enforceMaxSlippage ────────────────────────────────────────────────────────

describe("enforceMaxSlippage", () => {
  // Build a minimal valid SwapQuote for slippage tests (priceImpact = 1% = 100 bps)
  const baseQuote = {
    tokenIn: "KAS" as const,
    tokenOut: "USDT" as const,
    amountIn: 1_000_000n,
    amountOut: 990_000n,
    priceImpact: 0.01,           // 1% → 100 bps — within 500 bps hard cap
    fee: 1_000n,
    route: ["KAS", "USDT"],
    validUntil: Date.now() + 30_000,
    dexEndpoint: "https://dex.example.com",
  };

  it("does not throw when requestedBps is within cap", async () => {
    const { enforceMaxSlippage } = await import("../../extension/swap/swap");
    expect(() => enforceMaxSlippage(baseQuote, 100)).not.toThrow();
  });

  it("does not throw at exactly maxSlippageBps (boundary)", async () => {
    const { enforceMaxSlippage } = await import("../../extension/swap/swap");
    expect(() => enforceMaxSlippage(baseQuote, 500)).not.toThrow();
  });

  it("throws SLIPPAGE_EXCEEDED when requestedBps > maxSlippageBps", async () => {
    const { enforceMaxSlippage } = await import("../../extension/swap/swap");
    expect(() => enforceMaxSlippage(baseQuote, 501)).toThrow(/SLIPPAGE_EXCEEDED/);
  });

  it("throws PRICE_IMPACT_TOO_HIGH when quote priceImpact bps > maxSlippageBps", async () => {
    const { enforceMaxSlippage } = await import("../../extension/swap/swap");
    const highImpactQuote = { ...baseQuote, priceImpact: 0.06 }; // 6% → 600 bps > 500
    expect(() => enforceMaxSlippage(highImpactQuote, 50)).toThrow(/PRICE_IMPACT_TOO_HIGH/);
  });

  it("checks requestedBps BEFORE priceImpact (requestedBps gate fires first)", async () => {
    const { enforceMaxSlippage } = await import("../../extension/swap/swap");
    // Both violations present; only SLIPPAGE_EXCEEDED should be thrown
    const highImpactQuote = { ...baseQuote, priceImpact: 0.06 }; // 600 bps
    expect(() => enforceMaxSlippage(highImpactQuote, 600)).toThrow(/SLIPPAGE_EXCEEDED/);
  });
});
