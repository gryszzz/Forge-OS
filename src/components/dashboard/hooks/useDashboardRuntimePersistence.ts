import { useEffect } from "react";
import { readPersistedDashboardState, writePersistedDashboardState } from "../../../runtime/persistentState";
import { seedLog } from "../../../log/seedLog";

type Params = {
  agent: any;
  cycleIntervalMs: number;
  runtimeScope: string;
  maxDecisionEntries: number;
  maxLogEntries: number;
  maxQueueEntries: number;
  maxMarketSnapshots: number;
  runtimeHydrated: boolean;
  setRuntimeHydrated: (v: boolean) => void;
  status: any;
  execMode: any;
  liveExecutionArmed: boolean;
  queue: any[];
  log: any[];
  decisions: any[];
  marketHistory: any[];
  attributionSummary?: any;
  nextAutoCycleAt: number;
  setStatus: (v: any) => void;
  setExecMode: (v: any) => void;
  setLiveExecutionArmed: (v: any) => void;
  setQueue: (v: any) => void;
  setLog: (v: any) => void;
  setDecisions: (v: any) => void;
  setMarketHistory: (v: any) => void;
  setNextAutoCycleAt: (v: any) => void;
  liveExecutionDefault: boolean;
  writeDelayMs?: number;
};

export function useDashboardRuntimePersistence(params: Params) {
  const {
    agent,
    cycleIntervalMs,
    runtimeScope,
    maxDecisionEntries,
    maxLogEntries,
    maxQueueEntries,
    maxMarketSnapshots,
    runtimeHydrated,
    setRuntimeHydrated,
    status,
    execMode,
    liveExecutionArmed,
    queue,
    log,
    decisions,
    marketHistory,
    attributionSummary,
    nextAutoCycleAt,
    setStatus,
    setExecMode,
    setLiveExecutionArmed,
    setQueue,
    setLog,
    setDecisions,
    setMarketHistory,
    setNextAutoCycleAt,
    liveExecutionDefault,
    writeDelayMs = 250,
  } = params;

  useEffect(() => {
    setRuntimeHydrated(false);
    const persisted = readPersistedDashboardState(runtimeScope);

    if (persisted) {
      // Only restore status if there's a valid agent
      if (persisted.status && agent?.name) {
        setStatus(persisted.status);
      }
      if (persisted.execMode && ["autonomous", "manual", "notify"].includes(String(persisted.execMode))) {
        setExecMode(persisted.execMode);
      } else {
        setExecMode(agent.execMode || "manual");
      }
      if (typeof persisted.liveExecutionArmed === "boolean") {
        setLiveExecutionArmed(persisted.liveExecutionArmed);
      } else {
        setLiveExecutionArmed(liveExecutionDefault);
      }
      setQueue(Array.isArray(persisted.queue) ? persisted.queue.slice(0, maxQueueEntries) : []);
      setLog(
        Array.isArray(persisted.log) && persisted.log.length > 0
          ? persisted.log.slice(0, maxLogEntries)
          : seedLog(agent.name)
      );
      setDecisions(Array.isArray(persisted.decisions) ? persisted.decisions.slice(0, maxDecisionEntries) : []);
      setMarketHistory(
        Array.isArray((persisted as any).marketHistory)
          ? (persisted as any).marketHistory.slice(-maxMarketSnapshots)
          : []
      );
      setNextAutoCycleAt(
        Number.isFinite(persisted.nextAutoCycleAt)
          ? Math.max(Date.now() + 1000, Number(persisted.nextAutoCycleAt))
          : Date.now() + cycleIntervalMs
      );
    } else {
      // Only set to RUNNING if there's a valid agent
      if (agent?.name) {
        setStatus("RUNNING");
      }
      setExecMode(agent.execMode || "manual");
      setLiveExecutionArmed(liveExecutionDefault);
      setQueue([]);
      setDecisions([]);
      setMarketHistory([]);
      setLog(seedLog(agent.name));
      setNextAutoCycleAt(Date.now() + cycleIntervalMs);
    }

    setRuntimeHydrated(true);
  }, [
    agent.execMode,
    agent.name,
    cycleIntervalMs,
    liveExecutionDefault,
    maxDecisionEntries,
    maxLogEntries,
    maxMarketSnapshots,
    maxQueueEntries,
    runtimeScope,
    setDecisions,
    setExecMode,
    setLiveExecutionArmed,
    setLog,
    setMarketHistory,
    setNextAutoCycleAt,
    setQueue,
    setRuntimeHydrated,
    setStatus,
  ]);

  useEffect(() => {
    if (!runtimeHydrated) return;
    const persistTimer = setTimeout(() => {
      writePersistedDashboardState(runtimeScope, {
        status: status as "RUNNING" | "PAUSED" | "SUSPENDED",
        execMode: execMode as "autonomous" | "manual" | "notify",
        liveExecutionArmed,
        queue,
        log,
        decisions,
        marketHistory,
        attributionSummary,
        nextAutoCycleAt,
      });
    }, writeDelayMs);
    return () => clearTimeout(persistTimer);
  }, [
    decisions,
    execMode,
    liveExecutionArmed,
    log,
    marketHistory,
    attributionSummary,
    nextAutoCycleAt,
    queue,
    runtimeHydrated,
    runtimeScope,
    status,
    writeDelayMs,
  ]);
}
