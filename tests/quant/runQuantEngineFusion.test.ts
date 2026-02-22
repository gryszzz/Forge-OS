import { describe, expect, it } from "vitest";
import { fuseWithQuantCore, resolveAiOverlayPlan } from "../../src/quant/runQuantEngineFusion";

describe("runQuantEngineFusion", () => {
  it("forces risk-off accumulate override and caps kelly by quant kelly_cap", () => {
    const fused = fuseWithQuantCore({
      agent: { capitalLimit: 10 },
      coreDecision: {
        action: "HOLD",
        confidence_score: 0.7,
        risk_score: 0.8,
        kelly_fraction: 0.05,
        capital_allocation_kas: 2,
        expected_value_pct: 1.2,
        stop_loss_pct: 2,
        take_profit_pct: 6,
        monte_carlo_win_pct: 55,
        rationale: "core",
        risk_factors: ["r1"],
        quant_metrics: { regime: "RISK_OFF", risk_ceiling: 0.6, kelly_cap: 0.03 },
      },
      aiDecision: {
        action: "ACCUMULATE",
        confidence_score: 0.95,
        risk_score: 0.4,
        kelly_fraction: 0.9,
        capital_allocation_kas: 5,
        expected_value_pct: 4,
        stop_loss_pct: 1,
        take_profit_pct: 9,
        monte_carlo_win_pct: 70,
        rationale: "ai",
        risk_factors: ["r2"],
      },
      aiLatencyMs: 200,
      startedAt: Date.now() - 50,
      sanitizeDecision: (raw) => raw,
    });

    expect(fused.action).toBe("HOLD");
    expect(fused.kelly_fraction).toBeLessThanOrEqual(0.03);
    expect(String(fused.decision_source_detail)).toContain("quant_core_guarded");
    expect(Array.isArray(fused.risk_factors)).toBe(true);
  });

  it("calls AI in adaptive mode for uncertain/risk-boundary states", () => {
    const plan = resolveAiOverlayPlan({
      coreDecision: {
        action: "ACCUMULATE",
        confidence_score: 0.7,
        risk_score: 0.61,
        kelly_fraction: 0.04,
        quant_metrics: {
          data_quality_score: 0.8,
          sample_count: 20,
          risk_ceiling: 0.65,
          regime: "RANGE_VOL",
          edge_score: 0.15,
        },
      },
      cached: null,
      config: {
        aiTransportReady: true,
        aiOverlayMode: "adaptive",
        minIntervalMs: 1000,
        cacheTtlMs: 5000,
      },
    });
    expect(plan.kind).toBe("call");
  });
});

