import fs from "node:fs";
import path from "node:path";
import {
  describeLocalTxPolicyConfig,
  readLocalTxPolicyConfig,
  selectUtxoEntriesForLocalBuild,
} from "../server/tx-builder/localPolicy.mjs";

function envInt(name, fallback, min = 0) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.round(n));
}

function makeEntry({ amountSompi, daa, id }) {
  return {
    outpoint: { transactionId: String(id || "a").repeat(64).slice(0, 64), index: 0 },
    utxoEntry: {
      amount: Math.max(1, Math.round(Number(amountSompi || 0))),
      blockDaaScore: Math.max(0, Math.round(Number(daa || 0))),
      isCoinbase: false,
      scriptPublicKey: { version: 0, script: "00" },
    },
  };
}

function genShape(name, size, seed = 1) {
  const entries = [];
  let s = Math.max(1, seed | 0);
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  if (name === "fragmented") {
    for (let i = 0; i < size; i += 1) {
      entries.push(makeEntry({
        amountSompi: 5_000_000 + Math.round(rand() * 40_000_000),
        daa: 1_000 + i,
        id: String.fromCharCode(97 + (i % 26)),
      }));
    }
    return entries;
  }
  if (name === "whale-mix") {
    for (let i = 0; i < size; i += 1) {
      const isWhale = i < Math.max(1, Math.floor(size * 0.15));
      entries.push(makeEntry({
        amountSompi: isWhale ? 500_000_000 + Math.round(rand() * 2_000_000_000) : 10_000_000 + Math.round(rand() * 90_000_000),
        daa: 1_000 + Math.round(rand() * 2000),
        id: String.fromCharCode(97 + (i % 26)),
      }));
    }
    return entries;
  }
  // "recent-heavy"
  for (let i = 0; i < size; i += 1) {
    const recentBias = i < Math.floor(size * 0.7);
    entries.push(makeEntry({
      amountSompi: 15_000_000 + Math.round(rand() * (recentBias ? 120_000_000 : 400_000_000)),
      daa: recentBias ? 9_000 + i : 500 + i,
      id: String.fromCharCode(97 + (i % 26)),
    }));
  }
  return entries;
}

function benchmarkOne({ shape, outputsTotalSompi, outputCount, telemetry }) {
  const entries = genShape(shape, envInt("TX_POLICY_BENCH_UTXO_COUNT", 48, 4), shape.length + outputCount);
  const cfg = readLocalTxPolicyConfig();
  const started = performance.now();
  const plan = selectUtxoEntriesForLocalBuild({
    entries,
    outputsTotalSompi: BigInt(outputsTotalSompi),
    outputCount,
    requestPriorityFeeSompi: 0,
    telemetry,
    config: cfg,
  });
  const elapsedMs = performance.now() - started;
  const selectedAmountSompi = Number(plan.selectedAmountSompi || 0n);
  const requiredTargetSompi = Number(plan.requiredTargetSompi || 0n);
  const overfundSompi = Math.max(0, selectedAmountSompi - requiredTargetSompi);
  const selectedInputs = plan.selectedEntries.length;
  return {
    shape,
    outputCount,
    elapsedMs,
    selectedInputs,
    totalInputs: plan.totalEntries,
    inputUsePct: plan.totalEntries > 0 ? (selectedInputs / plan.totalEntries) * 100 : 0,
    priorityFeeSompi: Number(plan.priorityFeeSompi || 0),
    overfundSompi,
    truncated: Boolean(plan.truncatedByMaxInputs),
    selectionMode: String(plan.selectionMode || cfg.coinSelection),
    priorityFeeMode: String(plan.priorityFeeMode || cfg.priorityFeeMode),
    adaptiveSignals: plan.adaptiveSignals || null,
  };
}

function fmtRow(row) {
  return [
    row.shape.padEnd(12),
    String(row.outputCount).padStart(2),
    `${row.selectedInputs}/${row.totalInputs}`.padStart(8),
    `${row.inputUsePct.toFixed(1)}%`.padStart(8),
    String(row.priorityFeeSompi).padStart(10),
    String(row.overfundSompi).padStart(12),
    `${row.elapsedMs.toFixed(2)}ms`.padStart(10),
    (row.truncated ? "yes" : "no").padStart(5),
  ].join("  ");
}

function loadTelemetryProfile() {
  const raw = String(process.env.TX_POLICY_BENCH_TELEMETRY_PROFILE || "").trim();
  if (!raw) return null;
  const profilePath = raw.includes("/") || raw.endsWith(".json")
    ? path.resolve(process.cwd(), raw)
    : path.resolve(process.cwd(), "scripts/telemetry-profiles", `${raw}.json`);
  const text = fs.readFileSync(profilePath, "utf8");
  const parsed = JSON.parse(text);
  return {
    name: String(parsed?.name || raw),
    observedConfirmP95Ms: envInt("TX_POLICY_BENCH_CONFIRM_P95_MS", Number(parsed?.observedConfirmP95Ms ?? 12000), 0),
    daaCongestionPct: envInt("TX_POLICY_BENCH_DAA_CONGESTION_PCT", Number(parsed?.daaCongestionPct ?? 45), 0),
  };
}

function run() {
  const outputTotalKas = Number(process.env.TX_POLICY_BENCH_OUTPUTS_TOTAL_KAS || 2.4);
  const outputsTotalSompi = Math.round(outputTotalKas * 1e8);
  const telemetryProfile = loadTelemetryProfile();
  const telemetry = telemetryProfile || {
    observedConfirmP95Ms: envInt("TX_POLICY_BENCH_CONFIRM_P95_MS", 12000, 0),
    daaCongestionPct: envInt("TX_POLICY_BENCH_DAA_CONGESTION_PCT", 45, 0),
    name: "env-default",
  };
  const outputCounts = String(process.env.TX_POLICY_BENCH_OUTPUT_COUNTS || "1,2,4")
    .split(",")
    .map((v) => Math.max(1, Math.round(Number(v || 0))))
    .filter((v, idx, arr) => Number.isFinite(v) && arr.indexOf(v) === idx);
  const shapes = ["fragmented", "whale-mix", "recent-heavy"];
  const rows = [];
  for (const shape of shapes) {
    for (const outputCount of outputCounts) {
      rows.push(benchmarkOne({ shape, outputsTotalSompi, outputCount, telemetry }));
    }
  }

  console.log("[tx-policy-bench] config", JSON.stringify(describeLocalTxPolicyConfig(readLocalTxPolicyConfig())));
  console.log("[tx-policy-bench] telemetry", JSON.stringify(telemetry));
  console.log("");
  console.log("shape          out   selected     use%   fee_sompi  overfund_sompi    elapsed  trunc");
  console.log("---------------------------------------------------------------------------------------");
  for (const row of rows) console.log(fmtRow(row));

  const summary = rows.reduce(
    (acc, row) => {
      acc.count += 1;
      acc.selectedInputs += row.selectedInputs;
      acc.feeSompi += row.priorityFeeSompi;
      acc.elapsedMs += row.elapsedMs;
      acc.truncated += row.truncated ? 1 : 0;
      return acc;
    },
    { count: 0, selectedInputs: 0, feeSompi: 0, elapsedMs: 0, truncated: 0 }
  );
  console.log("");
  console.log(
    "[tx-policy-bench] summary",
    JSON.stringify({
      samples: summary.count,
      avgSelectedInputs: Number((summary.selectedInputs / Math.max(1, summary.count)).toFixed(2)),
      avgPriorityFeeSompi: Math.round(summary.feeSompi / Math.max(1, summary.count)),
      avgElapsedMs: Number((summary.elapsedMs / Math.max(1, summary.count)).toFixed(3)),
      truncatedSelections: summary.truncated,
    })
  );
}

run();
