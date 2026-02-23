export type BackendExecutionReceipt = {
  txid: string;
  status?: string | null;
  confirmations?: number | null;
  feeKas?: number | null;
  feeSompi?: number | null;
  broadcastTs?: number | null;
  confirmTs?: number | null;
  confirmTsSource?: string | null;
  slippageKas?: number | null;
  priceAtBroadcastUsd?: number | null;
  priceAtConfirmUsd?: number | null;
  source?: string | null;
  updatedAt?: number | null;
  raw?: any;
  [key: string]: any;
};

export type BackendReceiptConsistencyReport = {
  txid?: string;
  queueId?: string;
  agentId?: string;
  agentName?: string;
  status: "consistent" | "mismatch" | "insufficient";
  mismatches?: string[];
  provenance?: string;
  truthLabel?: string;
  checkedTs?: number;
  confirmTsDriftMs?: number;
  feeDiffKas?: number;
  slippageDiffKas?: number;
};

const env = (import.meta as any)?.env || {};
const RECEIPT_API_URL = String(env.VITE_EXECUTION_RECEIPT_API_URL || "").trim().replace(/\/+$/, "");
const RECEIPT_API_TOKEN = String(env.VITE_EXECUTION_RECEIPT_API_TOKEN || "").trim();
const RECEIPT_API_TIMEOUT_MS = Math.max(500, Number(env.VITE_EXECUTION_RECEIPT_API_TIMEOUT_MS || 4000));
const RECEIPT_IMPORT_ENABLED =
  String(env.VITE_EXECUTION_RECEIPT_IMPORT_ENABLED || "true").toLowerCase() !== "false";
const RECEIPT_SSE_ENABLED =
  String(env.VITE_EXECUTION_RECEIPT_SSE_ENABLED || "true").toLowerCase() !== "false";
const RECEIPT_SSE_URL = String(env.VITE_EXECUTION_RECEIPT_SSE_URL || "").trim().replace(/\/+$/, "");
const RECEIPT_SSE_REPLAY = String(env.VITE_EXECUTION_RECEIPT_SSE_REPLAY || "true").toLowerCase() !== "false";
const RECEIPT_SSE_REPLAY_LIMIT = Math.max(0, Number(env.VITE_EXECUTION_RECEIPT_SSE_REPLAY_LIMIT || 100));

function normalizeTxid(txid: string) {
  const v = String(txid || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(v)) throw new Error("invalid_txid");
  return v;
}

function parseReceiptPayload(payload: any): BackendExecutionReceipt | null {
  const receipt = payload?.receipt && typeof payload.receipt === "object" ? payload.receipt : null;
  if (!receipt) return null;
  const txid = normalizeTxid(String(receipt.txid || ""));
  return {
    ...receipt,
    txid,
  };
}

export function backendReceiptImportConfigured() {
  return RECEIPT_IMPORT_ENABLED && !!RECEIPT_API_URL;
}

export function backendReceiptStreamConfigured() {
  const base = RECEIPT_SSE_URL || (RECEIPT_API_URL ? `${RECEIPT_API_URL}/v1/execution-receipts/stream` : "");
  return RECEIPT_IMPORT_ENABLED && RECEIPT_SSE_ENABLED && !!base && typeof EventSource !== "undefined";
}

export function backendReceiptMetricsConfigured() {
  return backendReceiptImportConfigured();
}

function normalizeStreamReceiptPayload(payload: any): BackendExecutionReceipt | null {
  if (!payload || typeof payload !== "object") return null;
  if (payload.receipt && typeof payload.receipt === "object") {
    return parseReceiptPayload(payload);
  }
  if (payload.txid) {
    return parseReceiptPayload({ receipt: payload });
  }
  return null;
}

function buildReceiptStreamUrl() {
  const base = RECEIPT_SSE_URL || (RECEIPT_API_URL ? `${RECEIPT_API_URL}/v1/execution-receipts/stream` : "");
  if (!base) return "";
  const url = new URL(base, typeof window !== "undefined" ? window.location.origin : "http://localhost");
  if (RECEIPT_SSE_REPLAY) url.searchParams.set("replay", "1");
  if (RECEIPT_SSE_REPLAY_LIMIT > 0) url.searchParams.set("limit", String(RECEIPT_SSE_REPLAY_LIMIT));
  if (RECEIPT_API_TOKEN) url.searchParams.set("token", RECEIPT_API_TOKEN);
  return url.toString();
}

export function openBackendExecutionReceiptStream(params: {
  onReceipt: (receipt: BackendExecutionReceipt) => void;
  onStatus?: (status: "connecting" | "open" | "error" | "closed") => void;
}) {
  if (!backendReceiptStreamConfigured()) return null;
  const url = buildReceiptStreamUrl();
  if (!url) return null;
  const onReceipt = params?.onReceipt;
  const onStatus = params?.onStatus;
  const source = new EventSource(url);
  onStatus?.("connecting");

  const handleOpen = () => onStatus?.("open");
  const handleError = () => onStatus?.("error");
  const handleReceipt = (ev: MessageEvent) => {
    try {
      const payload = ev?.data ? JSON.parse(String(ev.data)) : null;
      const receipt = normalizeStreamReceiptPayload(payload);
      if (receipt && typeof onReceipt === "function") onReceipt(receipt);
    } catch {
      // Ignore malformed SSE events and keep the stream alive.
    }
  };

  source.addEventListener("open", handleOpen as EventListener);
  source.addEventListener("error", handleError as EventListener);
  source.addEventListener("receipt", handleReceipt as EventListener);

  return {
    close() {
      try { source.removeEventListener("open", handleOpen as EventListener); } catch {}
      try { source.removeEventListener("error", handleError as EventListener); } catch {}
      try { source.removeEventListener("receipt", handleReceipt as EventListener); } catch {}
      try { source.close(); } catch {}
      onStatus?.("closed");
    },
    source,
    url,
  };
}

export async function fetchBackendExecutionReceipt(txidRaw: string): Promise<BackendExecutionReceipt | null> {
  if (!backendReceiptImportConfigured()) return null;
  const txid = normalizeTxid(txidRaw);
  if (typeof fetch !== "function") throw new Error("backend_receipt_fetch_unavailable");

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), RECEIPT_API_TIMEOUT_MS) : null;
  try {
    const res = await fetch(`${RECEIPT_API_URL}/v1/execution-receipts?txid=${encodeURIComponent(txid)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(RECEIPT_API_TOKEN ? { Authorization: `Bearer ${RECEIPT_API_TOKEN}` } : {}),
      },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`backend_receipt_${res.status}:${String(text || "").slice(0, 180)}`);
    }
    const payload = text ? JSON.parse(text) : {};
    return parseReceiptPayload(payload);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function postBackendReceiptConsistencyReport(report: BackendReceiptConsistencyReport): Promise<boolean> {
  if (!backendReceiptMetricsConfigured()) return false;
  if (typeof fetch !== "function") throw new Error("backend_receipt_metrics_fetch_unavailable");
  const status = String(report?.status || "").toLowerCase();
  if (!["consistent", "mismatch", "insufficient"].includes(status)) throw new Error("invalid_consistency_status");

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), RECEIPT_API_TIMEOUT_MS) : null;
  try {
    const res = await fetch(`${RECEIPT_API_URL}/v1/receipt-consistency`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(RECEIPT_API_TOKEN ? { Authorization: `Bearer ${RECEIPT_API_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        txid: report?.txid ? normalizeTxid(String(report.txid)) : undefined,
        queueId: report?.queueId ? String(report.queueId).slice(0, 120) : undefined,
        agentId: report?.agentId ? String(report.agentId).slice(0, 120) : undefined,
        agentName: report?.agentName ? String(report.agentName).slice(0, 120) : undefined,
        status,
        mismatches: Array.isArray(report?.mismatches)
          ? report!.mismatches.map((m) => String(m).trim()).filter(Boolean).slice(0, 8)
          : [],
        provenance: report?.provenance ? String(report.provenance).slice(0, 24) : undefined,
        truthLabel: report?.truthLabel ? String(report.truthLabel).slice(0, 48) : undefined,
        checkedTs: Number.isFinite(Number(report?.checkedTs)) ? Math.max(0, Math.round(Number(report?.checkedTs))) : undefined,
        confirmTsDriftMs:
          Number.isFinite(Number(report?.confirmTsDriftMs)) ? Math.max(0, Math.round(Number(report?.confirmTsDriftMs))) : undefined,
        feeDiffKas:
          Number.isFinite(Number(report?.feeDiffKas)) ? Math.max(0, Number(Number(report?.feeDiffKas).toFixed(8))) : undefined,
        slippageDiffKas:
          Number.isFinite(Number(report?.slippageDiffKas)) ? Math.max(0, Number(Number(report?.slippageDiffKas).toFixed(8))) : undefined,
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) return false;
    return true;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
