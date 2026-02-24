import { useEffect, useMemo, useState } from "react";
import { DEFAULT_NETWORK } from "../../../constants";
import { computeSharedRiskBudgetAllocation } from "../../../portfolio/allocator";
import { readPersistedDashboardState } from "../../../runtime/persistentState";
import { readPortfolioAllocatorConfig, writePortfolioAllocatorConfig } from "../../../runtime/portfolioState";

type UsePortfolioAllocatorParams = {
  portfolioScope: string;
  allAgents: any[];
  activeAgentId?: string;
  walletAddress?: string;
  walletKas?: number;
  activeDecisions: any[];
  activeQueue: any[];
  activeAttributionSummary?: any;
};

export function usePortfolioAllocator(params: UsePortfolioAllocatorParams) {
  const {
    portfolioScope,
    allAgents,
    activeAgentId,
    walletAddress,
    walletKas,
    activeDecisions,
    activeQueue,
    activeAttributionSummary,
  } = params;

  const [portfolioConfig, setPortfolioConfig] = useState(() => readPortfolioAllocatorConfig(portfolioScope));
  const [portfolioRefreshSeq, setPortfolioRefreshSeq] = useState(0);
  const [peerRuntimeCache, setPeerRuntimeCache] = useState(() => ({} as Record<string, any>));

  useEffect(() => {
    setPortfolioConfig(readPortfolioAllocatorConfig(portfolioScope));
  }, [portfolioScope]);

  useEffect(() => {
    const id = setTimeout(() => {
      writePortfolioAllocatorConfig(portfolioScope, portfolioConfig);
    }, 200);
    return () => clearTimeout(id);
  }, [portfolioConfig, portfolioScope]);

  useEffect(() => {
    const activeId = String(activeAgentId || "");
    const loadPeers = () => {
      const next: Record<string, any> = {};
      for (const row of allAgents) {
        const rowId = String(row?.agentId || row?.name || "");
        if (!rowId || rowId === activeId) continue;
        const rowScope = `${DEFAULT_NETWORK}:${String(walletAddress || "unknown").toLowerCase()}:${rowId.toLowerCase()}`;
        next[rowId] = readPersistedDashboardState(rowScope) || {};
      }
      setPeerRuntimeCache(next);
    };
    loadPeers();
    const timer = setInterval(loadPeers, 4000);
    return () => clearInterval(timer);
  }, [activeAgentId, allAgents, portfolioRefreshSeq, walletAddress]);

  const portfolioSummary = useMemo(() => {
    const inputs = allAgents.map((row: any) => {
      const rowId = String(row?.agentId || row?.name || "");
      const isActive = rowId === String(activeAgentId || "");
      const persisted = isActive
        ? { queue: activeQueue, decisions: activeDecisions, attributionSummary: activeAttributionSummary }
        : (peerRuntimeCache[rowId] || {}) as any;
      const lastDecision = Array.isArray((persisted as any).decisions) ? (persisted as any).decisions[0]?.dec : undefined;
      const pendingKas = Array.isArray((persisted as any).queue)
        ? (persisted as any).queue
            .filter((q: any) => q?.status === "pending" && q?.metaKind !== "treasury_fee")
            .reduce((sum: number, q: any) => sum + Number(q?.amount_kas || 0), 0)
        : 0;

      const overrideKey = rowId.toLowerCase();
      const override = (portfolioConfig?.agentOverrides || {})[overrideKey] || {};

      // Extract balance from peer runtime (use capitalLimit as default if not available)
      const balanceKas = Number(row?.capitalLimitKas || row?.capitalLimit || 0);

      // Extract PnL from attribution summary
      const attributionSummary = (persisted as any).attributionSummary;
      const pnlKas = Number(attributionSummary?.netPnlKas || 0);
      const pnlMode = attributionSummary?.netPnlMode || "estimated";

      return {
        agentId: rowId,
        name: String(row?.name || rowId),
        enabled: override.enabled !== false,
        capitalLimitKas: Number(row?.capitalLimit || 0),
        targetAllocationPct: Number(
          override.targetAllocationPct ??
            row?.portfolioAllocationPct ??
            Math.round(100 / Math.max(1, allAgents.length))
        ),
        riskBudgetWeight: Number(override.riskWeight ?? row?.riskBudgetWeight ?? 1),
        strategyTemplate: String(row?.strategyTemplate || row?.strategyLabel || row?.strategyClass || "custom"),
        strategyClass: String(row?.strategyClass || ""),
        attributionSummary,
        pendingKas,
        lastDecision,
        balanceKas,
        pnlKas,
        pnlMode,
      };
    });

    return computeSharedRiskBudgetAllocation({
      walletKas: Number(walletKas || 0),
      agents: inputs,
      config: portfolioConfig,
    });
  }, [activeAgentId, activeAttributionSummary, activeDecisions, activeQueue, allAgents, peerRuntimeCache, portfolioConfig, walletKas]);

  const activePortfolioRow = useMemo(
    () => portfolioSummary?.rows?.find((row: any) => String(row?.agentId) === String(activeAgentId)) || null,
    [activeAgentId, portfolioSummary]
  );

  const patchPortfolioConfig = (patch: any) => {
    setPortfolioConfig((prev: any) => ({ ...prev, ...patch, updatedAt: Date.now() }));
  };

  const patchPortfolioAgentOverride = (agentId: string, patch: any) => {
    const key = String(agentId || "").toLowerCase();
    if (!key) return;
    setPortfolioConfig((prev: any) => ({
      ...prev,
      updatedAt: Date.now(),
      agentOverrides: {
        ...(prev?.agentOverrides || {}),
        [key]: {
          ...((prev?.agentOverrides || {})[key] || {}),
          ...patch,
        },
      },
    }));
    setPortfolioRefreshSeq((v) => v + 1);
  };

  const refreshPortfolioPeers = () => {
    setPortfolioRefreshSeq((v) => v + 1);
  };

  return {
    portfolioConfig,
    setPortfolioConfig,
    peerRuntimeCache,
    portfolioSummary,
    activePortfolioRow,
    patchPortfolioConfig,
    patchPortfolioAgentOverride,
    refreshPortfolioPeers,
  };
}
