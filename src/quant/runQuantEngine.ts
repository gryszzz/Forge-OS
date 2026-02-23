import { buildQuantCoreDecision, type QuantContext } from "./quantCore";
import { clamp, round, toFinite } from "./math";
import {
  agentOverlayCacheKey,
  createOverlayDecisionCache,
} from "./runQuantEngineOverlayCache";
import {
  AUDIT_HASH_ALGO,
  buildAuditSigningPayloadFromRecord,
  hashCanonical,
} from "./runQuantEngineAudit";
import { requestAiOverlayDecision } from "./runQuantEngineAiTransport";
import { fuseWithQuantCore, resolveAiOverlayPlan } from "./runQuantEngineFusion";
import { RUN_QUANT_ENGINE_CONFIG as CFG } from "./runQuantEngineConfig";
import {
  appendSourceDetail,
  localQuantDecisionFromCore,
  sanitizeCachedOverlayDecision,
} from "./runQuantEngineFallback";

const AI_OVERLAY_CACHE = createOverlayDecisionCache(CFG.aiOverlayCacheMaxEntries);

function auditSignerHeaders() {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (CFG.auditSignerToken) headers.Authorization = `Bearer ${CFG.auditSignerToken}`;
  return headers;
}

async function maybeAttachCryptographicAuditSignature(decision: any) {
  const auditRecord = decision?.audit_record;
  if (!auditRecord || !CFG.auditSignerUrl) return decision;
  const signingPayload = buildAuditSigningPayloadFromRecord(auditRecord, {
    decisionAuditRecordVersion: CFG.decisionAuditRecordVersion,
    auditHashAlgo: AUDIT_HASH_ALGO,
    aiPromptVersion: CFG.aiPromptVersion,
    aiResponseSchemaVersion: CFG.aiResponseSchemaVersion,
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CFG.auditSignerTimeoutMs);
  try {
    const res = await fetch(CFG.auditSignerUrl, {
      method: "POST",
      headers: auditSignerHeaders(),
      body: JSON.stringify({ signingPayload }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(String(data?.error?.message || `audit_signer_${res.status || "failed"}`));
    }
    const sig = data?.signature && typeof data.signature === "object" ? data.signature : data;
    const cryptoSignature = {
      status: "signed",
      alg: String(sig?.alg || sig?.algorithm || "unknown").slice(0, 80),
      key_id: String(sig?.keyId || sig?.key_id || "").slice(0, 160),
      sig_b64u: String(sig?.signatureB64u || sig?.signature || sig?.sig_b64u || "").slice(0, 600),
      payload_hash_sha256_b64u: String(sig?.payloadHashSha256B64u || sig?.payload_hash_sha256_b64u || "").slice(0, 160),
      signer: String(sig?.signer || "audit-signer").slice(0, 80),
      signed_ts: Math.max(0, Math.round(toFinite(sig?.signedAt ?? sig?.signed_ts, Date.now()))),
      signing_latency_ms: Math.max(0, Math.round(toFinite(sig?.signingLatencyMs ?? sig?.signing_latency_ms, 0))),
      public_key_pem:
        typeof sig?.publicKeyPem === "string"
          ? sig.publicKeyPem.slice(0, 4000)
          : (typeof sig?.public_key_pem === "string" ? sig.public_key_pem.slice(0, 4000) : undefined),
    };
    return {
      ...decision,
      audit_record: {
        ...auditRecord,
        crypto_signature: cryptoSignature,
      },
    };
  } catch (err: any) {
    const message =
      err?.name === "AbortError"
        ? `audit_signer_timeout_${CFG.auditSignerTimeoutMs}ms`
        : String(err?.message || "audit_signer_failed");
    if (CFG.auditSignerRequired) {
      throw new Error(message);
    }
    return {
      ...decision,
      audit_record: {
        ...auditRecord,
        crypto_signature: {
          status: "error",
          signer: "audit-signer",
          error: message.slice(0, 240),
        },
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function sanitizeQuantMetrics(raw: any) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key) continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      out[key] = Math.abs(value) >= 1000 ? Math.round(value) : round(value, 6);
      continue;
    }
    if (typeof value === "string") {
      out[key] = value.slice(0, 80);
      continue;
    }
    if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeDecision(raw: any, agent: any) {
  const actionRaw = String(raw?.action || "HOLD").toUpperCase();
  const action = ["ACCUMULATE", "REDUCE", "HOLD", "REBALANCE"].includes(actionRaw) ? actionRaw : "HOLD";

  const capitalLimit = Math.max(0, toFinite(agent?.capitalLimit, 0));
  const allocation = clamp(toFinite(raw?.capital_allocation_kas, 0), 0, capitalLimit);
  const allocationPct =
    capitalLimit > 0
      ? clamp((allocation / capitalLimit) * 100, 0, 100)
      : clamp(toFinite(raw?.capital_allocation_pct, 0), 0, 100);

  const confidence = clamp(toFinite(raw?.confidence_score, 0), 0, 1);
  const risk = clamp(toFinite(raw?.risk_score, 1), 0, 1);

  const volatilityRaw = String(raw?.volatility_estimate || "MEDIUM").toUpperCase();
  const volatility = ["LOW", "MEDIUM", "HIGH"].includes(volatilityRaw) ? volatilityRaw : "MEDIUM";

  const liquidityRaw = String(raw?.liquidity_impact || "MODERATE").toUpperCase();
  const liquidity = ["MINIMAL", "MODERATE", "SIGNIFICANT"].includes(liquidityRaw) ? liquidityRaw : "MODERATE";

  const phaseRaw = String(raw?.strategy_phase || "HOLDING").toUpperCase();
  const phase = ["ENTRY", "SCALING", "HOLDING", "EXIT"].includes(phaseRaw) ? phaseRaw : "HOLDING";

  const riskFactors = Array.isArray(raw?.risk_factors)
    ? raw.risk_factors.map((v: any) => String(v)).filter(Boolean).slice(0, 6)
    : [];

  const decisionSourceRaw = String(raw?.decision_source || "ai").toLowerCase();
  const decisionSource = ["ai", "fallback", "quant-core", "hybrid-ai"].includes(decisionSourceRaw)
    ? decisionSourceRaw
    : "ai";
  const decisionSourceDetail = String(raw?.decision_source_detail || "").slice(0, 220);
  const quantMetrics = sanitizeQuantMetrics(raw?.quant_metrics);
  const engineLatencyMs = Math.max(0, Math.round(toFinite(raw?.engine_latency_ms, 0)));
  const rawAudit = raw?.audit_record && typeof raw.audit_record === "object" ? raw.audit_record : null;
  const rawCryptoSig = rawAudit?.crypto_signature && typeof rawAudit.crypto_signature === "object"
    ? rawAudit.crypto_signature
    : null;
  const auditRecord = rawAudit
    ? {
        audit_record_version: String(rawAudit.audit_record_version || CFG.decisionAuditRecordVersion).slice(0, 80),
        hash_algo: String(rawAudit.hash_algo || AUDIT_HASH_ALGO).slice(0, 64),
        prompt_version: String(rawAudit.prompt_version || CFG.aiPromptVersion).slice(0, 80),
        ai_response_schema_version: String(rawAudit.ai_response_schema_version || CFG.aiResponseSchemaVersion).slice(0, 80),
        quant_feature_snapshot_hash: String(rawAudit.quant_feature_snapshot_hash || "").slice(0, 120),
        decision_hash: String(rawAudit.decision_hash || "").slice(0, 120),
        audit_sig: String(rawAudit.audit_sig || "").slice(0, 140),
        overlay_plan_reason: String(rawAudit.overlay_plan_reason || "").slice(0, 160),
        engine_path: String(rawAudit.engine_path || "").slice(0, 80),
        prompt_used: Boolean(rawAudit.prompt_used),
        ai_transport_ready: Boolean(rawAudit.ai_transport_ready),
        created_ts: Math.max(0, Math.round(toFinite(rawAudit.created_ts, 0))),
        crypto_signature: rawCryptoSig
          ? {
              status: String(rawCryptoSig.status || "").slice(0, 32) || undefined,
              alg: String(rawCryptoSig.alg || "").slice(0, 80) || undefined,
              key_id: String(rawCryptoSig.key_id || rawCryptoSig.keyId || "").slice(0, 160) || undefined,
              sig_b64u: String(rawCryptoSig.sig_b64u || rawCryptoSig.signatureB64u || "").slice(0, 600) || undefined,
              payload_hash_sha256_b64u:
                String(rawCryptoSig.payload_hash_sha256_b64u || rawCryptoSig.payloadHashSha256B64u || "").slice(0, 160) || undefined,
              signer: String(rawCryptoSig.signer || "").slice(0, 80) || undefined,
              signed_ts: Math.max(0, Math.round(toFinite(rawCryptoSig.signed_ts ?? rawCryptoSig.signedAt, 0))),
              signing_latency_ms: Math.max(0, Math.round(toFinite(rawCryptoSig.signing_latency_ms ?? rawCryptoSig.signingLatencyMs, 0))),
              public_key_pem:
                typeof rawCryptoSig.public_key_pem === "string"
                  ? rawCryptoSig.public_key_pem.slice(0, 4000)
                  : (typeof rawCryptoSig.publicKeyPem === "string" ? rawCryptoSig.publicKeyPem.slice(0, 4000) : undefined),
              error: String(rawCryptoSig.error || "").slice(0, 240) || undefined,
            }
          : undefined,
        quant_feature_snapshot_excerpt:
          rawAudit.quant_feature_snapshot_excerpt && typeof rawAudit.quant_feature_snapshot_excerpt === "object"
            ? {
                regime: String(rawAudit.quant_feature_snapshot_excerpt.regime || "").slice(0, 40),
                sample_count: Math.max(0, Math.round(toFinite(rawAudit.quant_feature_snapshot_excerpt.sample_count, 0))),
                edge_score: round(toFinite(rawAudit.quant_feature_snapshot_excerpt.edge_score, 0), 6),
                data_quality_score: round(toFinite(rawAudit.quant_feature_snapshot_excerpt.data_quality_score, 0), 6),
                price_usd: round(toFinite(rawAudit.quant_feature_snapshot_excerpt.price_usd, 0), 8),
                wallet_kas: round(toFinite(rawAudit.quant_feature_snapshot_excerpt.wallet_kas, 0), 6),
                daa_score: Math.max(0, Math.round(toFinite(rawAudit.quant_feature_snapshot_excerpt.daa_score, 0))),
              }
            : undefined,
      }
    : undefined;

  return {
    action,
    confidence_score: round(confidence, 4),
    risk_score: round(risk, 4),
    kelly_fraction: clamp(toFinite(raw?.kelly_fraction, 0), 0, 1),
    capital_allocation_kas: Number(allocation.toFixed(6)),
    capital_allocation_pct: Number(allocationPct.toFixed(2)),
    expected_value_pct: Number(toFinite(raw?.expected_value_pct, 0).toFixed(2)),
    stop_loss_pct: Number(Math.max(0, toFinite(raw?.stop_loss_pct, 0)).toFixed(2)),
    take_profit_pct: Number(Math.max(0, toFinite(raw?.take_profit_pct, 0)).toFixed(2)),
    monte_carlo_win_pct: Number(clamp(toFinite(raw?.monte_carlo_win_pct, 0), 0, 100).toFixed(2)),
    volatility_estimate: volatility,
    liquidity_impact: liquidity,
    strategy_phase: phase,
    rationale: String(raw?.rationale || "No rationale returned by engine."),
    risk_factors: riskFactors,
    next_review_trigger: String(raw?.next_review_trigger || "On next cycle or major DAA/price movement."),
    decision_source: decisionSource,
    decision_source_detail: decisionSourceDetail,
    quant_metrics: quantMetrics,
    engine_latency_ms: engineLatencyMs,
    ...(auditRecord ? { audit_record: auditRecord } : {}),
  };
}

function buildQuantFeatureSnapshot(agent: any, kasData: any, quantCoreDecision: any) {
  const qm = quantCoreDecision?.quant_metrics || {};
  return {
    agent: {
      id: String(agent?.agentId || agent?.name || "agent"),
      risk: String(agent?.risk || ""),
      capitalLimit: round(Math.max(0, toFinite(agent?.capitalLimit, 0)), 6),
      autoApproveThreshold: round(Math.max(0, toFinite(agent?.autoApproveThreshold, 0)), 6),
      strategyTemplate: String(agent?.strategyTemplate || agent?.strategyLabel || "custom"),
    },
    kaspa: {
      address: String(kasData?.address || ""),
      walletKas: round(Math.max(0, toFinite(kasData?.walletKas, 0)), 6),
      priceUsd: round(Math.max(0, toFinite(kasData?.priceUsd, 0)), 8),
      daaScore: Math.max(0, Math.round(toFinite(kasData?.dag?.daaScore, 0))),
      network: String(kasData?.dag?.networkName || kasData?.dag?.network || ""),
    },
    quantCore: {
      action: String(quantCoreDecision?.action || "HOLD"),
      confidence_score: round(toFinite(quantCoreDecision?.confidence_score, 0), 4),
      risk_score: round(toFinite(quantCoreDecision?.risk_score, 0), 4),
      kelly_fraction: round(toFinite(quantCoreDecision?.kelly_fraction, 0), 6),
      capital_allocation_kas: round(toFinite(quantCoreDecision?.capital_allocation_kas, 0), 6),
      expected_value_pct: round(toFinite(quantCoreDecision?.expected_value_pct, 0), 4),
      quant_metrics: {
        regime: String(qm?.regime || ""),
        sample_count: Math.max(0, Math.round(toFinite(qm?.sample_count, 0))),
        edge_score: round(toFinite(qm?.edge_score, 0), 6),
        data_quality_score: round(toFinite(qm?.data_quality_score, 0), 6),
        ewma_volatility: round(toFinite(qm?.ewma_volatility, 0), 6),
        risk_ceiling: round(toFinite(qm?.risk_ceiling, 0), 6),
        kelly_cap: round(toFinite(qm?.kelly_cap, 0), 6),
      },
    },
  };
}

async function attachDecisionAuditRecord(params: {
  decision: any;
  agent: any;
  kasData: any;
  quantCoreDecision: any;
  overlayPlanReason: string;
  enginePath: string;
}) {
  const decision = params.decision || {};
  const quantSnapshot = buildQuantFeatureSnapshot(params.agent, params.kasData, params.quantCoreDecision);
  const quantFeatureSnapshotHash = await hashCanonical(quantSnapshot);
  const decisionForHash = {
    ...decision,
    audit_record: undefined,
  };
  const decisionHash = await hashCanonical(decisionForHash);
  const auditSig = await hashCanonical({
    decision_hash: decisionHash,
    quant_feature_snapshot_hash: quantFeatureSnapshotHash,
    prompt_version: CFG.aiPromptVersion,
    ai_response_schema_version: CFG.aiResponseSchemaVersion,
    overlay_plan_reason: params.overlayPlanReason,
    engine_path: params.enginePath,
  });
  return sanitizeDecision(
    {
      ...decision,
      audit_record: {
        audit_record_version: CFG.decisionAuditRecordVersion,
        hash_algo: AUDIT_HASH_ALGO,
        prompt_version: CFG.aiPromptVersion,
        ai_response_schema_version: CFG.aiResponseSchemaVersion,
        quant_feature_snapshot_hash: quantFeatureSnapshotHash,
        decision_hash: decisionHash,
        audit_sig: auditSig,
        overlay_plan_reason: params.overlayPlanReason,
        engine_path: params.enginePath,
        prompt_used: params.enginePath === "hybrid-ai" || params.enginePath === "ai",
        ai_transport_ready: CFG.aiTransportReady,
        created_ts: Date.now(),
        quant_feature_snapshot_excerpt: {
          regime: String(params.quantCoreDecision?.quant_metrics?.regime || ""),
          sample_count: Math.max(0, Math.round(toFinite(params.quantCoreDecision?.quant_metrics?.sample_count, 0))),
          edge_score: round(toFinite(params.quantCoreDecision?.quant_metrics?.edge_score, 0), 6),
          data_quality_score: round(toFinite(params.quantCoreDecision?.quant_metrics?.data_quality_score, 0), 6),
          price_usd: round(toFinite(params.kasData?.priceUsd, 0), 8),
          wallet_kas: round(toFinite(params.kasData?.walletKas, 0), 6),
          daa_score: Math.max(0, Math.round(toFinite(params.kasData?.dag?.daaScore, 0))),
        },
      },
    },
    params.agent
  );
}

async function finalizeDecisionAuditRecord(params: {
  decision: any;
  agent: any;
  kasData: any;
  quantCoreDecision: any;
  overlayPlanReason: string;
  enginePath: string;
}) {
  const withAudit = await attachDecisionAuditRecord(params);
  return maybeAttachCryptographicAuditSignature(withAudit);
}

function getCachedOverlay(cacheKey: string) {
  return AI_OVERLAY_CACHE.get(cacheKey);
}

function setCachedOverlay(cacheKey: string, signature: string, decision: any) {
  AI_OVERLAY_CACHE.set(cacheKey, signature, decision);
}

export async function runQuantEngine(agent: any, kasData: any, context?: QuantContext) {
  const startedAt = Date.now();
  const quantCoreDecision = sanitizeDecision(
    {
      ...buildQuantCoreDecision(agent, kasData, context),
      engine_latency_ms: Date.now() - startedAt,
    },
    agent
  );
  const cacheKey = agentOverlayCacheKey(agent, kasData);
  const cachedOverlay = getCachedOverlay(cacheKey);
  const overlayPlan = resolveAiOverlayPlan({
    coreDecision: quantCoreDecision,
    cached: cachedOverlay,
    config: {
      aiTransportReady: CFG.aiTransportReady,
      aiOverlayMode: CFG.aiOverlayMode,
      minIntervalMs: CFG.aiOverlayMinIntervalMs,
      cacheTtlMs: CFG.aiOverlayCacheTtlMs,
    },
  });

  if (
    overlayPlan.kind === "skip" &&
    overlayPlan.reason === "ai_transport_not_configured" &&
    !CFG.aiFallbackEnabled &&
    CFG.aiOverlayMode !== "off"
  ) {
    throw new Error("Real AI overlay is required but AI transport is not configured (set VITE_AI_API_URL and credentials/proxy).");
  }

  // Local quant core is the primary engine. AI acts only as a bounded overlay.
  if (overlayPlan.kind === "skip") {
    return finalizeDecisionAuditRecord({
      decision: localQuantDecisionFromCore({ agent, coreDecision: quantCoreDecision, reason: overlayPlan.reason, startedAt, sanitizeDecision }),
      agent,
      kasData,
      quantCoreDecision,
      overlayPlanReason: overlayPlan.reason,
      enginePath: "quant-core",
    });
  }

  if (overlayPlan.kind === "reuse" && cachedOverlay) {
    return finalizeDecisionAuditRecord({
      decision: sanitizeCachedOverlayDecision({ agent, cached: cachedOverlay, startedAt, reason: overlayPlan.reason, sanitizeDecision }),
      agent,
      kasData,
      quantCoreDecision,
      overlayPlanReason: overlayPlan.reason,
      enginePath: "hybrid-ai",
    });
  }

  const aiStartedAt = Date.now();
  try {
    const aiDecision = await requestAiOverlayDecision({
      agent,
      kasData,
      quantCoreDecision,
      config: {
        apiUrl: CFG.aiApiUrl,
        model: CFG.aiModel,
        anthropicApiKey: CFG.anthropicApiKey,
        timeoutMs: CFG.aiTimeoutMs,
        maxAttempts: CFG.aiMaxAttempts,
        retryableStatuses: CFG.aiRetryableStatuses,
      },
      sanitizeDecision,
    });
    const aiLatencyMs = Date.now() - aiStartedAt;
    const fused = fuseWithQuantCore({
      agent,
      coreDecision: quantCoreDecision,
      aiDecision,
      aiLatencyMs,
      startedAt,
      sanitizeDecision,
    });
    fused.decision_source_detail = appendSourceDetail(fused?.decision_source_detail, `overlay_plan:${overlayPlan.reason}`);
    setCachedOverlay(cacheKey, overlayPlan.signature, fused);
    return finalizeDecisionAuditRecord({
      decision: fused,
      agent,
      kasData,
      quantCoreDecision,
      overlayPlanReason: overlayPlan.reason,
      enginePath: "hybrid-ai",
    });
  } catch (err: any) {
    if (cachedOverlay) {
      const cacheAgeMs = Math.max(0, Date.now() - cachedOverlay.ts);
      if (cacheAgeMs <= CFG.aiOverlayCacheTtlMs) {
        return finalizeDecisionAuditRecord({
          decision: sanitizeCachedOverlayDecision({
            agent,
            cached: cachedOverlay,
            startedAt,
            reason: `ai_error_cache_reuse_${cacheAgeMs}ms`,
            sanitizeDecision,
          }),
          agent,
          kasData,
          quantCoreDecision,
          overlayPlanReason: `ai_error_cache_reuse_${cacheAgeMs}ms`,
          enginePath: "hybrid-ai",
        });
      }
    }
    if (CFG.aiFallbackEnabled) {
      const reason = err?.name === "AbortError" ? `ai_timeout_${CFG.aiTimeoutMs}ms` : (err?.message || "request failure");
      return finalizeDecisionAuditRecord({
        decision: localQuantDecisionFromCore({ agent, coreDecision: quantCoreDecision, reason, startedAt, sanitizeDecision }),
        agent,
        kasData,
        quantCoreDecision,
        overlayPlanReason: reason,
        enginePath: "quant-core",
      });
    }
    if (err?.name === "AbortError") throw new Error(`AI request timeout (${CFG.aiTimeoutMs}ms)`);
    throw err;
  }
}
