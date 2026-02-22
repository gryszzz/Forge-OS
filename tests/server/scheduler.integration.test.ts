import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePort, httpJson, spawnNodeProcess, startJsonServer, stopProcess, waitFor, waitForHttp } from "./helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

describe("scheduler integration (callback retry / idempotency lease recovery)", () => {
  const children: Array<ReturnType<typeof spawnNodeProcess>> = [];
  const servers: Array<{ close: () => void }> = [];

  afterEach(async () => {
    await Promise.all(children.map((c) => stopProcess(c.child)));
    children.length = 0;
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            try {
              s.close(() => resolve());
            } catch {
              resolve();
            }
          })
      )
    );
    servers.length = 0;
  });

  it("retries a failed callback on the next cycle without dedupe suppression", async () => {
    const kasPort = await getFreePort();
    const callbackPort = await getFreePort();
    const schedulerPort = await getFreePort();

    const kasServer = await startJsonServer(kasPort, async (req, _body, url) => {
      if (req.method === "GET" && url.pathname === "/info/price") return { body: { price: 0.12 } };
      if (req.method === "GET" && url.pathname === "/info/blockdag") {
        return { body: { networkName: "kaspa-mainnet", headerCount: 123, blockCount: 123, daaScore: 123 } };
      }
      if (req.method === "GET" && /\/addresses\/.+\/balance$/.test(url.pathname)) return { body: { balance: 100000000 } };
      return { status: 404, body: { error: "not_found" } };
    });
    servers.push(kasServer as any);

    const callbackCalls: any[] = [];
    let callbackAttempt = 0;
    const callbackServer = await startJsonServer(callbackPort, async (req, body) => {
      callbackAttempt += 1;
      callbackCalls.push({
        attempt: callbackAttempt,
        headers: req.headers,
        body,
      });
      if (callbackAttempt === 1) {
        return { status: 500, body: { error: "fail_once" } };
      }
      return { status: 200, body: { ok: true } };
    });
    servers.push(callbackServer as any);

    const sched = spawnNodeProcess(["server/scheduler/index.mjs"], {
      cwd: repoRoot,
      env: {
        PORT: String(schedulerPort),
        HOST: "127.0.0.1",
        KAS_API_BASE: `http://127.0.0.1:${kasPort}`,
        SCHEDULER_TICK_MS: "60000",
        SCHEDULER_REDIS_AUTHORITATIVE_QUEUE: "false",
        SCHEDULER_CALLBACK_TIMEOUT_MS: "1000",
      },
    });
    children.push(sched);
    await waitForHttp(`http://127.0.0.1:${schedulerPort}/health`);

    const register = await httpJson(`http://127.0.0.1:${schedulerPort}/v1/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-int",
        id: "agent-int",
        walletAddress: "kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85",
        callbackUrl: `http://127.0.0.1:${callbackPort}/callback`,
        cycleIntervalMs: 1000,
      }),
    });
    expect(register.res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 1100));
    const tick1 = await httpJson(`http://127.0.0.1:${schedulerPort}/v1/scheduler/tick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(tick1.res.status).toBe(200);

    await waitFor(async () => {
      const agents = await httpJson(`http://127.0.0.1:${schedulerPort}/v1/agents`);
      const agent = Array.isArray(agents.body?.agents) ? agents.body.agents.find((a: any) => a.id === "agent-int") : null;
      return Boolean(agent?.failureCount >= 1 && agent?.lastDispatch?.ok === false && callbackCalls.length >= 1);
    }, 10_000, 150);

    const firstHeaders = callbackCalls[0]?.headers || {};
    const firstIdempotency = String(firstHeaders["x-forgeos-idempotency-key"] || "");
    expect(firstIdempotency.length).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 1100));
    const tick2 = await httpJson(`http://127.0.0.1:${schedulerPort}/v1/scheduler/tick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(tick2.res.status).toBe(200);

    await waitFor(async () => {
      const agents = await httpJson(`http://127.0.0.1:${schedulerPort}/v1/agents`);
      const agent = Array.isArray(agents.body?.agents) ? agents.body.agents.find((a: any) => a.id === "agent-int") : null;
      return Boolean(agent?.lastDispatch?.ok === true && callbackCalls.length >= 2);
    }, 10_000, 150);

    expect(callbackCalls.length).toBeGreaterThanOrEqual(2);
    const metricsText = await fetch(`http://127.0.0.1:${schedulerPort}/metrics`).then((r) => r.text());
    expect(metricsText).toMatch(/forgeos_scheduler_callback_error_total\s+1/);
    expect(metricsText).toMatch(/forgeos_scheduler_callback_success_total\s+1/);
    expect(metricsText).toMatch(/forgeos_scheduler_callback_dedupe_skipped_total\s+0/);

    const telemetrySummary = await httpJson(`http://127.0.0.1:${schedulerPort}/v1/telemetry-summary`);
    expect(telemetrySummary.res.status).toBe(200);
    expect(telemetrySummary.body.ok).toBe(true);
    expect(telemetrySummary.body.scheduler.queueCapacity).toBeGreaterThan(0);
    expect(telemetrySummary.body.callbacks).toHaveProperty("latencyP95BucketMs");
  }, 30_000);
});
