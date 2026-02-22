import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function setWindowKasware(kasware: any) {
  (globalThis as any).window = {
    kasware,
    kastle: undefined,
    location: { href: '' },
    prompt: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
}

function setWindowKastle(kastle: any) {
  (globalThis as any).window = {
    kasware: undefined,
    kastle,
    location: { href: '' },
    prompt: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
}

function setWindowGhostBridge(opts?: {
  accountAddress?: string;
  networkId?: string;
  txid?: string;
  rejectTransact?: boolean;
  transactPayload?: any;
}) {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const add = (type: string, fn: any) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
  };
  const remove = (type: string, fn: any) => {
    listeners.get(type)?.delete(fn);
  };
  const emit = (type: string, detail?: any) => {
    const fns = listeners.get(type);
    if (!fns) return;
    for (const fn of [...fns]) fn({ type, detail });
  };
  const txid = opts?.txid || "e".repeat(64);
  const accountAddress = opts?.accountAddress || "kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85";
  const networkId = opts?.networkId || "mainnet";
  class MockCustomEvent {
    type: string;
    detail: any;
    constructor(type: string, init?: any) {
      this.type = type;
      this.detail = init?.detail;
    }
  }
  (globalThis as any).CustomEvent = MockCustomEvent as any;
  (globalThis as any).window = {
    kasware: undefined,
    kastle: undefined,
    location: { href: "" },
    prompt: vi.fn(),
    addEventListener: vi.fn((type: string, fn: any) => add(type, fn)),
    removeEventListener: vi.fn((type: string, fn: any) => remove(type, fn)),
    dispatchEvent: vi.fn((event: any) => {
      const type = String(event?.type || "");
      if (type === "kaspa:requestProviders") {
        emit("kaspa:provider", { id: "ghost", name: "Ghost Wallet" });
        return true;
      }
      if (type === "kaspa:invoke") {
        const req = event?.detail || {};
        if (req.method === "account") {
          emit("kaspa:event", { id: req.id, data: { addresses: [accountAddress], networkId } });
          return true;
        }
        if (req.method === "transact") {
          if (opts?.rejectTransact) {
            emit("kaspa:event", { id: req.id, data: false });
            return true;
          }
          emit("kaspa:event", { id: req.id, data: opts?.transactPayload ?? { txid } });
          return true;
        }
      }
      return true;
    }),
  };
}

describe('WalletAdapter', () => {
  const originalEnv = { ...(import.meta as any).env };
  const originalFetch = (globalThis as any).fetch;
  const originalCustomEvent = (globalThis as any).CustomEvent;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as any).window;
    vi.unstubAllEnvs();
    (import.meta as any).env = { ...originalEnv };
    if (originalFetch) (globalThis as any).fetch = originalFetch;
    else delete (globalThis as any).fetch;
    if (typeof originalCustomEvent !== "undefined") (globalThis as any).CustomEvent = originalCustomEvent;
    else delete (globalThis as any).CustomEvent;
  });

  it('connects kasware when requestAccounts and getNetwork succeed', async () => {
    setWindowKasware({
      requestAccounts: vi.fn().mockResolvedValue(['kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85']),
      getNetwork: vi.fn().mockResolvedValue('mainnet'),
    });
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    const session = await WalletAdapter.connectKasware();
    expect(session.provider).toBe('kasware');
    expect(session.network).toBe('mainnet');
    expect(session.address).toMatch(/^kaspa:/);
  });

  it('falls back when getNetwork fails but address matches active profile', async () => {
    setWindowKasware({
      requestAccounts: vi.fn().mockResolvedValue(['kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85']),
      getNetwork: vi.fn().mockRejectedValue(new Error('provider flaked')),
    });
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    const session = await WalletAdapter.connectKasware();
    expect(session.network).toBe('mainnet');
  });

  it('normalizes user rejection on sendKasware', async () => {
    setWindowKasware({
      sendKaspa: vi.fn().mockRejectedValue(new Error('User rejected request')),
    });
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    await expect(
      WalletAdapter.sendKasware('kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85', 1)
    ).rejects.toThrow(/User rejected wallet request/);
  });

  it('normalizes kasware timeout errors on send', async () => {
    setWindowKasware({
      sendKaspa: vi.fn().mockRejectedValue(new Error('kasware_send_kaspa_timeout_45000ms')),
    });
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    await expect(
      WalletAdapter.sendKasware('kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85', 1)
    ).rejects.toThrow(/timed out/i);
  });

  it('connects kastle when connect/getAccount/request succeed', async () => {
    setWindowKastle({
      connect: vi.fn().mockResolvedValue(true),
      getAccount: vi.fn().mockResolvedValue({
        address: 'kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85',
        publicKey: '02abc',
      }),
      request: vi.fn().mockImplementation((method: string) => {
        if (method === 'kas:get_network') return Promise.resolve('mainnet');
        return Promise.resolve(null);
      }),
    });
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    const session = await WalletAdapter.connectKastle();
    expect(session.provider).toBe('kastle');
    expect(session.network).toBe('mainnet');
    expect(session.address).toMatch(/^kaspa:/);
  });

  it('builds kastle raw multi-output tx via backend tx-builder endpoint when configured', async () => {
    vi.stubEnv('VITE_KASTLE_RAW_TX_ENABLED', 'true');
    vi.stubEnv('VITE_KASTLE_RAW_TX_MANUAL_JSON_PROMPT_ENABLED', 'false');
    vi.stubEnv('VITE_KASTLE_TX_BUILDER_URL', 'http://127.0.0.1:9999/v1/kastle/build-tx-json');
    vi.stubEnv('VITE_KASTLE_TX_BUILDER_TIMEOUT_MS', '5000');
    const signAndBroadcastTx = vi.fn().mockResolvedValue('d'.repeat(64));
    setWindowKastle({
      connect: vi.fn().mockResolvedValue(true),
      getAccount: vi.fn().mockResolvedValue({
        address: 'kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85',
        publicKey: '02abc',
      }),
      request: vi.fn().mockImplementation((method: string) => {
        if (method === 'kas:get_network') return Promise.resolve('mainnet');
        return Promise.resolve(null);
      }),
      signAndBroadcastTx,
    });
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ txJson: '{"mock":"txjson"}' }),
    });
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    const txid = await WalletAdapter.sendKastleRawTx([
      { to: 'kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85', amount_kas: 1.0 },
      { to: 'kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85', amount_kas: 0.06 },
    ], 'combined treasury');
    expect(txid).toBe('d'.repeat(64));
    expect((globalThis as any).fetch).toHaveBeenCalledOnce();
    expect(signAndBroadcastTx).toHaveBeenCalledWith('mainnet', '{"mock":"txjson"}');
  });

  it('fails kastle send when provider payload does not contain a txid', async () => {
    setWindowKastle({
      sendKaspa: vi.fn().mockResolvedValue({ ok: true }),
    });
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    await expect(
      WalletAdapter.sendKastle('kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85', 0.25)
    ).rejects.toThrow(/did not return a transaction id/i);
  });

  it('reuses cached kastle account address for tx-builder backend after connect', async () => {
    vi.stubEnv('VITE_KASTLE_RAW_TX_ENABLED', 'true');
    vi.stubEnv('VITE_KASTLE_RAW_TX_MANUAL_JSON_PROMPT_ENABLED', 'false');
    vi.stubEnv('VITE_KASTLE_TX_BUILDER_URL', 'http://127.0.0.1:9999/v1/kastle/build-tx-json');
    const getAccount = vi.fn().mockResolvedValue({
      address: 'kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85',
      publicKey: '02abc',
    });
    setWindowKastle({
      connect: vi.fn().mockResolvedValue(true),
      getAccount,
      request: vi.fn().mockImplementation((method: string) => {
        if (method === 'kas:get_network') return Promise.resolve('mainnet');
        return Promise.resolve(null);
      }),
      signAndBroadcastTx: vi.fn().mockResolvedValue('f'.repeat(64)),
    });
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ txJson: '{"mock":"txjson"}' }),
    });
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    await WalletAdapter.connectKastle();
    await WalletAdapter.sendKastleRawTx([
      { to: 'kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85', amount_kas: 1.0 },
      { to: 'kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85', amount_kas: 0.05 },
    ]);
    expect(getAccount).toHaveBeenCalledTimes(1);
  });

  it('connects and sends with ghost wallet bridge', async () => {
    setWindowGhostBridge();
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    const session = await WalletAdapter.connectGhost();
    expect(session.provider).toBe('ghost');
    expect(session.address).toMatch(/^kaspa:/);
    const txid = await WalletAdapter.sendGhostOutputs([
      { to: 'kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85', amount_kas: 1 },
      { to: 'kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85', amount_kas: 0.1 },
    ]);
    expect(txid).toBe('e'.repeat(64));
  });

  it('normalizes ghost wallet rejection on transact', async () => {
    setWindowGhostBridge({ rejectTransact: true });
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    await WalletAdapter.connectGhost();
    await expect(
      WalletAdapter.sendGhost('kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85', 0.5)
    ).rejects.toThrow(/User rejected wallet request/i);
  });

  it('prompts for ghost txid when payload is non-standard and accepts manual txid', async () => {
    setWindowGhostBridge({ transactPayload: { result: { raw: 'serialized-tx-payload' } } });
    (globalThis as any).window.prompt = vi.fn().mockReturnValue('c'.repeat(64));
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    await WalletAdapter.connectGhost();
    const txid = await WalletAdapter.sendGhost('kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85', 0.75);
    expect(txid).toBe('c'.repeat(64));
    expect((globalThis as any).window.prompt).toHaveBeenCalled();
  });

  it('opens kaspium deep-link and accepts manual txid', async () => {
    const prompt = vi.fn().mockReturnValue('a'.repeat(64));
    (globalThis as any).window = {
      kasware: undefined,
      kastle: undefined,
      location: { href: '' },
      prompt,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    const txid = await WalletAdapter.sendKaspium(
      'kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85',
      0.5,
      'test'
    );
    expect(txid).toBe('a'.repeat(64));
    expect((globalThis as any).window.location.href).toMatch(/kaspium:\/\/send|kaspa:/);
    expect(decodeURIComponent((globalThis as any).window.location.href)).toContain('kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85');
    expect(prompt).toHaveBeenCalled();
  });

  it('rejects invalid kaspium manual txid format', async () => {
    const prompt = vi.fn().mockReturnValue('badtxid');
    (globalThis as any).window = {
      kasware: undefined,
      kastle: undefined,
      location: { href: '' },
      prompt,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    await expect(
      WalletAdapter.sendKaspium('kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85', 0.5)
    ).rejects.toThrow(/Invalid txid format/i);
  });

  it('supports hardware bridge manual txid flow', async () => {
    const prompt = vi.fn().mockReturnValue('b'.repeat(64));
    (globalThis as any).window = {
      prompt,
      location: { href: '' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    const txid = await WalletAdapter.sendHardwareBridge(
      'tangem',
      'kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85',
      0.25,
      'hardware test'
    );
    expect(txid).toBe('b'.repeat(64));
    expect(prompt).toHaveBeenCalled();
  });

  it('rejects invalid hardware bridge txid format', async () => {
    const prompt = vi.fn().mockReturnValue('not-a-txid');
    (globalThis as any).window = {
      prompt,
      location: { href: '' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    await expect(
      WalletAdapter.sendHardwareBridge(
        'onekey',
        'kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85',
        0.25
      )
    ).rejects.toThrow(/Invalid txid format/i);
  });
});
