export const DEFS = {
  name:"", kpiTarget:"12", capitalLimit:"5000", risk:"medium", execMode:"manual",
  autoApproveThreshold:"50",
  kpiMetric:"ROI %", horizon:30, revenueSource:"momentum",
  dataSources:["KAS On-Chain","Kaspa DAG"], frequency:"1h",
  strategyTemplate:"dca_accumulator",
  strategyLabel:"Steady DCA Builder",
  strategyClass:"accumulation",
  riskBudgetWeight:"1.0",
  portfolioAllocationPct:"25",
};

export const STRATEGY_TEMPLATES = [
  {
    id: "dca_accumulator",
    name: "Steady DCA Builder",
    tag: "ACCUMULATION",
    tagColor: "#00C2A8", // Kaspa green
    class: "accumulation",
    purpose: "Core accumulation engine for steady inventory growth with low drawdown behavior.",
    bestFor: "Range-to-neutral regimes, long accumulation windows, disciplined compounding.",
    desc: "Frequent small entries, strict downside control, and conservative auto-execution thresholds.",
    defaults: {
      risk: "low",
      kpiTarget: "10",
      horizon: 90,
      frequency: "4h",
      revenueSource: "accumulation",
      execMode: "manual",
      autoApproveThreshold: "25",
    },
  },
  {
    id: "trend",
    name: "Trend Rider",
    tag: "MOMENTUM",
    tagColor: "#7C3AED", // Purple
    class: "momentum",
    purpose: "Compound into persistent directional moves while protecting against reversals.",
    bestFor: "Clear momentum regimes with stable liquidity and improving edge score.",
    desc: "Scales entries with trend persistence and tightens risk when momentum degrades.",
    defaults: {
      risk: "medium",
      kpiTarget: "18",
      horizon: 45,
      frequency: "1h",
      revenueSource: "trend",
      execMode: "manual",
      autoApproveThreshold: "40",
    },
  },
  {
    id: "mean_reversion",
    name: "Dip Harvester",
    tag: "REVERSION",
    tagColor: "#F59E0B", // Amber
    class: "reversion",
    purpose: "Accumulate discounted KAS during temporary weakness without chasing breakouts.",
    bestFor: "Range regimes, oversold snaps, and volatility normalization after spikes.",
    desc: "Buys weakness with quant-regime gating and reduced chase behavior.",
    defaults: {
      risk: "low",
      kpiTarget: "14",
      horizon: 30,
      frequency: "30m",
      revenueSource: "mean-reversion",
      execMode: "manual",
      autoApproveThreshold: "20",
    },
  },
  {
    id: "vol_breakout",
    name: "Volatility Expansion Hunter",
    tag: "BREAKOUT",
    tagColor: "#EF4444", // Red
    class: "breakout",
    purpose: "Exploit expansion regimes with tighter automation controls and rapid reviews.",
    bestFor: "Breakout conditions, elevated DAA activity, and strong regime transitions.",
    desc: "Responds to volatility expansion while preserving accumulation-only discipline.",
    defaults: {
      risk: "medium",
      kpiTarget: "22",
      horizon: 21,
      frequency: "15m",
      revenueSource: "breakout",
      execMode: "notify",
      autoApproveThreshold: "15",
    },
  },
];

export const RISK_OPTS = [
  {v:"low",l:"Low",desc:"Tight stops. Max 5% exposure per action."},
  {v:"medium",l:"Medium",desc:"Balanced Kelly sizing. 10% max exposure."},
  {v:"high",l:"High",desc:"Aggressive. 20% max. Wide targets."},
];

export const EXEC_OPTS = [
  {v:"autonomous",l:"Fully Autonomous",desc:"Auto-signs under threshold. Manual above."},
  {v:"manual",l:"Manual Approval",desc:"Every action requires wallet signature."},
  {v:"notify",l:"Notify Only",desc:"Decisions generated, no execution."},
];
