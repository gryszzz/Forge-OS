import { C, mono } from "../../tokens";

type Props = {
  networkLabel: string;
  status: string;
  execMode: string;
  liveExecutionArmed: boolean;
  autoCycleCountdownLabel: string;
  lastDecisionSource: string;
  usage: { used: number; limit: number; locked?: boolean };
  executionGuardrails: any;
  receiptConsistencyMetrics: any;
  // New: explicitly wired account-state badges
  isAccumulateOnly: boolean;
  walletProvider: string;
  quantClientMode: string;
};

function decisionSourceBadgeColor(source: string) {
  const normalized = String(source || "").toLowerCase();
  if (normalized === "hybrid-ai") return C.accent;
  if (normalized === "quant-core") return C.text;
  if (normalized === "fallback") return C.warn;
  return C.purple;
}

function getSourceIcon(source: string) {
  const normalized = String(source || "").toLowerCase();
  if (normalized === "hybrid-ai") return "🤖";
  if (normalized === "ai") return "🧠";
  if (normalized === "quant-core") return "📊";
  return "⚡";
}

function getCalibrationIcon(tier: string) {
  if (tier === "critical") return "🔴";
  if (tier === "degraded") return "🟡";
  if (tier === "warn") return "🟠";
  return "🟢";
}

function getTruthIcon(degraded: boolean) {
  return degraded ? "⚠️" : "✅";
}

// Chip badge for the account-state row
function Chip({ label, active, color, icon }: { label: string; active: boolean; color: string; icon?: string }) {
  if (!active) return null;
  return (
    <div style={{
      background: `${color}18`,
      padding: "5px 11px",
      borderRadius: 5,
      border: `1px solid ${color}60`,
      display: "flex",
      alignItems: "center",
      gap: 5,
    }}>
      {icon && <span style={{ fontSize: 12 }}>{icon}</span>}
      <span style={{ fontSize: 11, color, fontWeight: 700, ...mono, letterSpacing: "0.06em" }}>{label}</span>
    </div>
  );
}

export function DashboardMissionControlBadges(props: Props) {
  const {
    networkLabel,
    status,
    execMode,
    liveExecutionArmed,
    autoCycleCountdownLabel,
    lastDecisionSource,
    usage,
    executionGuardrails,
    receiptConsistencyMetrics: _rcm,
    isAccumulateOnly,
    walletProvider,
    quantClientMode,
  } = props;

  const calTier = String(executionGuardrails?.calibration?.tier || "healthy").toLowerCase();
  const truthDegraded = executionGuardrails?.truth?.degraded;
  const isAutonomous = execMode === "autonomous";
  const isWorker = quantClientMode === "worker";
  const providerUpper = String(walletProvider || "").toUpperCase();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* ── Account-state chips: these 5 are specifically wired to account settings ── */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {/* AUTONOMOUS — only visible when exec mode is autonomous */}
        <Chip label="AUTONOMOUS" active={isAutonomous} color={C.accent} icon="🤖" />

        {/* LIVE EXEC ON — only visible when live execution is armed */}
        <Chip label="LIVE EXEC ON" active={liveExecutionArmed} color={C.ok} icon="🚀" />

        {/* ACCUMULATE-ONLY — only visible when env flag is on */}
        <Chip label="ACCUMULATE-ONLY" active={isAccumulateOnly} color={C.ok} icon="♻️" />

        {/* KASWARE / wallet provider — shows actual provider name */}
        {walletProvider && (
          <div style={{
            background: `${C.purple}18`,
            padding: "5px 11px",
            borderRadius: 5,
            border: `1px solid ${C.purple}60`,
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}>
            <span style={{ fontSize: 11 }}>👛</span>
            <span style={{ fontSize: 11, color: C.purple, fontWeight: 700, ...mono, letterSpacing: "0.06em" }}>
              {providerUpper}
            </span>
          </div>
        )}

        {/* ENGINE WORKER — only visible when quant engine runs in worker thread */}
        <Chip label="ENGINE WORKER" active={isWorker} color={C.ok} icon="⚙️" />
      </div>

      {/* ── Runtime status row ── */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {/* Network */}
        <div style={{ background: C.s2, padding: "5px 10px", borderRadius: 5, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 9, color: C.dim, ...mono }}>NET</span>
          <span style={{ fontSize: 10, color: C.text, fontWeight: 700, ...mono }}>{networkLabel.toUpperCase()}</span>
        </div>

        {/* Agent status */}
        <div style={{ background: status === "RUNNING" ? `${C.ok}20` : `${C.dim}20`, padding: "5px 10px", borderRadius: 5, border: `1px solid ${status === "RUNNING" ? C.ok : C.dim}`, display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 12 }}>{status === "RUNNING" ? "🟢" : status === "PAUSED" ? "🟡" : "⚫"}</span>
          <span style={{ fontSize: 10, color: status === "RUNNING" ? C.ok : status === "PAUSED" ? C.warn : C.dim, fontWeight: 700, ...mono }}>{status}</span>
        </div>

        {/* Auto Cycle */}
        <div style={{ background: C.s2, padding: "5px 10px", borderRadius: 5, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 12 }}>⏱️</span>
          <span style={{ fontSize: 10, color: status === "RUNNING" ? C.text : C.dim, fontWeight: 700, ...mono }}>{autoCycleCountdownLabel}</span>
        </div>

        {/* Decision Source */}
        <div style={{ background: `${decisionSourceBadgeColor(lastDecisionSource)}15`, padding: "5px 10px", borderRadius: 5, border: `1px solid ${decisionSourceBadgeColor(lastDecisionSource)}40`, display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 12 }}>{getSourceIcon(lastDecisionSource)}</span>
          <span style={{ fontSize: 10, color: decisionSourceBadgeColor(lastDecisionSource), fontWeight: 700, ...mono }}>{lastDecisionSource.toUpperCase()}</span>
        </div>

        {/* Cycles Used */}
        <div style={{ background: C.s2, padding: "5px 10px", borderRadius: 5, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 12 }}>🔄</span>
          <span style={{ fontSize: 10, color: C.text, fontWeight: 700, ...mono }}>
            {usage.used} / {usage.limit >= 999 ? "∞" : usage.limit}
          </span>
        </div>

        {/* Calibration */}
        <div style={{
          background: calTier === "critical" ? `${C.danger}20` : calTier === "degraded" || calTier === "warn" ? `${C.warn}20` : `${C.ok}20`,
          padding: "5px 10px",
          borderRadius: 5,
          border: `1px solid ${calTier === "critical" ? C.danger : calTier === "degraded" || calTier === "warn" ? C.warn : C.ok}`,
          display: "flex",
          alignItems: "center",
          gap: 5,
        }}>
          <span style={{ fontSize: 12 }}>{getCalibrationIcon(calTier)}</span>
          <span style={{ fontSize: 10, color: calTier === "critical" ? C.danger : calTier === "degraded" || calTier === "warn" ? C.warn : C.ok, fontWeight: 700, ...mono }}>
            CAL {Number(executionGuardrails?.calibration?.health || 1).toFixed(2)}
          </span>
        </div>

        {/* Truth */}
        <div style={{
          background: truthDegraded ? `${C.danger}20` : `${C.ok}20`,
          padding: "5px 10px",
          borderRadius: 5,
          border: `1px solid ${truthDegraded ? C.danger : C.ok}`,
          display: "flex",
          alignItems: "center",
          gap: 5,
        }}>
          <span style={{ fontSize: 12 }}>{getTruthIcon(truthDegraded)}</span>
          <span style={{ fontSize: 10, color: truthDegraded ? C.danger : C.ok, fontWeight: 700, ...mono }}>
            {truthDegraded ? `${Number(executionGuardrails?.truth?.mismatchRatePct || 0).toFixed(1)}%` : "VERIFIED"}
          </span>
        </div>
      </div>
    </div>
  );
}
