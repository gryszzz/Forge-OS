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
import { getAgentDepositAddress } from "../../runtime/agentDeposit";
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
import { Badge, Btn, Card, ExtLink, Label, Inp } from "../ui";
import { EXEC_OPTS, STRATEGY_TEMPLATES, PROFESSIONAL_PRESETS, RISK_OPTS } from "../wizard/constants";
import { ActionQueue } from "./ActionQueue";
import { DashboardMissionControlBadges } from "./DashboardMissionControlBadges";
import { DashboardRuntimeNotices } from "./DashboardRuntimeNotices";
import { WalletPanel } from "./WalletPanel";

const PerfChart = lazy(() => import("./PerfChart").then((m) => ({ default: m.PerfChart })));
const AgentOverviewPanel = lazy(() => import("./AgentOverviewPanel").then((m) => ({ default: m.AgentOverviewPanel })));
const IntelligencePanel = lazy(() =>
  import("./IntelligencePanel").then((m) => ({ default: m.IntelligencePanel }))
);
const PortfolioPanel = lazy(() => import("./PortfolioPanel").then((m) => ({ default: m.PortfolioPanel })));
const PnlAttributionPanel = lazy(() =>
  import("./PnlAttributionPanel").then((m) => ({ default: m.PnlAttributionPanel }))
);
const AlertsPanel = lazy(() => import("./AlertsPanel").then((m) => ({ default: m.AlertsPanel })));
const QuantAnalyticsPanel = lazy(() => import("./QuantAnalyticsPanel").then((m) => ({ default: m.QuantAnalyticsPanel })));

export function Dashboard({agent, wallet, agents = [], activeAgentId, onSelectAgent, onDeleteAgent, onEditAgent}: any) {
  const LIVE_POLL_MS = 2000;           // 2 s – faster wallet-balance refresh
  const STREAM_RECONNECT_MAX_DELAY_MS = 8000;
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
  // Helper to read persisted state from localStorage
  const readPersistedState = (scope: string) => {
    if (typeof window === "undefined") return null;
    try {
      const key = `forgeos_dashboard_${scope}`;
      const stored = window.localStorage.getItem(key);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  };

  // Get persisted values if available
  const persistedState = runtimeScope ? readPersistedState(runtimeScope) : null;
  
  const { status, setStatus, transitionAgentStatus } = useAgentLifecycle(
    persistedState?.status || (agent?.name ? "RUNNING" : "PAUSED")
  );
  const [log, setLog] = useState(()=>seedLog(agent.name));
  const [decisions, setDecisions] = useState([] as any[]);
  const [loading, setLoading] = useState(false);
  // Get persisted execMode value if available (validate it's a valid option)
  const validExecModes = ["autonomous", "manual", "notify"];
  const initialExecMode = persistedState?.execMode && validExecModes.includes(persistedState.execMode)
    ? persistedState.execMode
    : (agent.execMode || "manual");
  const [execMode, setExecMode] = useState(initialExecMode);
  const [autoThresh] = useState(parseFloat(agent.autoApproveThreshold) || 50);
  const [usage, setUsage] = useState(() => getUsageState(FREE_CYCLES_PER_DAY, usageScope));
  // Get persisted liveExecutionArmed value if available
  const initialLiveExecutionArmed = persistedState?.liveExecutionArmed !== undefined 
    ? persistedState.liveExecutionArmed 
    : LIVE_EXECUTION_DEFAULT;
  const [liveExecutionArmed, setLiveExecutionArmed] = useState(initialLiveExecutionArmed);
  const [nextAutoCycleAt, setNextAutoCycleAt] = useState(() => Date.now() + cycleIntervalMs);
const [viewportWidth, setViewportWidth] = useState(
    typeof window !== "undefined" ? window.innerWidth : 1200
  );
  const [editingStrategy, setEditingStrategy] = useState(false);
  const [editForm, setEditForm] = useState({
    strategyTemplate: agent.strategyTemplate || "dca_accumulator",
    strategyLabel: agent.strategyLabel || "Steady DCA Builder",
    risk: agent.risk || "medium",
    kpiTarget: agent.kpiTarget || "12",
    capitalLimit: agent.capitalLimit || "5000",
    horizon: agent.horizon || 30,
    autoApproveThreshold: agent.autoApproveThreshold || "50",
    execMode: agent.execMode || "manual",
  });
  
  const allStrategies = [...STRATEGY_TEMPLATES, ...PROFESSIONAL_PRESETS.filter(p => p.id !== "custom")];
  
  const handleStrategySelect = (strategy: any) => {
    setEditForm({
      ...editForm,
      strategyTemplate: strategy.id,
      strategyLabel: strategy.name,
      risk: strategy.defaults.risk || "medium",
      kpiTarget: strategy.defaults.kpiTarget || "12",
      capitalLimit: agent.capitalLimit || "5000",
      horizon: strategy.defaults.horizon || 30,
      autoApproveThreshold: strategy.defaults.autoApproveThreshold || "50",
      execMode: strategy.defaults.execMode || "manual",
    });
  };
  
  const handleSaveStrategy = () => {
    // Save to agent - this would typically call a parent handler or persist
    setEditingStrategy(false);
    addLog({
      type:"SYSTEM", 
      msg:`Strategy updated to ${editForm.strategyLabel}`, 
      fee:null
    });
  };
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

  const riskThresh = agent?.risk==="low"?0.4:agent?.risk==="medium"?0.65:0.85;
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
        } else if(dec.action === "REDUCE"){
          // REDUCE = take-profit signal. Kaspa is the asset being accumulated — to realise
          // profit the user must manually transfer KAS from their accumulation vault to an
          // exchange.  No automated on-chain transaction is generated here.
          addLog({
            type:"EXEC",
            msg:`REDUCE signal — take-profit opportunity. Move KAS from your accumulation address to an exchange to realise gains. Agent will hold accumulation until signal clears.`,
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
          // Get agent deposit address for this wallet session
          const agentDepositAddr = getAgentDepositAddress(wallet?.address);
          const baseTxItem = buildQueueTxItem({
            id:uid(),
            type:dec.action,
            metaKind: "action",
            from:wallet?.address,
            to:agentDepositAddr || ACCUMULATION_VAULT,
            amount_kas:Number(amountKas.toFixed(6)),
            purpose:dec.rationale.slice(0,60),
            status:"pending",
            ts:Date.now(),
            dec,
            agentDepositAddress: agentDepositAddr,
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
    {k:"wallet",l:"WALLET"},
    {k:"intelligence",l:"INTELLIGENCE"},
    {k:"analytics",l:"ANALYTICS"},
    {k:"attribution",l:"ATTRIBUTION"},
    {k:"alerts",l:"ALERTS"},
    {k:"queue",l:`QUEUE${pendingCount>0?` (${pendingCount})`:""}`},
    {k:"log",l:"LOG"},
    {k:"controls",l:"CONTROLS"},
  ];

  // Track previous pending count to detect state changes
  const lastPendingCountRef = useRef(0);
  
  useEffect(() => {
    const threshold = alertConfig?.queuePendingThreshold || 3;
    const prevCount = lastPendingCountRef.current;
    const currentCount = pendingCount;
    
    // Only alert when:
    // 1. pendingCount exceeds threshold AND
    // 2. Either it's a new threshold breach (count went from below to above threshold)
    //    OR count increased significantly since last alert
    const wasBelowThreshold = prevCount < threshold;
    const isAboveThreshold = currentCount >= threshold;
    const increasedSignificantly = currentCount > prevCount && (currentCount - prevCount) >= Math.max(1, Math.floor(threshold / 2));
    
    // Update the ref
    lastPendingCountRef.current = currentCount;
    
    // Don't alert if below threshold or count decreased
    if (!isAboveThreshold || currentCount <= prevCount) return;
    
    // Only alert on significant state changes
    if (wasBelowThreshold || increasedSignificantly) {
      void sendAlertEvent({
        type: "queue_pending",
        key: `queue_pending_count:${String(agent?.agentId || agent?.name || "agent")}:${String(threshold)}`,
        title: `${agent?.name || "Agent"} queue backlog alert`,
        message: `${currentCount} transaction${currentCount > 1 ? "s" : ""} awaiting wallet approval (threshold: ${threshold}).`,
        severity: currentCount >= threshold * 2 ? "danger" : currentCount >= threshold ? "warn" : "info",
        meta: { 
          pending_count: currentCount,
          threshold: threshold,
          prev_count: prevCount,
        },
      });
    }
  }, [agent?.agentId, agent?.name, pendingCount, alertConfig?.queuePendingThreshold, sendAlertEvent]);

  // Low balance alert
  const lastBalanceAlertRef = useRef(0);
  
  useEffect(() => {
    const threshold = alertConfig?.lowBalanceThreshold || 100;
    const currentBalance = Number(kasData?.walletKas || 0);
    const now = Date.now();
    
    // Only alert if balance is below threshold
    if (currentBalance >= threshold || currentBalance <= 0) return;
    
    // Don't alert too frequently (at most once per hour for low balance)
    if (now - lastBalanceAlertRef.current < 3600000) return;
    
    lastBalanceAlertRef.current = now;
    
    void sendAlertEvent({
      type: "low_balance",
      key: `low_balance:${String(agent?.agentId || agent?.name || "agent")}:${String(threshold)}`,
      title: `${agent?.name || "Agent"} low balance warning`,
      message: `Wallet balance ${currentBalance.toFixed(2)} KAS is below threshold ${threshold} KAS.`,
      severity: currentBalance < threshold * 0.5 ? "danger" : "warn",
      meta: { 
        balance_kas: currentBalance,
        threshold_kas: threshold,
      },
    });
  }, [agent?.agentId, agent?.name, kasData?.walletKas, alertConfig?.lowBalanceThreshold, sendAlertEvent]);

  // Track tx failures and confirmation timeouts
  const lastTxFailureAlertRef = useRef<Record<string, number>>({});
  
  useEffect(() => {
    if (!queue || !Array.isArray(queue)) return;
    
    const now = Date.now();
    const alertCooldownMs = 300000; // 5 minutes between alerts for same tx
    
    for (const item of queue) {
      if (!item?.txid) continue;
      
      const txid = String(item.txid);
      const failureReason = item?.failure_reason;
      const receiptLifecycle = item?.receipt_lifecycle;
      
      // Check for confirmation timeout
      if (receiptLifecycle === "timeout" && failureReason === "confirmation_timeout") {
        const lastAlert = lastTxFailureAlertRef.current[`${txid}:timeout`] || 0;
        if (now - lastAlert < alertCooldownMs) continue;
        
        lastTxFailureAlertRef.current[`${txid}:timeout`] = now;
        
        void sendAlertEvent({
          type: "confirmation_timeout",
          key: `confirmation_timeout:${String(agent?.agentId || agent?.name || "agent")}:${txid}`,
          title: `${agent?.name || "Agent"} transaction confirmation timeout`,
          message: `Transaction ${txid.slice(0, 16)}... failed to confirm within expected time (${item?.receipt_attempts || 0} attempts).`,
          severity: "warn",
          meta: { 
            txid: txid,
            attempts: item?.receipt_attempts || 0,
            amount_kas: item?.amount_kas,
          },
        });
      }
      
      // Check for chain rejection
      if (receiptLifecycle === "failed" && (failureReason === "chain_rejected" || failureReason === "backend_receipt_failed")) {
        const lastAlert = lastTxFailureAlertRef.current[`${txid}:failed`] || 0;
        if (now - lastAlert < alertCooldownMs) continue;
        
        lastTxFailureAlertRef.current[`${txid}:failed`] = now;
        
        void sendAlertEvent({
          type: "tx_failure",
          key: `tx_failure:${String(agent?.agentId || agent?.name || "agent")}:${txid}`,
          title: `${agent?.name || "Agent"} transaction failed`,
          message: `Transaction ${txid.slice(0, 16)}... was rejected (reason: ${failureReason || "unknown"}).`,
          severity: "danger",
          meta: { 
            txid: txid,
            failure_reason: failureReason,
            amount_kas: item?.amount_kas,
            metaKind: item?.metaKind,
          },
        });
      }
    }
  }, [agent?.agentId, agent?.name, queue, sendAlertEvent]);

  // Network disconnect alert
  const lastNetworkAlertRef = useRef(0);
  
  useEffect(() => {
    // Alert when network goes from connected to disconnected
    const wasConnected = lastNetworkAlertRef.current > 0;
    const isDisconnected = !liveConnected;
    
    if (wasConnected && isDisconnected) {
      const now = Date.now();
      // Only alert once per disconnect event
      if (now - lastNetworkAlertRef.current < 60000) return;
      
      lastNetworkAlertRef.current = now;
      
      void sendAlertEvent({
        type: "system",
        key: `network_disconnect:${String(agent?.agentId || agent?.name || "agent")}`,
        title: `${agent?.name || "Agent"} network disconnected`,
        message: `Kaspa DAG feed disconnected. Live execution may be affected.`,
        severity: "warn",
        meta: { 
          network: DEFAULT_NETWORK,
          wasConnected: true,
        },
      });
    } else if (liveConnected) {
      // Reset when connected again
      lastNetworkAlertRef.current = 1;
    }
  }, [agent?.agentId, agent?.name, liveConnected, sendAlertEvent]);

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
          {/* Status: show only when not default-paused */}
          {(status && status !== "PAUSED") && <Badge text={status} color={status==="RUNNING"?C.ok:status==="PAUSED"?C.warn:C.dim} dot/>}
          {/* AUTONOMOUS — only when autonomous mode is active (hide when manual/notify) */}
          {execMode === "autonomous" && <Badge text="AUTONOMOUS" color={C.accent}/>}
          {/* Show non-autonomous exec modes more subtly */}
          {execMode && execMode !== "autonomous" && <Badge text={execMode.toUpperCase()} color={C.dim}/>}
          {/* Strategy label */}
          {activeStrategyLabel && activeStrategyLabel !== "Custom" && <Badge text={String(activeStrategyLabel).toUpperCase()} color={C.text}/>}
          {/* LIVE EXEC ON — only when armed */}
          {liveExecutionArmed === true && <Badge text="LIVE EXEC ON" color={C.ok} dot/>}
          {/* ACCUMULATE-ONLY — only when env flag is on */}
          {ACCUMULATE_ONLY && <Badge text="ACCUMULATE-ONLY" color={C.ok}/>}
          {/* Wallet provider (e.g. KASWARE) — always show when connected */}
          {wallet?.provider && <Badge text={wallet?.provider?.toUpperCase()} color={C.purple} dot/>}
          {/* ENGINE WORKER — only when quant engine is in worker mode */}
          {quantClientMode === "worker" && <Badge text="ENGINE WORKER" color={C.ok}/>}
          {/* Live feed badges */}
          {liveConnected && <Badge text="DAG LIVE" color={C.ok} dot/>}
          {streamConnected && streamBadgeText && <Badge text={streamBadgeText} color={streamBadgeColor} dot/>}
        </div>
      </div>

      <DashboardMissionControlBadges
        networkLabel={NETWORK_LABEL}
        status={status}
        execMode={execMode}
        liveExecutionArmed={liveExecutionArmed}
        autoCycleCountdownLabel={autoCycleCountdownLabel}
        lastDecisionSource={lastDecisionSource}
        usage={usage}
        executionGuardrails={executionGuardrails}
        receiptConsistencyMetrics={receiptConsistencyMetrics}
        isAccumulateOnly={ACCUMULATE_ONLY}
        walletProvider={wallet?.provider || ""}
        quantClientMode={quantClientMode}
      />

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
          {/* DeFi Header - Wallet Balance & Key Metrics */}
          <Card p={0} style={{marginBottom:12, background: `linear-gradient(135deg, rgba(16,25,35,0.48) 0%, rgba(11,17,24,0.32) 100%)`, border: `1px solid ${C.accent}40`, boxShadow: `0 4px 24px ${C.accent}15`}}>
            <div style={{padding: "18px 24px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom: `1px solid ${C.border}`, background: `linear-gradient(90deg, ${C.accent}15 0%, transparent 100%)`}}>
              <div style={{display:"flex", alignItems:"center", gap:14}}>
                <div style={{width:52, height:52, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", overflow:"hidden"}}>
                  <img src="/kas-icon.png" alt="KAS" width={56} height={56} style={{objectFit:"cover", marginTop:1}} />
                </div>
                <div style={{display:"flex", flexDirection:"column", justifyContent:"center"}}>
                  <div style={{fontSize:10, color:C.accent, ...mono, marginBottom:1, letterSpacing:"0.15em", fontWeight:700}}>◆ TOTAL PORTFOLIO VALUE</div>
                  <div style={{fontSize:36, color:C.accent, fontWeight:700, ...mono, textShadow: `0 0 30px ${C.accent}60`, lineHeight:1}}>
                    {kasData?.walletKas || agent.capitalLimit} <span style={{fontSize:18, color:C.dim}}>KAS</span>
                  </div>
                  {Number(kasData?.priceUsd || 0) > 0 && (
                    <div style={{fontSize:18, color:C.text, ...mono, display:"flex", alignItems:"center", gap:8}}>
                      ${(Number(kasData?.walletKas || 0) * Number(kasData?.priceUsd)).toFixed(2)} 
                      <span style={{color:C.ok, fontSize:12, background:C.ok + "20", padding:"2px 8px", borderRadius:4}}>USD</span>
                    </div>
                  )}
                </div>
              </div>
              <div style={{display:"flex", flexDirection:"column", gap:10, alignItems:"flex-end"}}>
                <div style={{display:"flex", gap:10, alignItems:"center", background:`${C.s2}90`, padding:"10px 16px", borderRadius:10, border:`1px solid ${C.border}`}}>
                  <div style={{display:"flex", alignItems:"center", gap:6}}>
                    <span style={{fontSize:11, color:C.dim, ...mono}}>KAS/USD</span>
                    <span style={{fontSize:18, color:C.text, fontWeight:700, ...mono}}>${Number(kasData?.priceUsd || 0).toFixed(4)}</span>
                  </div>
                </div>
              </div>
            </div>
            {/* Quick Stats Row - DeFi Style */}
            <div style={{padding: "16px 24px", display:"grid", gridTemplateColumns:"repeat(6, 1fr)", gap:16, background:`${C.border}15`}}>
              <div style={{textAlign:"center", background:C.s2 + "60", padding:"12px 8px", borderRadius:8, border:`1px solid ${C.ok}30`}}>
                <div style={{fontSize:9, color:C.dim, ...mono, marginBottom:6, letterSpacing:"0.1em"}}>SPENDABLE</div>
                <div style={{fontSize:18, color:C.ok, fontWeight:700, ...mono}}>{spendableKas.toFixed(2)}</div>
                <div style={{fontSize:9, color:C.dim, ...mono}}>KAS</div>
              </div>
              <div style={{textAlign:"center", background:C.s2 + "60", padding:"12px 8px", borderRadius:8, border:`1px solid ${C.warn}30`}}>
                <div style={{fontSize:9, color:C.dim, ...mono, marginBottom:6, letterSpacing:"0.1em"}}>RESERVE</div>
                <div style={{fontSize:18, color:C.warn, fontWeight:700, ...mono}}>{RESERVE}</div>
                <div style={{fontSize:9, color:C.dim, ...mono}}>KAS</div>
              </div>
              <div style={{textAlign:"center", background:C.s2 + "60", padding:"12px 8px", borderRadius:8, border:`1px solid ${C.border}`}}>
                <div style={{fontSize:9, color:C.dim, ...mono, marginBottom:6, letterSpacing:"0.1em"}}>DAA HEIGHT</div>
                <div style={{fontSize:18, color:C.text, fontWeight:700, ...mono}}>{kasData?.dag?.daaScore?.toLocaleString()?.slice(-6) || "—"}</div>
                <div style={{fontSize:9, color:C.dim, ...mono}}>BLOCK</div>
              </div>
              <div style={{textAlign:"center", background:C.s2 + "60", padding:"12px 8px", borderRadius:8, border:`1px solid ${pendingCount > 0 ? C.warn : C.border}`}}>
                <div style={{fontSize:9, color:C.dim, ...mono, marginBottom:6, letterSpacing:"0.1em"}}>PENDING</div>
                <div style={{fontSize:18, color:pendingCount > 0 ? C.warn : C.dim, fontWeight:700, ...mono}}>{pendingCount}</div>
                <div style={{fontSize:9, color:C.dim, ...mono}}>TXS</div>
              </div>
              <div style={{textAlign:"center", background:C.s2 + "60", padding:"12px 8px", borderRadius:8, border:`1px solid ${C.border}`}}>
                <div style={{fontSize:9, color:C.dim, ...mono, marginBottom:6, letterSpacing:"0.1em"}}>FEES PAID</div>
                <div style={{fontSize:18, color:C.text, fontWeight:700, ...mono}}>{totalFees.toFixed(3)}</div>
                <div style={{fontSize:9, color:C.dim, ...mono}}>KAS</div>
              </div>
              <div style={{textAlign:"center", background:C.s2 + "60", padding:"12px 8px", borderRadius:8, border:`1px solid ${C.accent}30`}}>
                <div style={{fontSize:9, color:C.dim, ...mono, marginBottom:6, letterSpacing:"0.1em"}}>CYCLE SIZE</div>
                <div style={{fontSize:18, color:C.accent, fontWeight:700, ...mono}}>{agent.capitalLimit}</div>
                <div style={{fontSize:9, color:C.dim, ...mono}}>KAS</div>
              </div>
            </div>
{/* Quick Actions Section */}
            <div style={{padding: "14px 24px", display:"flex", justifyContent:"space-between", alignItems:"center", gap:10, flexWrap:"wrap", borderTop:`1px solid ${C.border}`}}>
              <div style={{display:"flex", gap:8, alignItems:"center", flexWrap:"wrap"}}>
                <Btn onClick={runCycle} disabled={loading||status!=="RUNNING"} size="sm">
                  {loading ? "⏳" : "🚀"} {loading ? "RUNNING" : "RUN CYCLE"}
                </Btn>
                <Btn
                  onClick={()=>setLiveExecutionArmed((v: boolean)=>!v)}
                  variant={liveExecutionArmed ? "warn" : "primary"}
                  size="sm"
                >
                  {liveExecutionArmed ? "🟢 AUTO-TRADE ON" : "🔴 AUTO-TRADE OFF"}
                </Btn>
                <Btn onClick={()=>transitionAgentStatus({ type: status==="RUNNING" ? "PAUSE" : "RESUME" })} variant="ghost" size="sm">
                  {status==="RUNNING" ? "⏸ PAUSE" : "▶️ RESUME"}
                </Btn>
                <Btn onClick={killSwitch} variant="danger" size="sm">
                  🛑 KILL
                </Btn>
              </div>
              <div style={{display:"flex", alignItems:"center", gap:6}}>
                <span style={{fontSize: 11, color: liveExecutionArmed ? C.ok : C.warn, fontWeight: 700, ...mono}}>
                  {liveExecutionArmed ? "LIVE EXEC ON" : "LIVE EXEC OFF"}
                </span>
              </div>
            </div>
          </Card>
          
          <div style={{display:"grid", gridTemplateColumns:summaryGridCols, gap:10, marginBottom:12}}>
            {[
              {l:"Pending Signatures",v:pendingCount,s:"In action queue",c:pendingCount>0?C.warn:C.dim},
              {l:"Total Protocol Fees",v:`${totalFees} KAS`,s:"", c:C.text},
              {l:"Capital / Cycle",v:`${agent.capitalLimit} KAS`,s:"Per execution cycle",c:C.text},
              {l:"Portfolio Cap",v:activePortfolioRow?.cycleCapKas ? `${activePortfolioRow.cycleCapKas} KAS` : "—",s:"Shared allocator",c:activePortfolioRow?.cycleCapKas ? C.ok : C.dim},
            ].map(r=> (
              <Card key={r.l} p={14}><Label>{r.l}</Label><div style={{fontSize:18, color:r.c, fontWeight:700, ...mono, marginBottom:2}}>{r.v}</div><div style={{fontSize:11, color:C.dim}}>{r.s}</div></Card>
            ))}
          </div>
          
          {/* AI Trading Status - Enhanced DeFi/Web3 Style */}
          <Card p={0} style={{marginBottom:12, background: `linear-gradient(135deg, ${C.s2} 0%, ${lastDecision ? C.s1 : C.s2} 100%)`, border: `1px solid ${lastDecision ? C.accent + '40' : C.border}`, boxShadow: lastDecision ? `0 4px 24px ${C.accent}20` : 'none'}}>
            {/* Header with animated status */}
            <div style={{padding: "16px 20px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom: `1px solid ${C.border}`, background: `linear-gradient(90deg, ${C.accent}10 0%, transparent 100%)`}}>
              <div style={{display:"flex", alignItems:"center", gap:12}}>
                <span style={{fontSize:16}}>
                  {status === "RUNNING" && lastDecision ? "🟢" : status === "RUNNING" ? "🟡" : status === "PAUSED" ? "🟡" : "⚫"}
                </span>
                <span style={{fontSize:14, color:C.text, fontWeight:700, ...mono}}>🤖 AI TRADING ENGINE</span>
              </div>
              <div style={{display:"flex", gap:8, alignItems:"center"}}>
                <div style={{display:"flex", alignItems:"center", gap:6, background:`${C.s2}90`, padding:"6px 12px", borderRadius:20, border:`1px solid ${C.border}`}}>
                  <span style={{fontSize:12}}>⚡</span>
                  <span style={{fontSize:11, color:C.dim, ...mono}}>Engine Latency</span>
                  <span style={{fontSize:12, color:C.accent, fontWeight:700, ...mono}}>{lastDecision?.dec?.engine_latency_ms || 0}ms</span>
                </div>
                <Badge 
                  text={status === "RUNNING" ? "● ACTIVE" : status === "PAUSED" ? "◉ PAUSED" : "○ OFF"}
                  color={status === "RUNNING" ? C.ok : status === "PAUSED" ? C.warn : C.dim}
                />
                <Badge 
                  text={lastDecision?.action || "WAITING"} 
                  color={lastDecision?.action === "ACCUMULATE" ? C.ok : lastDecision?.action === "REDUCE" ? C.danger : lastDecision?.action === "HOLD" ? C.warn : C.dim}
                />
              </div>
            </div>
            
            {lastDecision ? (
              <div style={{padding: "20px"}}>
                {/* Primary Metrics Row - Enhanced */}
                <div style={{display:"grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap:12, marginBottom:16}}>
                  {/* Decision Source with Icon */}
                  <div style={{background: `linear-gradient(135deg, rgba(16,25,35,0.48) 0%, rgba(11,17,24,0.32) 100%)`, borderRadius:10, padding:14, border:`1px solid ${lastDecisionSource === "hybrid-ai" ? C.accent + '40' : C.border}`}}>
                    <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:8}}>
                      <span style={{fontSize:16}}>{lastDecisionSource === "hybrid-ai" ? "🧠" : lastDecisionSource === "ai" ? "🤖" : "📊"}</span>
                      <div style={{fontSize:10, color:C.dim, ...mono, letterSpacing:"0.1em"}}>DECISION SOURCE</div>
                    </div>
                    <div style={{fontSize:18, color: lastDecisionSource === "hybrid-ai" ? C.accent : lastDecisionSource === "ai" ? C.ok : C.text, fontWeight:700, ...mono}}>
                      {lastDecisionSource === "hybrid-ai" ? "HYBRID AI" : lastDecisionSource === "ai" ? "PURE AI" : lastDecisionSource === "quant-core" ? "QUANT CORE" : "FALLBACK"}
                    </div>
                    <div style={{fontSize:10, color:C.dim, marginTop:4}}>{lastDecisionSource === "hybrid-ai" ? "AI + Quant combined" : lastDecisionSource === "ai" ? "OpenAI powered" : "Local quant engine"}</div>
                  </div>
                  
                  {/* Confidence Score - Circular Gauge Style */}
                  <div style={{background: `linear-gradient(135deg, rgba(16,25,35,0.48) 0%, rgba(11,17,24,0.32) 100%)`, borderRadius:10, padding:14, border:`1px solid ${lastDecision.confidence_score >= 0.8 ? C.ok + '40' : lastDecision.confidence_score >= 0.5 ? C.warn + '40' : C.danger + '40'}`}}>
                    <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8}}>
                      <div style={{fontSize:10, color:C.dim, ...mono, letterSpacing:"0.1em"}}>CONFIDENCE</div>
                      <span style={{fontSize:14}}>{lastDecision.confidence_score >= 0.8 ? "🟢" : lastDecision.confidence_score >= 0.5 ? "🟡" : "🔴"}</span>
                    </div>
                    <div style={{display:"flex", alignItems:"baseline", gap:4}}>
                      <span style={{fontSize:28, color: lastDecision.confidence_score >= 0.8 ? C.ok : lastDecision.confidence_score >= 0.5 ? C.warn : C.danger, fontWeight:700, ...mono}}>
                        {(lastDecision.confidence_score * 100).toFixed(0)}
                      </span>
                      <span style={{fontSize:14, color:C.dim, ...mono}}>%</span>
                    </div>
                    <div style={{marginTop:8, height:4, background:C.s1, borderRadius:2, overflow:"hidden"}}>
                      <div style={{width: `${lastDecision.confidence_score * 100}%`, height:"100%", background: lastDecision.confidence_score >= 0.8 ? C.ok : lastDecision.confidence_score >= 0.5 ? C.warn : C.danger, borderRadius:2, transition:"width 0.5s ease"}} />
                    </div>
                  </div>
                  
                  {/* Kelly Sizing */}
                  <div style={{background: `linear-gradient(135deg, rgba(16,25,35,0.48) 0%, rgba(11,17,24,0.32) 100%)`, borderRadius:10, padding:14, border:`1px solid ${C.accent}40`}}>
                    <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8}}>
                      <div style={{fontSize:10, color:C.dim, ...mono, letterSpacing:"0.1em"}}>KELLY SIZING</div>
                      <span style={{fontSize:14}}>📈</span>
                    </div>
                    <div style={{display:"flex", alignItems:"baseline", gap:4}}>
                      <span style={{fontSize:28, color:C.accent, fontWeight:700, ...mono}}>
                        {(lastDecision.kelly_fraction * 100).toFixed(1)}
                      </span>
                      <span style={{fontSize:14, color:C.dim, ...mono}}>%</span>
                    </div>
                    <div style={{fontSize:10, color:C.dim, marginTop:4}}>Position size multiplier</div>
                  </div>
                  
                  {/* Monte Carlo Win */}
                  <div style={{background: `linear-gradient(135deg, rgba(16,25,35,0.48) 0%, rgba(11,17,24,0.32) 100%)`, borderRadius:10, padding:14, border:`1px solid ${C.ok}40`}}>
                    <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8}}>
                      <div style={{fontSize:10, color:C.dim, ...mono, letterSpacing:"0.1em"}}>MONTE CARLO</div>
                      <span style={{fontSize:14}}>🎯</span>
                    </div>
                    <div style={{display:"flex", alignItems:"baseline", gap:4}}>
                      <span style={{fontSize:28, color:C.ok, fontWeight:700, ...mono}}>
                        {lastDecision.monte_carlo_win_pct}
                      </span>
                      <span style={{fontSize:14, color:C.dim, ...mono}}>%</span>
                    </div>
                    <div style={{fontSize:10, color:C.dim, marginTop:4}}>Win probability</div>
                  </div>
                </div>
                
                {/* Quant Metrics Row - More Detail */}
                {lastDecision.quant_metrics && (
                  <div style={{background: "rgba(16,25,35,0.45)", borderRadius:10, padding:16, marginBottom:16, border:`1px solid ${C.border}`}}>
                    <div style={{fontSize:11, color:C.accent, fontWeight:700, ...mono, marginBottom:12, letterSpacing:"0.1em"}}>📊 QUANT CORE METRICS</div>
                    <div style={{display:"grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(5, 1fr)", gap:12}}>
                      <div>
                        <div style={{fontSize:9, color:C.dim, ...mono, marginBottom:4}}>SAMPLES</div>
                        <div style={{fontSize:16, color:C.text, fontWeight:700, ...mono}}>{lastDecision.quant_metrics.sample_count ?? "—"}</div>
                      </div>
                      <div>
                        <div style={{fontSize:9, color:C.dim, ...mono, marginBottom:4}}>EDGE SCORE</div>
                        <div style={{fontSize:16, color: Number(lastDecision.quant_metrics.edge_score) > 0 ? C.ok : C.warn, fontWeight:700, ...mono}}>{Number(lastDecision.quant_metrics.edge_score || 0).toFixed(4) ?? "—"}</div>
                      </div>
                      <div>
                        <div style={{fontSize:9, color:C.dim, ...mono, marginBottom:4}}>VOLATILITY</div>
                        <div style={{fontSize:16, color:C.text, fontWeight:700, ...mono}}>{Number(lastDecision.quant_metrics.ewma_volatility || 0).toFixed(4) ?? "—"}</div>
                      </div>
                      <div>
                        <div style={{fontSize:9, color:C.dim, ...mono, marginBottom:4}}>DATA QUALITY</div>
                        <div style={{fontSize:16, color: (lastDecision.quant_metrics.data_quality_score || 0) >= 0.7 ? C.ok : C.warn, fontWeight:700, ...mono}}>{((lastDecision.quant_metrics.data_quality_score || 0) * 100).toFixed(0)}%</div>
                      </div>
                      <div>
                        <div style={{fontSize:9, color:C.dim, ...mono, marginBottom:4}}>REGIME</div>
                        <div style={{fontSize:14, color: lastDecision.quant_metrics.regime === "RISK_ON" ? C.ok : lastDecision.quant_metrics.regime === "RISK_OFF" ? C.danger : C.warn, fontWeight:700, ...mono}}>
                          {String(lastDecision.quant_metrics.regime || "NA").replace(/_/g, " ")}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Risk & Execution Row */}
                <div style={{display:"flex", gap:12, marginBottom:16, flexWrap:"wrap"}}>
                  <div style={{flex: "1 1 200px", background: "rgba(16,25,35,0.45)", borderRadius:10, padding:14, border:`1px solid ${lastDecision.risk_score <= 0.4 ? C.ok + '40' : lastDecision.risk_score <= 0.7 ? C.warn + '40' : C.danger + '40'}`}}>
                    <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8}}>
                      <div style={{fontSize:10, color:C.dim, ...mono}}>RISK SCORE</div>
                      <span style={{fontSize:14}}>{lastDecision.risk_score <= 0.4 ? "🛡️" : lastDecision.risk_score <= 0.7 ? "⚠️" : "🚨"}</span>
                    </div>
                    <div style={{fontSize:24, color: lastDecision.risk_score <= 0.4 ? C.ok : lastDecision.risk_score <= 0.7 ? C.warn : C.danger, fontWeight:700, ...mono}}>
                      {lastDecision.risk_score?.toFixed(3)}
                    </div>
                    <div style={{fontSize:10, color:C.dim, marginTop:4}}>
                      {lastDecision.risk_score <= 0.4 ? "Low risk - Safe to execute" : lastDecision.risk_score <= 0.7 ? "Medium risk - Caution advised" : "High risk - Blocked"}
                    </div>
                  </div>
                  
                  <div style={{flex: "1 1 200px", background: "rgba(16,25,35,0.45)", borderRadius:10, padding:14, border:`1px solid ${C.accent}40`}}>
                    <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8}}>
                      <div style={{fontSize:10, color:C.dim, ...mono}}>CAPITAL ALLOCATION</div>
                      <span style={{fontSize:14}}>💰</span>
                    </div>
                    <div style={{fontSize:24, color:C.accent, fontWeight:700, ...mono}}>
                      {lastDecision.capital_allocation_kas} <span style={{fontSize:12, color:C.dim}}>KAS</span>
                    </div>
                    <div style={{fontSize:10, color:C.dim, marginTop:4}}>
                      ~${(Number(lastDecision.capital_allocation_kas) * Number(kasData?.priceUsd || 0)).toFixed(2)} USD
                    </div>
                  </div>
                  
                  <div style={{flex: "1 1 200px", background: "rgba(16,25,35,0.45)", borderRadius:10, padding:14, border:`1px solid ${C.border}`}}>
                    <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8}}>
                      <div style={{fontSize:10, color:C.dim, ...mono}}>NETWORK STATUS</div>
                      <span style={{fontSize:14}}>{liveConnected ? "🟢" : "🔴"}</span>
                    </div>
                    <div style={{fontSize:18, color: liveConnected ? C.ok : C.danger, fontWeight:700, ...mono}}>
                      {liveConnected ? "CONNECTED" : "OFFLINE"}
                    </div>
                    <div style={{fontSize:10, color:C.dim, marginTop:4}}>
                      {kasData?.dag?.daaScore ? `DAA: ${kasData.dag.daaScore.toLocaleString()}` : "Waiting for sync"}
                    </div>
                  </div>
                </div>
                
                {/* AI Rationale - Enhanced */}
                <div style={{background: `linear-gradient(135deg, ${C.accent}08 0%, ${C.s2} 100%)`, borderRadius:10, padding:16, marginBottom:16, border:`1px solid ${C.accent}30`}}>
                  <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8}}>
                    <div style={{display:"flex", alignItems:"center", gap:8}}>
                      <span style={{fontSize:14}}>🧠</span>
                      <div style={{fontSize:11, color:C.accent, fontWeight:700, ...mono, letterSpacing:"0.1em"}}>AI RATIONALE</div>
                    </div>
                    {lastDecision.quant_metrics?.ai_overlay_applied && (
                      <Badge text="🧠 AI OVERLAY ACTIVE" color={C.accent} />
                    )}
                  </div>
                  <div style={{fontSize:13, color:C.text, ...mono, lineHeight:1.6}}>
                    {lastDecision.rationale}
                  </div>
                </div>
                
                {/* Status Badges Row */}
                <div style={{display:"flex", gap:8, flexWrap:"wrap"}}>
                  {lastDecision.quant_metrics?.regime && (
                    <Badge 
                      text={`📊 ${String(lastDecision.quant_metrics.regime).replace(/_/g, " ")}`} 
                      color={lastDecision.quant_metrics.regime === "RISK_ON" ? C.ok : lastDecision.quant_metrics.regime === "RISK_OFF" ? C.danger : C.warn}
                    />
                  )}
                  <Badge 
                    text={`⚠️ RISK: ${lastDecision.risk_score?.toFixed(2)}`} 
                    color={lastDecision.risk_score <= 0.4 ? C.ok : lastDecision.risk_score <= 0.7 ? C.warn : C.danger}
                  />
                  <Badge 
                    text={`💰 ${lastDecision.capital_allocation_kas} KAS`} 
                    color={C.text}
                  />
                  {executionGuardrails?.calibration?.tier && (
                    <Badge 
                      text={`🎯 CAL: ${executionGuardrails.calibration.tier.toUpperCase()}`}
                      color={executionGuardrails.calibration.tier === "healthy" ? C.ok : C.warn}
                    />
                  )}
                  {executionGuardrails?.truth?.degraded && (
                    <Badge text="⚠️ TRUTH DEGRADED" color={C.danger} />
                  )}
                  {!executionGuardrails?.truth?.degraded && (
                    <Badge text="✅ VERIFIED" color={C.ok} />
                  )}
                </div>
              </div>
            ) : (
              <div style={{padding: "32px 20px", textAlign:"center", background: `linear-gradient(180deg, ${C.s2} 0%, ${C.s1} 100%)`}}>
                <div style={{fontSize:48, marginBottom:16}}>🤖</div>
                <div style={{fontSize:16, color:C.text, fontWeight:700, ...mono, marginBottom:8}}>AI Agent Ready</div>
                <div style={{fontSize:12, color:C.dim, marginBottom:16}}>Run a quant cycle to generate AI trading signals</div>
                <Btn onClick={runCycle} disabled={loading || (status !== "RUNNING")} style={{padding:"12px 32px", fontSize:14}}>
                  {loading ? "⚡ PROCESSING..." : "🚀 RUN QUANT CYCLE"}
                </Btn>
              </div>
            )}
          </Card>
          
          {/* On-Chain Activity - Recent Transactions with Explorer Links */}
          {queue && queue.length > 0 && (
            <Card p={0} style={{marginBottom:12, border: `1px solid ${C.ok}30`}}>
              <div style={{padding: "14px 20px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom: `1px solid ${C.border}`, background: `${C.ok}08`}}>
                <div style={{display:"flex", alignItems:"center", gap:10}}>
                  <span style={{fontSize:13, color:C.ok, fontWeight:700, ...mono}}>⛓️ ON-CHAIN ACTIVITY</span>
                </div>
                <div style={{display:"flex", gap:6}}>
                  <Badge 
                    text={`${queue.filter((q:any)=>q.status === "confirmed").length} CONFIRMED`} 
                    color={C.ok}
                  />
                  <Badge 
                    text={`${queue.filter((q:any)=>q.status === "signed" || q.status === "broadcasted").length} PENDING`} 
                    color={C.warn}
                  />
                </div>
              </div>
              
              <div style={{maxHeight: 200, overflowY: "auto"}}>
                {queue.slice(0, 5).map((item: any, i: number) => {
                  const isConfirmed = item.receipt_lifecycle === "confirmed";
                  const isPending = item.status === "signed" || item.status === "broadcasted" || item.status === "pending";
                  return (
                    <div key={i} style={{
                      display: "grid", 
                      gridTemplateColumns: isMobile ? "1fr" : "80px 80px 1fr 100px 80px", 
                      gap: 8, 
                      padding: "12px 20px", 
                      borderBottom: `1px solid ${C.border}`,
                      background: isConfirmed ? `${C.ok}08` : isPending ? `${C.warn}08` : C.s1
                    }}>
                      <div>
                        <div style={{fontSize:10, color:C.dim, ...mono}}>ACTION</div>
                        <div style={{fontSize:12, color: item.type === "ACCUMULATE" ? C.ok : item.type === "REDUCE" ? C.danger : C.text, fontWeight:700, ...mono}}>
                          {item.type}
                        </div>
                      </div>
                      <div>
                        <div style={{fontSize:10, color:C.dim, ...mono}}>AMOUNT</div>
                        <div style={{fontSize:12, color:C.text, fontWeight:700, ...mono}}>
                          {item.amount_kas} KAS
                        </div>
                      </div>
                      <div>
                        <div style={{fontSize:10, color:C.dim, ...mono}}>TXID</div>
                        <div style={{fontSize:11, color:C.accent, ...mono, wordBreak: "break-all"}}>
                          {item.txid ? `${item.txid.slice(0, 20)}...` : "—"}
                        </div>
                      </div>
                      <div>
                        <div style={{fontSize:10, color:C.dim, ...mono}}>STATUS</div>
                        <Badge 
                          text={isConfirmed ? "CONFIRMED ✓" : isPending ? "PENDING" : item.status?.toUpperCase() || "—"} 
                          color={isConfirmed ? C.ok : isPending ? C.warn : C.dim}
                        />
                      </div>
                      <div>
                        {item.txid && (
                          <ExtLink href={`${EXPLORER}/txs/${item.txid}`} label="VERIFY ↗"/>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              
              <div style={{padding: "10px 20px", borderTop: `1px solid ${C.border}`, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                <span style={{fontSize:11, color:C.dim, ...mono}}>Click "VERIFY ↗" to view transaction on Kaspa Explorer</span>
                <Btn onClick={() => setTab("queue")} variant="ghost" size="sm">VIEW ALL TRANSACTIONS →</Btn>
              </div>
            </Card>
          )}
          
          {/* Performance Tracker - High Frequency Trading Metrics */}
          <Card p={0} style={{marginBottom:12, background: `linear-gradient(135deg, rgba(16,25,35,0.48) 0%, rgba(11,17,24,0.32) 100%)`, border: `1px solid ${C.ok}30`, boxShadow: `0 4px 20px ${C.ok}10`}}>
            {/* Header */}
            <div style={{padding: "16px 20px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom: `1px solid ${C.border}`, background: `linear-gradient(90deg, ${C.ok}10 0%, transparent 100%)`}}>
              <div style={{display:"flex", alignItems:"center", gap:10}}>
                <span style={{fontSize:16}}>📈</span>
                <span style={{fontSize:14, color:C.text, fontWeight:700, ...mono}}>PERFORMANCE TRACKER</span>
              </div>
              <div style={{display:"flex", gap:8, alignItems:"center"}}>
                <div style={{display:"flex", alignItems:"center", gap:6, background:`${C.s2}90`, padding:"4px 10px", borderRadius:20, border:`1px solid ${C.border}`}}>
                  <span style={{fontSize:10, color:C.dim, ...mono}}>TODAY'S P&L</span>
                  <span style={{fontSize:12, color: pnlAttribution?.netPnlKas > 0 ? C.ok : C.danger, fontWeight:700, ...mono}}>
                    {pnlAttribution?.netPnlKas > 0 ? "+" : ""}{Number(pnlAttribution?.netPnlKas || 0).toFixed(4)} KAS
                  </span>
                </div>
                <Badge text={`${queue?.filter((q:any)=>q.status === "confirmed").length} TXS`} color={C.accent} />
              </div>
            </div>
            
            {/* Main Stats Grid */}
            <div style={{padding: "16px 20px"}}>
              <div style={{display:"grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(5, 1fr)", gap:12, marginBottom:16}}>
                {/* Total PnL */}
                <div style={{background: `linear-gradient(135deg, ${pnlAttribution?.netPnlKas > 0 ? C.ok : C.danger}15 0%, ${C.s2} 100%)`, borderRadius:10, padding:14, border:`1px solid ${pnlAttribution?.netPnlKas > 0 ? C.ok : C.danger}40`}}>
                  <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8}}>
                    <div style={{fontSize:10, color:C.dim, ...mono}}>TOTAL P&L</div>
                    <span style={{fontSize:14}}>{pnlAttribution?.netPnlKas > 0 ? "📈" : "📉"}</span>
                  </div>
                  <div style={{fontSize:24, color:pnlAttribution?.netPnlKas > 0 ? C.ok : C.danger, fontWeight:700, ...mono}}>
                    {pnlAttribution?.netPnlKas > 0 ? "+" : ""}{Number(pnlAttribution?.netPnlKas || 0).toFixed(4)}
                  </div>
                  <div style={{fontSize:10, color:C.dim, ...mono}}>KAS</div>
                </div>
                
                {/* Trade Count */}
                <div style={{background: "rgba(16,25,35,0.45)", borderRadius:10, padding:14, border:`1px solid ${C.border}`}}>
                  <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8}}>
                    <div style={{fontSize:10, color:C.dim, ...mono}}>TRADES</div>
                    <span style={{fontSize:14}}>🔢</span>
                  </div>
                  <div style={{fontSize:24, color:C.accent, fontWeight:700, ...mono}}>
                    {queue?.filter((q:any)=>q.status === "confirmed" || q.status === "broadcasted").length || 0}
                  </div>
                  <div style={{fontSize:10, color:C.dim, ...mono}}>executions</div>
                </div>
                
                {/* Win Rate */}
                <div style={{background: "rgba(16,25,35,0.45)", borderRadius:10, padding:14, border:`1px solid ${C.border}`}}>
                  <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8}}>
                    <div style={{fontSize:10, color:C.dim, ...mono}}>WIN RATE</div>
                    <span style={{fontSize:14}}>🎯</span>
                  </div>
                  <div style={{fontSize:24, color:C.ok, fontWeight:700, ...mono}}>
                    {pnlAttribution?.winRatePct || 0}%
                  </div>
                  <div style={{fontSize:10, color:C.dim, ...mono}}>profit rate</div>
                </div>
                
                {/* Avg Profit */}
                <div style={{background: "rgba(16,25,35,0.45)", borderRadius:10, padding:14, border:`1px solid ${C.border}`}}>
                  <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8}}>
                    <div style={{fontSize:10, color:C.dim, ...mono}}>AVG PROFIT</div>
                    <span style={{fontSize:14}}>💎</span>
                  </div>
                  <div style={{fontSize:24, color:C.ok, fontWeight:700, ...mono}}>
                    +{Number(pnlAttribution?.avgProfitKas || 0).toFixed(4)}
                  </div>
                  <div style={{fontSize:10, color:C.dim, ...mono}}>KAS per win</div>
                </div>
                
                {/* Best Trade */}
                <div style={{background: "rgba(16,25,35,0.45)", borderRadius:10, padding:14, border:`1px solid ${C.ok}40`}}>
                  <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8}}>
                    <div style={{fontSize:10, color:C.dim, ...mono}}>BEST TRADE</div>
                    <span style={{fontSize:14}}>🏆</span>
                  </div>
                  <div style={{fontSize:24, color:C.ok, fontWeight:700, ...mono}}>
                    +{Number(pnlAttribution?.bestTradeKas || 0).toFixed(4)}
                  </div>
                  <div style={{fontSize:10, color:C.dim, ...mono}}>KAS all-time</div>
                </div>
              </div>
              
              {/* Secondary Stats */}
              <div style={{display:"grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, 1fr)", gap:12, marginBottom:16}}>
                {/* Total Fees Paid */}
                <div style={{background: "rgba(16,25,35,0.45)", borderRadius:10, padding:14, border:`1px solid ${C.border}`}}>
                  <div style={{fontSize:10, color:C.dim, ...mono, marginBottom:4}}>TOTAL FEES</div>
                  <div style={{fontSize:18, color:C.warn, fontWeight:700, ...mono}}>-{totalFees.toFixed(4)}</div>
                  <div style={{fontSize:10, color:C.dim, ...mono}}>KAS paid</div>
                </div>
                
                {/* Net Profit */}
                <div style={{background: "rgba(16,25,35,0.45)", borderRadius:10, padding:14, border:`1px solid ${(pnlAttribution?.netPnlKas - totalFees) > 0 ? C.ok : C.danger}40`}}>
                  <div style={{fontSize:10, color:C.dim, ...mono, marginBottom:4}}>NET PROFIT</div>
                  <div style={{fontSize:18, color:(pnlAttribution?.netPnlKas - totalFees) > 0 ? C.ok : C.danger, fontWeight:700, ...mono}}>
                    {(pnlAttribution?.netPnlKas - totalFees) > 0 ? "+" : ""}{(pnlAttribution?.netPnlKas - totalFees || 0).toFixed(4)}
                  </div>
                  <div style={{fontSize:10, color:C.dim, ...mono}}>KAS after fees</div>
                </div>
                
                {/* Decisions Made */}
                <div style={{background: "rgba(16,25,35,0.45)", borderRadius:10, padding:14, border:`1px solid ${C.border}`}}>
                  <div style={{fontSize:10, color:C.dim, ...mono, marginBottom:4}}>DECISIONS</div>
                  <div style={{fontSize:18, color:C.text, fontWeight:700, ...mono}}>{decisions.length}</div>
                  <div style={{fontSize:10, color:C.dim, ...mono}}>AI signals</div>
                </div>
                
                {/* Accuracy */}
                <div style={{background: "rgba(16,25,35,0.45)", borderRadius:10, padding:14, border:`1px solid ${C.border}`}}>
                  <div style={{fontSize:10, color:C.dim, ...mono, marginBottom:4}}>ACCURACY</div>
                  <div style={{fontSize:18, color:C.accent, fontWeight:700, ...mono}}>
                    {decisions.length > 0 ? Math.round((decisions.filter((d:any)=>d?.dec?.action === "ACCUMULATE" || d?.dec?.action === "HOLD").length / decisions.length) * 100) : 0}%
                  </div>
                  <div style={{fontSize:10, color:C.dim, ...mono}}>signal accuracy</div>
                </div>
              </div>
              
              {/* Quick Stats Row */}
              <div style={{display:"flex", gap:8, flexWrap:"wrap", justifyContent:"space-between", alignItems:"center"}}>
                <div style={{display:"flex", gap:8}}>
                  <Badge text={`💰 Budget: ${agent.capitalLimit} KAS/cycle`} color={C.accent} />
                  <Badge text={`🎯 Target: ${agent.kpiTarget}% ROI`} color={C.ok} />
                  <Badge text={`⏱️ Cycle: ${AUTO_CYCLE_SECONDS}s`} color={C.text} />
                </div>
                <div style={{display:"flex", gap:8}}>
                  <Btn onClick={() => setTab("analytics")} variant="ghost" size="sm">
                    📊 FULL ANALYTICS →
                  </Btn>
                </div>
              </div>
            </div>
          </Card>

          {/* AI Agent Overview Panel */}
          <Suspense fallback={<Card p={18}><Label>Agent Overview</Label><div style={{fontSize:12,color:C.dim}}>Loading agent overview...</div></Card>}>
            <AgentOverviewPanel 
              decisions={decisions} 
              queue={queue} 
              agent={agent}
              onNavigate={(tabName: string) => setTab(tabName)}
            />
          </Suspense>
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
          </div>
        </div>
      )}

      {tab==="portfolio" && (
        <Suspense fallback={<Card p={18}><Label>Portfolio</Label><div style={{fontSize:12,color:C.dim}}>Loading portfolio allocator...</div></Card>}>
          <PortfolioPanel
            agents={allAgents}
            activeAgentId={activeAgentId || agent?.agentId}
            walletKas={kasData?.walletKas || 0}
            kasPriceUsd={kasData?.priceUsd || 0}
            lastDecision={decisions[0] || null}
            summary={portfolioSummary}
            config={portfolioConfig}
            onConfigPatch={patchPortfolioConfig}
            onAgentOverridePatch={patchPortfolioAgentOverride}
            onSelectAgent={onSelectAgent}
            onRefresh={refreshPortfolioPeers}
            onDeleteAgent={onDeleteAgent}
            onEditAgent={onEditAgent}
          />
        </Suspense>
      )}

      {tab==="intelligence" && (
        <Suspense fallback={<Card p={18}><Label>Intelligence</Label><div style={{fontSize:12,color:C.dim}}>Loading intelligence panel...</div></Card>}>
          <IntelligencePanel decisions={decisions} queue={queue} loading={loading} onRun={runCycle}/>
        </Suspense>
      )}
      
      {tab==="analytics" && (
        <Suspense fallback={<Card p={18}><Label>Analytics</Label><div style={{fontSize:12,color:C.dim}}>Loading analytics panel...</div></Card>}>
          <QuantAnalyticsPanel decisions={decisions} queue={queue} />
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
      {tab==="wallet" && <WalletPanel agent={agent} wallet={wallet} kasData={kasData} marketHistory={marketHistory} lastDecision={decisions[0] || null}/>}

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
          {/* Strategy Management Card */}
          <Card p={20} style={{gridColumn: "1 / -1"}}>
            <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16}}>
              <Label>Strategy Configuration</Label>
              <Btn onClick={()=>setEditingStrategy(!editingStrategy)} variant={editingStrategy ? "warn" : "primary"} size="sm">
                {editingStrategy ? "Cancel" : "Edit Strategy"}
              </Btn>
            </div>
            
            {/* Current Strategy Display */}
            {!editingStrategy && (
              <div>
                <div style={{display:"flex", gap:8, flexWrap:"wrap", marginBottom:16}}>
                  <Badge text={agent?.strategyLabel || "Custom"} color={C.accent}/>
                  <Badge text={agent?.strategyClass?.toUpperCase() || "CUSTOM"} color={C.text}/>
                  <Badge text={`RISK: ${agent?.risk?.toUpperCase() || "MEDIUM"}`} color={agent?.risk === "low" ? C.ok : agent?.risk === "medium" ? C.warn : C.danger}/>
                </div>
                <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:12}}>
                  {[
                    ["ROI Target", `${agent?.kpiTarget || 12}%`],
                    ["Capital / Cycle", `${agent?.capitalLimit || 5000} KAS`],
                    ["Horizon", `${agent?.horizon || 30} days`],
                    ["Auto-Approve ≤", `${agent?.autoApproveThreshold || 50} KAS`],
                  ].map(([k,v])=> (
                    <div key={k as any} style={{background:C.s2, padding:"10px 14px", borderRadius:6}}>
                      <div style={{fontSize:10, color:C.dim, ...mono, marginBottom:4}}>{k}</div>
                      <div style={{fontSize:14, color:C.text, fontWeight:600, ...mono}}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {/* Edit Mode */}
            {editingStrategy && (
              <div>
                <div style={{fontSize:11, color:C.dim, ...mono, marginBottom:10}}>SELECT STRATEGY PRESET</div>
                <div style={{display:"grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(2, 1fr)", gap:12, marginBottom:16}}>
                  {allStrategies.map((strategy: any) => {
                    const isSelected = editForm.strategyTemplate === strategy.id;
                    return (
                      <div 
                        key={strategy.id}
                        onClick={()=>handleStrategySelect(strategy)}
                        style={{
                          padding:"16px 18px", 
                          borderRadius:10, 
                          cursor:"pointer", 
                          border:`2px solid ${isSelected ? C.accent : C.border}`,
                          background:isSelected ? `${C.accent}15` : C.s2,
                          transition:"all 0.2s",
                          boxShadow: isSelected ? `0 4px 12px ${C.accent}30` : "none"
                        }}
                      >
                        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8}}>
                          <span style={{fontSize:14, color:isSelected ? C.accent : C.text, fontWeight:700, ...mono}}>{strategy.name}</span>
                          <Badge text={strategy.tag} color={strategy.tagColor || C.purple} size="sm"/>
                        </div>
                        <div style={{fontSize:11, color:C.dim, lineHeight:1.4}}>{strategy.purpose?.slice(0, 80)}...</div>
                      </div>
                    );
                  })}
                </div>
                
                <div style={{fontSize:11, color:C.dim, ...mono, marginBottom:10, marginTop:16}}>CONFIGURE PARAMETERS</div>
                <div style={{display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))", gap:12, marginBottom:16}}>
                  <Inp 
                    label="ROI Target" 
                    value={editForm.kpiTarget} 
                    onChange={(v: string)=>setEditForm({...editForm, kpiTarget: v})} 
                    type="number" 
                    suffix="%"
                  />
                  <Inp 
                    label="Capital / Cycle" 
                    value={editForm.capitalLimit} 
                    onChange={(v: string)=>setEditForm({...editForm, capitalLimit: v})} 
                    type="number" 
                    suffix="KAS"
                  />
                  <Inp 
                    label="Horizon (days)" 
                    value={editForm.horizon} 
                    onChange={(v: string)=>setEditForm({...editForm, horizon: Number(v)})} 
                    type="number"
                  />
                  <Inp 
                    label="Auto-Approve ≤" 
                    value={editForm.autoApproveThreshold} 
                    onChange={(v: string)=>setEditForm({...editForm, autoApproveThreshold: v})} 
                    type="number" 
                    suffix="KAS"
                  />
                </div>
                
                <div style={{fontSize:11, color:C.dim, ...mono, marginBottom:10}}>RISK TOLERANCE</div>
                <div style={{display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:16}}>
                  {RISK_OPTS.map(r=>{const on = editForm.risk === r.v; return (
                    <div 
                      key={r.v} 
                      onClick={()=>setEditForm({...editForm, risk: r.v})}
                      style={{
                        padding:"12px 10px", 
                        borderRadius:4, 
                        cursor:"pointer", 
                        border:`1px solid ${on?C.accent:C.border}`, 
                        background:on?C.aLow:C.s2, 
                        textAlign:"center", 
                        transition:"all 0.15s"
                      }}
                    >
                      <div style={{fontSize:12, color:on?C.accent:C.text, fontWeight:600, ...mono}}>{r.l}</div>
                    </div>
                  );})}
                </div>
                
                <div style={{fontSize:11, color:C.dim, ...mono, marginBottom:10}}>EXECUTION MODE</div>
                <div style={{display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:16}}>
                  {EXEC_OPTS.map(r=>{const on = editForm.execMode === r.v; return (
                    <div 
                      key={r.v} 
                      onClick={()=>setEditForm({...editForm, execMode: r.v})}
                      style={{
                        padding:"12px 10px", 
                        borderRadius:4, 
                        cursor:"pointer", 
                        border:`1px solid ${on?C.accent:C.border}`, 
                        background:on?C.aLow:C.s2, 
                        textAlign:"center", 
                        transition:"all 0.15s"
                      }}
                    >
                      <div style={{fontSize:11, color:on?C.accent:C.text, fontWeight:600, ...mono}}>{r.l}</div>
                    </div>
                  );})}
                </div>
                
                <div style={{display:"flex", gap:10, justifyContent:"flex-end"}}>
                  <Btn onClick={()=>setEditingStrategy(false)} variant="ghost">Cancel</Btn>
                  <Btn onClick={handleSaveStrategy}>Save Changes</Btn>
                </div>
              </div>
            )}
          </Card>
          
          {/* Execution Mode Card */}
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
              <Label>⚡ Quick Actions</Label>
              <div style={{fontSize:11, color:C.dim, ...mono, marginBottom:10}}>
                Auto cycle cadence: every {AUTO_CYCLE_SECONDS}s · Next cycle in {autoCycleCountdownLabel}
              </div>
              <div style={{display:"flex", gap:8, flexWrap:"wrap"}}>
                <Btn onClick={runCycle} disabled={loading||status!=="RUNNING"} size="sm">
                  {loading ? "⏳" : "🚀"} {loading ? "RUNNING" : "RUN CYCLE"}
                </Btn>
                <Btn
                  onClick={()=>setLiveExecutionArmed((v: boolean)=>!v)}
                  variant={liveExecutionArmed ? "warn" : "primary"}
                  size="sm"
                >
                  {liveExecutionArmed ? "🟢 AUTO-TRADE ON" : "🔴 AUTO-TRADE OFF"}
                </Btn>
                <Btn onClick={()=>transitionAgentStatus({ type: status==="RUNNING" ? "PAUSE" : "RESUME" })} variant="ghost" size="sm">
                  {status==="RUNNING" ? "⏸ PAUSE" : "▶️ RESUME"}
                </Btn>
                <Btn onClick={killSwitch} variant="danger" size="sm">
                  🛑 KILL
                </Btn>
              </div>
            </Card>
            <Card p={18}>
              <Label>Active Risk Limits — {agent?.risk?.toUpperCase() || "MEDIUM"}</Label>
              {[["Max Single Exposure",agent?.risk==="low"?"5%":agent?.risk==="medium"?"10%":"20%",C.warn],["Drawdown Halt",agent?.risk==="low"?"-8%":agent?.risk==="medium"?"-15%":"-25%",C.danger],["Confidence Floor","0.75",C.dim],["Kelly Cap",agent?.risk==="low"?"10%":agent?.risk==="medium"?"20%":"40%",C.warn],["Auto-Approve ≤",`${autoThresh} KAS`,C.accent]].map(([k,v,c])=> (
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
