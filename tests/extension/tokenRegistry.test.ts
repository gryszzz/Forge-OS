// Phase 6 — Integration tests: Token Registry (Phase 4)
// Tests DEFAULT_REGISTRY structure, accessor functions, and stable-token availability.
// Pure functions — no chrome or browser mocks needed.

import { describe, expect, it } from "vitest";

// ── DEFAULT_REGISTRY structure ────────────────────────────────────────────────

describe("DEFAULT_REGISTRY", () => {
  it("contains KAS, USDT, USDC, and ZRX entries", async () => {
    const { DEFAULT_REGISTRY } = await import("../../extension/tokens/registry");
    expect(DEFAULT_REGISTRY.tokens.KAS).toBeDefined();
    expect(DEFAULT_REGISTRY.tokens.USDT).toBeDefined();
    expect(DEFAULT_REGISTRY.tokens.USDC).toBeDefined();
    expect(DEFAULT_REGISTRY.tokens.ZRX).toBeDefined();
  });

  it("KAS is enabled with 8 decimals and null assetId (native)", async () => {
    const { DEFAULT_REGISTRY } = await import("../../extension/tokens/registry");
    const kas = DEFAULT_REGISTRY.tokens.KAS;
    expect(kas.enabled).toBe(true);
    expect(kas.decimals).toBe(8);
    expect(kas.assetId).toBeNull();
    expect(kas.disabledReason).toBeNull();
  });

  it("USDT and USDC are enabled when stable swaps are live", async () => {
    const { DEFAULT_REGISTRY, STABLES_ENABLED } = await import("../../extension/tokens/registry");
    expect(STABLES_ENABLED).toBe(true);
    expect(DEFAULT_REGISTRY.tokens.USDT.enabled).toBe(true);
    expect(DEFAULT_REGISTRY.tokens.USDC.enabled).toBe(true);
  });

  it("disabled reasons are empty for enabled stables and present for disabled routes", async () => {
    const { DEFAULT_REGISTRY } = await import("../../extension/tokens/registry");
    expect(DEFAULT_REGISTRY.tokens.USDT.disabledReason).toBeNull();
    expect(DEFAULT_REGISTRY.tokens.USDC.disabledReason).toBeNull();
    expect(DEFAULT_REGISTRY.tokens.ZRX.disabledReason).toBeTruthy();
  });

  it("USDT/USDC have 6 decimals and ZRX has 18 decimals", async () => {
    const { DEFAULT_REGISTRY } = await import("../../extension/tokens/registry");
    expect(DEFAULT_REGISTRY.tokens.USDT.decimals).toBe(6);
    expect(DEFAULT_REGISTRY.tokens.USDC.decimals).toBe(6);
    expect(DEFAULT_REGISTRY.tokens.ZRX.decimals).toBe(18);
  });
});

// ── getToken ──────────────────────────────────────────────────────────────────

describe("getToken", () => {
  it("returns the KAS token definition", async () => {
    const { getToken } = await import("../../extension/tokens/registry");
    const kas = getToken("KAS");
    expect(kas.id).toBe("KAS");
    expect(kas.symbol).toBe("KAS");
    expect(kas.name).toBe("Kaspa");
  });

  it("returns USDT token definition", async () => {
    const { getToken } = await import("../../extension/tokens/registry");
    const usdt = getToken("USDT");
    expect(usdt.id).toBe("USDT");
    expect(usdt.symbol).toBe("USDT");
  });

  it("returns USDC token definition", async () => {
    const { getToken } = await import("../../extension/tokens/registry");
    const usdc = getToken("USDC");
    expect(usdc.id).toBe("USDC");
    expect(usdc.symbol).toBe("USDC");
  });

  it("returns ZRX token definition (disabled route)", async () => {
    const { getToken } = await import("../../extension/tokens/registry");
    const zrx = getToken("ZRX");
    expect(zrx.id).toBe("ZRX");
    expect(zrx.symbol).toBe("0x");
  });
});

// ── isTokenEnabled ─────────────────────────────────────────────────────────────

describe("isTokenEnabled", () => {
  it("returns true for KAS", async () => {
    const { isTokenEnabled } = await import("../../extension/tokens/registry");
    expect(isTokenEnabled("KAS")).toBe(true);
  });

  it("returns true for USDT", async () => {
    const { isTokenEnabled } = await import("../../extension/tokens/registry");
    expect(isTokenEnabled("USDT")).toBe(true);
  });

  it("returns true for USDC", async () => {
    const { isTokenEnabled } = await import("../../extension/tokens/registry");
    expect(isTokenEnabled("USDC")).toBe(true);
  });

  it("returns false for ZRX until explicit routing support is enabled", async () => {
    const { isTokenEnabled } = await import("../../extension/tokens/registry");
    expect(isTokenEnabled("ZRX")).toBe(false);
  });
});

// ── getEnabledTokens ───────────────────────────────────────────────────────────

describe("getEnabledTokens", () => {
  it("returns only tokens with enabled=true", async () => {
    const { getEnabledTokens } = await import("../../extension/tokens/registry");
    const enabled = getEnabledTokens();
    expect(enabled.every((t) => t.enabled)).toBe(true);
  });

  it("includes KAS", async () => {
    const { getEnabledTokens } = await import("../../extension/tokens/registry");
    const ids = getEnabledTokens().map((t) => t.id);
    expect(ids).toContain("KAS");
  });

  it("includes USDT/USDC and excludes ZRX while 0x route is disabled", async () => {
    const { getEnabledTokens } = await import("../../extension/tokens/registry");
    const ids = getEnabledTokens().map((t) => t.id);
    expect(ids).toContain("USDT");
    expect(ids).toContain("USDC");
    expect(ids).not.toContain("ZRX");
  });
});

// ── getAllTokens ───────────────────────────────────────────────────────────────

describe("getAllTokens", () => {
  it("returns all tokens regardless of enabled state", async () => {
    const { getAllTokens } = await import("../../extension/tokens/registry");
    const all = getAllTokens();
    const ids = all.map((t) => t.id);
    expect(ids).toContain("KAS");
    expect(ids).toContain("USDT");
    expect(ids).toContain("USDC");
    expect(ids).toContain("ZRX");
  });

  it("count matches the number of entries in DEFAULT_REGISTRY", async () => {
    const { getAllTokens, DEFAULT_REGISTRY } = await import("../../extension/tokens/registry");
    expect(getAllTokens().length).toBe(Object.keys(DEFAULT_REGISTRY.tokens).length);
  });
});
