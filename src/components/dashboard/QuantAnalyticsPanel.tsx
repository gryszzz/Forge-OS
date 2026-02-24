import { useEffect, useState } from "react";
import { C, mono } from "../../tokens";
import { Badge, Card, Label } from "../ui";
import { useAnalyticsWorker } from "./hooks/useAnalyticsWorker";

function calculatePerformanceMetrics(decisions: any[], queue: any[]) {
  if (!decisions || decisions.length === 0) {
    return {
      totalDecisions: 0,
      accumulateCount: 0,
      reduceCount: 0,
      holdCount: 0,
      rebalanceCount: 0,
      winRate: 0,
      avgConfidence: 0,
      avgKelly: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      maxDrawdown: 0,
      profitFactor: 0,
      calmarRatio: 0,
      avgWinPct: 0,
      avgLossPct: 0,
      streakWins: 0,
      streakLosses: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      var95: 0,
      cvar95: 0,
    };
  }

  const accumulateDecisions = decisions.filter(d => d.dec?.action === "ACCUMULATE");
  const reduceDecisions = decisions.filter(d => d.dec?.action === "REDUCE");
  const holdDecisions = decisions.filter(d => d.dec?.action === "HOLD");
  const rebalanceDecisions = decisions.filter(d => d.dec?.action === "REBALANCE");

  const executedDecisions: any[] = [];
  for (const decision of decisions) {
    const hash = decision?.dec?.audit_record?.decision_hash;
    if (hash) {
      const matchingTx = queue.find((q: any) => 
        q?.dec?.audit_record?.decision_hash === hash && 
        (q.status === "confirmed" || q.receipt_lifecycle === "confirmed")
      );
      if (matchingTx) {
        executedDecisions.push({ decision, tx: matchingTx });
      }
    }
  }

  let wins = 0;
  let losses = 0;
  let winsTotal = 0;
  let lossesTotal = 0;

  for (let i = 0; i < executedDecisions.length - 1; i++) {
    const current = executedDecisions[i];
    const next = executedDecisions[i + 1];
    if (current.decision.dec?.action === "ACCUMULATE") {
      const currentPrice = current.decision.kasData?.priceUsd || 0;
      const nextPrice = next?.decision?.kasData?.priceUsd || currentPrice;
      if (nextPrice > currentPrice) {
        wins++;
        winsTotal += (nextPrice - currentPrice) / currentPrice;
      } else if (nextPrice < currentPrice) {
        losses++;
        lossesTotal += (currentPrice - nextPrice) / currentPrice;
      }
    }
  }

  const totalActionable = wins + losses;
  const winRate = totalActionable > 0 ? (wins / totalActionable) * 100 : 50;
  
  const returns: number[] = [];
  for (let i = 1; i < decisions.length; i++) {
    const prevPrice = decisions[i - 1]?.kasData?.priceUsd || 0;
    const currPrice = decisions[i]?.kasData?.priceUsd || 0;
    if (prevPrice > 0) {
      returns.push((currPrice - prevPrice) / prevPrice);
    }
  }

  const avgConfidence = decisions.reduce((sum, d) => sum + (d.dec?.confidence_score || 0), 0) / decisions.length;
  const avgKelly = decisions.reduce((sum, d) => sum + (d.dec?.kelly_fraction || 0), 0) / decisions.length;
  
  let maxDrawdown = 0;
  let peak = 0;
  for (const decision of decisions) {
    const price = decision?.kasData?.priceUsd || 0;
    if (price > 0) {
      if (price > peak) peak = price;
      const drawdown = (peak - price) / peak;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
  }

  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdReturn = returns.length > 1 
    ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1))
    : 0;
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

  const downsideReturns = returns.filter(r => r < 0);
  const downsideDeviation = downsideReturns.length > 0
    ? Math.sqrt(downsideReturns.reduce((sum, r) => sum + r * r, 0) / downsideReturns.length)
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
    const worstReturns = sortedReturns.slice(0, varIndex + 1);
    cvar95 = Math.abs(worstReturns.reduce((a, b) => a + b, 0) / worstReturns.length);
  }

  let maxStreakWins = 0;
  let maxStreakLosses = 0;
  let tempStreak = 0;
  let lastAction: "win" | "loss" | null = null;

  for (const decision of decisions) {
    const action = decision.dec?.action;
    if (action === "ACCUMULATE") {
      if (lastAction === "win" || lastAction === null) {
        tempStreak++;
        if (tempStreak > maxStreakWins) maxStreakWins = tempStreak;
      } else {
        tempStreak = 1;
      }
      lastAction = "win";
    } else if (action === "REDUCE" || action === "HOLD") {
      if (lastAction === "loss" || lastAction === null) {
        tempStreak++;
        if (tempStreak > maxStreakLosses) maxStreakLosses = tempStreak;
      } else {
        tempStreak = 1;
      }
      lastAction = "loss";
    }
  }

  return {
    totalDecisions: decisions.length,
    accumulateCount: accumulateDecisions.length,
    reduceCount: reduceDecisions.length,
    holdCount: holdDecisions.length,
    rebalanceCount: rebalanceDecisions.length,
    winRate,
    avgConfidence,
    avgKelly,
    sharpeRatio,
    sortinoRatio,
    maxDrawdown: maxDrawdown * 100,
    profitFactor,
    calmarRatio,
    avgWinPct,
    avgLossPct,
    streakWins: maxStreakWins,
    streakLosses: maxStreakLosses,
    realizedPnl: 0,
    unrealizedPnl: 0,
    var95: var95 * 100,
    cvar95: cvar95 * 100,
  };
}

function calculateIndicators(decisions: any[]) {
  if (!decisions || decisions.length < 20) return null;

  const prices = decisions.map(d => d?.kasData?.priceUsd).filter(p => p && p > 0);
  if (prices.length < 20) return null;

  const rsiPeriod = 14;
  let gains = 0;
  let losses = 0;
  for (let i = prices.length - rsiPeriod; i < prices.length - 1; i++) {
    const change = prices[i + 1] - prices[i];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / rsiPeriod;
  const avgLoss = losses / rsiPeriod;
  const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
  const rsi = 100 - (100 / (1 + rs));

  const sma20 = prices.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, prices.length);
  const sma50 = prices.length >= 50 ? prices.slice(-50).reduce((a, b) => a + b, 0) / 50 : sma20;

  const currentPrice = prices[prices.length - 1];
  const priceVsSma20 = ((currentPrice - sma20) / sma20) * 100;
  const priceVsSma50 = ((currentPrice - sma50) / sma50) * 100;

  const shortTermTrend = prices[prices.length - 1] > prices[Math.max(0, prices.length - 5)] ? "BULLISH" : "BEARISH";
  const mediumTermTrend = prices[prices.length - 1] > prices[Math.max(0, prices.length - 20)] ? "BULLISH" : "BEARISH";

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const volatility = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length) * Math.sqrt(252) * 100;

  return {
    rsi: Math.round(rsi * 10) / 10,
    sma20: Math.round(sma20 * 100000) / 100000,
    sma50: Math.round(sma50 * 100000) / 100000,
    priceVsSma20: Math.round(priceVsSma20 * 100) / 100,
    priceVsSma50: Math.round(priceVsSma50 * 100) / 100,
    shortTermTrend,
    mediumTermTrend,
    volatility: Math.round(volatility * 100) / 100,
    currentPrice: Math.round(currentPrice * 100000) / 100000,
    priceChange24h: Math.round(((prices[prices.length - 1] - prices[Math.max(0, prices.length - 24)]) / prices[Math.max(0, prices.length - 24)] * 100) * 100) / 100,
  };
}

export function QuantAnalyticsPanel({ decisions = [], queue = [] }: { decisions?: any[]; queue?: any[] }) {
  const [viewportWidth, setViewportWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const isMobile = viewportWidth < 760;

  // Off-thread calculation via web worker
  const workerResult = useAnalyticsWorker(decisions, queue);
  // Fall back to synchronous calculation while worker is warming up
  const metrics = workerResult.metrics ?? calculatePerformanceMetrics(decisions, queue);
  const indicators = workerResult.indicators ?? calculateIndicators(decisions);

  const getScoreColor = (value: number, goodThreshold: number, badThreshold: number) => {
    if (value >= goodThreshold) return C.ok;
    if (value <= badThreshold) return C.danger;
    return C.warn;
  };

  const getRating = (value: number, thresholds: { excellent: number; good: number; fair: number }) => {
    if (value >= thresholds.excellent) return { label: "EXCELLENT", color: C.ok };
    if (value >= thresholds.good) return { label: "GOOD", color: C.accent };
    if (value >= thresholds.fair) return { label: "FAIR", color: C.warn };
    return { label: "NEEDS WORK", color: C.danger };
  };

  const performanceRating = getRating(metrics.sharpeRatio, { excellent: 2.0, good: 1.0, fair: 0.5 });
  const winRateRating = getRating(metrics.winRate, { excellent: 60, good: 55, fair: 50 });
  const riskRating = getRating(metrics.maxDrawdown, { excellent: 10, good: 15, fair: 25 });

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: C.text, fontWeight: 700, ...mono }}>
          Quant Analytics Dashboard
        </div>
        <div style={{ fontSize: 11, color: C.dim }}>
          Performance metrics, advanced indicators, and profit tracking
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
        <Card p={16} style={{ border: `1px solid ${performanceRating.color}40` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <Label>Performance Score</Label>
            <Badge text={performanceRating.label} color={performanceRating.color} />
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: performanceRating.color, ...mono }}>
            {metrics.totalDecisions > 0 ? metrics.sharpeRatio.toFixed(2) : "—"}
          </div>
          <div style={{ fontSize: 10, color: C.dim, ...mono, marginTop: 4 }}>
            Sharpe Ratio (target: 2.0+)
          </div>
        </Card>

        <Card p={16} style={{ border: `1px solid ${winRateRating.color}40` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <Label>Win Rate</Label>
            <Badge text={winRateRating.label} color={winRateRating.color} />
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: winRateRating.color, ...mono }}>
            {metrics.totalDecisions > 0 ? `${metrics.winRate.toFixed(1)}%` : "—"}
          </div>
          <div style={{ fontSize: 10, color: C.dim, ...mono, marginTop: 4 }}>
            Target: 55%+
          </div>
        </Card>

        <Card p={16} style={{ border: `1px solid ${riskRating.color}40` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <Label>Risk Score</Label>
            <Badge text={riskRating.label} color={riskRating.color} />
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: riskRating.color, ...mono }}>
            {metrics.totalDecisions > 0 ? `-${metrics.maxDrawdown.toFixed(1)}%` : "—"}
          </div>
          <div style={{ fontSize: 10, color: C.dim, ...mono, marginTop: 4 }}>
            Max Drawdown (target: 15%-)
          </div>
        </Card>
      </div>

      <Card p={18} style={{ marginBottom: 12 }}>
        <Label style={{ marginBottom: 12 }}>Key Performance Metrics</Label>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)", gap: 10 }}>
          {[
            ["Total Decisions", metrics.totalDecisions, C.text],
            ["ACCUMULATE", metrics.accumulateCount, C.ok],
            ["REDUCE", metrics.reduceCount, C.danger],
            ["HOLD", metrics.holdCount, C.warn],
            ["Avg Confidence", metrics.totalDecisions > 0 ? `${(metrics.avgConfidence * 100).toFixed(0)}%` : "—", metrics.avgConfidence >= 0.75 ? C.ok : C.warn],
            ["Avg Kelly", metrics.totalDecisions > 0 ? `${(metrics.avgKelly * 100).toFixed(1)}%` : "—", C.accent],
            ["Sortino Ratio", metrics.totalDecisions > 0 ? metrics.sortinoRatio.toFixed(2) : "—", getScoreColor(metrics.sortinoRatio, 3, 0.5)],
            ["Calmar Ratio", metrics.totalDecisions > 0 ? metrics.calmarRatio.toFixed(2) : "—", getScoreColor(metrics.calmarRatio, 2, 0.5)],
            ["Profit Factor", metrics.totalDecisions > 0 ? metrics.profitFactor.toFixed(2) : "—", getScoreColor(metrics.profitFactor, 2, 1)],
            ["Avg Win", metrics.avgWinPct > 0 ? `+${metrics.avgWinPct.toFixed(2)}%` : "—", C.ok],
            ["Avg Loss", metrics.avgLossPct > 0 ? `-${metrics.avgLossPct.toFixed(2)}%` : "—", C.danger],
            ["Win Streak", metrics.streakWins, C.ok],
            ["Loss Streak", metrics.streakLosses, C.danger],
            ["VaR (95%)", metrics.var95 > 0 ? `-${metrics.var95.toFixed(2)}%` : "—", C.warn],
            ["CVaR (95%)", metrics.cvar95 > 0 ? `-${metrics.cvar95.toFixed(2)}%` : "—", C.danger],
          ].map(([label, value, color]) => (
            <div key={String(label)} style={{ background: C.s2, borderRadius: 6, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: C.dim, ...mono, marginBottom: 4 }}>{String(label)}</div>
              <div style={{ fontSize: 14, color: color as string, fontWeight: 700, ...mono }}>{String(value)}</div>
            </div>
          ))}
        </div>
      </Card>

      {indicators && (
        <Card p={18} style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <Label>Advanced Technical Indicators</Label>
            <Badge text="LIVE" color={C.ok} dot />
          </div>
          
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
            {[
              ["RSI (14)", indicators.rsi, indicators.rsi > 70 ? C.danger : indicators.rsi < 30 ? C.ok : C.text, 
               indicators.rsi > 70 ? "OVERBOUGHT" : indicators.rsi < 30 ? "OVERSOLD" : "NEUTRAL"],
              ["SMA (20)", indicators.sma20, C.text, `Price ${indicators.priceVsSma20 >= 0 ? "+" : ""}${indicators.priceVsSma20}%`],
              ["SMA (50)", indicators.sma50, C.text, `Price ${indicators.priceVsSma50 >= 0 ? "+" : ""}${indicators.priceVsSma50}%`],
              ["24h Change", `${indicators.priceChange24h >= 0 ? "+" : ""}${indicators.priceChange24h}%`, 
               indicators.priceChange24h > 0 ? C.ok : C.danger, indicators.priceChange24h > 0 ? "GAIN" : "LOSS"],
            ].map(([label, value, color, note]) => (
              <div key={String(label)} style={{ background: C.s2, borderRadius: 6, padding: "12px 14px" }}>
                <div style={{ fontSize: 10, color: C.dim, ...mono, marginBottom: 4 }}>{String(label)}</div>
                <div style={{ fontSize: 16, color: color as string, fontWeight: 700, ...mono }}>{String(value)}</div>
                {note && <div style={{ fontSize: 10, color: C.dim, ...mono, marginTop: 2 }}>{String(note)}</div>}
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Badge text={`TREND: ${indicators.shortTermTrend}`} color={indicators.shortTermTrend === "BULLISH" ? C.ok : C.danger} />
            <Badge text={`MEDIUM: ${indicators.mediumTermTrend}`} color={indicators.mediumTermTrend === "BULLISH" ? C.ok : C.danger} />
            <Badge text={`VOLATILITY: ${indicators.volatility.toFixed(1)}%`} color={indicators.volatility < 30 ? C.ok : indicators.volatility < 60 ? C.warn : C.danger} />
          </div>
        </Card>
      )}

      {!indicators && metrics.totalDecisions > 0 && (
        <Card p={18} style={{ marginBottom: 12, textAlign: "center" }}>
          <div style={{ fontSize: 12, color: C.dim, ...mono }}>Collecting more data points for advanced indicators...</div>
          <div style={{ fontSize: 11, color: C.dim, ...mono, marginTop: 4 }}>Need at least 20 decisions with price data</div>
        </Card>
      )}

      {metrics.totalDecisions > 0 && (
        <Card p={18} style={{ marginBottom: 12 }}>
          <Label style={{ marginBottom: 12 }}>Decision Distribution</Label>
          <div style={{ display: "flex", height: 24, borderRadius: 4, overflow: "hidden", marginBottom: 12 }}>
            {metrics.accumulateCount > 0 && (
              <div style={{ width: `${(metrics.accumulateCount / metrics.totalDecisions) * 100}%`, background: C.ok, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {metrics.accumulateCount / metrics.totalDecisions > 0.1 && <span style={{ fontSize: 10, color: C.s1, ...mono }}>ACC</span>}
              </div>
            )}
            {metrics.reduceCount > 0 && (
              <div style={{ width: `${(metrics.reduceCount / metrics.totalDecisions) * 100}%`, background: C.danger, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {metrics.reduceCount / metrics.totalDecisions > 0.1 && <span style={{ fontSize: 10, color: C.s1, ...mono }}>RED</span>}
              </div>
            )}
            {metrics.holdCount > 0 && (
              <div style={{ width: `${(metrics.holdCount / metrics.totalDecisions) * 100}%`, background: C.warn, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {metrics.holdCount / metrics.totalDecisions > 0.1 && <span style={{ fontSize: 10, color: C.s1, ...mono }}>HOLD</span>}
              </div>
            )}
            {metrics.rebalanceCount > 0 && (
              <div style={{ width: `${(metrics.rebalanceCount / metrics.totalDecisions) * 100}%`, background: C.purple, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {metrics.rebalanceCount / metrics.totalDecisions > 0.1 && <span style={{ fontSize: 10, color: C.s1, ...mono }}>REB</span>}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11, ...mono }}>
            <span style={{ color: C.ok }}>ACCUMULATE: {metrics.accumulateCount}</span>
            <span style={{ color: C.danger }}>REDUCE: {metrics.reduceCount}</span>
            <span style={{ color: C.warn }}>HOLD: {metrics.holdCount}</span>
            <span style={{ color: C.purple }}>REBALANCE: {metrics.rebalanceCount}</span>
          </div>
        </Card>
      )}

      <Card p={18}>
        <Label style={{ marginBottom: 12 }}>Optimization Tips</Label>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {metrics.sharpeRatio < 2 && <div style={{ fontSize: 12, color: C.warn, ...mono }}>* Improve Sharpe Ratio by reducing position sizes during high volatility</div>}
          {metrics.winRate < 55 && <div style={{ fontSize: 12, color: C.warn, ...mono }}>* Win rate below 55%: Consider longer holding periods or wait for stronger momentum</div>}
          {metrics.maxDrawdown > 15 && <div style={{ fontSize: 12, color: C.danger, ...mono }}>* High drawdown: Implement tighter stop losses or reduce Kelly fraction</div>}
          {metrics.profitFactor < 1.5 && <div style={{ fontSize: 12, color: C.warn, ...mono }}>* Profit factor below 1.5: Review risk/reward ratios on losing trades</div>}
          {metrics.totalDecisions < 30 && <div style={{ fontSize: 12, color: C.dim, ...mono }}>* Need more decisions for reliable metrics - keep the agent running</div>}
          {metrics.sharpeRatio >= 2 && metrics.winRate >= 55 && metrics.maxDrawdown < 15 && <div style={{ fontSize: 12, color: C.ok, ...mono }}>* Excellent performance! Consider slightly increasing position sizes</div>}
        </div>
      </Card>
    </div>
  );
}

