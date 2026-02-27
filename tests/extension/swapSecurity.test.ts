import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getConfiguredSwapRouteInfo,
  resolveSwapRouteSource,
} from "../../extension/swap/routeSource";
import {
  enforceSwapSigningDomain,
  validateEip712Domain,
  validateSwapTransactionTarget,
} from "../../extension/swap/signingDomain";
import {
  advanceSwapSettlement,
  createSwapSettlementRecord,
} from "../../extension/swap/settlement";
import {
  buildZeroExQuoteFetchConfig,
  resolveEvmTokenAddress,
  validateZeroExQuotePolicy,
} from "../../extension/swap/0xAdapter";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("swap route source", () => {
  it("uses kaspa-native route by default", () => {
    const info = getConfiguredSwapRouteInfo();
    expect(info.source).toBe("kaspa_native");
    expect(info.allowed).toBe(true);
  });

  it("rejects KAS pair on evm_0x route source", () => {
    const decision = resolveSwapRouteSource("KAS", "USDC", "evm_0x");
    expect(decision.allowed).toBe(false);
    expect(decision.requiresEvmSigner).toBe(true);
  });

  it("rejects ZRX pair on kaspa_native route source", () => {
    const decision = resolveSwapRouteSource("ZRX", "USDC", "kaspa_native");
    expect(decision.allowed).toBe(false);
  });
});

describe("swap signing domain", () => {
  it("requires external EVM signer for evm_0x", () => {
    const result = enforceSwapSigningDomain({
      routeSource: "evm_0x",
      hasManagedKaspaSession: true,
      hasExternalEvmSigner: false,
    });
    expect(result.ok).toBe(false);
    expect(result.requiredDomain).toBe("evm_sidecar");
  });

  it("validates EIP712 domain contract + chain + name", () => {
    const errors = validateEip712Domain(
      { name: "Permit2", chainId: 1, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
      { name: "Permit2", chainId: 1, verifyingContract: "0x000000000022d473030f116ddee9f6b43ac78ba3" },
    );
    expect(errors).toEqual([]);
  });

  it("rejects transaction target mismatch", () => {
    expect(
      validateSwapTransactionTarget("0x111111125421ca6dc452d289314280a0f8842a65", "0x222222125421ca6dc452d289314280a0f8842a65"),
    ).toBe(false);
  });
});

describe("swap settlement state machine", () => {
  it("allows legal progression REQUESTED -> QUOTED -> SIGNED", () => {
    const base = createSwapSettlementRecord("swap1", "blocked", 1000);
    const quoted = advanceSwapSettlement(base, "QUOTED", {}, 1100);
    const signed = advanceSwapSettlement(quoted, "SIGNED", {}, 1200);
    expect(signed.state).toBe("SIGNED");
    expect(signed.updatedAt).toBe(1200);
  });

  it("allows bridge-level failure from SIGNED before submission", () => {
    const base = createSwapSettlementRecord("swap3", "evm_0x", 1000);
    const quoted = advanceSwapSettlement(base, "QUOTED", {}, 1100);
    const signed = advanceSwapSettlement(quoted, "SIGNED", {}, 1200);
    const failed = advanceSwapSettlement(signed, "FAILED_BRIDGE", { error: "user rejected" }, 1300);
    expect(failed.state).toBe("FAILED_BRIDGE");
    expect(failed.error).toContain("rejected");
  });

  it("rejects invalid transition REQUESTED -> CONFIRMED", () => {
    const base = createSwapSettlementRecord("swap2", "blocked", 1000);
    expect(() => advanceSwapSettlement(base, "CONFIRMED", {}, 1200))
      .toThrow(/INVALID_SETTLEMENT_TRANSITION/);
  });
});

describe("0x adapter policy checks", () => {
  it("maps known ERC-20 addresses on Ethereum mainnet", () => {
    expect(resolveEvmTokenAddress("USDC", 1)).toMatch(/^0x/i);
    expect(resolveEvmTokenAddress("USDT", 1)).toMatch(/^0x/i);
    expect(resolveEvmTokenAddress("ZRX", 1)).toMatch(/^0x/i);
    expect(resolveEvmTokenAddress("KAS", 1)).toBeNull();
  });

  it("builds quote config from request + sidecar session", () => {
    const cfg = buildZeroExQuoteFetchConfig(
      { tokenIn: "USDC", tokenOut: "ZRX", amountIn: 1_000_000n, slippageBps: 50 },
      { walletType: "metamask", address: "0x1111111111111111111111111111111111111111", chainId: 1, connectedAt: 1, updatedAt: 1 },
      { endpoint: "https://api.0x.org/swap/allowance-holder/quote", expectedSettlerTo: "0x111111125421ca6dc452d289314280a0f8842a65" },
    );
    expect(cfg.sellTokenAddress).toMatch(/^0x/i);
    expect(cfg.buyTokenAddress).toMatch(/^0x/i);
    expect(cfg.sellAmount).toBe("1000000");
  });

  it("accepts quote matching policy", () => {
    const errors = validateZeroExQuotePolicy(
      {
        chainId: 1,
        liquidityAvailable: true,
        minBuyAmount: "123",
        transaction: { to: "0x111111125421ca6dc452d289314280a0f8842a65" },
        issues: { allowance: { spender: "0x000000000022d473030f116ddee9f6b43ac78ba3" } },
      },
      {
        allowedChainIds: [1],
        expectedSettlerTo: "0x111111125421ca6dc452d289314280a0f8842a65",
        expectedAllowanceSpender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      },
    );
    expect(errors).toEqual([]);
  });

  it("rejects chain and settler mismatch", () => {
    const errors = validateZeroExQuotePolicy(
      {
        chainId: 10,
        liquidityAvailable: true,
        minBuyAmount: "123",
        transaction: { to: "0xdeadbeef00000000000000000000000000000000" },
      },
      {
        allowedChainIds: [1],
        expectedSettlerTo: "0x111111125421ca6dc452d289314280a0f8842a65",
      },
    );
    expect(errors).toContain("ZEROX_CHAIN_NOT_ALLOWED");
    expect(errors).toContain("ZEROX_SETTLER_MISMATCH");
  });

  it("rejects quote when chain differs from active sidecar session", () => {
    const errors = validateZeroExQuotePolicy(
      {
        chainId: 10,
        liquidityAvailable: true,
        minBuyAmount: "42",
        transaction: { to: "0x111111125421ca6dc452d289314280a0f8842a65" },
      },
      {
        allowedChainIds: [1, 10],
        expectedChainId: 1,
        expectedSettlerTo: "0x111111125421ca6dc452d289314280a0f8842a65",
      },
    );
    expect(errors).toContain("ZEROX_CHAIN_SESSION_MISMATCH");
  });
});
