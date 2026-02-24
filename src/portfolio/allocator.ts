const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const n = (v: any, fallback = 0) => {
  const out = Number(v);
  return Number.isFinite(out) ? out : fallback;
};

export type PortfolioAgentInput = {
  agentId: string;
  name: string;
  enabled?: boolean;
  capitalLimitKas?: number;
  targetAllocationPct?: number;
  riskBudgetWeight?: number;
  pendingKas?: number;
  strategyTemplate?: string;
  strategyClass?: string;
  attributionSummary?: any;
  lastDecision?: any;
  balanceKas?: number;
  pnlKas?: number;
  pnlMode?: "estimated" | "hybrid" | "realized";
};

export type PortfolioAllocatorConfigLike = {
  totalBudgetPct?: number;
  reserveKas?: number;
  maxAgentAllocationPct?: number;
  rebalanceThresholdPct?: number;
};

export type PortfolioAllocationRow = {
  agentId: string;
  name: string;
  enabled: boolean;
  targetPct: number;
  riskWeight: number;
  score: number;
  routingCapMultiplier: number;
  maxShareCapPct: number;
  templateRegimeMultiplier: number;
  budgetPct: number;
  budgetKas: number;
  cycleCapKas: number;
  queuePressurePct: number;
  strategyTemplate: string;
  calibrationHealth: number;
  calibrationTier: "healthy" | "watch" | "degraded" | "critical";
  truthQualityScore: number;
  regime: string;
  action: string;
  confidence: number;
  risk: number;
  dataQuality: number;
  rebalanceDeltaKas: number;
  notes: string[];
  // Per-agent balance and PnL
  balanceKas: number;
  pnlKas: number;
  pnlMode: "estimated" | "hybrid" | "realized";
  realizedPnlKas: number;
  estimatedPnlKas: number;
};

export type PortfolioAllocationSummary = {
  walletKas: number;
  reserveKas: number;
  allocatableKas: number;
  targetBudgetKas: number;
  allocatedKas: number;
  utilizationPct: number;
  concentrationPct: number;
  riskWeightedExposurePct: number;
  rows: PortfolioAllocationRow[];
};

function actionMultiplier(action: string) {
  const a = String(action || "HOLD").toUpperCase();
  if (a === "ACCUMULATE") return 1;
  if (a === "REBALANCE") return 0.75;
  if (a === "REDUCE") return 0.35;
  return 0.5;
}

function regimeMultiplier(regime: string) {
  const r = String(regime || "NEUTRAL").toUpperCase();
  if (r === "RISK_OFF") return 0.2;
  if (r === "RANGE_VOL") return 0.6;
  if (r === "TREND_UP" || r === "FLOW_ACCUMULATION") return 1.1;
  return 0.85;
}

function strategyTemplateRegimeMultiplier(strategyTemplate: string, strategyClass: string, regime: string) {
  const template = String(strategyTemplate || strategyClass || "custom").toLowerCase();
  const r = String(regime || "NEUTRAL").toUpperCase();
  const isTrend = /trend|momentum/.test(template);
  const isMeanReversion = /mean[_ -]?reversion|reversion|range/.test(template);
  const isBreakout = /breakout|volatility/.test(template);
  const isDca = /\bdca\b|accumulator|accumulation/.test(template);
  if (isTrend) {
    if (r === "TREND_UP" || r === "FLOW_ACCUMULATION") return 1.16;
    if (r === "RISK_OFF") return 0.72;
    if (r === "RANGE_VOL") return 0.9;
    return 1;
  }
  if (isMeanReversion) {
    if (r === "RANGE_VOL") return 1.14;
    if (r === "TREND_UP") return 0.86;
    if (r === "RISK_OFF") return 0.76;
    return 1;
  }
  if (isBreakout) {
    if (r === "TREND_UP") return 1.08;
    if (r === "RANGE_VOL") return 1.05;
    if (r === "RISK_OFF") return 0.74;
    return 1;
  }
  if (isDca) {
    if (r === "RISK_OFF") return 0.92;
    if (r === "FLOW_ACCUMULATION" || r === "TREND_UP") return 1.08;
    return 1.02;
  }
  return 1;
}

function calibrationRoutingCapMultiplier(params: {
  calibrationRouting: ReturnType<typeof deriveCalibrationRouting>;
  templateRegimeBoost: number;
  regime: string;
  action: string;
}) {
  const { calibrationRouting, templateRegimeBoost, regime, action } = params;
  let cap = 1;
  if (!calibrationRouting.samplesSufficient) cap *= 0.92;
  if (calibrationRouting.tier === "watch") cap *= 0.88;
  if (calibrationRouting.tier === "degraded") cap *= 0.68;
  if (calibrationRouting.tier === "critical") cap *= 0.45;
  if (calibrationRouting.truthDegraded) {
    cap *= clamp(1 - calibrationRouting.truthMismatchRatePct / 140, 0.55, 0.9);
  }
  if (templateRegimeBoost < 1) {
    // Misaligned templates can still run, but they should not dominate capital during drift.
    cap *= clamp(0.65 + templateRegimeBoost * 0.35, 0.58, 0.95);
  }
  if (String(regime || "").toUpperCase() === "RISK_OFF") cap *= 0.72;
  if (String(action || "").toUpperCase() === "REDUCE") cap *= 0.65;
  return clamp(cap, 0.2, 1);
}

function deriveCalibrationRouting(attribution: any) {
  const brier = clamp(n(attribution?.confidenceBrierScore, 0), 0, 1);
  const evCalErr = clamp(n(attribution?.evCalibrationErrorPct, 0), 0, 100);
  const regimeHitRatePct = clamp(n(attribution?.regimeHitRatePct, 0), 0, 100);
  const regimeHitSamples = Math.max(0, n(attribution?.regimeHitSamples, 0));
  const truthDegraded = Boolean(attribution?.truthDegraded);
  const truthMismatchRatePct = clamp(n(attribution?.truthMismatchRatePct, 0), 0, 100);
  const receiptCoveragePct = clamp(n(attribution?.realizedReceiptCoveragePct ?? attribution?.receiptCoveragePct, 0), 0, 100);

  const samplesSufficient = regimeHitSamples >= 8;
  const brierScore = clamp(1 - brier / 0.35, 0, 1.1);
  const evScore = clamp(1 - evCalErr / 20, 0, 1.1);
  const regimeScore = clamp(regimeHitRatePct / 100, 0, 1.1);
  const rawHealth = samplesSufficient
    ? (brierScore * 0.4 + evScore * 0.35 + regimeScore * 0.25)
    : 0.88;
  const truthPenalty = truthDegraded ? clamp(1 - truthMismatchRatePct / 120, 0.35, 0.92) : 1;
  const receiptCoverageFactor = clamp(0.7 + receiptCoveragePct / 100 * 0.35, 0.7, 1.05);
  const health = clamp(rawHealth * truthPenalty * receiptCoverageFactor, 0.2, 1.1);
  const sizeMultiplier = samplesSufficient
    ? clamp(0.35 + health * 0.85, 0.3, 1.2)
    : 0.9;
  const tier =
    health < 0.42 ? "critical"
      : health < 0.62 ? "degraded"
      : health < 0.82 ? "watch"
      : "healthy";
  return {
    samplesSufficient,
    brier,
    evCalErr,
    regimeHitRatePct,
    regimeHitSamples,
    truthDegraded,
    truthMismatchRatePct,
    receiptCoveragePct,
    health,
    sizeMultiplier,
    truthQualityScore: clamp((truthDegraded ? 0.5 : 0.9) * receiptCoverageFactor * truthPenalty, 0.2, 1.1),
    tier,
  } as const;
}

function buildNotes(params: {
  enabled: boolean;
  action: string;
  regime: string;
  strategyTemplate?: string;
  queuePressurePct: number;
  risk: number;
  confidence: number;
  dataQuality: number;
  calibrationTier?: string;
  truthDegraded?: boolean;
}) {
  const notes: string[] = [];
  if (!params.enabled) notes.push("disabled in allocator");
  if (params.regime === "RISK_OFF") notes.push("risk-off regime throttle");
  if (params.queuePressurePct > 20) notes.push("queue pressure high");
  if (params.risk > 0.7) notes.push("elevated risk score");
  if (params.confidence < 0.7) notes.push("low confidence");
  if (params.dataQuality < 0.5) notes.push("limited data quality");
  if (params.calibrationTier === "critical" || params.calibrationTier === "degraded") notes.push("calibration routing throttle");
  if (params.truthDegraded) notes.push("truth quality degraded");
  if (params.action === "REDUCE") notes.push("reduce signal active");
  if (params.strategyTemplate) notes.push(`template:${String(params.strategyTemplate).slice(0, 24)}`);
  if (!notes.length) notes.push("within shared budget guardrails");
  return notes.slice(0, 4);
}

export function computeSharedRiskBudgetAllocation(params: {
  walletKas: number;
  agents: PortfolioAgentInput[];
  config?: PortfolioAllocatorConfigLike;
}): PortfolioAllocationSummary {
  const walletKas = Math.max(0, n(params.walletKas, 0));
  const reserveKas = Math.max(0, n(params.config?.reserveKas, 5));
  const allocatableKas = Math.max(0, walletKas - reserveKas);
  const totalBudgetPct = clamp(n(params.config?.totalBudgetPct, 0.85), 0.05, 1);
  const maxAgentAllocationPct = clamp(n(params.config?.maxAgentAllocationPct, 0.5), 0.05, 1);
  const rebalanceThresholdPct = clamp(n(params.config?.rebalanceThresholdPct, 0.08), 0.01, 0.5);
  const targetBudgetKas = allocatableKas * totalBudgetPct;
  const agents = Array.isArray(params.agents) ? params.agents : [];

  const enabledRows = agents.map((agent) => {
    const dec = agent?.lastDecision || {};
    const qm = dec?.quant_metrics || {};
    const risk = clamp(n(dec?.risk_score, 0.75), 0, 1);
    const confidence = clamp(n(dec?.confidence_score, 0.55), 0, 1);
    const dataQuality = clamp(n(qm?.data_quality_score, 0.45), 0, 1);
    const action = String(dec?.action || "HOLD").toUpperCase();
    const regime = String(qm?.regime || "NEUTRAL").toUpperCase();
    const riskCeiling = Math.max(0.1, n(qm?.risk_ceiling, 0.65));
    const riskHeadroom = clamp((riskCeiling - risk) / riskCeiling, -1, 1);
    const pendingKas = Math.max(0, n(agent?.pendingKas, 0));
    const capitalLimitKas = Math.max(0, n(agent?.capitalLimitKas, 0));
    const targetPct = clamp(n(agent?.targetAllocationPct, 0), 0, 100);
    const riskWeight = clamp(n(agent?.riskBudgetWeight, 1), 0, 10);
    const enabled = agent?.enabled !== false;
    const queuePressurePct = capitalLimitKas > 0 ? clamp((pendingKas / capitalLimitKas) * 100, 0, 500) : 0;
    const strategyTemplate = String(agent?.strategyTemplate || agent?.strategyClass || "custom");
    const strategyClass = String(agent?.strategyClass || "");
    const calibrationRouting = deriveCalibrationRouting(agent?.attributionSummary);
    const templateRegimeBoost = strategyTemplateRegimeMultiplier(strategyTemplate, strategyClass, regime);

    // Extract PnL from attribution summary
    const attribution = agent?.attributionSummary;
    const pnlMode = String(attribution?.netPnlMode || "estimated") as "estimated" | "hybrid" | "realized";
    const pnlKas = n(attribution?.netPnlKas, 0);
    const realizedPnlKas = n(attribution?.netPnlKas, 0); // Use netPnlKas as realized when confirmed
    const estimatedPnlKas = n(attribution?.estimatedNetPnlKas || attribution?.netPnlKas, 0);
    
    // Calculate balance from budget + pending - this represents the agent's allocated capital
    const balanceKas = n(agent?.balanceKas, 0) || n(agent?.capitalLimitKas, 0);

    const baseTargetWeight = targetPct > 0 ? targetPct / 100 : 0;
    const signalStrength = clamp(0.25 + confidence * 0.45 + Math.max(0, riskHeadroom) * 0.2 + dataQuality * 0.1, 0.05, 1.1);
    const queuePenalty = clamp(1 - queuePressurePct / 160, 0.2, 1);
    const score = enabled
      ? Math.max(
          0,
          (baseTargetWeight > 0 ? baseTargetWeight : riskWeight * 0.2) *
            signalStrength *
            actionMultiplier(action) *
            regimeMultiplier(regime) *
            templateRegimeBoost *
            calibrationRouting.sizeMultiplier *
            queuePenalty
        )
      : 0;

    return {
      agentId: String(agent?.agentId || agent?.name || "agent"),
      name: String(agent?.name || agent?.agentId || "Agent"),
      enabled,
      targetPct,
      riskWeight,
      capitalLimitKas,
      pendingKas,
      strategyTemplate,
      strategyClass,
      templateRegimeBoost,
      action,
      regime,
      confidence,
      risk,
      dataQuality,
      calibrationRouting,
      score,
      queuePressurePct,
      // PnL data
      balanceKas,
      pnlKas,
      pnlMode,
      realizedPnlKas,
      estimatedPnlKas,
    };
  });

  const totalScore = enabledRows.reduce((sum, row) => sum + row.score, 0);
  const fallbackWeightSum = enabledRows.reduce((sum, row) => sum + (row.enabled ? Math.max(0.1, row.riskWeight) : 0), 0);

  const rows: PortfolioAllocationRow[] = enabledRows.map((row) => {
    const normalizedWeight =
      totalScore > 0
        ? row.score / totalScore
        : (row.enabled ? Math.max(0.1, row.riskWeight) / Math.max(0.1, fallbackWeightSum) : 0);

    const routingCapMultiplier = calibrationRoutingCapMultiplier({
      calibrationRouting: row.calibrationRouting,
      templateRegimeBoost: row.templateRegimeBoost,
      regime: row.regime,
      action: row.action,
    });
    const maxShareCapPct = clamp(maxAgentAllocationPct * routingCapMultiplier, 0.02, 1);
    const rawBudgetKas = targetBudgetKas * normalizedWeight;
    const budgetKas = Math.min(rawBudgetKas, targetBudgetKas * maxShareCapPct);
    const budgetPct = targetBudgetKas > 0 ? clamp((budgetKas / targetBudgetKas) * 100, 0, 100) : 0;
    const cycleCapKas = Math.min(
      budgetKas,
      row.capitalLimitKas > 0 ? row.capitalLimitKas : budgetKas,
      Math.max(0, targetBudgetKas * maxShareCapPct)
    );
    const rebalanceDeltaKas = budgetKas - row.pendingKas;

    return {
      agentId: row.agentId,
      name: row.name,
      enabled: row.enabled,
      targetPct: row.targetPct,
      riskWeight: row.riskWeight,
      score: Number(row.score.toFixed(6)),
      routingCapMultiplier: Number(routingCapMultiplier.toFixed(4)),
      maxShareCapPct: Number((maxShareCapPct * 100).toFixed(2)),
      templateRegimeMultiplier: Number(row.templateRegimeBoost.toFixed(4)),
      budgetPct: Number(budgetPct.toFixed(2)),
      budgetKas: Number(budgetKas.toFixed(6)),
      cycleCapKas: Number(Math.max(0, cycleCapKas).toFixed(6)),
      queuePressurePct: Number(row.queuePressurePct.toFixed(2)),
      strategyTemplate: row.strategyTemplate,
      calibrationHealth: Number(row.calibrationRouting.health.toFixed(4)),
      calibrationTier: row.calibrationRouting.tier,
      truthQualityScore: Number(row.calibrationRouting.truthQualityScore.toFixed(4)),
      regime: row.regime,
      action: row.action,
      confidence: Number(row.confidence.toFixed(4)),
      risk: Number(row.risk.toFixed(4)),
      dataQuality: Number(row.dataQuality.toFixed(4)),
      rebalanceDeltaKas:
        Math.abs(rebalanceDeltaKas) >= targetBudgetKas * rebalanceThresholdPct
          ? Number(rebalanceDeltaKas.toFixed(6))
          : 0,
      notes: buildNotes({
        enabled: row.enabled,
        action: row.action,
        regime: row.regime,
        strategyTemplate: row.strategyTemplate,
        queuePressurePct: row.queuePressurePct,
        risk: row.risk,
        confidence: row.confidence,
        dataQuality: row.dataQuality,
        calibrationTier: row.calibrationRouting.tier,
        truthDegraded: row.calibrationRouting.truthDegraded,
      })
        .concat(
          routingCapMultiplier < 0.999 || rawBudgetKas > budgetKas + 1e-9
            ? ["dynamic concentration cap"]
            : []
        )
        .slice(0, 5),
      // Per-agent balance and PnL
      balanceKas: Number(row.balanceKas.toFixed(6)),
      pnlKas: Number(row.pnlKas.toFixed(6)),
      pnlMode: row.pnlMode,
      realizedPnlKas: Number(row.realizedPnlKas.toFixed(6)),
      estimatedPnlKas: Number(row.estimatedPnlKas.toFixed(6)),
    };
  });

  const allocatedKas = rows.reduce((sum, row) => sum + row.budgetKas, 0);
  const concentrationPct = rows.length
    ? Math.max(...rows.map((row) => (targetBudgetKas > 0 ? (row.budgetKas / targetBudgetKas) * 100 : 0)))
    : 0;
  const riskWeightedExposurePct = rows.length
    ? rows.reduce((sum, row) => sum + row.budgetPct * row.risk, 0) / 100
    : 0;

  rows.sort((a, b) => b.budgetKas - a.budgetKas || a.name.localeCompare(b.name));

  return {
    walletKas: Number(walletKas.toFixed(6)),
    reserveKas: Number(reserveKas.toFixed(6)),
    allocatableKas: Number(allocatableKas.toFixed(6)),
    targetBudgetKas: Number(targetBudgetKas.toFixed(6)),
    allocatedKas: Number(allocatedKas.toFixed(6)),
    utilizationPct: Number((targetBudgetKas > 0 ? (allocatedKas / targetBudgetKas) * 100 : 0).toFixed(2)),
    concentrationPct: Number(concentrationPct.toFixed(2)),
    riskWeightedExposurePct: Number(riskWeightedExposurePct.toFixed(4)),
    rows,
  };
}
