import { clamp, round, toFinite } from "./math";
import { decisionSignature, type CachedOverlayDecision } from "./runQuantEngineOverlayCache";

type OverlayPlanConfig = {
  aiTransportReady: boolean;
  aiOverlayMode: "off" | "always" | "adaptive";
  minIntervalMs: number;
  cacheTtlMs: number;
};

type ResolveOverlayPlanParams = {
  coreDecision: any;
  cached: CachedOverlayDecision | null;
  config: OverlayPlanConfig;
};

type FuseParams = {
  agent: any;
  coreDecision: any;
  aiDecision: any;
  aiLatencyMs: number;
  startedAt: number;
  sanitizeDecision: (raw: any, agent: any) => any;
};

export function resolveAiOverlayPlan(params: ResolveOverlayPlanParams) {
  const { coreDecision, cached, config } = params;
  const now = Date.now();
  const signature = decisionSignature(coreDecision);
  const qm = coreDecision?.quant_metrics || {};

  if (!config.aiTransportReady) return { kind: "skip" as const, reason: "ai_transport_not_configured", signature };
  if (config.aiOverlayMode === "off") return { kind: "skip" as const, reason: "ai_overlay_mode_off", signature };
  if (config.aiOverlayMode === "always") return { kind: "call" as const, reason: "ai_overlay_mode_always", signature };

  if (cached && cached.signature === signature) {
    const ageMs = Math.max(0, now - cached.ts);
    if (ageMs <= config.minIntervalMs) {
      return { kind: "reuse" as const, reason: `cache_hit_min_interval_${ageMs}ms`, signature };
    }
    if (config.aiOverlayMode === "adaptive" && ageMs <= config.cacheTtlMs) {
      const conf = toFinite(coreDecision?.confidence_score, 0);
      const risk = toFinite(coreDecision?.risk_score, 1);
      const riskCeiling = toFinite(qm.risk_ceiling, 0.65);
      const regime = String(qm.regime || "NEUTRAL");
      const edge = Math.abs(toFinite(qm.edge_score, 0));
      const uncertainZone = conf < 0.88 && conf > 0.56;
      const nearRiskBoundary = Math.abs(risk - riskCeiling) < 0.06;
      const regimeSensitive = regime === "RISK_OFF" || regime === "RANGE_VOL";
      if (!uncertainZone && !nearRiskBoundary && !regimeSensitive && edge > 0.2) {
        return { kind: "reuse" as const, reason: `cache_hit_stable_state_${ageMs}ms`, signature };
      }
    }
  }

  const dataQuality = toFinite(qm.data_quality_score, 0);
  const confidence = toFinite(coreDecision?.confidence_score, 0);
  const risk = toFinite(coreDecision?.risk_score, 1);
  const riskCeiling = toFinite(qm.risk_ceiling, 0.65);
  const regime = String(qm.regime || "NEUTRAL");
  const edge = Math.abs(toFinite(qm.edge_score, 0));
  const samples = toFinite(qm.sample_count, 0);
  const kelly = toFinite(coreDecision?.kelly_fraction, 0);

  if (dataQuality < 0.4 || samples < 6) {
    return { kind: "skip" as const, reason: "low_data_quality", signature };
  }

  const regimeSensitive = regime === "RISK_OFF" || regime === "RANGE_VOL";
  const nearRiskBoundary = Math.abs(risk - riskCeiling) < 0.08;
  const uncertainZone = confidence < 0.9 && confidence > 0.58;
  const lowEdge = edge < 0.12;
  const highConvictionDeterministic =
    dataQuality >= 0.72 &&
    confidence >= 0.88 &&
    !regimeSensitive &&
    !nearRiskBoundary &&
    edge >= 0.25 &&
    (kelly === 0 || kelly >= 0.02);
  if (highConvictionDeterministic) return { kind: "skip" as const, reason: "quant_core_high_conviction", signature };
  if (regimeSensitive || nearRiskBoundary || uncertainZone || lowEdge) {
    return { kind: "call" as const, reason: "adaptive_uncertain_or_sensitive", signature };
  }
  return { kind: "skip" as const, reason: "adaptive_cost_control", signature };
}

function mergeRiskFactors(a: any[], b: any[], extra?: string) {
  const merged = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
  if (extra) merged.push(extra);
  return Array.from(new Set(merged.map((v) => String(v).trim()).filter(Boolean))).slice(0, 6);
}

export function fuseWithQuantCore(params: FuseParams) {
  const { agent, coreDecision, aiDecision, aiLatencyMs, startedAt, sanitizeDecision } = params;
  const regime = String(coreDecision?.quant_metrics?.regime || "NEUTRAL");
  const riskCeiling = toFinite(coreDecision?.quant_metrics?.risk_ceiling, 0.65);
  const aiAction = String(aiDecision?.action || "HOLD");
  let action = aiAction;
  let conflict = false;

  if (regime === "RISK_OFF" && aiAction === "ACCUMULATE") {
    action = coreDecision.action === "REDUCE" ? "REDUCE" : "HOLD";
    conflict = true;
  }
  if (toFinite(coreDecision?.risk_score, 0) > riskCeiling && aiAction === "ACCUMULATE") {
    action = coreDecision.action === "REDUCE" ? "REDUCE" : "HOLD";
    conflict = true;
  }

  const blendedRisk = round(Math.max(toFinite(coreDecision?.risk_score, 1), toFinite(aiDecision?.risk_score, 1)), 4);
  let blendedConfidence = round(
    clamp(
      toFinite(coreDecision?.confidence_score, 0.5) * 0.58 + toFinite(aiDecision?.confidence_score, 0.5) * 0.42 - (conflict ? 0.08 : 0),
      0,
      1
    ),
    4
  );
  if (action === "HOLD") blendedConfidence = Math.min(blendedConfidence, 0.86);

  const kellyCap = toFinite(coreDecision?.quant_metrics?.kelly_cap, toFinite(coreDecision?.kelly_fraction, 0));
  const blendedKelly = round(
    clamp(
      Math.min(
        Math.max(toFinite(coreDecision?.kelly_fraction, 0) * 0.8, toFinite(aiDecision?.kelly_fraction, 0) * 0.6),
        kellyCap || 1
      ),
      0,
      1
    ),
    4
  );

  let allocationKas = 0;
  const coreAlloc = toFinite(coreDecision?.capital_allocation_kas, 0);
  const aiAlloc = toFinite(aiDecision?.capital_allocation_kas, 0);
  if (action === "ACCUMULATE") {
    allocationKas = Math.min(aiAlloc || coreAlloc, coreAlloc * 1.25 || aiAlloc || 0);
  } else if (action === "REDUCE" || action === "REBALANCE") {
    allocationKas = Math.min(Math.max(coreAlloc, aiAlloc * 0.75), Math.max(coreAlloc * 1.5, aiAlloc));
  }

  const riskFactors = mergeRiskFactors(coreDecision?.risk_factors, aiDecision?.risk_factors, conflict ? "AI signal conflict; core risk override applied" : undefined);
  const aiRationale = String(aiDecision?.rationale || "AI overlay unavailable.").trim();
  const coreRationale = String(coreDecision?.rationale || "").trim();
  const rationale = `${coreRationale} AI overlay: ${aiRationale}`.slice(0, 900);

  return sanitizeDecision(
    {
      ...aiDecision,
      action,
      confidence_score: blendedConfidence,
      risk_score: blendedRisk,
      kelly_fraction: blendedKelly,
      capital_allocation_kas: action === "HOLD" ? 0 : allocationKas,
      expected_value_pct: round((toFinite(coreDecision?.expected_value_pct, 0) * 0.6) + (toFinite(aiDecision?.expected_value_pct, 0) * 0.4), 2),
      stop_loss_pct: round(Math.max(toFinite(coreDecision?.stop_loss_pct, 0), toFinite(aiDecision?.stop_loss_pct, 0)), 2),
      take_profit_pct: round((toFinite(coreDecision?.take_profit_pct, 0) * 0.6) + (toFinite(aiDecision?.take_profit_pct, 0) * 0.4), 2),
      monte_carlo_win_pct: round((toFinite(coreDecision?.monte_carlo_win_pct, 0) * 0.65) + (toFinite(aiDecision?.monte_carlo_win_pct, 0) * 0.35), 2),
      volatility_estimate: coreDecision?.volatility_estimate || aiDecision?.volatility_estimate,
      liquidity_impact: coreDecision?.liquidity_impact || aiDecision?.liquidity_impact,
      strategy_phase: action === "ACCUMULATE" ? coreDecision?.strategy_phase || aiDecision?.strategy_phase : aiDecision?.strategy_phase || coreDecision?.strategy_phase,
      rationale,
      risk_factors: riskFactors,
      next_review_trigger: coreDecision?.next_review_trigger || aiDecision?.next_review_trigger,
      decision_source: "hybrid-ai",
      decision_source_detail: `regime:${regime};ai_latency_ms:${aiLatencyMs};mode:quant_core_guarded`,
      quant_metrics: {
        ...(coreDecision?.quant_metrics || {}),
        ai_overlay_applied: true,
        ai_action_raw: aiAction,
        ai_confidence_raw: toFinite(aiDecision?.confidence_score, 0),
      },
      engine_latency_ms: Date.now() - startedAt,
    },
    agent
  );
}

