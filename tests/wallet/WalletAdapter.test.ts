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

function setWindowForgeOSBridge(opts?: {
  connectResult?: { address: string; network: string } | null;
  signResult?: string | null;
  stallConnect?: boolean;
}) {
  const listeners = new Set<(event: any) => void>();
  const connectResult =
    opts?.connectResult ??
    { address: "kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85", network: "mainnet" };
  const signResult = opts?.signResult ?? "sig_bridge_mock";
  const stallConnect = opts?.stallConnect === true;

  const windowMock: any = {
    kasware: undefined,
    kastle: undefined,
    forgeos: undefined,
    location: { href: "" },
    prompt: vi.fn(),
    localStorage: {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    addEventListener: vi.fn((type: string, fn: (event: any) => void) => {
      if (type === "message") listeners.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: (event: any) => void) => {
      if (type === "message") listeners.delete(fn);
    }),
    dispatchEvent: vi.fn(),
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  };

  windowMock.postMessage = vi.fn((payload: any) => {
    if (!payload?.__forgeos__) return;
    const requestId = payload.requestId;
    const respond = (response: Record<string, unknown>) => {
      const event = { source: windowMock, data: response };
      listeners.forEach((fn) => fn(event));
    };

    if (payload.type === "FORGEOS_BRIDGE_PING") {
      respond({
        __forgeos__: true,
        type: "FORGEOS_BRIDGE_PONG",
        requestId,
        result: { bridgeReady: true },
      });
      return;
    }

    if (payload.type === "FORGEOS_CONNECT") {
      if (stallConnect) return;
      respond({
        __forgeos__: true,
        type: "FORGEOS_CONNECT_RESULT",
        requestId,
        result: connectResult,
      });
      return;
    }

    if (payload.type === "FORGEOS_SIGN") {
      respond({
        __forgeos__: true,
        type: "FORGEOS_SIGN_RESULT",
        requestId,
        result: signResult,
      });
    }
  });

  (globalThis as any).window = windowMock;
  return windowMock;
}

function setWindowForgeOSNoBridge(opts?: { managedWalletJson?: string | null; providerInjected?: boolean }) {
  const listeners = new Set<(event: any) => void>();
  const managedWalletJson = opts?.managedWalletJson ?? null;
  const providerInjected = opts?.providerInjected === true;

  const windowMock: any = {
    kasware: undefined,
    kastle: undefined,
    forgeos: providerInjected ? { isForgeOS: true, connect: vi.fn(), signMessage: vi.fn() } : undefined,
    location: { href: "" },
    prompt: vi.fn(),
    localStorage: {
      getItem: vi.fn().mockImplementation((key: string) => {
        if (key === "forgeos.managed.wallet.v1") return managedWalletJson;
        return null;
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    addEventListener: vi.fn((type: string, fn: (event: any) => void) => {
      if (type === "message") listeners.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: (event: any) => void) => {
      if (type === "message") listeners.delete(fn);
    }),
    dispatchEvent: vi.fn(),
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    postMessage: vi.fn(),
  };

  (globalThis as any).window = windowMock;
  return windowMock;
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

  it('connectForgeOS uses site bridge fallback when injected provider is unavailable', async () => {
    const windowMock = setWindowForgeOSBridge();
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    const session = await WalletAdapter.connectForgeOS();
    expect(session.provider).toBe('forgeos');
    expect(session.network).toBe('mainnet');
    expect(session.address).toMatch(/^kaspa:/);
    expect(windowMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ __forgeos__: true, type: 'FORGEOS_BRIDGE_PING' }),
      '*'
    );
    expect(windowMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ __forgeos__: true, type: 'FORGEOS_CONNECT' }),
      '*'
    );
  });

  it('connectForgeOS coalesces concurrent connect requests to a single bridge connect', async () => {
    const windowMock = setWindowForgeOSBridge();
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    const [a, b] = await Promise.all([WalletAdapter.connectForgeOS(), WalletAdapter.connectForgeOS()]);
    expect(a.address).toBe(b.address);
    expect(a.network).toBe('mainnet');

    const connectCalls = (windowMock.postMessage as any).mock.calls.filter(
      (args: any[]) => args?.[0]?.__forgeos__ === true && args?.[0]?.type === 'FORGEOS_CONNECT'
    );
    expect(connectCalls.length).toBe(1);
  });

  it('connectForgeOS fails fast with unlock guidance when bridge connect stalls', async () => {
    vi.stubEnv('VITE_FORGEOS_CONNECT_TIMEOUT_MS', '300');
    setWindowForgeOSBridge({ stallConnect: true });
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    await expect(WalletAdapter.connectForgeOS()).rejects.toThrow(/unlock your wallet/i);
  });

  it('connectForgeOS enforces strict extension-auth policy when configured', async () => {
    vi.stubEnv('VITE_FORGEOS_STRICT_EXTENSION_AUTH_CONNECT', 'true');
    setWindowForgeOSNoBridge({
      managedWalletJson: JSON.stringify({
        phrase: 'word '.repeat(12).trim(),
        address: 'kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85',
        network: 'mainnet',
      }),
      providerInjected: true,
    });
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    await expect(WalletAdapter.connectForgeOS()).rejects.toThrow(/extension-auth connect is required/i);
  });

  it('connectForgeOS allows managed fallback when strict extension-auth policy is disabled', async () => {
    vi.stubEnv('VITE_FORGEOS_STRICT_EXTENSION_AUTH_CONNECT', 'false');
    setWindowForgeOSNoBridge({
      managedWalletJson: JSON.stringify({
        phrase: 'word '.repeat(12).trim(),
        address: 'kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85',
        network: 'mainnet',
      }),
      providerInjected: true,
    });
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    const session = await WalletAdapter.connectForgeOS();
    expect(session.provider).toBe('forgeos');
    expect(session.network).toBe('mainnet');
    expect(session.address).toMatch(/^kaspa:/);
  });

  it('signMessageForgeOS uses site bridge fallback when injected provider is unavailable', async () => {
    const windowMock = setWindowForgeOSBridge({ signResult: 'bridge_signature_123' });
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    const signature = await WalletAdapter.signMessageForgeOS('hello kaspa');
    expect(signature).toBe('bridge_signature_123');
    expect(windowMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ __forgeos__: true, type: 'FORGEOS_SIGN', message: 'hello kaspa' }),
      '*'
    );
  });

  it('probeForgeOSBridgeStatus reports bridge reachability for content-script transport', async () => {
    setWindowForgeOSBridge();
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    const status = await WalletAdapter.probeForgeOSBridgeStatus(400);
    expect(status.providerInjected).toBe(false);
    expect(status.bridgeReachable).toBe(true);
    expect(status.managedWalletPresent).toBe(false);
    expect(status.transport).toBe('bridge');
  });

  it('probeForgeOSBridgeStatus reports managed fallback when provider and bridge are unavailable', async () => {
    setWindowForgeOSNoBridge({
      managedWalletJson: JSON.stringify({
        phrase: 'word '.repeat(12).trim(),
        address: 'kaspa:qpv7fcvdlz6th4hqjtm9qkkms2dw0raem963x3hm8glu3kjgj7922vy69hv85',
        network: 'mainnet',
      }),
      providerInjected: false,
    });
    const { WalletAdapter } = await import('../../src/wallet/WalletAdapter');
    const status = await WalletAdapter.probeForgeOSBridgeStatus(300);
    expect(status.providerInjected).toBe(false);
    expect(status.bridgeReachable).toBe(false);
    expect(status.managedWalletPresent).toBe(true);
    expect(status.transport).toBe('managed');
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
