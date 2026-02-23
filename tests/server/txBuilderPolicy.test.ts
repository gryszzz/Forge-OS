import { beforeEach, describe, expect, it, vi } from "vitest";

function makeEntry(amount: number, daa: number, idSuffix: string) {
  return {
    outpoint: { transactionId: idSuffix.repeat(64).slice(0, 64), index: 0 },
    utxoEntry: {
      amount,
      blockDaaScore: daa,
      isCoinbase: false,
      scriptPublicKey: { version: 0, script: "00" },
    },
  };
}

describe("tx-builder local policy", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.TX_BUILDER_LOCAL_WASM_COIN_SELECTION;
    delete process.env.TX_BUILDER_LOCAL_WASM_MAX_INPUTS;
    delete process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_MODE;
    delete process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_OUTPUT_BPS;
    delete process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_SOMPI;
    delete process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_PER_INPUT_SOMPI;
    delete process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_FRAGMENTATION_THRESHOLD_INPUTS;
    delete process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_FRAGMENTATION_BUMP_SOMPI;
    delete process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_TRUNCATION_BUMP_SOMPI;
    delete process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_DAA_CONGESTION_BUMP_SOMPI;
    delete process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_RECEIPT_LAG_HIGH_MS;
    delete process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_RECEIPT_LAG_CRITICAL_MS;
    delete process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_RECEIPT_LAG_BUMP_SOMPI;
    delete process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_SCHEDULER_CALLBACK_HIGH_MS;
    delete process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_SCHEDULER_CALLBACK_CRITICAL_MS;
    delete process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_SCHEDULER_CALLBACK_BUMP_SOMPI;
  });

  it("selects oldest/smallest-first in auto consolidation mode and computes output_bps fee", async () => {
    process.env.TX_BUILDER_LOCAL_WASM_COIN_SELECTION = "auto";
    process.env.TX_BUILDER_LOCAL_WASM_MAX_INPUTS = "3";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_MODE = "output_bps";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_OUTPUT_BPS = "10"; // 10 bps

    const policy = await import("../../server/tx-builder/localPolicy.mjs");
    const entries = [
      makeEntry(300_000_000, 120, "a"),
      makeEntry(100_000_000, 100, "b"),
      makeEntry(200_000_000, 110, "c"),
      makeEntry(500_000_000, 130, "d"),
    ];

    const outputsTotalSompi = 250_000_000n;
    const plan = policy.selectUtxoEntriesForLocalBuild({
      entries,
      outputsTotalSompi,
      outputCount: 2,
      requestPriorityFeeSompi: undefined,
      config: policy.readLocalTxPolicyConfig(),
    });

    expect(plan.selectionMode).toBe("auto");
    expect(plan.priorityFeeSompi).toBeGreaterThan(0);
    expect(plan.selectedEntries.length).toBeGreaterThan(0);
    expect(plan.selectedEntries.length).toBeLessThanOrEqual(3);
    expect(plan.selectedAmountSompi).toBeGreaterThanOrEqual(plan.requiredTargetSompi);
    // auto+consolidation should prefer lowest DAA / small UTXOs first
    const selectedDaa = plan.selectedEntries.map((e: any) => Number(e.utxoEntry.blockDaaScore));
    expect(selectedDaa[0]).toBe(100);
  });

  it("honors largest-first and max input cap", async () => {
    process.env.TX_BUILDER_LOCAL_WASM_COIN_SELECTION = "largest-first";
    process.env.TX_BUILDER_LOCAL_WASM_MAX_INPUTS = "1";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_MODE = "fixed";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_SOMPI = "0";

    const policy = await import("../../server/tx-builder/localPolicy.mjs");
    const entries = [
      makeEntry(100_000_000, 100, "a"),
      makeEntry(900_000_000, 110, "b"),
      makeEntry(300_000_000, 120, "c"),
    ];
    const plan = policy.selectUtxoEntriesForLocalBuild({
      entries,
      outputsTotalSompi: 200_000_000n,
      outputCount: 1,
      requestPriorityFeeSompi: 0,
      config: policy.readLocalTxPolicyConfig(),
    });

    expect(plan.selectedEntries).toHaveLength(1);
    expect(Number(plan.selectedEntries[0].utxoEntry.amount)).toBe(900_000_000);
    expect(plan.truncatedByMaxInputs).toBe(false);
  });

  it("raises adaptive priority fee with high latency and fragmented selections", async () => {
    process.env.TX_BUILDER_LOCAL_WASM_COIN_SELECTION = "smallest-first";
    process.env.TX_BUILDER_LOCAL_WASM_MAX_INPUTS = "6";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_MODE = "adaptive";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_SOMPI = "2000";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_PER_INPUT_SOMPI = "1000";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_FRAGMENTATION_THRESHOLD_INPUTS = "3";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_FRAGMENTATION_BUMP_SOMPI = "5000";

    const policy = await import("../../server/tx-builder/localPolicy.mjs");
    const entries = [
      makeEntry(60_000_000, 100, "a"),
      makeEntry(70_000_000, 101, "b"),
      makeEntry(80_000_000, 102, "c"),
      makeEntry(90_000_000, 103, "d"),
      makeEntry(500_000_000, 104, "e"),
    ];
    const plan = policy.selectUtxoEntriesForLocalBuild({
      entries,
      outputsTotalSompi: 220_000_000n,
      outputCount: 2,
      requestPriorityFeeSompi: 0,
      telemetry: { observedConfirmP95Ms: 48_000, daaCongestionPct: 82 },
      config: policy.readLocalTxPolicyConfig(),
    });

    expect(plan.priorityFeeMode).toBe("adaptive");
    expect(plan.priorityFeeSompi).toBeGreaterThan(2_000);
    expect(plan.adaptiveSignals).toBeTruthy();
    expect(plan.adaptiveSignals.recomputedPriorityFeeSompi).toBe(plan.priorityFeeSompi);
    expect(plan.selectedEntries.length).toBeGreaterThanOrEqual(3);
  });

  it("degrades adaptive summary influence when telemetry freshness is stale", async () => {
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_MODE = "adaptive";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_SOMPI = "2000";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_DAA_CONGESTION_BUMP_SOMPI = "20000";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_PER_INPUT_SOMPI = "0";

    const policy = await import("../../server/tx-builder/localPolicy.mjs");
    const baseParams = {
      requestPriorityFeeSompi: 0,
      outputsTotalSompi: 200_000_000n,
      outputCount: 2,
      config: policy.readLocalTxPolicyConfig(),
      selectionStats: { selectedInputCount: 2, truncatedByMaxInputs: false },
    };
    const freshFee = policy.computePriorityFeeSompi({
      ...baseParams,
      telemetry: { observedConfirmP95Ms: 60_000, daaCongestionPct: 90, summaryFreshnessState: "fresh" },
    });
    const staleSoftFee = policy.computePriorityFeeSompi({
      ...baseParams,
      telemetry: { observedConfirmP95Ms: 60_000, daaCongestionPct: 90, summaryFreshnessState: "stale_soft" },
    });
    const staleHardFee = policy.computePriorityFeeSompi({
      ...baseParams,
      telemetry: { observedConfirmP95Ms: 60_000, daaCongestionPct: 90, summaryFreshnessState: "stale_hard" },
    });

    expect(freshFee).toBeGreaterThan(staleSoftFee);
    expect(staleSoftFee).toBeGreaterThanOrEqual(staleHardFee);
  });

  it("raises adaptive fee with receipt lag and scheduler callback latency pressure", async () => {
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_MODE = "adaptive";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_SOMPI = "1000";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_PER_INPUT_SOMPI = "0";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_DAA_CONGESTION_BUMP_SOMPI = "0";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_RECEIPT_LAG_BUMP_SOMPI = "5000";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_SCHEDULER_CALLBACK_BUMP_SOMPI = "3000";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_RECEIPT_LAG_HIGH_MS = "5000";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_RECEIPT_LAG_CRITICAL_MS = "15000";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_SCHEDULER_CALLBACK_HIGH_MS = "200";
    process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_SCHEDULER_CALLBACK_CRITICAL_MS = "1000";

    const policy = await import("../../server/tx-builder/localPolicy.mjs");
    const baseParams = {
      requestPriorityFeeSompi: 0,
      outputsTotalSompi: 150_000_000n,
      outputCount: 1,
      config: policy.readLocalTxPolicyConfig(),
      selectionStats: { selectedInputCount: 1, truncatedByMaxInputs: false },
    };
    const lowPressureFee = policy.computePriorityFeeSompi({
      ...baseParams,
      telemetry: {
        observedConfirmP95Ms: 6000,
        receiptLagP95Ms: 1500,
        schedulerCallbackLatencyP95BucketMs: 100,
        daaCongestionPct: 10,
        summaryFreshnessState: "fresh",
      },
    });
    const highPressureFee = policy.computePriorityFeeSompi({
      ...baseParams,
      telemetry: {
        observedConfirmP95Ms: 6000,
        receiptLagP95Ms: 20000,
        schedulerCallbackLatencyP95BucketMs: 1500,
        daaCongestionPct: 10,
        summaryFreshnessState: "fresh",
      },
    });

    expect(highPressureFee).toBeGreaterThan(lowPressureFee);
  });
});
