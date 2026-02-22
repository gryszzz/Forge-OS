import { afterEach, describe, expect, it, vi } from "vitest";
import { requestAiOverlayDecision } from "../../src/quant/runQuantEngineAiTransport";

describe("runQuantEngineAiTransport", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
    else delete (globalThis as any).fetch;
    vi.restoreAllMocks();
  });

  it("retries retryable status and returns sanitized decision", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}), text: async () => "" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ decision: { action: "ACCUMULATE", confidence_score: 0.8 } }) });
    (globalThis as any).fetch = fetchMock;

    const out = await requestAiOverlayDecision({
      agent: { name: "A" },
      kasData: { address: "kaspa:qabc", walletKas: 1, priceUsd: 0.1, dag: { networkName: "kaspa-mainnet" } },
      quantCoreDecision: { action: "HOLD", quant_metrics: {} },
      config: {
        apiUrl: "http://127.0.0.1:9999/mock-ai",
        model: "x",
        timeoutMs: 1000,
        maxAttempts: 2,
        retryableStatuses: new Set([503]),
      },
      sanitizeDecision: (raw) => ({ ...raw, _sanitized: true }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out._sanitized).toBe(true);
    expect(out.action).toBe("ACCUMULATE");
  });
});

