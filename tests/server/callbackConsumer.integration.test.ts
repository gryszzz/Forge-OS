import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePort, httpJson, spawnNodeProcess, stopProcess, waitForHttp } from "./helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

describe("callback consumer reference service", () => {
  const children: Array<ReturnType<typeof spawnNodeProcess>> = [];

  afterEach(async () => {
    await Promise.all(children.map((c) => stopProcess(c.child)));
    children.length = 0;
  });

  it("enforces idempotency and fence ordering for scheduler callbacks and stores receipts", async () => {
    const port = await getFreePort();
    const proc = spawnNodeProcess(["server/callback-consumer/index.mjs"], {
      cwd: repoRoot,
      env: { PORT: String(port), HOST: "127.0.0.1" },
    });
    children.push(proc);
    await waitForHttp(`http://127.0.0.1:${port}/health`);

    const callbackBody = {
      event: "forgeos.scheduler.cycle",
      scheduler: { instanceId: "sched-a", leaderFenceToken: 10, queueTaskId: "task-1", callbackIdempotencyKey: "idem-1" },
      agent: { id: "agent-1", userId: "user-1", name: "Agent 1", strategyLabel: "DCA" },
      market: { priceUsd: 0.12, dag: { daaScore: 123 } },
    };

    const baseHeaders = {
      "Content-Type": "application/json",
      "X-ForgeOS-Agent-Key": "user-1:agent-1",
    };

    const accepted = await httpJson(`http://127.0.0.1:${port}/v1/scheduler/cycle`, {
      method: "POST",
      headers: {
        ...baseHeaders,
        "X-ForgeOS-Idempotency-Key": "forgeos.scheduler:user-1:agent-1:10:task-1",
        "X-ForgeOS-Leader-Fence-Token": "10",
      },
      body: JSON.stringify(callbackBody),
    });
    expect(accepted.res.status).toBe(200);
    expect(accepted.body.ok).toBe(true);
    expect(accepted.body.duplicate).toBe(false);

    const duplicate = await httpJson(`http://127.0.0.1:${port}/v1/scheduler/cycle`, {
      method: "POST",
      headers: {
        ...baseHeaders,
        "X-ForgeOS-Idempotency-Key": "forgeos.scheduler:user-1:agent-1:10:task-1",
        "X-ForgeOS-Leader-Fence-Token": "10",
      },
      body: JSON.stringify(callbackBody),
    });
    expect(duplicate.res.status).toBe(200);
    expect(duplicate.body.duplicate).toBe(true);

    const stale = await httpJson(`http://127.0.0.1:${port}/v1/scheduler/cycle`, {
      method: "POST",
      headers: {
        ...baseHeaders,
        "X-ForgeOS-Idempotency-Key": "forgeos.scheduler:user-1:agent-1:9:task-2",
        "X-ForgeOS-Leader-Fence-Token": "9",
      },
      body: JSON.stringify({
        ...callbackBody,
        scheduler: { ...callbackBody.scheduler, leaderFenceToken: 9, queueTaskId: "task-2", callbackIdempotencyKey: "idem-2" },
      }),
    });
    expect(stale.res.status).toBe(409);
    expect(stale.body.error.message).toBe("stale_fence_token");

    const newerFence = await httpJson(`http://127.0.0.1:${port}/v1/scheduler/cycle`, {
      method: "POST",
      headers: {
        ...baseHeaders,
        "X-ForgeOS-Idempotency-Key": "forgeos.scheduler:user-1:agent-1:11:task-3",
        "X-ForgeOS-Leader-Fence-Token": "11",
      },
      body: JSON.stringify({
        ...callbackBody,
        scheduler: { ...callbackBody.scheduler, leaderFenceToken: 11, queueTaskId: "task-3", callbackIdempotencyKey: "idem-3" },
      }),
    });
    expect(newerFence.res.status).toBe(200);
    expect(newerFence.body.accepted).toBe(true);

    const txid = "a".repeat(64);
    const sseController = new AbortController();
    const sseRes = await fetch(`http://127.0.0.1:${port}/v1/execution-receipts/stream?replay=0`, {
      signal: sseController.signal,
    });
    expect(sseRes.ok).toBe(true);
    const sseReader = sseRes.body?.getReader();
    expect(sseReader).toBeTruthy();
    let sseBuffer = "";
    const waitForReceiptEvent = async (needleTxid: string, timeoutMs = 5000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const next = await Promise.race([
          sseReader!.read(),
          new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 250)),
        ]);
        if ((next as any)?.timeout) {
          if (sseBuffer.includes(needleTxid) && sseBuffer.includes("event: receipt")) return;
          continue;
        }
        const chunk = next as ReadableStreamReadResult<Uint8Array>;
        if (chunk.done) break;
        sseBuffer += new TextDecoder().decode(chunk.value);
        if (sseBuffer.includes(needleTxid) && sseBuffer.includes("event: receipt")) return;
      }
      throw new Error("sse_receipt_event_timeout");
    };

    const receiptAccepted = await httpJson(`http://127.0.0.1:${port}/v1/execution-receipts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txid,
        userId: "user-1",
        agentId: "agent-1",
        status: "confirmed",
        confirmations: 3,
        feeKas: 0.0001,
        confirmTsSource: "chain",
      }),
    });
    expect(receiptAccepted.res.status).toBe(200);
    expect(receiptAccepted.body.txid).toBe(txid);
    await waitForReceiptEvent(txid);

    const receiptDuplicate = await httpJson(`http://127.0.0.1:${port}/v1/execution-receipts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txid,
        userId: "user-1",
        agentId: "agent-1",
        status: "confirmed",
      }),
    });
    expect(receiptDuplicate.res.status).toBe(200);
    expect(receiptDuplicate.body.duplicate).toBe(true);

    const receiptFetch = await httpJson(`http://127.0.0.1:${port}/v1/execution-receipts?txid=${txid}`);
    expect(receiptFetch.res.status).toBe(200);
    expect(receiptFetch.body.receipt.txid).toBe(txid);

    const consistency1 = await httpJson(`http://127.0.0.1:${port}/v1/receipt-consistency`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txid,
        queueId: "q-1",
        status: "consistent",
        checkedTs: Date.now(),
        provenance: "BACKEND",
      }),
    });
    expect(consistency1.res.status).toBe(200);
    expect(consistency1.body.ok).toBe(true);

    const consistency2 = await httpJson(`http://127.0.0.1:${port}/v1/receipt-consistency`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txid,
        queueId: "q-1",
        status: "mismatch",
        mismatches: ["confirm_ts", "fee_kas"],
        checkedTs: Date.now(),
        provenance: "BACKEND",
        confirmTsDriftMs: 1800,
        feeDiffKas: 0.002,
      }),
    });
    expect(consistency2.res.status).toBe(200);
    expect(consistency2.body.ok).toBe(true);

    const summary = await httpJson(`http://127.0.0.1:${port}/v1/telemetry-summary`);
    expect(summary.res.status).toBe(200);
    expect(summary.body.ok).toBe(true);
    expect(summary.body.receipts.confirmedCount).toBeGreaterThanOrEqual(1);
    expect(summary.body.receipts.confirmationLatencyMs).toBeTruthy();
    expect(summary.body.truth.consistencyChecksTotal).toBe(2);
    expect(summary.body.truth.consistencyMismatchTotal).toBe(1);

    const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`);
    const metricsText = await metricsRes.text();
    expect(metricsText).toContain("forgeos_callback_consumer_cycle_accepted_total 2");
    expect(metricsText).toContain("forgeos_callback_consumer_cycle_duplicate_total 1");
    expect(metricsText).toContain("forgeos_callback_consumer_cycle_stale_fence_total 1");
    expect(metricsText).toContain("forgeos_callback_consumer_receipt_sse_events_total");
    expect(metricsText).toContain("forgeos_callback_consumer_receipt_consistency_checks_total 2");
    expect(metricsText).toContain("forgeos_callback_consumer_receipt_consistency_mismatch_total 1");
    expect(metricsText).toContain('forgeos_callback_consumer_receipt_consistency_mismatch_by_type_total{type="confirm_ts"} 1');
    expect(metricsText).toContain('forgeos_callback_consumer_receipt_consistency_mismatch_by_type_total{type="fee_kas"} 1');

    try { sseController.abort(); } catch {}
  }, 20_000);
});
