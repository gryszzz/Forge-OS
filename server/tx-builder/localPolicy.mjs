function envNum(name, fallback, min = 0) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function envInt(name, fallback, min = 0) {
  return Math.max(min, Math.round(envNum(name, fallback, min)));
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return /^(1|true|yes)$/i.test(String(raw));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseCoinSelectionMode(raw) {
  const v = String(raw || "auto").trim().toLowerCase();
  if (v === "largest-first" || v === "smallest-first" || v === "oldest-first" || v === "newest-first") return v;
  return "auto";
}

function parseFeeMode(raw) {
  const v = String(raw || "request_or_fixed").trim().toLowerCase();
  if (v === "fixed" || v === "output_bps" || v === "per_output" || v === "request_or_fixed" || v === "adaptive") return v;
  return "request_or_fixed";
}

export function readLocalTxPolicyConfig() {
  return {
    coinSelection: parseCoinSelectionMode(process.env.TX_BUILDER_LOCAL_WASM_COIN_SELECTION),
    maxInputs: envInt("TX_BUILDER_LOCAL_WASM_MAX_INPUTS", 48, 1),
    estimatedNetworkFeeSompi: envInt("TX_BUILDER_LOCAL_WASM_ESTIMATED_NETWORK_FEE_SOMPI", 20_000, 0),
    perInputFeeBufferSompi: envInt("TX_BUILDER_LOCAL_WASM_PER_INPUT_FEE_BUFFER_SOMPI", 1_500, 0),
    extraSafetyBufferSompi: envInt("TX_BUILDER_LOCAL_WASM_EXTRA_SAFETY_BUFFER_SOMPI", 5_000, 0),
    priorityFeeMode: parseFeeMode(process.env.TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_MODE),
    priorityFeeFixedSompi: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_SOMPI", 0, 0),
    priorityFeeOutputBps: envNum("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_OUTPUT_BPS", 5, 0),
    priorityFeePerOutputSompi: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_PER_OUTPUT_SOMPI", 2_000, 0),
    priorityFeeMinSompi: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_MIN_SOMPI", 0, 0),
    priorityFeeMaxSompi: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_MAX_SOMPI", 2_500_000, 0),
    priorityFeeAdaptiveTargetConfirmMs: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_TARGET_CONFIRM_MS", 8000, 100),
    priorityFeeAdaptiveHighConfirmMs: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_HIGH_CONFIRM_MS", 20000, 100),
    priorityFeeAdaptiveCriticalConfirmMs: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_CRITICAL_CONFIRM_MS", 45000, 100),
    priorityFeeAdaptiveLatencyUpPct: envNum("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_LATENCY_UP_PCT", 120, 0),
    priorityFeeAdaptiveLatencyDownPct: envNum("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_LATENCY_DOWN_PCT", 30, 0),
    priorityFeeAdaptivePerInputSompi: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_PER_INPUT_SOMPI", 500, 0),
    priorityFeeAdaptiveFragmentationThresholdInputs: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_FRAGMENTATION_THRESHOLD_INPUTS", 10, 1),
    priorityFeeAdaptiveFragmentationBumpSompi: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_FRAGMENTATION_BUMP_SOMPI", 4_000, 0),
    priorityFeeAdaptiveTruncationBumpSompi: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_TRUNCATION_BUMP_SOMPI", 8_000, 0),
    priorityFeeAdaptiveDaaCongestionThresholdPct: envNum("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_DAA_CONGESTION_THRESHOLD_PCT", 70, 0),
    priorityFeeAdaptiveDaaCongestionBumpSompi: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_DAA_CONGESTION_BUMP_SOMPI", 6_000, 0),
    priorityFeeAdaptiveReceiptLagHighMs: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_RECEIPT_LAG_HIGH_MS", 12000, 0),
    priorityFeeAdaptiveReceiptLagCriticalMs: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_RECEIPT_LAG_CRITICAL_MS", 45000, 0),
    priorityFeeAdaptiveReceiptLagBumpSompi: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_RECEIPT_LAG_BUMP_SOMPI", 4_000, 0),
    priorityFeeAdaptiveSchedulerCallbackHighMs: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_SCHEDULER_CALLBACK_HIGH_MS", 500, 0),
    priorityFeeAdaptiveSchedulerCallbackCriticalMs: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_SCHEDULER_CALLBACK_CRITICAL_MS", 2500, 0),
    priorityFeeAdaptiveSchedulerCallbackBumpSompi: envInt("TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_ADAPTIVE_SCHEDULER_CALLBACK_BUMP_SOMPI", 2_500, 0),
    preferConsolidation: envBool("TX_BUILDER_LOCAL_WASM_PREFER_CONSOLIDATION", true),
  };
}

function amountSompi(entry) {
  return BigInt(Math.max(0, Math.round(Number(entry?.utxoEntry?.amount || 0))));
}

function daaScore(entry) {
  const n = Number(entry?.utxoEntry?.blockDaaScore || 0);
  return Number.isFinite(n) ? n : 0;
}

function coinSort(entries, mode, preferConsolidation) {
  const list = [...entries];
  const byAmountAsc = (a, b) => {
    const diff = amountSompi(a) - amountSompi(b);
    return diff === 0n ? 0 : diff < 0n ? -1 : 1;
  };
  const byAmountDesc = (a, b) => -byAmountAsc(a, b);
  const byDaaAsc = (a, b) => daaScore(a) - daaScore(b);
  const byDaaDesc = (a, b) => daaScore(b) - daaScore(a);

  if (mode === "largest-first") return list.sort((a, b) => byAmountDesc(a, b) || byDaaAsc(a, b));
  if (mode === "smallest-first") return list.sort((a, b) => byAmountAsc(a, b) || byDaaAsc(a, b));
  if (mode === "newest-first") return list.sort((a, b) => byDaaDesc(a, b) || byAmountDesc(a, b));
  if (mode === "oldest-first") return list.sort((a, b) => byDaaAsc(a, b) || byAmountDesc(a, b));
  // auto
  if (preferConsolidation) return list.sort((a, b) => byDaaAsc(a, b) || byAmountAsc(a, b));
  return list.sort((a, b) => byAmountDesc(a, b) || byDaaAsc(a, b));
}

function clampPriorityFeeSompi(n, cfg) {
  return clamp(Math.round(Number(n || 0)), cfg.priorityFeeMinSompi, Math.max(cfg.priorityFeeMinSompi, cfg.priorityFeeMaxSompi));
}

function computeBaselineFeeSompi({ requestPriorityFeeSompi, outputsTotalSompi, outputCount, cfg }) {
  const requestFee = Math.max(0, Math.round(Number(requestPriorityFeeSompi || 0)));
  const outputCountSafe = Math.max(0, Math.round(Number(outputCount || 0)));
  const fixedFee = clampPriorityFeeSompi(cfg.priorityFeeFixedSompi, cfg);
  const perOutputFee = clampPriorityFeeSompi(outputCountSafe * Math.max(0, Math.round(cfg.priorityFeePerOutputSompi)), cfg);
  const base = Number(outputsTotalSompi > 0n ? outputsTotalSompi : 0n);
  const outputBpsFee = clampPriorityFeeSompi(Math.round((base * Number(cfg.priorityFeeOutputBps || 0)) / 10_000), cfg);
  return {
    requestFee,
    fixedFee,
    perOutputFee,
    outputBpsFee,
    defaultAdaptiveBaseFee: Math.max(fixedFee, perOutputFee, outputBpsFee),
  };
}

function adaptiveLatencyMultiplier(confirmP95Ms, cfg) {
  const p95 = Math.max(0, Math.round(Number(confirmP95Ms || 0)));
  if (!(p95 > 0)) return 1;
  const target = Math.max(100, Math.round(Number(cfg.priorityFeeAdaptiveTargetConfirmMs || 8000)));
  const high = Math.max(target, Math.round(Number(cfg.priorityFeeAdaptiveHighConfirmMs || 20000)));
  const critical = Math.max(high, Math.round(Number(cfg.priorityFeeAdaptiveCriticalConfirmMs || 45000)));
  if (p95 > high) {
    const severity = clamp((p95 - high) / Math.max(1, critical - high), 0, 1.5);
    return 1 + (severity * Number(cfg.priorityFeeAdaptiveLatencyUpPct || 120)) / 100;
  }
  if (p95 < target) {
    const relief = clamp((target - p95) / Math.max(1, target), 0, 1);
    return Math.max(0.5, 1 - (relief * Number(cfg.priorityFeeAdaptiveLatencyDownPct || 30)) / 100);
  }
  return 1;
}

function adaptivePressureSeverity(valueMs, highMs, criticalMs) {
  const v = Math.max(0, Math.round(Number(valueMs || 0)));
  const high = Math.max(0, Math.round(Number(highMs || 0)));
  const critical = Math.max(high, Math.round(Number(criticalMs || 0)));
  if (!(v > 0) || !(high > 0) || v < high) return 0;
  if (critical <= high) return 1;
  return clamp((v - high) / Math.max(1, critical - high), 0, 1.5);
}

export function computePriorityFeeSompi({ requestPriorityFeeSompi, outputsTotalSompi, outputCount, config, telemetry, selectionStats }) {
  const cfg = config || readLocalTxPolicyConfig();
  const baseFees = computeBaselineFeeSompi({ requestPriorityFeeSompi, outputsTotalSompi, outputCount, cfg });
  const requestFee = baseFees.requestFee;
  if (cfg.priorityFeeMode === "fixed") return clampPriorityFeeSompi(cfg.priorityFeeFixedSompi, cfg);
  if (cfg.priorityFeeMode === "output_bps") {
    return baseFees.outputBpsFee;
  }
  if (cfg.priorityFeeMode === "per_output") {
    return baseFees.perOutputFee;
  }
  if (cfg.priorityFeeMode === "adaptive") {
    const selectedInputCount = Math.max(0, Math.round(Number(selectionStats?.selectedInputCount || 0)));
    const truncatedByMaxInputs = Boolean(selectionStats?.truncatedByMaxInputs);
    const summaryFreshnessState = String(telemetry?.summaryFreshnessState || "").toLowerCase();
    const staleHard = summaryFreshnessState === "stale_hard";
    const staleSoft = summaryFreshnessState === "stale_soft";
    const confirmP95Ms = staleHard
      ? 0
      : Math.max(0, Math.round(Number(telemetry?.observedConfirmP95Ms || telemetry?.confirmP95Ms || 0)));
    const receiptLagP95Ms = staleHard
      ? 0
      : Math.max(0, Math.round(Number(telemetry?.receiptLagP95Ms || telemetry?.observedReceiptLagP95Ms || 0)));
    const schedulerCallbackLatencyP95BucketMs = staleHard
      ? 0
      : Math.max(0, Math.round(Number(telemetry?.schedulerCallbackLatencyP95BucketMs || 0)));
    const daaCongestionPct = staleHard ? 0 : clamp(Number(telemetry?.daaCongestionPct || 0), 0, 100);
    const rawLatencyMultiplier = adaptiveLatencyMultiplier(confirmP95Ms, cfg);
    const freshnessDampen = staleSoft ? 0.45 : 1;
    const latencyMultiplier = 1 + ((rawLatencyMultiplier - 1) * freshnessDampen);
    const adaptiveBase = requestFee > 0 ? requestFee : baseFees.defaultAdaptiveBaseFee;
    let fee = Math.round(adaptiveBase * latencyMultiplier);
    fee += selectedInputCount * Math.max(0, Math.round(cfg.priorityFeeAdaptivePerInputSompi || 0));
    if (selectedInputCount >= Math.max(1, Math.round(cfg.priorityFeeAdaptiveFragmentationThresholdInputs || 10))) {
      fee += Math.max(0, Math.round(cfg.priorityFeeAdaptiveFragmentationBumpSompi || 0));
    }
    if (truncatedByMaxInputs) {
      fee += Math.max(0, Math.round(cfg.priorityFeeAdaptiveTruncationBumpSompi || 0));
    }
    if (daaCongestionPct >= Number(cfg.priorityFeeAdaptiveDaaCongestionThresholdPct || 70)) {
      fee += Math.round(Math.max(0, Math.round(cfg.priorityFeeAdaptiveDaaCongestionBumpSompi || 0)) * freshnessDampen);
    }
    const receiptLagSeverity = adaptivePressureSeverity(
      receiptLagP95Ms,
      cfg.priorityFeeAdaptiveReceiptLagHighMs,
      cfg.priorityFeeAdaptiveReceiptLagCriticalMs
    );
    if (receiptLagSeverity > 0) {
      fee += Math.round(Math.max(0, Math.round(cfg.priorityFeeAdaptiveReceiptLagBumpSompi || 0)) * receiptLagSeverity * freshnessDampen);
    }
    const schedulerCallbackSeverity = adaptivePressureSeverity(
      schedulerCallbackLatencyP95BucketMs,
      cfg.priorityFeeAdaptiveSchedulerCallbackHighMs,
      cfg.priorityFeeAdaptiveSchedulerCallbackCriticalMs
    );
    if (schedulerCallbackSeverity > 0) {
      fee += Math.round(
        Math.max(0, Math.round(cfg.priorityFeeAdaptiveSchedulerCallbackBumpSompi || 0)) *
        schedulerCallbackSeverity *
        freshnessDampen
      );
    }
    return clampPriorityFeeSompi(fee, cfg);
  }
  // request_or_fixed
  return clampPriorityFeeSompi(requestFee > 0 ? requestFee : cfg.priorityFeeFixedSompi, cfg);
}

function extendSelectionToTarget({ ordered, selectedEntries, selectedAmountSompi, cfg, baseTargetSompi, targetSompi }) {
  let truncatedByMaxInputs = false;
  let total = selectedAmountSompi;
  for (let i = selectedEntries.length; i < ordered.length; i += 1) {
    if (selectedEntries.length >= cfg.maxInputs) {
      truncatedByMaxInputs = true;
      break;
    }
    const entry = ordered[i];
    selectedEntries.push(entry);
    total += amountSompi(entry);
    const dynamicTargetSompi = baseTargetSompi + BigInt(selectedEntries.length) * BigInt(Math.max(0, cfg.perInputFeeBufferSompi));
    if (total >= dynamicTargetSompi && total >= targetSompi) break;
  }
  return { selectedEntries, selectedAmountSompi: total, truncatedByMaxInputs };
}

export function selectUtxoEntriesForLocalBuild({ entries, outputsTotalSompi, outputCount, requestPriorityFeeSompi, telemetry, config }) {
  const cfg = config || readLocalTxPolicyConfig();
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  if (!normalizedEntries.length) {
    return {
      selectedEntries: [],
      selectedAmountSompi: 0n,
      outputsTotalSompi,
      requiredTargetSompi: 0n,
      priorityFeeSompi: 0,
      selectionMode: cfg.coinSelection,
      totalEntries: 0,
      truncatedByMaxInputs: false,
      priorityFeeMode: cfg.priorityFeeMode,
      adaptiveSignals: undefined,
    };
  }

  let priorityFeeSompi = computePriorityFeeSompi({
    requestPriorityFeeSompi,
    outputsTotalSompi,
    outputCount,
    telemetry,
    config: cfg,
  });
  const ordered = coinSort(normalizedEntries, cfg.coinSelection, cfg.preferConsolidation);

  const baseTargetSompi =
    BigInt(outputsTotalSompi || 0n) +
    BigInt(Math.max(0, cfg.estimatedNetworkFeeSompi)) +
    BigInt(Math.max(0, cfg.extraSafetyBufferSompi)) +
    BigInt(Math.max(0, priorityFeeSompi));

  const selectedEntries = [];
  let selectedAmountSompi = 0n;
  let truncatedByMaxInputs = false;
  for (const entry of ordered) {
    if (selectedEntries.length >= cfg.maxInputs) {
      truncatedByMaxInputs = true;
      break;
    }
    selectedEntries.push(entry);
    selectedAmountSompi += amountSompi(entry);
    const dynamicTargetSompi =
      baseTargetSompi + BigInt(selectedEntries.length) * BigInt(Math.max(0, cfg.perInputFeeBufferSompi));
    if (selectedAmountSompi >= dynamicTargetSompi) break;
  }

  let requiredTargetSompi =
    baseTargetSompi + BigInt(selectedEntries.length) * BigInt(Math.max(0, cfg.perInputFeeBufferSompi));

  let adaptiveSignals;
  if (cfg.priorityFeeMode === "adaptive") {
    const recomputedAdaptiveFeeSompi = computePriorityFeeSompi({
      requestPriorityFeeSompi,
      outputsTotalSompi,
      outputCount,
      telemetry,
      selectionStats: {
        selectedInputCount: selectedEntries.length,
        truncatedByMaxInputs,
      },
      config: cfg,
    });
    adaptiveSignals = {
      summaryFreshnessState: String(telemetry?.summaryFreshnessState || "fresh"),
      observedConfirmP95Ms: Math.max(0, Math.round(Number(telemetry?.observedConfirmP95Ms || telemetry?.confirmP95Ms || 0))),
      daaCongestionPct: clamp(Number(telemetry?.daaCongestionPct || 0), 0, 100),
      receiptLagP95Ms: Math.max(0, Math.round(Number(telemetry?.receiptLagP95Ms || telemetry?.observedReceiptLagP95Ms || 0))),
      schedulerCallbackLatencyP95BucketMs: Math.max(0, Math.round(Number(telemetry?.schedulerCallbackLatencyP95BucketMs || 0))),
      selectedInputCount: selectedEntries.length,
      truncatedByMaxInputs,
      provisionalPriorityFeeSompi: priorityFeeSompi,
      recomputedPriorityFeeSompi: recomputedAdaptiveFeeSompi,
    };
    if (recomputedAdaptiveFeeSompi !== priorityFeeSompi) {
      priorityFeeSompi = recomputedAdaptiveFeeSompi;
      requiredTargetSompi =
        BigInt(outputsTotalSompi || 0n) +
        BigInt(Math.max(0, cfg.estimatedNetworkFeeSompi)) +
        BigInt(Math.max(0, cfg.extraSafetyBufferSompi)) +
        BigInt(Math.max(0, priorityFeeSompi)) +
        BigInt(selectedEntries.length) * BigInt(Math.max(0, cfg.perInputFeeBufferSompi));
      if (selectedAmountSompi < requiredTargetSompi && selectedEntries.length < ordered.length) {
        const extended = extendSelectionToTarget({
          ordered,
          selectedEntries,
          selectedAmountSompi,
          cfg,
          baseTargetSompi:
            BigInt(outputsTotalSompi || 0n) +
            BigInt(Math.max(0, cfg.estimatedNetworkFeeSompi)) +
            BigInt(Math.max(0, cfg.extraSafetyBufferSompi)) +
            BigInt(Math.max(0, priorityFeeSompi)),
          targetSompi: requiredTargetSompi,
        });
        selectedAmountSompi = extended.selectedAmountSompi;
        truncatedByMaxInputs = truncatedByMaxInputs || extended.truncatedByMaxInputs;
        requiredTargetSompi =
          BigInt(outputsTotalSompi || 0n) +
          BigInt(Math.max(0, cfg.estimatedNetworkFeeSompi)) +
          BigInt(Math.max(0, cfg.extraSafetyBufferSompi)) +
          BigInt(Math.max(0, priorityFeeSompi)) +
          BigInt(selectedEntries.length) * BigInt(Math.max(0, cfg.perInputFeeBufferSompi));
        adaptiveSignals.selectedInputCount = selectedEntries.length;
        adaptiveSignals.truncatedByMaxInputs = truncatedByMaxInputs;
      }
    }
  }

  return {
    selectedEntries,
    selectedAmountSompi,
    outputsTotalSompi,
    requiredTargetSompi,
    priorityFeeSompi,
    selectionMode: cfg.coinSelection,
    priorityFeeMode: cfg.priorityFeeMode,
    totalEntries: ordered.length,
    truncatedByMaxInputs,
    adaptiveSignals,
    config: cfg,
  };
}

export function describeLocalTxPolicyConfig(config = readLocalTxPolicyConfig()) {
  return {
    coinSelection: config.coinSelection,
    maxInputs: config.maxInputs,
    estimatedNetworkFeeSompi: config.estimatedNetworkFeeSompi,
    perInputFeeBufferSompi: config.perInputFeeBufferSompi,
    extraSafetyBufferSompi: config.extraSafetyBufferSompi,
    priorityFeeMode: config.priorityFeeMode,
    priorityFeeFixedSompi: config.priorityFeeFixedSompi,
    priorityFeeOutputBps: config.priorityFeeOutputBps,
    priorityFeePerOutputSompi: config.priorityFeePerOutputSompi,
    priorityFeeMinSompi: config.priorityFeeMinSompi,
    priorityFeeMaxSompi: config.priorityFeeMaxSompi,
    priorityFeeAdaptiveTargetConfirmMs: config.priorityFeeAdaptiveTargetConfirmMs,
    priorityFeeAdaptiveHighConfirmMs: config.priorityFeeAdaptiveHighConfirmMs,
    priorityFeeAdaptiveCriticalConfirmMs: config.priorityFeeAdaptiveCriticalConfirmMs,
    priorityFeeAdaptiveLatencyUpPct: config.priorityFeeAdaptiveLatencyUpPct,
    priorityFeeAdaptiveLatencyDownPct: config.priorityFeeAdaptiveLatencyDownPct,
    priorityFeeAdaptivePerInputSompi: config.priorityFeeAdaptivePerInputSompi,
    priorityFeeAdaptiveFragmentationThresholdInputs: config.priorityFeeAdaptiveFragmentationThresholdInputs,
    priorityFeeAdaptiveFragmentationBumpSompi: config.priorityFeeAdaptiveFragmentationBumpSompi,
    priorityFeeAdaptiveTruncationBumpSompi: config.priorityFeeAdaptiveTruncationBumpSompi,
    priorityFeeAdaptiveDaaCongestionThresholdPct: config.priorityFeeAdaptiveDaaCongestionThresholdPct,
    priorityFeeAdaptiveDaaCongestionBumpSompi: config.priorityFeeAdaptiveDaaCongestionBumpSompi,
    priorityFeeAdaptiveReceiptLagHighMs: config.priorityFeeAdaptiveReceiptLagHighMs,
    priorityFeeAdaptiveReceiptLagCriticalMs: config.priorityFeeAdaptiveReceiptLagCriticalMs,
    priorityFeeAdaptiveReceiptLagBumpSompi: config.priorityFeeAdaptiveReceiptLagBumpSompi,
    priorityFeeAdaptiveSchedulerCallbackHighMs: config.priorityFeeAdaptiveSchedulerCallbackHighMs,
    priorityFeeAdaptiveSchedulerCallbackCriticalMs: config.priorityFeeAdaptiveSchedulerCallbackCriticalMs,
    priorityFeeAdaptiveSchedulerCallbackBumpSompi: config.priorityFeeAdaptiveSchedulerCallbackBumpSompi,
    preferConsolidation: config.preferConsolidation,
  };
}
