import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import { createClient } from "redis";

const PORT = Number(process.env.PORT || 8796);
const HOST = String(process.env.HOST || "0.0.0.0");
const ALLOWED_ORIGINS = String(process.env.CALLBACK_CONSUMER_ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const AUTH_TOKENS = String(process.env.CALLBACK_CONSUMER_AUTH_TOKENS || process.env.CALLBACK_CONSUMER_AUTH_TOKEN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const REQUIRE_AUTH_FOR_READS = /^(1|true|yes)$/i.test(String(process.env.CALLBACK_CONSUMER_AUTH_READS || "false"));
const REDIS_URL = String(process.env.CALLBACK_CONSUMER_REDIS_URL || process.env.REDIS_URL || "").trim();
const REDIS_PREFIX = String(process.env.CALLBACK_CONSUMER_REDIS_PREFIX || "forgeos:callback-consumer").trim() || "forgeos:callback-consumer";
const REDIS_CONNECT_TIMEOUT_MS = Math.max(250, Number(process.env.CALLBACK_CONSUMER_REDIS_CONNECT_TIMEOUT_MS || 2000));
const IDEMPOTENCY_TTL_MS = Math.max(1000, Number(process.env.CALLBACK_CONSUMER_IDEMPOTENCY_TTL_MS || 24 * 60 * 60 * 1000));
const MAX_EVENTS = Math.max(10, Number(process.env.CALLBACK_CONSUMER_MAX_EVENTS || 500));
const MAX_RECEIPTS = Math.max(10, Number(process.env.CALLBACK_CONSUMER_MAX_RECEIPTS || 2000));
const RECEIPT_SSE_HEARTBEAT_MS = Math.max(1000, Number(process.env.CALLBACK_CONSUMER_RECEIPT_SSE_HEARTBEAT_MS || 15000));
const RECEIPT_SSE_MAX_CLIENTS = Math.max(1, Number(process.env.CALLBACK_CONSUMER_RECEIPT_SSE_MAX_CLIENTS || 200));
const RECEIPT_SSE_REPLAY_DEFAULT_LIMIT = Math.max(0, Number(process.env.CALLBACK_CONSUMER_RECEIPT_SSE_REPLAY_DEFAULT_LIMIT || 100));

let redisClient = null;
const recentEvents = [];
const recentReceipts = new Map();
const idempotencyMemory = new Map();
const fenceMemory = new Map();
const receiptSseClients = new Map();
let nextReceiptSseClientId = 1;

const metrics = {
  startedAtMs: Date.now(),
  httpRequestsTotal: 0,
  httpResponsesByRouteStatus: new Map(),
  authFailuresTotal: 0,
  cycleAcceptedTotal: 0,
  cycleDuplicateTotal: 0,
  cycleStaleFenceTotal: 0,
  cycleErrorsTotal: 0,
  receiptAcceptedTotal: 0,
  receiptDuplicateTotal: 0,
  receiptConsistencyChecksTotal: 0,
  receiptConsistencyMismatchTotal: 0,
  receiptConsistencyByTypeTotal: new Map(),
  receiptConsistencyByStatusTotal: new Map(),
  receiptSseConnectionsTotal: 0,
  receiptSseEventsTotal: 0,
  redisEnabled: false,
  redisConnected: false,
  redisOpsTotal: 0,
  redisErrorsTotal: 0,
  redisLastError: "",
};

const REDIS_KEYS = {
  idempotencyPrefix: `${REDIS_PREFIX}:idem`,
  fencePrefix: `${REDIS_PREFIX}:fence`,
  receiptPrefix: `${REDIS_PREFIX}:receipt`,
};

function nowMs() {
  return Date.now();
}

function inc(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

function resolveOrigin(req) {
  const origin = req.headers.origin || "*";
  if (ALLOWED_ORIGINS.includes("*")) return typeof origin === "string" ? origin : "*";
  return ALLOWED_ORIGINS.includes(String(origin)) ? String(origin) : "null";
}

function authEnabled() {
  return AUTH_TOKENS.length > 0;
}

function routeRequiresAuth(req, pathname) {
  if (!authEnabled()) return false;
  if (req.method === "OPTIONS") return false;
  if (req.method === "GET" && pathname === "/health") return false;
  if (req.method === "GET" && !REQUIRE_AUTH_FOR_READS) return false;
  return true;
}

function getAuthToken(req) {
  const authHeader = String(req.headers.authorization || "").trim();
  if (/^bearer\s+/i.test(authHeader)) return authHeader.replace(/^bearer\s+/i, "").trim();
  return String(req.headers["x-callback-consumer-token"] || "").trim();
}

function getAuthTokenWithQuery(req, url) {
  const headerToken = getAuthToken(req);
  if (headerToken) return headerToken;
  if (!url) return "";
  return String(url.searchParams.get("token") || "").trim();
}

function json(res, status, body, origin = "*") {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Callback-Consumer-Token",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function text(res, status, body, origin = "*") {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": origin,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sseWrite(res, event, data, id) {
  if (id != null) res.write(`id: ${String(id)}\n`);
  if (event) res.write(`event: ${String(event)}\n`);
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  for (const line of String(payload).split(/\r?\n/)) {
    res.write(`data: ${line}\n`);
  }
  res.write("\n");
}

function sanitizeReceiptSseReplayLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.min(MAX_RECEIPTS, Math.round(n)));
}

function closeReceiptSseClient(clientId) {
  const client = receiptSseClients.get(clientId);
  if (!client) return;
  receiptSseClients.delete(clientId);
  try { if (client.heartbeat) clearInterval(client.heartbeat); } catch {}
  try { client.res.end(); } catch {}
}

function streamReceiptToSseClients(receipt) {
  if (!receipt || receiptSseClients.size === 0) return;
  const txid = String(receipt.txid || "").trim().toLowerCase();
  const agentKey = String(receipt.agentKey || "").trim();
  const payload = {
    receipt,
    ts: nowMs(),
  };
  for (const [clientId, client] of receiptSseClients.entries()) {
    if (!client || !client.res) {
      receiptSseClients.delete(clientId);
      continue;
    }
    if (client.txid && client.txid !== txid) continue;
    if (client.agentKey && client.agentKey !== agentKey) continue;
    try {
      sseWrite(client.res, "receipt", payload, `${nowMs()}:${txid}`);
      metrics.receiptSseEventsTotal += 1;
    } catch {
      closeReceiptSseClient(clientId);
    }
  }
}

function openReceiptSseStream(req, res, origin, url) {
  if (receiptSseClients.size >= RECEIPT_SSE_MAX_CLIENTS) {
    json(res, 503, { error: { message: "receipt_sse_capacity_reached" } }, origin);
    return false;
  }
  const txid = String(url.searchParams.get("txid") || "").trim().toLowerCase();
  const agentKey = String(url.searchParams.get("agentKey") || "").trim();
  const replay = !/^(0|false|no)$/i.test(String(url.searchParams.get("replay") || "1"));
  const replayLimit = sanitizeReceiptSseReplayLimit(
    url.searchParams.get("limit") || RECEIPT_SSE_REPLAY_DEFAULT_LIMIT
  );
  const clientId = nextReceiptSseClientId++;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": origin,
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") {
    try { res.flushHeaders(); } catch {}
  }

  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat ${nowMs()}\n\n`);
    } catch {
      closeReceiptSseClient(clientId);
    }
  }, RECEIPT_SSE_HEARTBEAT_MS);

  receiptSseClients.set(clientId, {
    id: clientId,
    res,
    txid: txid || "",
    agentKey: agentKey || "",
    heartbeat,
    openedAt: nowMs(),
  });
  metrics.receiptSseConnectionsTotal += 1;

  sseWrite(res, "ready", { ok: true, txid: txid || null, agentKey: agentKey || null, replay }, `${nowMs()}:ready`);

  if (replay && replayLimit > 0) {
    const receipts = Array.from(recentReceipts.values())
      .filter((entry) => (txid ? String(entry?.txid || "").toLowerCase() === txid : true))
      .filter((entry) => (agentKey ? String(entry?.agentKey || "") === agentKey : true))
      .slice(-replayLimit);
    for (const receipt of receipts) {
      try {
        sseWrite(res, "receipt", { receipt, replay: true, ts: nowMs() }, `${nowMs()}:${String(receipt?.txid || "")}`);
        metrics.receiptSseEventsTotal += 1;
      } catch {
        break;
      }
    }
  }

  req.on("close", () => closeReceiptSseClient(clientId));
  req.on("error", () => closeReceiptSseClient(clientId));
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function recordHttp(routeKey, statusCode) {
  metrics.httpRequestsTotal += 1;
  inc(metrics.httpResponsesByRouteStatus, `${routeKey}|${statusCode}`);
}

async function redisOp(name, fn) {
  if (!redisClient) return null;
  try {
    metrics.redisOpsTotal += 1;
    return await fn(redisClient);
  } catch (e) {
    metrics.redisErrorsTotal += 1;
    metrics.redisLastError = String(e?.message || e || name).slice(0, 240);
    return null;
  }
}

function pruneIdempotencyMemory(now = nowMs()) {
  if (idempotencyMemory.size <= 50_000) return;
  for (const [k, v] of idempotencyMemory.entries()) {
    if (!v || now >= Number(v.expAt || 0)) idempotencyMemory.delete(k);
    if (idempotencyMemory.size <= 50_000) break;
  }
}

async function checkIdempotency(idempotencyKey) {
  const key = String(idempotencyKey || "").trim();
  if (!key) return { ok: false, reason: "idempotency_key_required" };
  if (redisClient) {
    const redisKey = `${REDIS_KEYS.idempotencyPrefix}:${key}`;
    const ok = await redisOp("idempotency_set_nx", (r) => r.set(redisKey, "1", { NX: true, PX: IDEMPOTENCY_TTL_MS }));
    if (ok == null) return { ok: true, duplicate: false, mode: "redis_fail_open" };
    if (ok !== "OK") return { ok: true, duplicate: true, mode: "redis" };
    return { ok: true, duplicate: false, mode: "redis" };
  }
  const now = nowMs();
  const prev = idempotencyMemory.get(key);
  if (prev && now < Number(prev.expAt || 0)) return { ok: true, duplicate: true, mode: "memory" };
  idempotencyMemory.set(key, { expAt: now + IDEMPOTENCY_TTL_MS });
  pruneIdempotencyMemory(now);
  return { ok: true, duplicate: false, mode: "memory" };
}

async function acceptCycleWithFenceAndIdempotency(agentKey, idempotencyKey, fenceToken) {
  const normalizedAgentKey = String(agentKey || "").trim();
  const normalizedIdem = String(idempotencyKey || "").trim();
  const normalizedFence = Math.max(0, Number(fenceToken || 0));
  if (!normalizedAgentKey) return { ok: false, reason: "agent_key_required" };
  if (!normalizedIdem) return { ok: false, reason: "idempotency_key_required" };
  if (!Number.isFinite(normalizedFence)) return { ok: false, reason: "invalid_fence_token" };

  if (redisClient) {
    const result = await redisOp("cycle_fence_idem_atomic", (r) =>
      r.eval(
        `
          local idemKey = KEYS[1]
          local fenceKey = KEYS[2]
          local idemTtl = tonumber(ARGV[1])
          local incomingFence = tonumber(ARGV[2])
          local currentFence = tonumber(redis.call("GET", fenceKey) or "0")
          if redis.call("EXISTS", idemKey) == 1 then
            return {"DUPLICATE", tostring(currentFence)}
          end
          if incomingFence < currentFence then
            return {"STALE", tostring(currentFence)}
          end
          local ok = redis.call("SET", idemKey, "1", "NX", "PX", idemTtl)
          if not ok then
            return {"DUPLICATE", tostring(currentFence)}
          end
          if incomingFence > currentFence then
            redis.call("SET", fenceKey, tostring(incomingFence))
            currentFence = incomingFence
          end
          return {"ACCEPTED", tostring(currentFence)}
        `,
        {
          keys: [
            `${REDIS_KEYS.idempotencyPrefix}:${normalizedIdem}`,
            `${REDIS_KEYS.fencePrefix}:${normalizedAgentKey}`,
          ],
          arguments: [String(IDEMPOTENCY_TTL_MS), String(normalizedFence)],
        }
      )
    );
    if (!Array.isArray(result) || !result[0]) {
      return { ok: true, duplicate: false, stale: false, currentFence: 0, mode: "redis_fail_open" };
    }
    const decision = String(result[0] || "").toUpperCase();
    const currentFence = Math.max(0, Number(result[1] || 0));
    if (decision === "DUPLICATE") return { ok: true, duplicate: true, stale: false, currentFence, mode: "redis" };
    if (decision === "STALE") return { ok: true, duplicate: false, stale: true, currentFence, mode: "redis" };
    return { ok: true, duplicate: false, stale: false, currentFence, mode: "redis" };
  }

  const idem = await checkIdempotency(normalizedIdem);
  if (!idem.ok) return idem;
  if (idem.duplicate) return { ok: true, duplicate: true, stale: false, currentFence: await getFenceToken(normalizedAgentKey), mode: "memory" };
  const currentFence = await getFenceToken(normalizedAgentKey);
  if (normalizedFence < currentFence) return { ok: true, duplicate: false, stale: true, currentFence, mode: "memory" };
  if (normalizedFence > currentFence) await setFenceToken(normalizedAgentKey, normalizedFence);
  return { ok: true, duplicate: false, stale: false, currentFence: Math.max(currentFence, normalizedFence), mode: "memory" };
}

async function acceptReceiptIdempotencyAndPersist(idempotencyKey, receipt) {
  const key = String(idempotencyKey || "").trim();
  if (!key) return { ok: false, reason: "idempotency_key_required" };
  if (redisClient) {
    const receiptKey = `${REDIS_KEYS.receiptPrefix}:${String(receipt?.txid || "").trim().toLowerCase()}`;
    const receiptTtlMs = IDEMPOTENCY_TTL_MS * 7;
    const payload = JSON.stringify(receipt);
    const result = await redisOp("receipt_idem_persist_atomic", (r) =>
      r.eval(
        `
          local idemKey = KEYS[1]
          local receiptKey = KEYS[2]
          local idemTtl = tonumber(ARGV[1])
          local receiptTtl = tonumber(ARGV[2])
          local receiptJson = ARGV[3]
          if redis.call("EXISTS", idemKey) == 1 then
            return {"DUPLICATE"}
          end
          local ok = redis.call("SET", idemKey, "1", "NX", "PX", idemTtl)
          if not ok then
            return {"DUPLICATE"}
          end
          redis.call("SET", receiptKey, receiptJson, "PX", receiptTtl)
          return {"ACCEPTED"}
        `,
        {
          keys: [`${REDIS_KEYS.idempotencyPrefix}:${key}`, receiptKey],
          arguments: [String(IDEMPOTENCY_TTL_MS), String(receiptTtlMs), payload],
        }
      )
    );
    if (!Array.isArray(result) || !result[0]) return { ok: true, duplicate: false, mode: "redis_fail_open" };
    const decision = String(result[0] || "").toUpperCase();
    if (decision === "DUPLICATE") return { ok: true, duplicate: true, mode: "redis" };
    return { ok: true, duplicate: false, mode: "redis" };
  }
  return checkIdempotency(key);
}

async function getFenceToken(agentKey) {
  const key = String(agentKey || "").trim();
  if (!key) return 0;
  if (redisClient) {
    const value = await redisOp("fence_get", (r) => r.get(`${REDIS_KEYS.fencePrefix}:${key}`));
    if (value == null) return 0;
    return Math.max(0, Number(value || 0));
  }
  return Math.max(0, Number(fenceMemory.get(key) || 0));
}

async function setFenceToken(agentKey, token) {
  const key = String(agentKey || "").trim();
  const next = Math.max(0, Number(token || 0));
  if (!key) return;
  if (redisClient) {
    await redisOp("fence_set", (r) => r.set(`${REDIS_KEYS.fencePrefix}:${key}`, String(next)));
    return;
  }
  fenceMemory.set(key, next);
}

function normalizeCycleRequest(req, body) {
  const scheduler = body?.scheduler && typeof body.scheduler === "object" ? body.scheduler : {};
  const agent = body?.agent && typeof body.agent === "object" ? body.agent : {};
  const headerIdem = String(req.headers["x-forgeos-idempotency-key"] || "").trim();
  const headerFence = String(req.headers["x-forgeos-leader-fence-token"] || "").trim();
  const headerAgentKey = String(req.headers["x-forgeos-agent-key"] || "").trim();
  const idempotencyKey = headerIdem || String(scheduler?.callbackIdempotencyKey || "").trim();
  const agentKey = headerAgentKey || [String(agent?.userId || "").trim(), String(agent?.id || "").trim()].filter(Boolean).join(":");
  const fenceToken = Math.max(0, Number(headerFence || scheduler?.leaderFenceToken || 0));
  if (!idempotencyKey) throw new Error("idempotency_key_required");
  if (!agentKey) throw new Error("agent_key_required");
  if (!Number.isFinite(fenceToken)) throw new Error("invalid_fence_token");
  return { idempotencyKey, agentKey, fenceToken, scheduler, agent, event: body };
}

function normalizeReceiptRequest(req, body) {
  const txid = String(body?.txid || body?.transactionId || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/i.test(txid)) throw new Error("invalid_txid");
  const idempotencyKey =
    String(req.headers["x-forgeos-idempotency-key"] || "").trim() ||
    String(body?.idempotencyKey || `receipt:${txid}`).trim();
  const agentKey =
    String(body?.agentKey || "").trim() ||
    [String(body?.userId || "").trim(), String(body?.agentId || "").trim()].filter(Boolean).join(":");
  const receipt = {
    txid,
    agentKey: agentKey || null,
    userId: body?.userId ? String(body.userId).slice(0, 120) : null,
    agentId: body?.agentId ? String(body.agentId).slice(0, 120) : null,
    walletAddress: body?.walletAddress ? String(body.walletAddress).slice(0, 120) : null,
    network: body?.network ? String(body.network).slice(0, 40) : null,
    status: String(body?.status || "confirmed").slice(0, 40),
    confirmations: Math.max(0, Number(body?.confirmations || 0)),
    feeKas: Number.isFinite(Number(body?.feeKas)) ? Number(Number(body.feeKas).toFixed(8)) : null,
    feeSompi: Number.isFinite(Number(body?.feeSompi)) ? Math.max(0, Math.round(Number(body.feeSompi))) : null,
    broadcastTs: Number.isFinite(Number(body?.broadcastTs)) ? Math.round(Number(body.broadcastTs)) : null,
    confirmTs: Number.isFinite(Number(body?.confirmTs)) ? Math.round(Number(body.confirmTs)) : null,
    confirmTsSource: body?.confirmTsSource ? String(body.confirmTsSource).slice(0, 40) : null,
    slippageKas: Number.isFinite(Number(body?.slippageKas)) ? Number(Number(body.slippageKas).toFixed(8)) : null,
    priceAtBroadcastUsd: Number.isFinite(Number(body?.priceAtBroadcastUsd)) ? Number(Number(body.priceAtBroadcastUsd).toFixed(8)) : null,
    priceAtConfirmUsd: Number.isFinite(Number(body?.priceAtConfirmUsd)) ? Number(Number(body.priceAtConfirmUsd).toFixed(8)) : null,
    source: body?.source ? String(body.source).slice(0, 120) : "external",
    raw: body?.raw && typeof body.raw === "object" ? body.raw : undefined,
    updatedAt: nowMs(),
  };
  return { idempotencyKey, receipt };
}

function normalizeReceiptConsistencyRequest(body) {
  const status = String(body?.status || "").trim().toLowerCase();
  if (!["consistent", "mismatch", "insufficient"].includes(status)) {
    throw new Error("invalid_receipt_consistency_status");
  }
  const txidRaw = String(body?.txid || "").trim().toLowerCase();
  if (txidRaw && !/^[a-f0-9]{64}$/i.test(txidRaw)) throw new Error("invalid_txid");
  const txid = txidRaw || null;
  const mismatches = Array.isArray(body?.mismatches)
    ? body.mismatches.map((m) => String(m || "").trim().toLowerCase()).filter(Boolean).slice(0, 8)
    : [];
  const checkedTs = Number(body?.checkedTs || 0);
  const report = {
    txid,
    queueId: body?.queueId ? String(body.queueId).slice(0, 120) : null,
    agentId: body?.agentId ? String(body.agentId).slice(0, 120) : null,
    agentName: body?.agentName ? String(body.agentName).slice(0, 120) : null,
    status,
    mismatches,
    provenance: body?.provenance ? String(body.provenance).slice(0, 24).toUpperCase() : null,
    truthLabel: body?.truthLabel ? String(body.truthLabel).slice(0, 48) : null,
    checkedTs: Number.isFinite(checkedTs) && checkedTs > 0 ? Math.round(checkedTs) : nowMs(),
    confirmTsDriftMs:
      Number.isFinite(Number(body?.confirmTsDriftMs)) && Number(body.confirmTsDriftMs) >= 0
        ? Math.round(Number(body.confirmTsDriftMs))
        : null,
    feeDiffKas:
      Number.isFinite(Number(body?.feeDiffKas)) && Number(body.feeDiffKas) >= 0
        ? Number(Number(body.feeDiffKas).toFixed(8))
        : null,
    slippageDiffKas:
      Number.isFinite(Number(body?.slippageDiffKas)) && Number(body.slippageDiffKas) >= 0
        ? Number(Number(body.slippageDiffKas).toFixed(8))
        : null,
  };
  return report;
}

function pushRecentEvent(entry) {
  recentEvents.unshift(entry);
  if (recentEvents.length > MAX_EVENTS) recentEvents.length = MAX_EVENTS;
}

function upsertReceipt(entry) {
  recentReceipts.set(entry.txid, entry);
  if (recentReceipts.size <= MAX_RECEIPTS) return;
  const oldestKey = recentReceipts.keys().next().value;
  if (oldestKey) recentReceipts.delete(oldestKey);
}

function percentileFromSorted(values, pct) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const p = Math.max(0, Math.min(100, Number(pct || 0)));
  const idx = Math.min(values.length - 1, Math.max(0, Math.ceil((p / 100) * values.length) - 1));
  const v = Number(values[idx]);
  return Number.isFinite(v) ? v : null;
}

function buildTelemetrySummary() {
  const now = nowMs();
  const confirmLatencies = [];
  const receiptLags = [];
  let confirmedReceipts = 0;
  let backendConfirmed = 0;
  let chainConfirmed = 0;

  for (const receipt of recentReceipts.values()) {
    const status = String(receipt?.status || "").toLowerCase();
    const confirmations = Math.max(0, Number(receipt?.confirmations || 0));
    if (status !== "confirmed" && confirmations <= 0) continue;
    confirmedReceipts += 1;

    const confirmTs = Number(receipt?.confirmTs || 0);
    const broadcastTs = Number(receipt?.broadcastTs || 0);
    if (confirmTs > 0 && broadcastTs > 0 && confirmTs >= broadcastTs) {
      confirmLatencies.push(confirmTs - broadcastTs);
    }
    if (confirmTs > 0 && now >= confirmTs) {
      receiptLags.push(now - confirmTs);
    }
    const source = String(receipt?.confirmTsSource || "").toLowerCase();
    if (source === "chain") chainConfirmed += 1;
    else if (source) backendConfirmed += 1;
  }

  confirmLatencies.sort((a, b) => a - b);
  receiptLags.sort((a, b) => a - b);

  return {
    ok: true,
    service: "forgeos-callback-consumer",
    receipts: {
      recentCount: recentReceipts.size,
      confirmedCount: confirmedReceipts,
      chainConfirmedCount: chainConfirmed,
      backendConfirmedCount: backendConfirmed,
      confirmationLatencyMs: {
        p50: percentileFromSorted(confirmLatencies, 50),
        p95: percentileFromSorted(confirmLatencies, 95),
        samples: confirmLatencies.length,
      },
      receiptLagMs: {
        p50: percentileFromSorted(receiptLags, 50),
        p95: percentileFromSorted(receiptLags, 95),
        samples: receiptLags.length,
      },
    },
    truth: {
      consistencyChecksTotal: metrics.receiptConsistencyChecksTotal,
      consistencyMismatchTotal: metrics.receiptConsistencyMismatchTotal,
    },
    ts: now,
  };
}

async function persistReceiptToRedis(receipt) {
  if (!redisClient) return;
  await redisOp("receipt_set", (r) =>
    r.set(`${REDIS_KEYS.receiptPrefix}:${receipt.txid}`, JSON.stringify(receipt), { PX: IDEMPOTENCY_TTL_MS * 7 })
  );
}

async function readReceiptFromRedis(txid) {
  if (!redisClient) return null;
  const raw = await redisOp("receipt_get", (r) => r.get(`${REDIS_KEYS.receiptPrefix}:${txid}`));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function exportPrometheus() {
  const lines = [];
  const push = (s) => lines.push(s);
  push("# HELP forgeos_callback_consumer_http_requests_total HTTP requests received.");
  push("# TYPE forgeos_callback_consumer_http_requests_total counter");
  push(`forgeos_callback_consumer_http_requests_total ${metrics.httpRequestsTotal}`);
  push("# HELP forgeos_callback_consumer_auth_failures_total Auth failures.");
  push("# TYPE forgeos_callback_consumer_auth_failures_total counter");
  push(`forgeos_callback_consumer_auth_failures_total ${metrics.authFailuresTotal}`);
  push("# HELP forgeos_callback_consumer_cycle_accepted_total Accepted scheduler cycle callbacks.");
  push("# TYPE forgeos_callback_consumer_cycle_accepted_total counter");
  push(`forgeos_callback_consumer_cycle_accepted_total ${metrics.cycleAcceptedTotal}`);
  push("# HELP forgeos_callback_consumer_cycle_duplicate_total Duplicate scheduler callbacks skipped.");
  push("# TYPE forgeos_callback_consumer_cycle_duplicate_total counter");
  push(`forgeos_callback_consumer_cycle_duplicate_total ${metrics.cycleDuplicateTotal}`);
  push("# HELP forgeos_callback_consumer_cycle_stale_fence_total Stale scheduler callbacks rejected by fence token.");
  push("# TYPE forgeos_callback_consumer_cycle_stale_fence_total counter");
  push(`forgeos_callback_consumer_cycle_stale_fence_total ${metrics.cycleStaleFenceTotal}`);
  push("# HELP forgeos_callback_consumer_receipt_accepted_total Execution receipts accepted.");
  push("# TYPE forgeos_callback_consumer_receipt_accepted_total counter");
  push(`forgeos_callback_consumer_receipt_accepted_total ${metrics.receiptAcceptedTotal}`);
  push("# HELP forgeos_callback_consumer_receipt_duplicate_total Execution receipts skipped by idempotency.");
  push("# TYPE forgeos_callback_consumer_receipt_duplicate_total counter");
  push(`forgeos_callback_consumer_receipt_duplicate_total ${metrics.receiptDuplicateTotal}`);
  push("# HELP forgeos_callback_consumer_receipt_consistency_checks_total Receipt consistency checks reported by clients.");
  push("# TYPE forgeos_callback_consumer_receipt_consistency_checks_total counter");
  push(`forgeos_callback_consumer_receipt_consistency_checks_total ${metrics.receiptConsistencyChecksTotal}`);
  push("# HELP forgeos_callback_consumer_receipt_consistency_mismatch_total Receipt consistency mismatches reported by clients.");
  push("# TYPE forgeos_callback_consumer_receipt_consistency_mismatch_total counter");
  push(`forgeos_callback_consumer_receipt_consistency_mismatch_total ${metrics.receiptConsistencyMismatchTotal}`);
  push("# HELP forgeos_callback_consumer_receipt_consistency_by_status_total Receipt consistency reports by status.");
  push("# TYPE forgeos_callback_consumer_receipt_consistency_by_status_total counter");
  push("# HELP forgeos_callback_consumer_receipt_consistency_mismatch_by_type_total Receipt consistency mismatches by mismatch type.");
  push("# TYPE forgeos_callback_consumer_receipt_consistency_mismatch_by_type_total counter");
  push("# HELP forgeos_callback_consumer_receipt_sse_connections_total Receipt SSE connections opened.");
  push("# TYPE forgeos_callback_consumer_receipt_sse_connections_total counter");
  push(`forgeos_callback_consumer_receipt_sse_connections_total ${metrics.receiptSseConnectionsTotal}`);
  push("# HELP forgeos_callback_consumer_receipt_sse_events_total Receipt SSE events emitted.");
  push("# TYPE forgeos_callback_consumer_receipt_sse_events_total counter");
  push(`forgeos_callback_consumer_receipt_sse_events_total ${metrics.receiptSseEventsTotal}`);
  push("# HELP forgeos_callback_consumer_receipt_sse_clients Current connected receipt SSE clients.");
  push("# TYPE forgeos_callback_consumer_receipt_sse_clients gauge");
  push(`forgeos_callback_consumer_receipt_sse_clients ${receiptSseClients.size}`);
  push("# HELP forgeos_callback_consumer_recent_events_count In-memory stored callback events.");
  push("# TYPE forgeos_callback_consumer_recent_events_count gauge");
  push(`forgeos_callback_consumer_recent_events_count ${recentEvents.length}`);
  push("# HELP forgeos_callback_consumer_recent_receipts_count In-memory stored receipt records.");
  push("# TYPE forgeos_callback_consumer_recent_receipts_count gauge");
  push(`forgeos_callback_consumer_recent_receipts_count ${recentReceipts.size}`);
  push("# HELP forgeos_callback_consumer_redis_enabled Redis configured.");
  push("# TYPE forgeos_callback_consumer_redis_enabled gauge");
  push(`forgeos_callback_consumer_redis_enabled ${metrics.redisEnabled ? 1 : 0}`);
  push("# HELP forgeos_callback_consumer_redis_connected Redis connected.");
  push("# TYPE forgeos_callback_consumer_redis_connected gauge");
  push(`forgeos_callback_consumer_redis_connected ${metrics.redisConnected ? 1 : 0}`);
  push("# HELP forgeos_callback_consumer_redis_ops_total Redis operations attempted.");
  push("# TYPE forgeos_callback_consumer_redis_ops_total counter");
  push(`forgeos_callback_consumer_redis_ops_total ${metrics.redisOpsTotal}`);
  push("# HELP forgeos_callback_consumer_redis_errors_total Redis operation errors.");
  push("# TYPE forgeos_callback_consumer_redis_errors_total counter");
  push(`forgeos_callback_consumer_redis_errors_total ${metrics.redisErrorsTotal}`);
  push("# HELP forgeos_callback_consumer_uptime_seconds Service uptime.");
  push("# TYPE forgeos_callback_consumer_uptime_seconds gauge");
  push(`forgeos_callback_consumer_uptime_seconds ${((nowMs() - metrics.startedAtMs) / 1000).toFixed(3)}`);

  for (const [k, v] of metrics.httpResponsesByRouteStatus.entries()) {
    const [route, status] = String(k).split("|");
    push(`forgeos_callback_consumer_http_responses_total{route="${esc(route)}",status="${esc(status)}"} ${v}`);
  }
  for (const [status, v] of metrics.receiptConsistencyByStatusTotal.entries()) {
    push(
      `forgeos_callback_consumer_receipt_consistency_by_status_total{status="${esc(status)}"} ${v}`
    );
  }
  for (const [kind, v] of metrics.receiptConsistencyByTypeTotal.entries()) {
    push(
      `forgeos_callback_consumer_receipt_consistency_mismatch_by_type_total{type="${esc(kind)}"} ${v}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function esc(v) {
  return String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

async function initRedis() {
  if (!REDIS_URL) return;
  metrics.redisEnabled = true;
  try {
    const client = createClient({
      url: REDIS_URL,
      socket: { reconnectStrategy: (retries) => Math.min(1000 + retries * 250, 5000) },
    });
    client.on("error", (e) => {
      metrics.redisConnected = false;
      metrics.redisLastError = String(e?.message || e || "redis_error").slice(0, 240);
    });
    client.on("ready", () => {
      metrics.redisConnected = true;
    });
    client.on("end", () => {
      metrics.redisConnected = false;
    });
    await Promise.race([
      client.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`redis_connect_timeout_${REDIS_CONNECT_TIMEOUT_MS}ms`)), REDIS_CONNECT_TIMEOUT_MS)
      ),
    ]);
    redisClient = client;
    metrics.redisConnected = true;
  } catch (e) {
    metrics.redisConnected = false;
    metrics.redisLastError = String(e?.message || e || "redis_init_failed").slice(0, 240);
    try {
      await redisClient?.disconnect?.();
    } catch {
      // ignore
    }
    redisClient = null;
  }
}

const server = http.createServer(async (req, res) => {
  const origin = resolveOrigin(req);
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const routeKey = `${req.method || "GET"} ${url.pathname}`;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Callback-Consumer-Token",
    });
    res.end();
    recordHttp(routeKey, 204);
    return;
  }

  if (routeRequiresAuth(req, url.pathname)) {
    const token = getAuthTokenWithQuery(req, url);
    if (!token || !AUTH_TOKENS.includes(token)) {
      metrics.authFailuresTotal += 1;
      json(res, 401, { error: { message: "unauthorized" } }, origin);
      recordHttp(routeKey, 401);
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      service: "forgeos-callback-consumer",
      auth: { enabled: authEnabled(), requireAuthForReads: REQUIRE_AUTH_FOR_READS },
      redis: { enabled: metrics.redisEnabled, connected: metrics.redisConnected, lastError: metrics.redisLastError || null },
      stores: { events: recentEvents.length, receipts: recentReceipts.size },
      ts: nowMs(),
    }, origin);
    recordHttp(routeKey, 200);
    return;
  }

  if (req.method === "GET" && url.pathname === "/metrics") {
    text(res, 200, exportPrometheus(), origin);
    recordHttp(routeKey, 200);
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/execution-receipts/stream") {
    const opened = openReceiptSseStream(req, res, origin, url);
    if (opened) {
      recordHttp(routeKey, 200);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/events") {
    json(res, 200, { events: recentEvents.slice(0, MAX_EVENTS), ts: nowMs() }, origin);
    recordHttp(routeKey, 200);
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/execution-receipts") {
    const txid = String(url.searchParams.get("txid") || "").trim().toLowerCase();
    if (txid) {
      const local = recentReceipts.get(txid);
      const receipt = local || (await readReceiptFromRedis(txid));
      if (!receipt) {
        json(res, 404, { error: { message: "receipt_not_found", txid } }, origin);
        recordHttp(routeKey, 404);
        return;
      }
      json(res, 200, { receipt, ts: nowMs() }, origin);
      recordHttp(routeKey, 200);
      return;
    }
    json(res, 200, { receipts: Array.from(recentReceipts.values()), ts: nowMs() }, origin);
    recordHttp(routeKey, 200);
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/telemetry-summary") {
    json(res, 200, buildTelemetrySummary(), origin);
    recordHttp(routeKey, 200);
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/scheduler/cycle") {
    let body;
    try {
      body = await readJson(req);
      const normalized = normalizeCycleRequest(req, body);
      const cycleGate = await acceptCycleWithFenceAndIdempotency(
        normalized.agentKey,
        normalized.idempotencyKey,
        normalized.fenceToken
      );
      if (!cycleGate.ok) throw new Error(String(cycleGate.reason || "idempotency_failed"));
      if (cycleGate.duplicate) {
        metrics.cycleDuplicateTotal += 1;
        json(res, 200, { ok: true, duplicate: true, reason: "idempotency_duplicate", ts: nowMs() }, origin);
        recordHttp(routeKey, 200);
        return;
      }
      if (cycleGate.stale) {
        metrics.cycleStaleFenceTotal += 1;
        json(res, 409, {
          error: {
            message: "stale_fence_token",
            currentFence: Math.max(0, Number(cycleGate.currentFence || 0)),
            receivedFence: normalized.fenceToken,
            agentKey: normalized.agentKey,
          },
        }, origin);
        recordHttp(routeKey, 409);
        return;
      }
      pushRecentEvent({
        id: crypto.randomUUID(),
        type: "scheduler_cycle",
        ts: nowMs(),
        idempotencyKey: normalized.idempotencyKey,
        agentKey: normalized.agentKey,
        fenceToken: normalized.fenceToken,
        schedulerInstanceId: String(normalized.scheduler?.instanceId || "").slice(0, 120) || null,
        queueTaskId: normalized.scheduler?.queueTaskId ? String(normalized.scheduler.queueTaskId).slice(0, 120) : null,
        agent: {
          id: normalized.agent?.id ? String(normalized.agent.id).slice(0, 120) : null,
          userId: normalized.agent?.userId ? String(normalized.agent.userId).slice(0, 120) : null,
          name: normalized.agent?.name ? String(normalized.agent.name).slice(0, 120) : null,
          strategyLabel: normalized.agent?.strategyLabel ? String(normalized.agent.strategyLabel).slice(0, 120) : null,
        },
      });
      metrics.cycleAcceptedTotal += 1;
      json(res, 200, { ok: true, accepted: true, duplicate: false, ts: nowMs() }, origin);
      recordHttp(routeKey, 200);
    } catch (e) {
      metrics.cycleErrorsTotal += 1;
      json(res, 400, { error: { message: String(e?.message || "invalid_callback") } }, origin);
      recordHttp(routeKey, 400);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/execution-receipts") {
    let body;
    try {
      body = await readJson(req);
      const { idempotencyKey, receipt } = normalizeReceiptRequest(req, body);
      const idem = await acceptReceiptIdempotencyAndPersist(idempotencyKey, receipt);
      if (!idem.ok) throw new Error(String(idem.reason || "idempotency_failed"));
      if (idem.duplicate) {
        metrics.receiptDuplicateTotal += 1;
        json(res, 200, { ok: true, duplicate: true, txid: receipt.txid, ts: nowMs() }, origin);
        recordHttp(routeKey, 200);
        return;
      }
      upsertReceipt(receipt);
      if (!redisClient || String(idem.mode || "").includes("fail_open")) {
        await persistReceiptToRedis(receipt);
      }
      streamReceiptToSseClients(receipt);
      metrics.receiptAcceptedTotal += 1;
      json(res, 200, { ok: true, accepted: true, txid: receipt.txid, receipt, ts: nowMs() }, origin);
      recordHttp(routeKey, 200);
    } catch (e) {
      json(res, 400, { error: { message: String(e?.message || "invalid_receipt") } }, origin);
      recordHttp(routeKey, 400);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/receipt-consistency") {
    let body;
    try {
      body = await readJson(req);
      const report = normalizeReceiptConsistencyRequest(body);
      metrics.receiptConsistencyChecksTotal += 1;
      inc(metrics.receiptConsistencyByStatusTotal, report.status);
      if (report.status === "mismatch") {
        metrics.receiptConsistencyMismatchTotal += 1;
        const mismatchTypes = report.mismatches.length ? report.mismatches : ["unknown"];
        for (const kind of mismatchTypes) inc(metrics.receiptConsistencyByTypeTotal, String(kind));
      }
      if (report.status === "mismatch") {
        pushRecentEvent({
          id: crypto.randomUUID(),
          type: "receipt_consistency_mismatch",
          ts: nowMs(),
          txid: report.txid,
          queueId: report.queueId,
          agentId: report.agentId,
          agentName: report.agentName,
          mismatches: report.mismatches,
          provenance: report.provenance,
          truthLabel: report.truthLabel,
          confirmTsDriftMs: report.confirmTsDriftMs,
          feeDiffKas: report.feeDiffKas,
          slippageDiffKas: report.slippageDiffKas,
        });
      }
      json(res, 200, { ok: true, accepted: true, ts: nowMs() }, origin);
      recordHttp(routeKey, 200);
    } catch (e) {
      json(res, 400, { error: { message: String(e?.message || "invalid_receipt_consistency") } }, origin);
      recordHttp(routeKey, 400);
    }
    return;
  }

  json(res, 404, { error: { message: "not_found" } }, origin);
  recordHttp(routeKey, 404);
});

await initRedis();

server.listen(PORT, HOST, () => {
  console.log(`[forgeos-callback-consumer] listening on http://${HOST}:${PORT}`);
  console.log(
    `[forgeos-callback-consumer] auth=${authEnabled() ? "on" : "off"} redis=${metrics.redisEnabled ? (metrics.redisConnected ? "connected" : "degraded") : "off"}`
  );
});
