/**
 * Analytics Engine Worker
 * Runs heavy performance-metric calculations off the main thread so
 * the UI stays responsive even with large decision/queue histories.
 */

type AnalyticsRequest = {
  id: number;
  decisions: any[];
  queue: any[];
};

type AnalyticsResponse =
  | { id: number; ok: true; metrics: PerformanceMetrics; indicators: TechnicalIndicators | null }
  | { id: number; ok: false; error: string };

export type PerformanceMetrics = {
  totalDecisions: number;
  accumulateCount: number;
  reduceCount: number;
  holdCount: number;
  rebalanceCount: number;
  winRate: number;
  avgConfidence: number;
  avgKelly: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  profitFactor: number;
  calmarRatio: number;
  avgWinPct: number;
  avgLossPct: number;
  streakWins: number;
  streakLosses: number;
  realizedPnl: number;
  unrealizedPnl: number;
  var95: number;
  cvar95: number;
};

export type TechnicalIndicators = {
  rsi: number;
  sma20: number;
  sma50: number;
  priceVsSma20: number;
  priceVsSma50: number;
  trend: "bullish" | "bearish" | "neutral";
  // Extended fields consumed by QuantAnalyticsPanel
  shortTermTrend: string;
  mediumTermTrend: string;
  volatility: number;
  currentPrice: number;
  priceChange24h: number;
};

// ─── internal pure calculations ────────────────────────────────────────────

function computeMetrics(decisions: any[], queue: any[]): PerformanceMetrics {
  const empty: PerformanceMetrics = {
    totalDecisions: 0, accumulateCount: 0, reduceCount: 0, holdCount: 0,
    rebalanceCount: 0, winRate: 0, avgConfidence: 0, avgKelly: 0,
    sharpeRatio: 0, sortinoRatio: 0, maxDrawdown: 0, profitFactor: 0,
    calmarRatio: 0, avgWinPct: 0, avgLossPct: 0, streakWins: 0,
    streakLosses: 0, realizedPnl: 0, unrealizedPnl: 0, var95: 0, cvar95: 0,
  };
  if (!decisions || decisions.length === 0) return empty;

  const accumulateDecisions = decisions.filter(d => d.dec?.action === "ACCUMULATE");
  const reduceDecisions = decisions.filter(d => d.dec?.action === "REDUCE");
  const holdDecisions = decisions.filter(d => d.dec?.action === "HOLD");
  const rebalanceDecisions = decisions.filter(d => d.dec?.action === "REBALANCE");

  // Match executed decisions with queue confirmations
  const executedDecisions: any[] = [];
  for (const decision of decisions) {
    const hash = decision?.dec?.audit_record?.decision_hash;
    if (hash) {
      const matchingTx = (queue || []).find((q: any) =>
        q?.dec?.audit_record?.decision_hash === hash &&
        (q.status === "confirmed" || q.receipt_lifecycle === "confirmed")
      );
      if (matchingTx) executedDecisions.push({ decision, tx: matchingTx });
    }
  }

  let wins = 0, losses = 0, winsTotal = 0, lossesTotal = 0;
  for (let i = 0; i < executedDecisions.length - 1; i++) {
    const current = executedDecisions[i];
    const next = executedDecisions[i + 1];
    if (current.decision.dec?.action === "ACCUMULATE") {
      const currentPrice = current.decision.kasData?.priceUsd || 0;
      const nextPrice = next?.decision?.kasData?.priceUsd || currentPrice;
      if (nextPrice > currentPrice) { wins++; winsTotal += (nextPrice - currentPrice) / currentPrice; }
      else if (nextPrice < currentPrice) { losses++; lossesTotal += (currentPrice - nextPrice) / currentPrice; }
    }
  }

  const totalActionable = wins + losses;
  const winRate = totalActionable > 0 ? (wins / totalActionable) * 100 : 50;

  const returns: number[] = [];
  for (let i = 1; i < decisions.length; i++) {
    const prevPrice = decisions[i - 1]?.kasData?.priceUsd || 0;
    const currPrice = decisions[i]?.kasData?.priceUsd || 0;
    if (prevPrice > 0) returns.push((currPrice - prevPrice) / prevPrice);
  }

  const avgConfidence = decisions.reduce((s, d) => s + (d.dec?.confidence_score || 0), 0) / decisions.length;
  const avgKelly = decisions.reduce((s, d) => s + (d.dec?.kelly_fraction || 0), 0) / decisions.length;

  let maxDrawdown = 0, peak = 0;
  for (const d of decisions) {
    const price = d?.kasData?.priceUsd || 0;
    if (price > 0) {
      if (price > peak) peak = price;
      const dd = (peak - price) / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1))
    : 0;
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

  const downsideReturns = returns.filter(r => r < 0);
  const downsideDeviation = downsideReturns.length > 0
    ? Math.sqrt(downsideReturns.reduce((s, r) => s + r * r, 0) / downsideReturns.length)
    : 0;
  const sortinoRatio = downsideDeviation > 0 ? (avgReturn / downsideDeviation) * Math.sqrt(252) : 0;
  const calmarRatio = maxDrawdown > 0 ? (avgReturn * 252) / maxDrawdown : 0;
  const profitFactor = lossesTotal > 0 ? winsTotal / lossesTotal : winsTotal > 0 ? 999 : 0;
  const avgWinPct = wins > 0 ? (winsTotal / wins) * 100 : 0;
  const avgLossPct = losses > 0 ? (lossesTotal / losses) * 100 : 0;

  const sortedReturns = [...returns].sort((a, b) => a - b);
  const varIndex = Math.floor(returns.length * 0.05);
  const var95 = returns.length > varIndex ? Math.abs(sortedReturns[varIndex] || 0) : 0.05;
  let cvar95 = 0;
  if (returns.length > varIndex) {
    const worst = sortedReturns.slice(0, varIndex + 1);
    cvar95 = Math.abs(worst.reduce((a, b) => a + b, 0) / worst.length);
  }

  let maxStreakWins = 0, maxStreakLosses = 0, tempStreak = 0;
  let lastAction: "win" | "loss" | null = null;
  for (const d of decisions) {
    const action = d.dec?.action;
    if (action === "ACCUMULATE") {
      tempStreak = lastAction === "win" || lastAction === null ? tempStreak + 1 : 1;
      if (tempStreak > maxStreakWins) maxStreakWins = tempStreak;
      lastAction = "win";
    } else if (action === "REDUCE" || action === "HOLD") {
      tempStreak = lastAction === "loss" || lastAction === null ? tempStreak + 1 : 1;
      if (tempStreak > maxStreakLosses) maxStreakLosses = tempStreak;
      lastAction = "loss";
    }
  }

  return {
    totalDecisions: decisions.length,
    accumulateCount: accumulateDecisions.length,
    reduceCount: reduceDecisions.length,
    holdCount: holdDecisions.length,
    rebalanceCount: rebalanceDecisions.length,
    winRate, avgConfidence, avgKelly, sharpeRatio, sortinoRatio,
    maxDrawdown: maxDrawdown * 100, profitFactor, calmarRatio,
    avgWinPct, avgLossPct,
    streakWins: maxStreakWins, streakLosses: maxStreakLosses,
    realizedPnl: 0, unrealizedPnl: 0,
    var95: var95 * 100, cvar95: cvar95 * 100,
  };
}

function computeIndicators(decisions: any[]): TechnicalIndicators | null {
  if (!decisions || decisions.length < 20) return null;
  const prices = decisions.map(d => d?.kasData?.priceUsd).filter((p): p is number => p != null && p > 0);
  if (prices.length < 20) return null;

  const rsiPeriod = 14;
  let gains = 0, losses = 0;
  for (let i = prices.length - rsiPeriod; i < prices.length - 1; i++) {
    const change = prices[i + 1] - prices[i];
    if (change > 0) gains += change; else losses += Math.abs(change);
  }
  const avgGain = gains / rsiPeriod;
  const avgLoss = losses / rsiPeriod;
  const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
  const rsi = 100 - (100 / (1 + rs));

  const sma20 = prices.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, prices.length);
  const sma50 = prices.length >= 50 ? prices.slice(-50).reduce((a, b) => a + b, 0) / 50 : sma20;
  const currentPrice = prices[prices.length - 1];
  const priceVsSma20 = Math.round(((currentPrice - sma20) / sma20) * 10000) / 100;
  const priceVsSma50 = Math.round(((currentPrice - sma50) / sma50) * 10000) / 100;
  const trend: TechnicalIndicators["trend"] = currentPrice > sma20 && sma20 > sma50 ? "bullish"
    : currentPrice < sma20 && sma20 < sma50 ? "bearish" : "neutral";
  const shortTermTrend = prices[prices.length - 1] > prices[Math.max(0, prices.length - 5)] ? "BULLISH" : "BEARISH";
  const mediumTermTrend = prices[prices.length - 1] > prices[Math.max(0, prices.length - 20)] ? "BULLISH" : "BEARISH";
  const priceChange24h = Math.round(
    ((prices[prices.length - 1] - prices[Math.max(0, prices.length - 24)]) / prices[Math.max(0, prices.length - 24)] * 100) * 100
  ) / 100;
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) rets.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  const meanR = rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const volatility = Math.round(
    Math.sqrt(rets.reduce((s, r) => s + Math.pow(r - meanR, 2), 0) / Math.max(1, rets.length)) * Math.sqrt(252) * 10000
  ) / 100;

  return {
    rsi: Math.round(rsi * 10) / 10,
    sma20: Math.round(sma20 * 100000) / 100000,
    sma50: Math.round(sma50 * 100000) / 100000,
    priceVsSma20, priceVsSma50, trend,
    shortTermTrend, mediumTermTrend, volatility,
    currentPrice: Math.round(currentPrice * 100000) / 100000,
    priceChange24h,
  };
}

// ─── message handler ────────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<AnalyticsRequest>) => {
  const msg = event.data;
  if (!msg || typeof msg.id !== "number") return;
  try {
    const metrics = computeMetrics(msg.decisions || [], msg.queue || []);
    const indicators = computeIndicators(msg.decisions || []);
    const out: AnalyticsResponse = { id: msg.id, ok: true, metrics, indicators };
    (self as unknown as Worker).postMessage(out);
  } catch (e: any) {
    const out: AnalyticsResponse = { id: msg.id, ok: false, error: String(e?.message || "analytics worker error") };
    (self as unknown as Worker).postMessage(out);
  }
};

export {};
