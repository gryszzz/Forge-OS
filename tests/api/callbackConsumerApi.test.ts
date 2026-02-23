import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("callbackConsumerApi", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.stubEnv("VITE_EXECUTION_RECEIPT_IMPORT_ENABLED", "true");
    vi.stubEnv("VITE_EXECUTION_RECEIPT_API_URL", "http://127.0.0.1:9999");
    vi.stubEnv("VITE_EXECUTION_RECEIPT_API_TOKEN", "");
    vi.stubEnv("VITE_EXECUTION_RECEIPT_API_TIMEOUT_MS", "2000");
    vi.stubEnv("VITE_EXECUTION_RECEIPT_SSE_ENABLED", "true");
    vi.stubEnv("VITE_EXECUTION_RECEIPT_SSE_URL", "");
    vi.stubEnv("VITE_EXECUTION_RECEIPT_SSE_REPLAY", "true");
    vi.stubEnv("VITE_EXECUTION_RECEIPT_SSE_REPLAY_LIMIT", "100");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns null for 404 receipt lookup", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 404, ok: false, text: async () => "" }) as any));
    const api = await import("../../src/api/callbackConsumerApi");
    const out = await api.fetchBackendExecutionReceipt("a".repeat(64));
    expect(out).toBeNull();
  });

  it("parses normalized receipt payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 200,
      ok: true,
      text: async () =>
        JSON.stringify({
          receipt: {
            txid: "B".repeat(64),
            status: "confirmed",
            confirmations: 3,
            feeKas: 0.0001,
          },
        }),
    }) as any));
    const api = await import("../../src/api/callbackConsumerApi");
    const out = await api.fetchBackendExecutionReceipt("b".repeat(64));
    expect(out?.txid).toBe("b".repeat(64));
    expect(out?.status).toBe("confirmed");
    expect(out?.confirmations).toBe(3);
    expect(out?.feeKas).toBeCloseTo(0.0001, 8);
  });

  it("handles SSE reconnect status transitions and receipt events", async () => {
    vi.stubEnv("VITE_EXECUTION_RECEIPT_API_TOKEN", "test-token");
    vi.stubEnv("VITE_EXECUTION_RECEIPT_SSE_URL", "http://127.0.0.1:7777/v1/execution-receipts/stream");
    vi.stubEnv("VITE_EXECUTION_RECEIPT_SSE_REPLAY_LIMIT", "12");

    class MockEventSource {
      static instances: MockEventSource[] = [];
      url: string;
      closed = false;
      listeners = new Map<string, Set<(ev?: any) => void>>();
      constructor(url: string) {
        this.url = url;
        MockEventSource.instances.push(this);
      }
      addEventListener(type: string, cb: (ev?: any) => void) {
        const set = this.listeners.get(type) || new Set();
        set.add(cb);
        this.listeners.set(type, set);
      }
      removeEventListener(type: string, cb: (ev?: any) => void) {
        this.listeners.get(type)?.delete(cb);
      }
      close() {
        this.closed = true;
      }
      emit(type: string, payload?: any) {
        const set = this.listeners.get(type);
        if (!set) return;
        for (const cb of set) cb(payload);
      }
    }

    vi.stubGlobal("EventSource", MockEventSource as any);
    const api = await import("../../src/api/callbackConsumerApi");

    const statuses: string[] = [];
    const receipts: any[] = [];
    const stream = api.openBackendExecutionReceiptStream({
      onStatus: (status) => statuses.push(status),
      onReceipt: (receipt) => receipts.push(receipt),
    });

    expect(stream).toBeTruthy();
    expect(typeof stream?.url).toBe("string");
    expect(stream?.url).toContain("/v1/execution-receipts/stream");
    expect(stream?.url).toContain("replay=1");
    expect(stream?.url).toContain("limit=12");
    expect(stream?.url).toContain("token=test-token");

    const source = MockEventSource.instances[0];
    expect(source).toBeTruthy();

    source.emit("error", { type: "error" });
    source.emit("open", { type: "open" });
    source.emit("receipt", { data: "{not-json" });
    source.emit("receipt", {
      data: JSON.stringify({
        receipt: {
          txid: "C".repeat(64),
          status: "confirmed",
          confirmations: 5,
          feeKas: 0.0002,
        },
      }),
    });
    source.emit("receipt", {
      data: JSON.stringify({
        txid: "D".repeat(64),
        status: "confirmed",
      }),
    });

    expect(statuses).toEqual(["connecting", "error", "open"]);
    expect(receipts).toHaveLength(2);
    expect(receipts[0]?.txid).toBe("c".repeat(64));
    expect(receipts[1]?.txid).toBe("d".repeat(64));

    stream?.close();
    expect(source.closed).toBe(true);
    expect(statuses).toEqual(["connecting", "error", "open", "closed"]);
  });

  it("posts receipt consistency metrics reports", async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, ok: true, text: async () => "" }) as any);
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("../../src/api/callbackConsumerApi");
    const ok = await api.postBackendReceiptConsistencyReport({
      txid: "e".repeat(64),
      queueId: "q-1",
      status: "mismatch",
      mismatches: ["confirm_ts", "fee_kas"],
      provenance: "BACKEND",
      truthLabel: "BACKEND CONFIRMED",
      checkedTs: Date.now(),
      confirmTsDriftMs: 1500,
      feeDiffKas: 0.001,
    });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(String(url)).toContain("/v1/receipt-consistency");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body || "{}"));
    expect(body.status).toBe("mismatch");
    expect(body.mismatches).toEqual(["confirm_ts", "fee_kas"]);
    expect(body.txid).toBe("e".repeat(64));
  });
});
