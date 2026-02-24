import { useEffect, useRef, useState } from "react";
import { C, mono } from "../../tokens";
import { Badge, Btn, Card, Inp } from "../ui";
import {
  PieChart, Pie, Cell,
  BarChart, Bar,
  LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";

// ─── helpers ─────────────────────────────────────────────────────────────────

const KasValue = ({ value, color = C.text, fontSize = 14 }: { value: string; color?: string; fontSize?: number }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
    <img src="/kas-icon.png" alt="KAS" width={fontSize + 2} height={fontSize + 2} style={{ borderRadius: "50%" }} />
    <span style={{ fontSize, color, fontWeight: 600, ...mono }}>{value}</span>
  </span>
);

function pct(v: number, digits = 1) { return `${Number(v || 0).toFixed(digits)}%`; }

function fmtTs(ts: number) {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
}

// ─── utility components ───────────────────────────────────────────────────────

const ProgressBar = ({ value, max = 100, color = C.accent, height = 6 }: { value: number; max?: number; color?: string; height?: number }) => {
  const fill = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div style={{ width: "100%", height, background: C.s2, borderRadius: height / 2, overflow: "hidden" }}>
      <div style={{ width: `${fill}%`, height: "100%", background: color, borderRadius: height / 2, transition: "width 0.3s ease" }} />
    </div>
  );
};

const CircularGauge = ({ value, max = 100, color = C.accent, size = 56 }: { value: number; max?: number; color?: string; size?: number }) => {
  const fill = Math.min(100, Math.max(0, (value / max) * 100));
  const sw = size / 8;
  const r = (size - sw) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)", flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={C.s2} strokeWidth={sw} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={sw}
        strokeDasharray={circ} strokeDashoffset={circ - (fill / 100) * circ}
        strokeLinecap="round" style={{ transition: "stroke-dashoffset 0.5s ease" }} />
    </svg>
  );
};

// ─── live ticker for a single value ──────────────────────────────────────────
function LiveTicker({ value, prev }: { value: number; prev: number }) {
  const up = value > prev;
  const down = value < prev;
  const color = up ? C.ok : down ? C.danger : C.text;
  return (
    <span style={{ fontSize: 11, color, ...mono, transition: "color 0.4s" }}>
      {up ? "▲" : down ? "▼" : "●"} {value.toFixed(4)}
    </span>
  );
}

// ─── colour palette ──────────────────────────────────────────────────────────
const CHART_COLORS = [C.accent, C.ok, C.purple, C.warn, C.danger, "#8884d8", "#82ca9d", "#ffc658"];

// ─── snapshot history for the compare line chart ─────────────────────────────
type BalanceSnap = { ts: number; label: string; [agentName: string]: number | string };
const MAX_SNAPS = 120;

// ─── main component ───────────────────────────────────────────────────────────
export function PortfolioPanel({
  agents, activeAgentId, walletKas, summary, config,
  onConfigPatch, onAgentOverridePatch, onSelectAgent, onRefresh, onDeleteAgent, onEditAgent,
}: any) {
  const rows: any[] = Array.isArray(summary?.rows) ? summary.rows : [];

  // ── Real-time balance/PnL tracking ─────────────────────────────────────────
  const prevBalance = useRef<Record<string, number>>({});
  const [lastUpdated, setLastUpdated] = useState<number>(0);

  // Balance history for compare chart
  const [balanceHistory, setBalanceHistory] = useState<BalanceSnap[]>([]);
  const [pnlHistory, setPnlHistory] = useState<BalanceSnap[]>([]);

  // Snapshot current balances whenever rows change
  useEffect(() => {
    if (!rows.length) return;
    const now = Date.now();
    setLastUpdated(now);

    // Store previous values for ticker
    prevBalance.current = Object.fromEntries(
      rows.map((r: any) => [r.agentId, Number(r.balanceKas || r.budgetKas || 0)])
    );

    const snap: BalanceSnap = { ts: now, label: fmtTs(now) };
    const pnlSnap: BalanceSnap = { ts: now, label: fmtTs(now) };
    for (const r of rows) {
      snap[r.name] = Number(r.balanceKas || r.budgetKas || 0);
      pnlSnap[r.name] = Number(r.pnlKas || 0);
    }
    setBalanceHistory(h => [...h, snap].slice(-MAX_SNAPS));
    setPnlHistory(h => [...h, pnlSnap].slice(-MAX_SNAPS));
  }, [summary]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Portfolio health ────────────────────────────────────────────────────────
  const health = Math.min(100,
    ((summary?.utilizationPct || 0) * 0.3) +
    (100 - (summary?.concentrationPct || 0)) * 0.3 +
    ((summary?.allocatedKas || 0) / Math.max(1, summary?.targetBudgetKas || 1)) * 40
  );
  const healthColor = health >= 70 ? C.ok : health >= 40 ? C.warn : C.danger;
  const healthLabel = health >= 70 ? "Healthy" : health >= 40 ? "Moderate" : "Needs Attention";

  const totalPnl = rows.reduce((s: number, r: any) => s + Number(r.pnlKas || 0), 0);

  // ── Chart data ──────────────────────────────────────────────────────────────
  const allocationData = rows
    .map((r: any, i: number) => ({ name: r.name, value: Number(r.budgetKas) || 0, color: CHART_COLORS[i % CHART_COLORS.length] }))
    .filter((d: any) => d.value > 0);

  const pnlChartData = rows.map((r: any) => ({
    name: r.name.substring(0, 12),
    PnL: Number(r.pnlKas || 0),
    Balance: Number(r.balanceKas || r.budgetKas || 0),
  }));

  // Agent names for multi-line chart
  const agentNames: string[] = rows.map((r: any) => r.name);

  // Decide which history to show: only render when we have ≥ 2 snapshots
  const showCompareChart = balanceHistory.length >= 2 && agentNames.length > 0;
  const showPnlHistory = pnlHistory.length >= 2 && agentNames.length > 0;

  // ── Tooltip formatters ──────────────────────────────────────────────────────
  const kasTooltipFormatter = (v: number) => [`${Number(v).toFixed(4)} KAS`, ""];
  const tooltipStyle = { background: C.s2, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11 };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 13, color: C.text, fontWeight: 700, ...mono }}>Portfolio</div>
          <div style={{ fontSize: 11, color: C.dim }}>
            Real-time balance & PnL across all deployed agents
            {lastUpdated > 0 && (
              <span style={{ marginLeft: 8, color: C.accent }}>
                · updated {fmtTs(lastUpdated)}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ fontSize: 10, color: C.dim, ...mono, background: C.s2, padding: "4px 10px", borderRadius: 4, border: `1px solid ${C.border}` }}>
            {rows.length} agent{rows.length !== 1 ? "s" : ""} live
          </div>
          <Btn onClick={onRefresh} size="sm" variant="ghost">Refresh</Btn>
        </div>
      </div>

      {/* Portfolio health + key numbers */}
      <Card p={16} style={{ marginBottom: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 16, alignItems: "center", marginBottom: 14 }}>
          <CircularGauge value={health} color={healthColor} size={72} />
          <div>
            <div style={{ fontSize: 11, color: C.dim, ...mono, marginBottom: 4 }}>OVERALL HEALTH</div>
            <div style={{ fontSize: 20, color: healthColor, fontWeight: 700, ...mono, marginBottom: 6 }}>{healthLabel}</div>
            <ProgressBar value={health} color={healthColor} height={6} />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 10 }}>
          {[
            { label: "Wallet Balance", value: <KasValue value={Number(walletKas || 0).toFixed(2)} color={C.accent} />, hint: "Current wallet balance" },
            { label: "Available to Deploy", value: <KasValue value={Number(summary?.allocatableKas || 0).toFixed(2)} />, hint: "After reserves" },
            { label: "Target Budget", value: <KasValue value={Number(summary?.targetBudgetKas || 0).toFixed(2)} color={C.ok} />, hint: "Total allocation target" },
            { label: "Currently Deployed", value: <KasValue value={Number(summary?.allocatedKas || 0).toFixed(2)} />, hint: "Assigned to agents" },
            { label: "Total P&L", value: <span style={{ fontSize: 14, color: totalPnl >= 0 ? C.ok : C.danger, fontWeight: 700, ...mono }}>{totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(4)} KAS</span>, hint: "Combined P&L" },
          ].map(({ label, value, hint }) => (
            <div key={label} title={hint} style={{ background: C.s2, borderRadius: 6, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: C.dim, ...mono, marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 14, fontWeight: 700, ...mono }}>{value}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Allocation by Agent - Simple List */}
      {rows.length > 0 && (
        <Card p={14} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: C.dim, ...mono, marginBottom: 12 }}>ALLOCATION BY AGENT</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rows.map((r: any, i: number) => {
              const allocation = Number(r.budgetKas || 0);
              const totalBudget = rows.reduce((s: number, row: any) => s + Number(row.budgetKas || 0), 0);
              const pct = totalBudget > 0 ? (allocation / totalBudget) * 100 : 0;
              return (
                <div key={r.agentId} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: CHART_COLORS[i % CHART_COLORS.length], flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 100 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: C.text, ...mono }}>{r.name}</span>
                      <span style={{ fontSize: 12, color: C.accent, ...mono }}>{allocation.toFixed(2)} KAS</span>
                    </div>
                    <ProgressBar value={pct} color={CHART_COLORS[i % CHART_COLORS.length]} height={6} />
                  </div>
                  <span style={{ fontSize: 11, color: C.dim, ...mono, minWidth: 40, textAlign: "right" }}>{pct.toFixed(0)}%</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* P&L Comparison */}
      {rows.length > 0 && (
        <Card p={14} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: C.dim, ...mono, marginBottom: 12 }}>P&L COMPARISON</div>
          {pnlChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={pnlChartData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: C.dim }} />
                <YAxis tick={{ fontSize: 10, fill: C.dim }} />
                <Tooltip formatter={(v: number, n: string) => [`${v.toFixed(4)} KAS`, n === "PnL" ? "P&L" : "Balance"]} contentStyle={tooltipStyle} />
                <Bar dataKey="PnL" radius={[4, 4, 0, 0]}>
                  {pnlChartData.map((_: any, i: number) => (
                    <Cell key={i} fill={(pnlChartData[i].PnL ?? 0) >= 0 ? C.ok : C.danger} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: C.dim, fontSize: 12 }}>No P&L data yet</div>
          )}
        </Card>
      )}

      {/* ── REAL-TIME COMPARE CHARTS (live balance & PnL history) ── */}
      {showCompareChart && (
        <Card p={14} style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: C.accent, fontWeight: 700, ...mono }}>⚡ LIVE BALANCE COMPARE</div>
            <span style={{ fontSize: 10, color: C.dim, ...mono }}>{balanceHistory.length} snapshots</span>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={balanceHistory} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="label" tick={{ fontSize: 9, fill: C.dim }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 9, fill: C.dim }} width={55}
                tickFormatter={(v: number) => `${v.toFixed(1)}`} />
              <Tooltip formatter={kasTooltipFormatter as any} contentStyle={tooltipStyle}
                labelStyle={{ color: C.dim, fontSize: 10 }} />
              <Legend wrapperStyle={{ fontSize: 10, color: C.dim }} />
              {agentNames.map((name, i) => (
                <Line key={name} type="monotone" dataKey={name}
                  stroke={CHART_COLORS[i % CHART_COLORS.length]}
                  strokeWidth={2} dot={false} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}

      {showPnlHistory && (
        <Card p={14} style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: C.ok, fontWeight: 700, ...mono }}>📈 LIVE P&L COMPARE</div>
            <span style={{ fontSize: 10, color: C.dim, ...mono }}>{pnlHistory.length} snapshots</span>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={pnlHistory} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="label" tick={{ fontSize: 9, fill: C.dim }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 9, fill: C.dim }} width={60}
                tickFormatter={(v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`} />
              <Tooltip formatter={kasTooltipFormatter as any} contentStyle={tooltipStyle}
                labelStyle={{ color: C.dim, fontSize: 10 }} />
              <Legend wrapperStyle={{ fontSize: 10, color: C.dim }} />
              {agentNames.map((name, i) => (
                <Line key={name} type="monotone" dataKey={name}
                  stroke={CHART_COLORS[i % CHART_COLORS.length]}
                  strokeWidth={2} dot={false} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 10, marginBottom: 14 }}>
        {[
          { label: "Budget In Use", value: pct(summary?.utilizationPct, 1), color: (summary?.utilizationPct || 0) >= 80 ? C.ok : C.warn, sub: "target 80%+" },
          { label: "Biggest Single Agent", value: pct(summary?.concentrationPct, 1), color: (summary?.concentrationPct || 0) > 55 ? C.warn : C.ok, sub: "lower = more diversified" },
          { label: "Active Agents", value: String(Array.isArray(agents) ? agents.length : 0), color: C.text, sub: "in shared pool" },
        ].map(({ label, value, color, sub }) => (
          <Card key={label} p={14}>
            <div style={{ fontSize: 10, color: C.dim, ...mono, marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 20, color, fontWeight: 700, ...mono }}>{value}</div>
            <div style={{ fontSize: 10, color: C.dim, marginTop: 4 }}>{sub}</div>
          </Card>
        ))}
      </div>

      {/* Allocator settings (collapsed) */}
      <Card p={14} style={{ marginBottom: 14 }}>
        <details>
          <summary style={{ cursor: "pointer", listStyle: "none", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, color: C.dim, ...mono }}>Advanced Settings</span>
            <span style={{ fontSize: 10, color: C.dim }}>▼</span>
          </summary>
          <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12 }}>
            <Inp label="Total Budget % of Wallet"
              value={String(Math.round(Number(config?.totalBudgetPct || 0) * 10000) / 100)}
              onChange={(v: string) => onConfigPatch({ totalBudgetPct: Math.max(5, Math.min(100, Number(v) || 0)) / 100 })}
              type="number" suffix="%" hint="What percentage of your wallet balance agents can use" />
            <Inp label="Reserve (always keep)"
              value={String(config?.reserveKas ?? 0)}
              onChange={(v: string) => onConfigPatch({ reserveKas: Math.max(0, Number(v) || 0) })}
              type="number" suffix="KAS" hint="KAS to always keep untouched" />
            <Inp label="Max Per Agent %"
              value={String(Math.round(Number(config?.maxAgentAllocationPct || 0) * 10000) / 100)}
              onChange={(v: string) => onConfigPatch({ maxAgentAllocationPct: Math.max(5, Math.min(100, Number(v) || 0)) / 100 })}
              type="number" suffix="%" hint="No single agent can get more than this share" />
            <Inp label="Rebalance Threshold %"
              value={String(Math.round(Number(config?.rebalanceThresholdPct || 0) * 10000) / 100)}
              onChange={(v: string) => onConfigPatch({ rebalanceThresholdPct: Math.max(1, Math.min(50, Number(v) || 0)) / 100 })}
              type="number" suffix="%" hint="Only trigger rebalance when drift exceeds this" />
          </div>
        </details>
      </Card>

      {/* ── Per-Agent Cards with live balance/PnL ── */}
      <Card p={0}>
        <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, background: C.s2, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: C.dim, ...mono }}>AGENTS · REAL-TIME</span>
          <span style={{ fontSize: 11, color: C.dim, ...mono }}>{rows.length} in pool</span>
        </div>

        {rows.length === 0 && (
          <div style={{ padding: 32, textAlign: "center", fontSize: 12, color: C.dim }}>No agents deployed yet.</div>
        )}

        {rows.map((row: any, idx: number) => {
          const isActive = row.agentId === activeAgentId;
          const riskC = row.risk <= 0.4 ? C.ok : row.risk <= 0.7 ? C.warn : C.danger;
          const pnl = Number(row.pnlKas || 0);
          const bal = Number(row.balanceKas || row.budgetKas || 0);
          const prevBal = prevBalance.current[row.agentId] ?? bal;
          const agentColor = CHART_COLORS[idx % CHART_COLORS.length];

          return (
            <div key={row.agentId} style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, background: isActive ? `${C.accent}08` : "transparent" }}>
              {/* Name row */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {/* Colour dot matching chart line */}
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: agentColor, display: "inline-block", flexShrink: 0 }} />
                  <button
                    onClick={() => onSelectAgent?.(row.agentId)}
                    style={{
                      background: isActive ? C.aLow : "transparent",
                      border: `1px solid ${isActive ? C.accent : C.border}`,
                      color: isActive ? C.accent : C.text,
                      borderRadius: 6, padding: "6px 12px", cursor: "pointer",
                      fontSize: 12, fontWeight: 600, ...mono,
                    }}
                  >
                    {row.name}
                  </button>
                  <Badge text={row.enabled ? "Active" : "Disabled"} color={row.enabled ? C.ok : C.dim} />
                  {/* Live PnL ticker */}
                  <LiveTicker value={bal} prev={prevBal} />
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: pnl >= 0 ? C.ok : C.danger, fontWeight: 700, ...mono }}>
                    {pnl >= 0 ? "▲ +" : "▼ "}{pnl.toFixed(4)} KAS P&L
                  </span>
                  <Badge text={`Risk: ${row.risk <= 0.4 ? "Low" : row.risk <= 0.7 ? "Med" : "High"}`} color={riskC} />
                  <button onClick={() => onEditAgent?.(row)} title="Edit agent"
                    style={{ background: C.s2, border: `1px solid ${C.border}`, color: C.dim, borderRadius: 4, padding: "4px 8px", cursor: "pointer", fontSize: 11, ...mono }}>
                    ✏️ Edit
                  </button>
                  <button
                    onClick={() => { if (window.confirm(`Delete agent "${row.name}"? This cannot be undone.`)) { onDeleteAgent?.(row.agentId); } }}
                    title="Delete agent"
                    style={{ background: C.dLow, border: `1px solid ${C.danger}50`, color: C.danger, borderRadius: 4, padding: "4px 8px", cursor: "pointer", fontSize: 11, ...mono }}>
                    🗑️ Delete
                  </button>
                </div>
              </div>

              {/* Key numbers */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(100px,1fr))", gap: 8, marginBottom: 10 }}>
                {[
                  { label: "Cycle Budget", value: <KasValue value={row.cycleCapKas} color={C.ok} />, hint: "Max KAS this agent can trade per cycle" },
                  { label: "Total Budget", value: <KasValue value={row.budgetKas} />, hint: "Total KAS allocated" },
                  {
                    label: "Live Balance",
                    value: <KasValue value={bal.toFixed(4)} color={C.accent} />,
                    hint: "Current balance for this agent",
                  },
                  {
                    label: "P&L",
                    value: <span style={{ fontSize: 13, fontWeight: 600, ...mono, color: pnl >= 0 ? C.ok : C.danger }}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(4)} KAS</span>,
                    hint: `PnL (${row.pnlMode || "estimated"})`,
                  },
                  { label: "Portfolio Share", value: pct(row.targetPct, 1), hint: "Target % of total portfolio" },
                  { label: "Queue Activity", value: pct(row.queuePressurePct, 1), hint: "How busy the execution queue is" },
                ].map(({ label, value, hint }) => (
                  <div key={label} title={hint} style={{ background: C.s2, borderRadius: 6, padding: "8px 10px" }}>
                    <div style={{ fontSize: 10, color: C.dim, ...mono, marginBottom: 2 }}>{label}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, ...mono }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* PnL progress bar vs budget */}
              {bal > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: C.dim, ...mono }}>Balance vs Budget</span>
                    <span style={{ fontSize: 10, color: C.dim, ...mono }}>{((bal / Math.max(1, Number(row.budgetKas))) * 100).toFixed(1)}%</span>
                  </div>
                  <ProgressBar
                    value={(bal / Math.max(1, Number(row.budgetKas))) * 100}
                    color={agentColor}
                    height={4}
                  />
                </div>
              )}

              {/* Notes */}
              {(row.notes || []).length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                  {(row.notes || []).map((note: string) => (
                    <Badge key={note} text={note.replace(/_/g, " ")} color={C.warn} />
                  ))}
                </div>
              )}

              {/* Advanced overrides */}
              <details>
                <summary style={{ cursor: "pointer", listStyle: "none" }}>
                  <span style={{ fontSize: 10, color: C.dim, ...mono }}>Override settings ▼</span>
                </summary>
                <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, background: C.s2, padding: "10px 12px", borderRadius: 6, cursor: "pointer" }}>
                    <input type="checkbox" checked={row.enabled}
                      onChange={(e) => onAgentOverridePatch?.(row.agentId, { enabled: e.target.checked })}
                      style={{ width: 16, height: 16, accentColor: C.accent }} />
                    <span style={{ fontSize: 11, color: C.text, ...mono }}>Enabled</span>
                  </label>
                  <Inp label="Target Allocation %"
                    value={String(row.targetPct)}
                    onChange={(v: string) => onAgentOverridePatch?.(row.agentId, { targetAllocationPct: Math.max(0, Math.min(100, Number(v) || 0)) })}
                    type="number" suffix="%" hint="Desired portfolio share for this agent" />
                  <Inp label="Risk Weight"
                    value={String(row.riskWeight)}
                    onChange={(v: string) => onAgentOverridePatch?.(row.agentId, { riskWeight: Math.max(0, Math.min(10, Number(v) || 0)) })}
                    type="number" hint="Allocator weight multiplier" />
                </div>
              </details>
            </div>
          );
        })}
      </Card>
    </div>
  );
}
