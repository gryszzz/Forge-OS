import { round, toFinite } from "./math";

type AiTransportConfig = {
  apiUrl: string;
  model: string;
  anthropicApiKey?: string;
  timeoutMs: number;
  maxAttempts: number;
  retryableStatuses: Set<number>;
};

type RequestAiDecisionParams = {
  agent: any;
  kasData: any;
  quantCoreDecision: any;
  config: AiTransportConfig;
  sanitizeDecision: (raw: any, agent: any) => any;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aiRetryDelayMs(attempt: number) {
  const jitter = Math.floor(Math.random() * 90);
  return 160 * (attempt + 1) + jitter;
}

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("AI response was not valid JSON");
  }
}

function buildHeaders(config: AiTransportConfig) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiUrl.includes("api.anthropic.com")) {
    if (!config.anthropicApiKey) {
      throw new Error(
        "Anthropic API key missing. Set VITE_ANTHROPIC_API_KEY or configure VITE_AI_API_URL to your secure backend endpoint."
      );
    }
    headers["x-api-key"] = config.anthropicApiKey;
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

export function buildAiOverlayPrompt(agent: any, kasData: any, quantCoreDecision: any) {
  const compactKasData = {
    fetched: toFinite(kasData?.fetched, 0),
    address: String(kasData?.address || ""),
    walletKas: round(toFinite(kasData?.walletKas, 0), 6),
    priceUsd: round(toFinite(kasData?.priceUsd, 0), 8),
    dag: {
      daaScore: toFinite(kasData?.dag?.daaScore, 0),
      difficulty: toFinite(kasData?.dag?.difficulty ?? kasData?.dag?.virtualDaaScore, 0),
      networkName: String(kasData?.dag?.networkName || kasData?.dag?.network || ""),
      pastMedianTime: toFinite(kasData?.dag?.pastMedianTime ?? kasData?.dag?.virtualPastMedianTime, 0),
    },
  };
  const quantMetrics = quantCoreDecision?.quant_metrics || {};
  return `You are a quant-grade AI risk overlay for a Kaspa-native autonomous trading engine. The local quant core (deterministic math) has already computed features, regime, Kelly cap, and risk limits. Your job is to refine the decision WITHOUT violating the local risk envelope.

Respond ONLY with a valid JSON object — no markdown, no prose, no code fences.

AGENT PROFILE:
Name: ${agent.name}
Strategy: momentum / on-chain flow / risk-controlled execution
Risk Tolerance: ${agent.risk} (low=conservative, high=aggressive)
KPI Target: ${agent.kpiTarget}% ROI
Capital per Cycle: ${agent.capitalLimit} KAS
Auto-Approve Threshold: ${agent.autoApproveThreshold} KAS

KASPA SNAPSHOT:
${JSON.stringify(compactKasData)}

LOCAL QUANT CORE PRIOR (trust this as the primary signal unless you have a strong reason):
${JSON.stringify({
  action: quantCoreDecision.action,
  confidence_score: quantCoreDecision.confidence_score,
  risk_score: quantCoreDecision.risk_score,
  kelly_fraction: quantCoreDecision.kelly_fraction,
  capital_allocation_kas: quantCoreDecision.capital_allocation_kas,
  expected_value_pct: quantCoreDecision.expected_value_pct,
  stop_loss_pct: quantCoreDecision.stop_loss_pct,
  take_profit_pct: quantCoreDecision.take_profit_pct,
  monte_carlo_win_pct: quantCoreDecision.monte_carlo_win_pct,
  quant_metrics: quantMetrics,
  rationale: quantCoreDecision.rationale,
  risk_factors: quantCoreDecision.risk_factors,
})}

RULES:
1. Do not exceed quant_metrics.kelly_cap in kelly_fraction.
2. Do not exceed local quant capital_allocation_kas by more than 25%.
3. If quant_metrics.regime is RISK_OFF, avoid ACCUMULATE unless confidence_score >= 0.9 and risk_score <= quant_metrics.risk_ceiling.
4. Preserve strict risk discipline; prefer HOLD over low-quality conviction.
5. Keep rationale concise and reference actual metrics from the snapshot/core prior.

OUTPUT (strict JSON, all fields required):
{
  "action": "ACCUMULATE or REDUCE or HOLD or REBALANCE",
  "confidence_score": 0.00,
  "risk_score": 0.00,
  "kelly_fraction": 0.00,
  "capital_allocation_kas": 0.00,
  "capital_allocation_pct": 0,
  "expected_value_pct": 0.00,
  "stop_loss_pct": 0.00,
  "take_profit_pct": 0.00,
  "monte_carlo_win_pct": 0,
  "volatility_estimate": "LOW or MEDIUM or HIGH",
  "liquidity_impact": "MINIMAL or MODERATE or SIGNIFICANT",
  "strategy_phase": "ENTRY or SCALING or HOLDING or EXIT",
  "rationale": "Two concise sentences citing specific metrics and why this refines the quant-core prior.",
  "risk_factors": ["factor1", "factor2", "factor3"],
  "next_review_trigger": "Describe the specific condition that should trigger next decision cycle"
}`;
}

export async function requestAiOverlayDecision(params: RequestAiDecisionParams) {
  const { agent, kasData, quantCoreDecision, config, sanitizeDecision } = params;
  const prompt = buildAiOverlayPrompt(agent, kasData, quantCoreDecision);
  const body = config.apiUrl.includes("api.anthropic.com")
    ? { model: config.model, max_tokens: 900, messages: [{ role: "user", content: prompt }] }
    : { prompt, agent, kasData, quantCore: quantCoreDecision };

  let data: any;
  for (let attempt = 0; attempt < config.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await fetch(config.apiUrl, {
        method: "POST",
        headers: buildHeaders(config),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const status = Number(res.status || 0);
        if (config.retryableStatuses.has(status) && attempt + 1 < config.maxAttempts) {
          await sleep(aiRetryDelayMs(attempt));
          continue;
        }
        throw new Error(`AI endpoint ${status || "request_failed"}`);
      }

      data = await res.json();
      break;
    } catch (err: any) {
      const isTimeout = err?.name === "AbortError";
      const rawMessage = String(err?.message || "");
      const isNetworkError = err?.name === "TypeError" || /failed to fetch|network|load failed/i.test(rawMessage);
      if (!isTimeout && isNetworkError && attempt + 1 < config.maxAttempts) {
        await sleep(aiRetryDelayMs(attempt));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (data?.error?.message) throw new Error(data.error.message);
  if (Array.isArray(data?.content)) {
    const text = data.content.map((block: any) => block.text || "").join("");
    const parsed = safeJsonParse(text.replace(/```json|```/g, "").trim());
    return sanitizeDecision({ ...parsed, decision_source: "ai" }, agent);
  }
  if (data?.decision) return sanitizeDecision({ ...data.decision, decision_source: "ai" }, agent);
  return sanitizeDecision({ ...data, decision_source: "ai" }, agent);
}

