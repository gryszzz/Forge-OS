import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePort, httpJson, spawnNodeProcess, startJsonServer, stopProcess, waitForHttp } from "./helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

describe("tx-builder integration (command mode)", () => {
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

  it("builds Kastle txJson through the bundled http-bridge command", async () => {
    const upstreamPort = await getFreePort();
    const txBuilderPort = await getFreePort();

    const upstreamCalls: any[] = [];
    const upstream = await startJsonServer(upstreamPort, async (_req, body, url) => {
      if (url.pathname !== "/v1/build") return { status: 404, body: { error: "not_found" } };
      upstreamCalls.push(body);
      return { body: { txJson: '{"mock":"txjson","outputs":2}' } };
    });
    servers.push(upstream as any);

    const proc = spawnNodeProcess(["server/tx-builder/index.mjs"], {
      cwd: repoRoot,
      env: {
        PORT: String(txBuilderPort),
        HOST: "127.0.0.1",
        TX_BUILDER_COMMAND: "node server/tx-builder/commands/kastle-http-bridge-command.mjs",
        KASTLE_TX_BUILDER_COMMAND_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}/v1/build`,
      },
    });
    children.push(proc);
    await waitForHttp(`http://127.0.0.1:${txBuilderPort}/health`);

    const build = await httpJson(`http://127.0.0.1:${txBuilderPort}/v1/kastle/build-tx-json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: "kastle",
        networkId: "mainnet",
        fromAddress: "kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85",
        outputs: [
          { address: "kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85", amountKas: 1.0 },
          { address: "kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85", amountKas: 0.06 },
        ],
        purpose: "combined treasury",
      }),
    });

    expect(build.res.status).toBe(200);
    expect(build.body.txJson).toContain('"mock":"txjson"');
    expect(build.body.meta.mode).toBe("command");
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0].outputs).toHaveLength(2);
  }, 20_000);

  it("builds Kastle txJson locally with kaspa-wasm using mocked Kaspa UTXOs", async () => {
    const kasApiPort = await getFreePort();
    const txBuilderPort = await getFreePort();
    const sourceAddress = "kaspa:qqkqkzjvr7zwxxmjxjkmxxdwju9kjs6e9u82uh59z07vgaks6gg62v8707g73";
    const treasuryAddress = "kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85";

    const kasApi = await startJsonServer(kasApiPort, async (req, _body, url) => {
      if (req.method === "GET" && url.pathname === `/addresses/${encodeURIComponent(sourceAddress)}/utxos`) {
        return {
          body: [
            {
              address: sourceAddress,
              outpoint: {
                transactionId: "e7853df278ddbd2b9ec567ea9ea17722e70ef8df284425d8a44d4f0e998757de",
                index: 0,
              },
              utxoEntry: {
                amount: "1999997931",
                scriptPublicKey: {
                  scriptPublicKey: "202c0b0a4c1f84e31b7234adb319ae970b6943592f0eae5e8513fcc476d0d211a5ac",
                },
                blockDaaScore: "33922603",
                isCoinbase: false,
              },
            },
          ],
        };
      }
      return { status: 404, body: { error: "not_found" } };
    });
    servers.push(kasApi as any);

    const proc = spawnNodeProcess(["server/tx-builder/index.mjs"], {
      cwd: repoRoot,
      env: {
        PORT: String(txBuilderPort),
        HOST: "127.0.0.1",
        TX_BUILDER_LOCAL_WASM_ENABLED: "true",
        TX_BUILDER_KAS_API_MAINNET: `http://127.0.0.1:${kasApiPort}`,
      },
    });
    children.push(proc);
    await waitForHttp(`http://127.0.0.1:${txBuilderPort}/health`);

    const build = await httpJson(`http://127.0.0.1:${txBuilderPort}/v1/kastle/build-tx-json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: "kastle",
        networkId: "mainnet",
        fromAddress: sourceAddress,
        outputs: [
          { address: sourceAddress, amountKas: 1.0 },
          { address: treasuryAddress, amountKas: 0.06 },
        ],
        purpose: "forgeos local wasm combined treasury test",
      }),
    });

    expect(build.res.status).toBe(200);
    expect(build.body.meta.mode).toBe("local_wasm");
    expect(build.body.meta.outputs).toBe(2);
    expect(typeof build.body.txJson).toBe("string");
    const parsed = JSON.parse(build.body.txJson);
    expect(Array.isArray(parsed.outputs)).toBe(true);
    expect(parsed.outputs.length).toBeGreaterThanOrEqual(2);

    const metricsText = await fetch(`http://127.0.0.1:${txBuilderPort}/metrics`).then((r) => r.text());
    expect(metricsText).toMatch(/forgeos_tx_builder_local_wasm_requests_total\s+1/);
  }, 30_000);

  it("feeds adaptive local policy with live telemetry summary from callback-consumer and scheduler endpoints", async () => {
    const kasApiPort = await getFreePort();
    const callbackSummaryPort = await getFreePort();
    const schedulerSummaryPort = await getFreePort();
    const txBuilderPort = await getFreePort();
    const sourceAddress = "kaspa:qqkqkzjvr7zwxxmjxjkmxxdwju9kjs6e9u82uh59z07vgaks6gg62v8707g73";
    const treasuryAddress = "kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85";

    const kasApi = await startJsonServer(kasApiPort, async (req, _body, url) => {
      if (req.method === "GET" && url.pathname === `/addresses/${encodeURIComponent(sourceAddress)}/utxos`) {
        return {
          body: [
            {
              address: sourceAddress,
              outpoint: {
                transactionId: "e7853df278ddbd2b9ec567ea9ea17722e70ef8df284425d8a44d4f0e998757de",
                index: 0,
              },
              utxoEntry: {
                amount: "1999997931",
                scriptPublicKey: {
                  scriptPublicKey: "202c0b0a4c1f84e31b7234adb319ae970b6943592f0eae5e8513fcc476d0d211a5ac",
                },
                blockDaaScore: "33922603",
                isCoinbase: false,
              },
            },
          ],
        };
      }
      return { status: 404, body: { error: "not_found" } };
    });
    servers.push(kasApi as any);

    const callbackSummary = await startJsonServer(callbackSummaryPort, async (_req, _body, url) => {
      if (url.pathname !== "/v1/telemetry-summary") return { status: 404, body: { error: "not_found" } };
      return {
        body: {
          ok: true,
          receipts: {
            confirmationLatencyMs: { p95: 33000, samples: 10 },
            receiptLagMs: { p95: 2400, samples: 10 },
          },
        },
      };
    });
    servers.push(callbackSummary as any);

    const schedulerSummary = await startJsonServer(schedulerSummaryPort, async (_req, _body, url) => {
      if (url.pathname !== "/v1/telemetry-summary") return { status: 404, body: { error: "not_found" } };
      return {
        body: {
          ok: true,
          scheduler: { saturationProxyPct: 82 },
          callbacks: { latencyP95BucketMs: 500 },
        },
      };
    });
    servers.push(schedulerSummary as any);

    const proc = spawnNodeProcess(["server/tx-builder/index.mjs"], {
      cwd: repoRoot,
      env: {
        PORT: String(txBuilderPort),
        HOST: "127.0.0.1",
        TX_BUILDER_LOCAL_WASM_ENABLED: "true",
        TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_MODE: "adaptive",
        TX_BUILDER_KAS_API_MAINNET: `http://127.0.0.1:${kasApiPort}`,
        TX_BUILDER_CALLBACK_CONSUMER_SUMMARY_URL: `http://127.0.0.1:${callbackSummaryPort}/v1/telemetry-summary`,
        TX_BUILDER_SCHEDULER_SUMMARY_URL: `http://127.0.0.1:${schedulerSummaryPort}/v1/telemetry-summary`,
        TX_BUILDER_TELEMETRY_SUMMARY_TTL_MS: "60000",
      },
    });
    children.push(proc);
    await waitForHttp(`http://127.0.0.1:${txBuilderPort}/health`);

    const build = await httpJson(`http://127.0.0.1:${txBuilderPort}/v1/kastle/build-tx-json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: "kastle",
        networkId: "mainnet",
        fromAddress: sourceAddress,
        outputs: [
          { address: sourceAddress, amountKas: 1.0 },
          { address: treasuryAddress, amountKas: 0.06 },
        ],
        purpose: "telemetry-fed adaptive fee test",
      }),
    });

    expect(build.res.status).toBe(200);
    expect(build.body.meta.mode).toBe("local_wasm");
    expect(build.body.meta.policy.priorityFeeMode).toBe("adaptive");
    expect(build.body.meta.policy.telemetry.observedConfirmP95Ms).toBe(33000);
    expect(build.body.meta.policy.telemetry.daaCongestionPct).toBe(82);
    expect(build.body.meta.policy.telemetry.receiptLagP95Ms).toBe(2400);

    const metricsText = await fetch(`http://127.0.0.1:${txBuilderPort}/metrics`).then((r) => r.text());
    expect(metricsText).toMatch(/forgeos_tx_builder_telemetry_summary_fetch_total\s+2/);
    expect(metricsText).toMatch(/forgeos_tx_builder_telemetry_summary_callback_confirm_p95_ms\s+33000/);
    expect(metricsText).toMatch(/forgeos_tx_builder_telemetry_summary_scheduler_saturation_proxy_pct\s+82/);
  }, 30_000);
});
