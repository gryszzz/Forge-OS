import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ACCUMULATE_ONLY,
  ACCUMULATION_VAULT,
  AGENT_SPLIT,
  AUTO_CYCLE_SECONDS,
  CONF_THRESHOLD,
  EXPLORER,
  FEE_RATE,
  FREE_CYCLES_PER_DAY,
  KAS_WS_URL,
  LIVE_EXECUTION_DEFAULT,
  DEFAULT_NETWORK,
  NETWORK_LABEL,
  NET_FEE,
  RESERVE,
  TREASURY_SPLIT,
  TREASURY,
  TREASURY_FEE_KAS,
  TREASURY_FEE_ONCHAIN_ENABLED,
  PNL_REALIZED_CONFIRMATION_POLICY,
  PNL_REALIZED_MIN_CONFIRMATIONS,
} from "../../constants";
import { fmtT, shortAddr, uid } from "../../helpers";
import { runQuantEngineClient, getQuantEngineClientMode } from "../../quant/runQuantEngineClient";
import { LOG_COL, seedLog } from "../../log/seedLog";
import { C, mono } from "../../tokens";
import { consumeUsageCycle, getUsageState } from "../../runtime/usageQuota";
import { derivePnlAttribution } from "../../analytics/pnlAttribution";
import { formatForgeError, normalizeError } from "../../runtime/errorTaxonomy";
import { buildQueueTxItem } from "../../tx/queueTx";
import { WalletAdapter } from "../../wallet/WalletAdapter";
import { useAgentLifecycle } from "./hooks/useAgentLifecycle";
import { useAutoCycleLoop } from "./hooks/useAutoCycleLoop";
import { useAlerts } from "./hooks/useAlerts";
import { useDashboardRuntimePersistence } from "./hooks/useDashboardRuntimePersistence";
import { useDashboardUiSummary } from "./hooks/useDashboardUiSummary";
import { useExecutionGuardrailsPolicy } from "./hooks/useExecutionGuardrailsPolicy";
import { useExecutionQueue } from "./hooks/useExecutionQueue";
import { useKaspaFeed } from "./hooks/useKaspaFeed";
import { usePortfolioAllocator } from "./hooks/usePortfolioAllocator";
import { useTreasuryPayout } from "./hooks/useTreasuryPayout";
import { SigningModal } from "../SigningModal";
import { Badge, Btn, Card, ExtLink, Label } from "../ui";
import { EXEC_OPTS } from "../wizard/constants";
import { ActionQueue } from "./ActionQueue";
import { DashboardMissionControlBadges } from "./DashboardMissionControlBadges";
import { DashboardRuntimeNotices } from "./DashboardRuntimeNotices";
import { WalletPanel } from "./WalletPanel";

const PerfChart = lazy(() => import("./PerfChart").then((m) => ({ default: m.PerfChart })));
const IntelligencePanel = lazy(() =>
  import("./IntelligencePanel").then((m) => ({ default: m.IntelligencePanel }))
);
const TreasuryPanel = lazy(() => import("./TreasuryPanel").then((m) => ({ default: m.TreasuryPanel })));
const PortfolioPanel = lazy(() => import("./PortfolioPanel").then((m) => ({ default: m.PortfolioPanel })));
const PnlAttributionPanel = lazy(() =>
  import("./PnlAttributionPanel").then((m) => ({ default: m.PnlAttributionPanel }))
);
const AlertsPanel = lazy(() => import("./AlertsPanel").then((m) => ({ default: m.AlertsPanel })));

export function Dashboard({agent, wallet, agents = [], activeAgentId, onSelectAgent}: any) {
  const LIVE_POLL_MS = 5000;
  const STREAM_RECONNECT_MAX_DELAY_MS = 12000;
  const RECEIPT_RETRY_BASE_MS = 2000;
  const RECEIPT_RETRY_MAX_MS = 30000;
  const RECEIPT_TIMEOUT_MS = 8 * 60 * 1000;
  const RECEIPT_MAX_ATTEMPTS = 18;
  const RECEIPT_POLL_INTERVAL_MS = 1200;
  const RECEIPT_POLL_BATCH_SIZE = 2;
  const MAX_QUEUE_ENTRIES = 160;
  const MAX_LOG_ENTRIES = 320;
  const MAX_DECISION_ENTRIES = 120;
  const MAX_MARKET_SNAPSHOTS = 240;
  const cycleIntervalMs = AUTO_CYCLE_SECONDS * 1000;
  const usageScope = `${DEFAULT_NETWORK}:${String(wallet?.address || "unknown").toLowerCase()}`;
  const portfolioScope = usageScope;
  const alertScope = usageScope;
  const runtimeScope = `${DEFAULT_NETWORK}:${String(wallet?.address || "unknown").toLowerCase()}:${String(agent?.agentId || agent?.name || "default").toLowerCase()}`;
  const cycleLockRef = useRef(false);
  const lastRegimeRef = useRef("");
  const [runtimeHydrated, setRuntimeHydrated] = useState(false);
  const [tab, setTab] = useState("overview");
  const { status, setStatus, transitionAgentStatus } = useAgentLifecycle("RUNNING");
  const [log, setLog] = useState(()=>seedLog(agent.name));
  const [decisions, setDecisions] = useState([] as any[]);
  const [loading, setLoading] = useState(false);
  const [execMode, setExecMode] = useState(agent.execMode || "manual");
  const [autoThresh] = useState(parseFloat(agent.autoApproveThreshold) || 50);
  const [usage, setUsage] = useState(() => getUsageState(FREE_CYCLES_PER_DAY, usageScope));
  const [liveExecutionArmed, setLiveExecutionArmed] = useState(LIVE_EXECUTION_DEFAULT);
  const [nextAutoCycleAt, setNextAutoCycleAt] = useState(() => Date.now() + cycleIntervalMs);
  const [viewportWidth, setViewportWidth] = useState(
    typeof window !== "undefined" ? window.innerWidth : 1200
  );
  const quantClientMode = useMemo(() => getQuantEngineClientMode(), []);

  const {
    kasData,
    marketHistory,
    setMarketHistory,
    kasDataLoading,
    kasDataError,
    liveConnected,
    streamConnected,
    streamRetryCount,
    refreshKasData,
  } = useKaspaFeed({
    walletAddress: wallet?.address,
    wsUrl: KAS_WS_URL,
    livePollMs: LIVE_POLL_MS,
    streamReconnectMaxDelayMs: STREAM_RECONNECT_MAX_DELAY_MS,
    maxMarketSnapshots: MAX_MARKET_SNAPSHOTS,
  });

  const addLog = useCallback(
    (e: any) => setLog((p: any) => [{ ts: Date.now(), ...e }, ...p].slice(0, MAX_LOG_ENTRIES)),
    [MAX_LOG_ENTRIES]
  );
  const activeStrategyLabel = String(agent?.strategyLabel || agent?.strategyTemplate || "Custom");
  const {
    alertConfig,
    alertSaveBusy,
    lastAlertResult,
    sendAlertEvent,
    patchAlertConfig,
    toggleAlertType,
    saveAlertConfig,
    sendTestAlert,
  } = useAlerts({
    alertScope,
    agentName: agent?.name,
    agentId: agent?.agentId,
    activeStrategyLabel,
  });
  const {
    queue,
    setQueue,
    signingItem,
    pendingCount,
    sendWalletTransfer,
    receiptBackoffMs,
    prependQueueItem,
    prependSignedBroadcastedQueueItem,
    handleQueueSign,
    handleQueueReject,
    handleSigningReject,
    handleSigned: handleSignedBase,
    rejectAllPending,
    receiptConsistencyMetrics,
  } = useExecutionQueue({
    wallet,
    maxQueueEntries: MAX_QUEUE_ENTRIES,
    addLog,
    kasPriceUsd: Number(kasData?.priceUsd || 0),
    setTab,
    receiptRetryBaseMs: RECEIPT_RETRY_BASE_MS,
    receiptRetryMaxMs: RECEIPT_RETRY_MAX_MS,
    receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
    receiptMaxAttempts: RECEIPT_MAX_ATTEMPTS,
    receiptPollIntervalMs: RECEIPT_POLL_INTERVAL_MS,
    receiptPollBatchSize: RECEIPT_POLL_BATCH_SIZE,
    sendAlertEvent,
    agentName: agent?.name,
    agentId: agent?.agentId,
  });

  const { settleTreasuryFeePayout, attachCombinedTreasuryOutput } = useTreasuryPayout({
    enabled: TREASURY_FEE_ONCHAIN_ENABLED,
    treasuryFeeKas: TREASURY_FEE_KAS,
    treasuryAddress: TREASURY,
    walletAddress: wallet?.address,
    walletProvider: wallet?.provider,
    kasPriceUsd: Number(kasData?.priceUsd || 0),
    maxQueueEntries: MAX_QUEUE_ENTRIES,
    addLog,
    setQueue,
    sendWalletTransfer,
    receiptBackoffMs,
  });

  useEffect(() => {
    setUsage(getUsageState(FREE_CYCLES_PER_DAY, usageScope));
  }, [usageScope]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (status === "RUNNING") {
      setNextAutoCycleAt(Date.now() + cycleIntervalMs);
    }
  }, [status, cycleIntervalMs]);

  useEffect(() => {
    // Migrate legacy persisted tab value after billing/paywall UI removal.
    if (tab === "billing") setTab("treasury");
  }, [tab]);

  const riskThresh = agent.risk==="low"?0.4:agent.risk==="medium"?0.65:0.85;
  const allAgents = useMemo(() => {
    const source = Array.isArray(agents) && agents.length > 0 ? agents : [agent];
    const deduped = new Map<string, any>();
    for (const row of source) {
      const id = String(row?.agentId || row?.name || "").trim();
      if (!id) continue;
      deduped.set(id, row);
    }
    return Array.from(deduped.values());
  }, [agent, agents]);

  const pnlAttributionBase = useMemo(
    () =>
      derivePnlAttribution({
        decisions,
        queue,
        log,
        marketHistory,
        realizedMinConfirmations: PNL_REALIZED_MIN_CONFIRMATIONS,
        confirmationDepthPolicy: PNL_REALIZED_CONFIRMATION_POLICY as any,
      }),
    [decisions, queue, log, marketHistory]
  );
  const executionGuardrails = useExecutionGuardrailsPolicy({
    pnlAttribution: pnlAttributionBase,
    receiptConsistencyMetrics,
  });
  const pnlAttribution = useMemo(() => {
    const truth = executionGuardrails.truth;
    const base = pnlAttributionBase as any;
    const downgradedMode =
      truth.degraded && String(base?.netPnlMode || "") === "realized"
        ? "hybrid"
        : base?.netPnlMode;
    return {
      ...base,
      netPnlMode: downgradedMode,
      truthDegraded: truth.degraded,
      truthDegradedReason: truth.reasons?.[0] || "",
      truthMismatchRatePct: truth.mismatchRatePct,
      truthCheckedSignals: truth.checked,
      truthMismatchSignals: truth.mismatches,
    };
  }, [executionGuardrails.truth, pnlAttributionBase]);

  useDashboardRuntimePersistence({
    agent,
    cycleIntervalMs,
    runtimeScope,
    maxDecisionEntries: MAX_DECISION_ENTRIES,
    maxLogEntries: MAX_LOG_ENTRIES,
    maxQueueEntries: MAX_QUEUE_ENTRIES,
    maxMarketSnapshots: MAX_MARKET_SNAPSHOTS,
    runtimeHydrated,
    setRuntimeHydrated,
    status,
    execMode,
    liveExecutionArmed,
    queue,
    log,
    decisions,
    marketHistory,
    attributionSummary: pnlAttribution,
    nextAutoCycleAt,
    setStatus,
    setExecMode,
    setLiveExecutionArmed,
    setQueue,
    setLog,
    setDecisions,
    setMarketHistory,
    setNextAutoCycleAt,
    liveExecutionDefault: LIVE_EXECUTION_DEFAULT,
  });

  const {
    portfolioConfig,
    portfolioSummary,
    activePortfolioRow,
    patchPortfolioConfig,
    patchPortfolioAgentOverride,
    refreshPortfolioPeers,
  } = usePortfolioAllocator({
    portfolioScope,
    allAgents,
    activeAgentId: agent?.agentId,
    walletAddress: wallet?.address,
    walletKas: Number(kasData?.walletKas || 0),
    activeDecisions: decisions,
    activeQueue: queue,
    activeAttributionSummary: pnlAttribution,
  });

  const runCycle = useCallback(async()=>{
    if (cycleLockRef.current || status!=="RUNNING" || !runtimeHydrated) return;
    cycleLockRef.current = true;
    setLoading(true);
    try{
      if(!kasData){
        addLog({type:"ERROR", msg:"No live Kaspa data available. Reconnect feed before running cycle.", fee:null});
        return;
      }

      setNextAutoCycleAt(Date.now() + cycleIntervalMs);
      addLog({type:"DATA", msg:`Kaspa DAG snapshot: DAA ${kasData?.dag?.daaScore||"—"} · Wallet ${kasData?.walletKas||"—"} KAS`, fee:null});
      setUsage(consumeUsageCycle(FREE_CYCLES_PER_DAY, usageScope));

      const dec = await runQuantEngineClient(agent, kasData||{}, { history: marketHistory });
      const decSource = String(dec?.decision_source || "ai");
      const quantRegime = String(dec?.quant_metrics?.regime || "NA");
      if (ACCUMULATE_ONLY && !["ACCUMULATE", "HOLD"].includes(dec.action)) {
        dec.action = "HOLD";
        dec.rationale = `${String(dec.rationale || "")} Execution constrained by accumulate-only mode.`.trim();
      }
      const decisionTs = Date.now();
      setDecisions((p: any)=>[{ts:decisionTs, dec, kasData, source:decSource}, ...p].slice(0, MAX_DECISION_ENTRIES));

      addLog({
        type:"AI",
        msg:`${dec.action} · Conf ${dec.confidence_score} · Kelly ${(dec.kelly_fraction*100).toFixed(1)}% · Monte Carlo ${dec.monte_carlo_win_pct}% win · regime:${quantRegime} · source:${decSource} · ${dec?.engine_latency_ms || 0}ms`,
        fee:0.12,
      });
      if (dec?.quant_metrics) {
        addLog({
          type:"DATA",
          msg:`Quant core → samples ${dec.quant_metrics.sample_count ?? "—"} · edge ${dec.quant_metrics.edge_score ?? "—"} · vol ${dec.quant_metrics.ewma_volatility ?? "—"} · dataQ ${dec.quant_metrics.data_quality_score ?? "—"}`,
          fee:null,
        });
      }
      if (decSource === "fallback" || decSource === "quant-core") {
        addLog({
          type:"SYSTEM",
          msg:`Local quant decision active (${dec?.decision_source_detail || "ai endpoint unavailable"}). Auto-approve uses same guardrails; AI overlay unavailable or bypassed.`,
          fee:null,
        });
        if (/ai_|timeout|endpoint|transport|request/i.test(String(dec?.decision_source_detail || ""))) {
          void sendAlertEvent({
            type: "ai_outage",
            key: `ai_outage:${String(agent?.agentId || agent?.name || "agent")}`,
            title: `${agent?.name || "Agent"} AI overlay unavailable`,
            message: `Quant core fallback active. detail=${String(dec?.decision_source_detail || "n/a")}`,
            severity: "warn",
            meta: { decision_source: decSource, regime: quantRegime },
          });
        }
      }

      const confOk = dec.confidence_score>=CONF_THRESHOLD;
      const riskOk = dec.risk_score<=riskThresh;
      const calibrationSizeMultiplier = Math.max(
        0,
        Math.min(1, Number(executionGuardrails?.effectiveSizingMultiplier || 1))
      );
      const autoApproveGuardrailDisabled = Boolean(executionGuardrails?.autoApproveDisabled);
      const autoApproveGuardrailReasons = Array.isArray(executionGuardrails?.autoApproveDisableReasons)
        ? executionGuardrails.autoApproveDisableReasons
        : [];
      const liveKas = Number(kasData?.walletKas || 0);
      const walletSupportsCombinedTreasury =
        TREASURY_FEE_ONCHAIN_ENABLED &&
        wallet?.provider !== "demo" &&
        TREASURY_FEE_KAS > 0 &&
        WalletAdapter.supportsNativeMultiOutput(String(wallet?.provider || ""));
      const treasuryPayoutReserveKas =
        TREASURY_FEE_ONCHAIN_ENABLED && wallet?.provider !== "demo" && TREASURY_FEE_KAS > 0
          ? (walletSupportsCombinedTreasury ? TREASURY_FEE_KAS : (TREASURY_FEE_KAS + NET_FEE))
          : 0;
      const availableToSpend = Math.max(0, liveKas - RESERVE - NET_FEE - treasuryPayoutReserveKas);
      const executionReady = liveConnected && !kasDataError && wallet?.provider !== "demo";

      if(!riskOk){
        addLog({type:"VALID", msg:`Risk gate FAILED — score ${dec.risk_score} > ${riskThresh} ceiling`, fee:null});
        addLog({type:"EXEC", msg:"BLOCKED by risk gate", fee:0.03});
        void sendAlertEvent({
          type: "risk_event",
          key: `risk_gate:${String(agent?.agentId || agent?.name || "agent")}`,
          title: `${agent?.name || "Agent"} risk gate blocked cycle`,
          message: `Risk score ${dec.risk_score} exceeded ceiling ${riskThresh}. action=${dec.action} regime=${quantRegime}`,
          severity: "warn",
          meta: { risk_score: dec.risk_score, risk_ceiling: riskThresh, regime: quantRegime },
        });
      } else if(!confOk){
        addLog({type:"VALID", msg:`Confidence ${dec.confidence_score} < ${CONF_THRESHOLD} threshold`, fee:null});
        addLog({type:"EXEC", msg:"HOLD — confidence gate enforced", fee:0.08});
      } else if (dec.action === "ACCUMULATE" && availableToSpend <= 0) {
        addLog({
          type:"VALID",
          msg:`Insufficient spendable balance after reserve (${RESERVE} KAS), network fee (${NET_FEE} KAS), and treasury payout reserve (${treasuryPayoutReserveKas.toFixed(4)} KAS).`,
          fee:null
        });
        addLog({type:"EXEC", msg:"HOLD — waiting for available balance", fee:0.03});
      } else {
        addLog({type:"VALID", msg:`Risk OK (${dec.risk_score}) · Conf OK (${dec.confidence_score}) · Kelly ${(dec.kelly_fraction*100).toFixed(1)}%`, fee:null});

        if (execMode === "notify") {
          addLog({type:"EXEC", msg:`NOTIFY mode active — ${dec.action} signal recorded, no transaction broadcast.`, fee:0.01});
        } else if (!liveExecutionArmed || !executionReady) {
          const reason = !liveExecutionArmed
            ? "live execution is disarmed"
            : "network feed or wallet provider is not execution-ready";
          addLog({
            type:"EXEC",
            msg:`Signal generated (${dec.action}) but no transaction broadcast because ${reason}.`,
            fee:0.01,
          });
        } else if(dec.action!=="HOLD"){
          const requested = Number(dec.capital_allocation_kas || 0);
          const calibrationScaledRequested =
            dec.action === "ACCUMULATE"
              ? Number((Math.max(0, requested) * calibrationSizeMultiplier).toFixed(6))
              : requested;
          if (dec.action === "ACCUMULATE" && calibrationScaledRequested < requested) {
            addLog({
              type:"SYSTEM",
              msg:
                `Calibration guardrail scaled execution from ${requested} to ${calibrationScaledRequested.toFixed(6)} KAS ` +
                `(health ${Number(executionGuardrails?.calibration?.health || 1).toFixed(3)} · ` +
                `tier ${String(executionGuardrails?.calibration?.tier || "healthy").toUpperCase()}).`,
              fee:null
            });
          }
          const sharedCapKas = Number(activePortfolioRow?.cycleCapKas || 0);
          const portfolioCapped =
            dec.action === "ACCUMULATE" && sharedCapKas > 0 ? Math.min(calibrationScaledRequested, sharedCapKas) : calibrationScaledRequested;
          const amountKas = dec.action === "ACCUMULATE" ? Math.min(portfolioCapped, availableToSpend) : calibrationScaledRequested;
          if (dec.action === "ACCUMULATE" && sharedCapKas > 0 && calibrationScaledRequested > portfolioCapped) {
            addLog({
              type:"SYSTEM",
              msg:`Shared portfolio allocator capped ${agent.name} cycle from ${calibrationScaledRequested} to ${portfolioCapped.toFixed(4)} KAS.`,
              fee:null
            });
          }
          if (calibrationScaledRequested > amountKas) {
            addLog({type:"SYSTEM", msg:`Clamped execution amount from ${calibrationScaledRequested} to ${amountKas.toFixed(4)} KAS (available balance guardrail).`, fee:null});
          }
          if (!(amountKas > 0)) {
            addLog({type:"EXEC", msg:"HOLD — computed execution amount is zero", fee:0.03});
            return;
          }
          const baseTxItem = buildQueueTxItem({
            id:uid(),
            type:dec.action,
            metaKind: "action",
            from:wallet?.address,
            to:ACCUMULATION_VAULT,
            amount_kas:Number(amountKas.toFixed(6)),
            purpose:dec.rationale.slice(0,60),
            status:"pending",
            ts:Date.now(),
            dec
          });
          const txItem = attachCombinedTreasuryOutput(baseTxItem);
          if (txItem?.treasuryCombined) {
            addLog({
              type:"TREASURY",
              msg:`Using combined treasury routing in primary transaction (${String(wallet?.provider || "wallet")}) · treasury ${Number(txItem?.treasuryCombinedFeeKas || TREASURY_FEE_KAS).toFixed(6)} KAS`,
              fee:null,
            });
          }
          const autoApproveCandidate =
            execMode==="autonomous" &&
            txItem.amount_kas <= autoThresh &&
            (decSource === "ai" || decSource === "hybrid-ai");
          const isAutoApprove = autoApproveCandidate && !autoApproveGuardrailDisabled;
          if (autoApproveCandidate && !isAutoApprove) {
            addLog({
              type:"SIGN",
              msg:`Auto-approve blocked by guardrail (${autoApproveGuardrailReasons.join(",") || "policy"}). Action routed to manual queue.`,
              fee:null
            });
          }
          if(isAutoApprove){
            try {
              const txid = await sendWalletTransfer(txItem);

              addLog({
                type:"EXEC",
                msg:`AUTO-APPROVED: ${dec.action} · ${txItem.amount_kas} KAS · txid: ${txid.slice(0,16)}...`,
                fee:0.08,
                truthLabel:"BROADCASTED",
                receiptProvenance:"ESTIMATED",
              });
              addLog({type:"TREASURY", msg:`Fee split → Pool: ${(FEE_RATE*AGENT_SPLIT).toFixed(4)} KAS / Treasury: ${(FEE_RATE*TREASURY_SPLIT).toFixed(4)} KAS`, fee:FEE_RATE});
              const signedItem = prependSignedBroadcastedQueueItem(txItem, txid);
              await settleTreasuryFeePayout(signedItem, "auto");
            } catch (e: any) {
              prependQueueItem(txItem);
              addLog({type:"SIGN", msg:`Auto-approve fallback to manual queue: ${e?.message || "wallet broadcast failed"}`, fee:null});
            }
          } else {
            addLog({type:"SIGN", msg:`Action queued for wallet signature: ${dec.action} · ${txItem.amount_kas} KAS`, fee:null});
            prependQueueItem(txItem);
          }
        } else {
          addLog({type:"EXEC", msg:"HOLD — no action taken", fee:0.08});
        }
      }
    }catch(e: any){
      const fx = normalizeError(e, { domain: "system" });
      addLog({type:"ERROR", msg:formatForgeError(fx), fee:null});
      if (fx.domain === "tx" && fx.code === "TX_BROADCAST_FAILED") {
        transitionAgentStatus({ type: "FAIL", reason: fx.message });
      }
    }
    finally {
      setLoading(false);
      cycleLockRef.current = false;
    }
  }, [
    ACCUMULATE_ONLY,
    MAX_DECISION_ENTRIES,
    activePortfolioRow,
    addLog,
    agent,
    autoThresh,
    cycleIntervalMs,
    execMode,
    kasData,
    liveExecutionArmed,
    liveConnected,
    marketHistory,
    kasDataError,
    prependQueueItem,
    prependSignedBroadcastedQueueItem,
    riskThresh,
    runtimeHydrated,
    sendWalletTransfer,
    settleTreasuryFeePayout,
    sendAlertEvent,
    status,
    transitionAgentStatus,
    usageScope,
    wallet,
  ]);

  useAutoCycleLoop({
    status,
    runtimeHydrated,
    loading,
    liveConnected,
    kasDataError,
    nextAutoCycleAt,
    cycleIntervalMs,
    cycleLockRef,
    setNextAutoCycleAt,
    runCycle,
  });

  useEffect(() => {
    const latestRegime = String(decisions[0]?.dec?.quant_metrics?.regime || "");
    if (!latestRegime) return;
    if (!lastRegimeRef.current) {
      lastRegimeRef.current = latestRegime;
      return;
    }
    if (lastRegimeRef.current === latestRegime) return;
    const previousRegime = lastRegimeRef.current;
    lastRegimeRef.current = latestRegime;
    void sendAlertEvent({
      type: "regime_shift",
      key: `regime_shift:${String(agent?.agentId || agent?.name || "agent")}:${previousRegime}->${latestRegime}`,
      title: `${agent?.name || "Agent"} regime shift`,
      message: `Regime changed from ${previousRegime} to ${latestRegime}.`,
      severity: latestRegime === "RISK_OFF" ? "warn" : "info",
      meta: { previous_regime: previousRegime, regime: latestRegime },
    });
  }, [agent?.agentId, agent?.name, decisions, sendAlertEvent]);

  const handleSigned = useCallback(async (tx: any) => {
    const currentSigningItem = signingItem ? { ...signingItem } : null;
    await handleSignedBase(tx);
    if (!currentSigningItem || currentSigningItem?.metaKind === "treasury_fee") return;
    const signedQueueItem = { ...currentSigningItem, status: "signed", txid: tx?.txid };
    await settleTreasuryFeePayout(signedQueueItem, "post-sign");
  }, [handleSignedBase, settleTreasuryFeePayout, signingItem]);

  const killSwitch = () => {
    transitionAgentStatus({ type: "KILL" });
    addLog({type:"SYSTEM", msg:"KILL-SWITCH activated — agent suspended. All pending actions cancelled.", fee:null});
    void sendAlertEvent({
      type: "risk_event",
      key: `kill_switch:${String(agent?.agentId || agent?.name || "agent")}`,
      title: `${agent?.name || "Agent"} kill-switch activated`,
      message: "Agent suspended and pending queue rejected.",
      severity: "danger",
      meta: { pending_rejected: queue.filter((q: any) => q.status === "pending").length },
    });
    rejectAllPending();
  };
  const totalFees = parseFloat(log.filter((l: any)=>l.fee).reduce((s: number, l: any)=>s+(l.fee||0),0).toFixed(4));
  const liveKasNum = Number(kasData?.walletKas || 0);
  const walletSupportsCombinedTreasuryUi =
    TREASURY_FEE_ONCHAIN_ENABLED &&
    wallet?.provider !== "demo" &&
    TREASURY_FEE_KAS > 0 &&
    WalletAdapter.supportsNativeMultiOutput(String(wallet?.provider || ""));
  const treasuryPayoutReserveKasUi =
    TREASURY_FEE_ONCHAIN_ENABLED && wallet?.provider !== "demo" && TREASURY_FEE_KAS > 0
      ? (walletSupportsCombinedTreasuryUi ? TREASURY_FEE_KAS : (TREASURY_FEE_KAS + NET_FEE))
      : 0;
  const uiSummary = useDashboardUiSummary({
    viewportWidth,
    nextAutoCycleAt,
    status,
    totalFees,
    queue,
    decisions,
    liveConnected,
    kasDataError,
    wallet,
    kasData,
    reserveKas: RESERVE,
    netFeeKas: NET_FEE,
    treasuryReserveKas: treasuryPayoutReserveKasUi,
    wsUrl: KAS_WS_URL,
    streamConnected,
    streamRetryCount,
  });
  const {
    isMobile,
    isTablet,
    summaryGridCols,
    splitGridCols,
    controlsGridCols,
    pendingCount: pendingCountUi,
    spendableKas,
    liveExecutionReady,
    autoCycleCountdownLabel,
    lastDecision,
    lastDecisionSource,
    streamBadgeText,
    streamBadgeColor,
  } = uiSummary;
  const TABS = [
    {k:"overview",l:"OVERVIEW"},
    {k:"portfolio",l:"PORTFOLIO"},
    {k:"intelligence",l:"INTELLIGENCE"},
    {k:"attribution",l:"ATTRIBUTION"},
    {k:"alerts",l:"ALERTS"},
    {k:"queue",l:`QUEUE${pendingCount>0?` (${pendingCount})`:""}`},
    {k:"treasury",l:"TREASURY"},
    {k:"wallet",l:"WALLET"},
    {k:"log",l:"LOG"},
    {k:"controls",l:"CONTROLS"},
  ];

  useEffect(() => {
    if (pendingCount <= 0) return;
    void sendAlertEvent({
      type: "queue_pending",
      key: `queue_pending_count:${String(agent?.agentId || agent?.name || "agent")}`,
      title: `${agent?.name || "Agent"} has pending signatures`,
      message: `${pendingCount} transaction${pendingCount > 1 ? "s" : ""} awaiting wallet approval.`,
      severity: pendingCount >= 3 ? "warn" : "info",
      meta: { pending_count: pendingCount },
    });
  }, [agent?.agentId, agent?.name, pendingCount, sendAlertEvent]);

  return(
    <div style={{maxWidth:1460, margin:"0 auto", padding:isMobile ? "14px 14px 22px" : "22px 24px 34px"}}>
      {signingItem && <SigningModal tx={signingItem} wallet={wallet} onSign={handleSigned} onReject={handleSigningReject}/>}

      {/* Header */}
      <div style={{display:"flex", flexDirection:isMobile ? "column" : "row", justifyContent:"space-between", alignItems:isMobile ? "stretch" : "flex-start", marginBottom:16, gap:isMobile ? 10 : 0}}>
        <div>
          <div style={{fontSize:11, color:C.dim, letterSpacing:"0.1em", ...mono, marginBottom:2}}>FORGE.OS / AGENT / {agent.name}</div>
          <div style={{fontSize:18, color:C.text, fontWeight:700, ...mono}}>{agent.name}</div>
        </div>
        <div style={{display:"flex", gap:6, alignItems:"center", flexWrap:"wrap", justifyContent:isMobile ? "flex-start" : "flex-end"}}>
          <Badge text={status} color={status==="RUNNING"?C.ok:status==="PAUSED"?C.warn:C.danger} dot/>
          <Badge text={execMode.toUpperCase()} color={C.accent}/>
          <Badge text={String(activeStrategyLabel).toUpperCase()} color={C.text}/>
          <Badge text={liveExecutionArmed ? "LIVE EXEC ON" : "LIVE EXEC OFF"} color={liveExecutionArmed ? C.ok : C.warn} dot/>
          <Badge text={ACCUMULATE_ONLY ? "ACCUMULATE-ONLY" : "MULTI-ACTION"} color={ACCUMULATE_ONLY ? C.ok : C.warn}/>
          <Badge text={wallet?.provider?.toUpperCase()||"WALLET"} color={C.purple} dot/>
          <Badge text={`ENGINE ${String(quantClientMode).toUpperCase()}`} color={quantClientMode === "worker" ? C.ok : C.warn}/>
          <Badge text={liveConnected?"DAG LIVE":"DAG OFFLINE"} color={liveConnected?C.ok:C.danger} dot/>
          <Badge text={streamBadgeText} color={streamBadgeColor} dot/>
        </div>
      </div>

      <DashboardRuntimeNotices kasDataError={kasDataError} refreshKasData={refreshKasData} kasDataLoading={kasDataLoading} liveExecutionArmed={liveExecutionArmed} liveExecutionReady={liveExecutionReady} executionGuardrails={executionGuardrails} pendingCount={pendingCount} isMobile={isMobile} setTab={setTab} />

      {/* Tabs */}
      <div style={{display:"flex", borderBottom:`1px solid ${C.border}`, marginBottom:18, overflowX:"auto"}}>
        {TABS.map(t=> (
          <button
            key={t.k}
            data-testid={`dashboard-tab-${t.k}`}
            onClick={()=>setTab(t.k)}
            style={{background:"none", border:"none", borderBottom:`2px solid ${tab===t.k?C.accent:"transparent"}`, color:tab===t.k?C.accent:C.dim, padding:"7px 14px", fontSize:11, cursor:"pointer", letterSpacing:"0.08em", ...mono, marginBottom:-1, whiteSpace:"nowrap", transition:"color 0.15s"}}
          >
            {t.l}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ── */}
      {tab==="overview" && (
        <div>
          <div style={{display:"grid", gridTemplateColumns:summaryGridCols, gap:10, marginBottom:12}}>
            {[
              {l:"Wallet Balance",    v:`${kasData?.walletKas||agent.capitalLimit} KAS`, s:shortAddr(wallet?.address),          c:C.accent},
              {l:"DAA Score",         v:kasData?.dag?.daaScore?.toLocaleString()||"—",   s:"Kaspa DAG height",                  c:C.text},
              {l:"Pending Signatures",v:pendingCount,                                    s:"In action queue",                   c:pendingCount>0?C.warn:C.dim},
              {l:"Total Protocol Fees",v:`${totalFees} KAS`,                             s:`${(totalFees*TREASURY_SPLIT).toFixed(4)} KAS → treasury`, c:C.text},
            ].map(r=> (
              <Card key={r.l} p={14}><Label>{r.l}</Label><div style={{fontSize:18, color:r.c, fontWeight:700, ...mono, marginBottom:2}}>{r.v}</div><div style={{fontSize:11, color:C.dim}}>{r.s}</div></Card>
            ))}
          </div>
          <Card p={16} style={{marginBottom:12}}>
            <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", gap:10, flexWrap:"wrap", marginBottom:8}}>
              <Label>Mission Control</Label>
              <DashboardMissionControlBadges networkLabel={NETWORK_LABEL} status={status} execMode={execMode} liveExecutionArmed={liveExecutionArmed} autoCycleCountdownLabel={autoCycleCountdownLabel} lastDecisionSource={lastDecisionSource} usage={usage} executionGuardrails={executionGuardrails} receiptConsistencyMetrics={receiptConsistencyMetrics} />
            </div>
            <div style={{display:"grid", gridTemplateColumns:isTablet ? "1fr" : "1fr 1fr 1fr 1fr", gap:8, marginBottom:10}}>
              <div style={{background:C.s2, border:`1px solid ${C.border}`, borderRadius:6, padding:"10px 12px"}}>
                <div style={{fontSize:10, color:C.dim, ...mono, marginBottom:4}}>Spendable Balance</div>
                <div style={{fontSize:13, color:C.ok, fontWeight:700, ...mono}}>{spendableKas.toFixed(4)} KAS</div>
              </div>
              <div style={{background:C.s2, border:`1px solid ${C.border}`, borderRadius:6, padding:"10px 12px"}}>
                <div style={{fontSize:10, color:C.dim, ...mono, marginBottom:4}}>Last Decision</div>
                <div style={{fontSize:13, color:C.text, fontWeight:700, ...mono}}>{lastDecision?.action || "—"}</div>
              </div>
              <div style={{background:C.s2, border:`1px solid ${C.border}`, borderRadius:6, padding:"10px 12px"}}>
                <div style={{fontSize:10, color:C.dim, ...mono, marginBottom:4}}>Capital / Cycle</div>
                <div style={{fontSize:13, color:C.text, fontWeight:700, ...mono}}>{agent.capitalLimit} KAS</div>
              </div>
              <div style={{background:C.s2, border:`1px solid ${C.border}`, borderRadius:6, padding:"10px 12px"}}>
                <div style={{fontSize:10, color:C.dim, ...mono, marginBottom:4}}>Portfolio Cycle Cap</div>
                <div style={{fontSize:13, color:activePortfolioRow?.cycleCapKas ? C.ok : C.dim, fontWeight:700, ...mono}}>
                  {activePortfolioRow?.cycleCapKas ? `${activePortfolioRow.cycleCapKas} KAS` : "—"}
                </div>
              </div>
              <div style={{background:C.s2, border:`1px solid ${C.border}`, borderRadius:6, padding:"10px 12px"}}>
                <div style={{fontSize:10, color:C.dim, ...mono, marginBottom:4}}>Execution Readiness</div>
                <div style={{fontSize:13, color:liveExecutionReady ? C.ok : C.warn, fontWeight:700, ...mono}}>
                  {liveExecutionReady ? "READY" : "NOT READY"}
                </div>
              </div>
              <div style={{background:C.s2, border:`1px solid ${C.border}`, borderRadius:6, padding:"10px 12px"}}>
                <div style={{fontSize:10, color:C.dim, ...mono, marginBottom:4}}>KAS Price (USD)</div>
                <div style={{fontSize:13, color:C.text, fontWeight:700, ...mono}}>
                  {Number(kasData?.priceUsd || 0) > 0 ? `$${Number(kasData.priceUsd).toFixed(6)}` : "—"}
                </div>
              </div>
              <div style={{background:C.s2, border:`1px solid ${C.border}`, borderRadius:6, padding:"10px 12px"}}>
                <div style={{fontSize:10, color:C.dim, ...mono, marginBottom:4}}>Quant Samples</div>
                <div style={{fontSize:13, color:C.text, fontWeight:700, ...mono}}>
                  {lastDecision?.quant_metrics?.sample_count ?? marketHistory.length ?? 0}
                </div>
              </div>
            </div>
            <div style={{display:"flex", gap:8, flexWrap:"wrap"}}>
              <ExtLink href={`${EXPLORER}/addresses/${wallet?.address}`} label="WALLET EXPLORER ↗" />
              <ExtLink href={`${EXPLORER}/addresses/${ACCUMULATION_VAULT}`} label="VAULT EXPLORER ↗" />
            </div>
          </Card>
          <div style={{marginBottom:12}}>
            <Suspense fallback={<Card p={18}><Label>Performance</Label><div style={{fontSize:12,color:C.dim}}>Loading performance chart...</div></Card>}>
              <PerfChart decisions={decisions} kpiTarget={agent.kpiTarget}/>
            </Suspense>
          </div>
          <div style={{display:"grid", gridTemplateColumns:splitGridCols, gap:12}}>
            <Card p={18}>
              <Label>Agent Configuration</Label>
              {[["Strategy",activeStrategyLabel],["Strategy Class",String(agent?.strategyClass || "custom").toUpperCase()],["Risk",agent.risk.toUpperCase()],["Capital / Cycle",`${agent.capitalLimit} KAS`],["Portfolio Allocator","AUTO"],["Exec Mode",execMode.toUpperCase()],["Auto-Approve ≤",`${autoThresh} KAS`],["Horizon",`${agent.horizon} days`],["KPI Target",`${agent.kpiTarget}% ROI`]].map(([k,v])=> (
                <div key={k as any} style={{display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:`1px solid ${C.border}`}}>
                  <span style={{fontSize:12, color:C.dim, ...mono}}>{k}</span>
                  <span style={{fontSize:12, color:C.text, ...mono}}>{v}</span>
                </div>
              ))}
              <div style={{fontSize:11, color:C.dim, marginTop:8}}>
                Shared portfolio weighting and allocator caps are managed automatically. Operator funding is set with <span style={{color:C.text, ...mono}}>Capital / Cycle</span>.
              </div>
            </Card>
            <Card p={18}>
              <Label>Actions</Label>
              <div style={{display:"flex", flexDirection:"column", gap:8}}>
                <Btn onClick={runCycle} disabled={loading||status!=="RUNNING"} style={{padding:"10px 0"}}>{loading?"PROCESSING...":"RUN QUANT CYCLE"}</Btn>
                <Btn onClick={refreshKasData} disabled={kasDataLoading} variant="ghost" style={{padding:"9px 0"}}>{kasDataLoading?"FETCHING DAG...":liveConnected?"REFRESH KASPA DATA":KAS_WS_URL?"RECONNECT STREAM/DATA":"RECONNECT KASPA FEED"}</Btn>
                <Btn
                  onClick={()=>setLiveExecutionArmed((v: boolean)=>!v)}
                  variant={liveExecutionArmed ? "warn" : "primary"}
                  style={{padding:"9px 0"}}
                >
                  {liveExecutionArmed ? "DISARM LIVE EXECUTION" : "ARM LIVE EXECUTION"}
                </Btn>
                <Btn onClick={()=>setTab("queue")} variant="ghost" style={{padding:"9px 0"}}>ACTION QUEUE {pendingCount>0?`(${pendingCount})`:""}</Btn>
                <Btn onClick={()=>transitionAgentStatus({ type: status==="RUNNING" ? "PAUSE" : "RESUME" })} variant="ghost" style={{padding:"9px 0"}}>{status==="RUNNING"?"PAUSE":"RESUME"}</Btn>
                <Btn onClick={killSwitch} variant="danger" style={{padding:"9px 0"}}>KILL-SWITCH</Btn>
              </div>
            </Card>
          </div>
        </div>
      )}

      {tab==="portfolio" && (
        <Suspense fallback={<Card p={18}><Label>Portfolio</Label><div style={{fontSize:12,color:C.dim}}>Loading portfolio allocator...</div></Card>}>
          <PortfolioPanel
            agents={allAgents}
            activeAgentId={activeAgentId || agent?.agentId}
            walletKas={kasData?.walletKas || 0}
            summary={portfolioSummary}
            config={portfolioConfig}
            onConfigPatch={patchPortfolioConfig}
            onAgentOverridePatch={patchPortfolioAgentOverride}
            onSelectAgent={onSelectAgent}
            onRefresh={refreshPortfolioPeers}
          />
        </Suspense>
      )}

      {tab==="intelligence" && (
        <Suspense fallback={<Card p={18}><Label>Intelligence</Label><div style={{fontSize:12,color:C.dim}}>Loading intelligence panel...</div></Card>}>
          <IntelligencePanel decisions={decisions} queue={queue} loading={loading} onRun={runCycle}/>
        </Suspense>
      )}
      {tab==="attribution" && (
        <Suspense fallback={<Card p={18}><Label>Attribution</Label><div style={{fontSize:12,color:C.dim}}>Loading attribution panel...</div></Card>}>
          <PnlAttributionPanel summary={pnlAttribution} />
        </Suspense>
      )}
      {tab==="alerts" && (
        <Suspense fallback={<Card p={18}><Label>Alerts</Label><div style={{fontSize:12,color:C.dim}}>Loading alerts panel...</div></Card>}>
          <AlertsPanel
            config={alertConfig}
            onPatch={patchAlertConfig}
            onToggleType={toggleAlertType}
            onSave={saveAlertConfig}
            onTest={sendTestAlert}
            saving={alertSaveBusy}
            lastResult={lastAlertResult}
          />
        </Suspense>
      )}
      {tab==="queue" && (
        <ActionQueue
          queue={queue}
          wallet={wallet}
          onSign={handleQueueSign}
          onReject={handleQueueReject}
          receiptConsistencyMetrics={receiptConsistencyMetrics}
        />
      )}
      {tab==="treasury" && (
        <Suspense fallback={<Card p={18}><Label>Treasury</Label><div style={{fontSize:12,color:C.dim}}>Loading treasury panel...</div></Card>}>
          <TreasuryPanel log={log} agentCapital={agent.capitalLimit}/>
        </Suspense>
      )}
      {tab==="wallet" && <WalletPanel agent={agent} wallet={wallet}/>}

      {/* ── LOG ── */}
      {tab==="log" && (
        <Card p={0}>
          <div style={{padding:"12px 18px", borderBottom:`1px solid ${C.border}`, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
            <span style={{fontSize:11, color:C.dim, ...mono}}>{log.length} entries · {totalFees} KAS fees</span>
            <Btn onClick={runCycle} disabled={loading||status!=="RUNNING"} size="sm">{loading?"...":"RUN CYCLE"}</Btn>
          </div>
          <div style={{maxHeight:520, overflowY:"auto"}}>
            {log.map((e: any, i: number)=>(
              <div key={i} style={{display:"grid", gridTemplateColumns:isMobile ? "74px 58px 1fr" : "92px 72px 1fr 80px", gap:10, padding:"8px 18px", borderBottom:`1px solid ${C.border}`, alignItems:"center"}}>
                <span style={{fontSize:11, color:C.dim, ...mono}}>{fmtT(e.ts)}</span>
                <span style={{fontSize:11, color:LOG_COL[e.type]||C.dim, fontWeight:700, ...mono}}>{e.type}</span>
                <div style={{display:"flex", flexDirection:"column", gap:5}}>
                  <div style={{fontSize:12, color:C.text, ...mono, lineHeight:1.4}}>{e.msg}</div>
                  {(e?.truthLabel || e?.receiptProvenance) && (
                    <div style={{display:"flex", gap:6, flexWrap:"wrap"}}>
                      {e?.truthLabel && (
                        <Badge
                          text={String(e.truthLabel)}
                          color={
                            String(e.truthLabel).includes("CHAIN CONFIRMED")
                              ? C.ok
                              : String(e.truthLabel).includes("BACKEND CONFIRMED")
                                ? C.purple
                                : String(e.truthLabel).includes("BROADCASTED")
                                  ? C.warn
                                  : C.dim
                          }
                        />
                      )}
                      {e?.receiptProvenance && (
                        <Badge
                          text={String(e.receiptProvenance)}
                          color={
                            String(e.receiptProvenance).toUpperCase() === "CHAIN"
                              ? C.ok
                              : String(e.receiptProvenance).toUpperCase() === "BACKEND"
                                ? C.purple
                                : C.warn
                          }
                        />
                      )}
                    </div>
                  )}
                </div>
                {!isMobile && <span style={{fontSize:11, color:C.dim, textAlign:"right", ...mono}}>{e.fee!=null?`${e.fee} KAS`:"—"}</span>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── CONTROLS ── */}
      {tab==="controls" && (
        <div style={{display:"grid", gridTemplateColumns:controlsGridCols, gap:14}}>
          <Card p={18}>
            <Label>Execution Mode</Label>
            {EXEC_OPTS.map(m=>{const on=execMode===m.v; return(
              <div key={m.v} onClick={()=>setExecMode(m.v)} style={{padding:"12px 14px", borderRadius:4, marginBottom:8, cursor:"pointer", border:`1px solid ${on?C.accent:C.border}`, background:on?C.aLow:C.s2, transition:"all 0.15s"}}>
                <div style={{display:"flex", alignItems:"center", gap:10, marginBottom:3}}>
                  <div style={{width:10, height:10, borderRadius:"50%", background:on?C.accent:C.muted, flexShrink:0}}/>
                  <span style={{fontSize:12, color:on?C.accent:C.text, fontWeight:700, ...mono}}>{m.l}</span>
                </div>
                <div style={{fontSize:11, color:C.dim, marginLeft:20}}>{m.desc}</div>
              </div>
            );})}
          </Card>
          <div style={{display:"flex", flexDirection:"column", gap:12}}>
            <Card p={18}>
              <Label>Agent Controls</Label>
              <div style={{fontSize:11, color:C.dim, ...mono, marginBottom:10}}>
                Auto cycle cadence: every {AUTO_CYCLE_SECONDS}s · Next cycle in {autoCycleCountdownLabel}
              </div>
              <div style={{display:"flex", flexDirection:"column", gap:8}}>
                <Btn onClick={()=>transitionAgentStatus({ type: status==="RUNNING" ? "PAUSE" : "RESUME" })} variant="ghost" style={{padding:"10px 0"}}>{status==="RUNNING"?"PAUSE AGENT":"RESUME AGENT"}</Btn>
                <Btn onClick={()=>setLiveExecutionArmed((v: boolean)=>!v)} variant={liveExecutionArmed ? "warn" : "primary"} style={{padding:"10px 0"}}>
                  {liveExecutionArmed ? "DISARM LIVE EXECUTION" : "ARM LIVE EXECUTION"}
                </Btn>
                <Btn onClick={()=>setTab("wallet")} variant="ghost" style={{padding:"10px 0"}}>MANAGE WALLET</Btn>
                <Btn onClick={killSwitch} variant="danger" style={{padding:"10px 0"}}>ACTIVATE KILL-SWITCH</Btn>
              </div>
            </Card>
            <Card p={18}>
              <Label>Active Risk Limits — {agent.risk.toUpperCase()}</Label>
              {[["Max Single Exposure",agent.risk==="low"?"5%":agent.risk==="medium"?"10%":"20%",C.warn],["Drawdown Halt",agent.risk==="low"?"-8%":agent.risk==="medium"?"-15%":"-25%",C.danger],["Confidence Floor","0.75",C.dim],["Kelly Cap",agent.risk==="low"?"10%":agent.risk==="medium"?"20%":"40%",C.warn],["Auto-Approve ≤",`${autoThresh} KAS`,C.accent]].map(([k,v,c])=> (
                <div key={k as any} style={{display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:`1px solid ${C.border}`}}>
                  <span style={{fontSize:12, color:C.dim, ...mono}}>{k}</span>
                  <span style={{fontSize:12, color:c as any, fontWeight:700, ...mono}}>{v}</span>
                </div>
              ))}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
