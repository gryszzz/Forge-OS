import { useEffect, useState, useCallback } from "react";
import { C, mono } from "../../src/tokens";
import { shortAddr, withKaspaAddressNetwork } from "../../src/helpers";
import { fetchKasBalance, fetchKasUsdPrice } from "../shared/api";
import {
  getWalletMeta,
  getNetwork,
  setNetwork as saveNetwork,
  getAutoLockMinutes,
  setAutoLockMinutes as saveAutoLockMinutes,
  getPersistUnlockSession,
  setPersistUnlockSession,
  getHidePortfolioBalances,
  setHidePortfolioBalances,
  setWalletMeta,
} from "../shared/storage";
import {
  vaultExists,
  lockWallet,
  getSession,
  extendSession,
  restoreSessionFromCache,
  setSessionPersistence,
} from "../vault/vault";
import { fetchDagInfo, getKaspaEndpointHealth, NETWORK_BPS } from "../network/kaspaClient";
import type { UnlockedSession } from "../vault/types";
import { signMessage as signManagedMessage } from "../../src/wallet/KaspaWalletManager";
import { WalletTab } from "../tabs/WalletTab";
import { AgentsTab } from "../tabs/AgentsTab";
import { SecurityTab } from "../tabs/SecurityTab";
import { SwapTab } from "../tabs/SwapTab";
import { LockScreen } from "./screens/LockScreen";
import { FirstRunScreen } from "./screens/FirstRunScreen";
import { ConnectApprovalScreen } from "./screens/ConnectApprovalScreen";
import { SignApprovalScreen } from "./screens/SignApprovalScreen";
import { EXTENSION_POPUP_BASE_MIN_HEIGHT, EXTENSION_POPUP_BASE_WIDTH, EXTENSION_POPUP_UI_SCALE } from "./layout";
import { outlineButton, popupShellBackground } from "./surfaces";
import {
  formatFiatFromUsd,
  type DisplayCurrency,
} from "../shared/fiat";

type Tab = "wallet" | "swap" | "agents" | "security";

// ── Screen state ─────────────────────────────────────────────────────────────
type Screen =
  | { type: "loading" }
  | { type: "first_run" }
  | { type: "locked" }
  | { type: "unlocked" };

const PENDING_CONNECT_KEY = "forgeos.connect.pending";
const PENDING_SIGN_KEY = "forgeos.sign.pending";

type PendingConnectRequest = {
  requestId: string;
  tabId: number;
  origin?: string;
};

type PendingSignRequest = {
  requestId: string;
  tabId: number;
  origin?: string;
  message: string;
};

export function Popup() {
  const [screen, setScreen] = useState<Screen>({ type: "loading" });
  const [session, setSession] = useState<UnlockedSession | null>(null);
  const [network, setNetwork] = useState("mainnet");
  const [balance, setBalance] = useState<number | null>(null);
  const [usdPrice, setUsdPrice] = useState(0);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<Tab>("wallet");
  const [walletMode, setWalletMode] = useState<"send" | "receive" | undefined>();
  const [autoLockMinutes, setAutoLockMinutes] = useState(15);
  const [persistUnlockSessionEnabled, setPersistUnlockSessionEnabled] = useState(false);
  const [hidePortfolioBalances, setHidePortfolioBalancesState] = useState(false);
  const [pendingConnect, setPendingConnect] = useState<PendingConnectRequest | null>(null);
  const [pendingSign, setPendingSign] = useState<PendingSignRequest | null>(null);
  const [signingSiteRequest, setSigningSiteRequest] = useState(false);
  const [siteSignError, setSiteSignError] = useState<string | null>(null);
  const [lockedAddress, setLockedAddress] = useState<string | null>(null);
  const [dagScore, setDagScore] = useState<string | null>(null);
  const [activeRpcEndpoint, setActiveRpcEndpoint] = useState<string | null>(null);
  const [balanceUpdatedAt, setBalanceUpdatedAt] = useState<number | null>(null);
  const [priceUpdatedAt, setPriceUpdatedAt] = useState<number | null>(null);
  const [dagUpdatedAt, setDagUpdatedAt] = useState<number | null>(null);
  const [feedStatusMessage, setFeedStatusMessage] = useState<string | null>(null);

  const NETWORKS = ["mainnet", "testnet-10", "testnet-11", "testnet-12"] as const;
  const NETWORK_LABELS: Record<string, string> = {
    mainnet: "MAINNET",
    "testnet-10": "TN10",
    "testnet-11": "TN11",
    "testnet-12": "TN12",
  };
  const BALANCE_FEED_STALE_MS = 45_000;
  const PRICE_FEED_STALE_MS = 45_000;
  const DAG_FEED_STALE_MS = 60_000;

  // ── Initialise ──────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const [exists, net, lockMins, persistUnlock, hideBalances] = await Promise.all([
          vaultExists(),
          getNetwork(),
          getAutoLockMinutes(),
          getPersistUnlockSession(),
          getHidePortfolioBalances(),
        ]);
        setNetwork(net);
        setAutoLockMinutes(lockMins);
        setPersistUnlockSessionEnabled(persistUnlock === true);
        setHidePortfolioBalancesState(hideBalances === true);

        if (!exists) {
          // No vault — check for legacy address-only metadata from content bridge
          const meta = await getWalletMeta();
          if (meta?.address) {
            // External wallet (Kasware/Kastle user) — no vault, show balance only
            setSession({ mnemonic: "", address: meta.address, network: net, autoLockAt: Infinity });
            fetchBalances(meta.address, net);
            setScreen({ type: "unlocked" });
          } else {
            setScreen({ type: "first_run" });
          }
          return;
        }

        // Vault exists — check if session is still active (popup reopened within TTL)
        const existing = getSession() ?? await restoreSessionFromCache();
        if (existing) {
          setSession(existing);
          fetchBalances(existing.address, net);
          setScreen({ type: "unlocked" });
        } else {
          // Show the wallet address on the lock screen so the user knows whose account they're signing into
          const meta = await getWalletMeta();
          setLockedAddress(meta?.address ?? null);
          setScreen({ type: "locked" });
        }
      } catch {
        // If init fails for any reason, fall through to first_run so the popup
        // is never stuck on the black loading screen.
        setScreen({ type: "first_run" });
      }
    })();
  }, []);

  // ── Pending site approval request sync ─────────────────────────────────────
  const readPendingApprovals = useCallback(() => {
    const sessionStore = (chrome.storage as any)?.session;
    if (!sessionStore?.get) return;
    sessionStore.get([PENDING_CONNECT_KEY, PENDING_SIGN_KEY]).then((result: any) => {
      const pendingConnectReq = result?.[PENDING_CONNECT_KEY];
      const pendingSignReq = result?.[PENDING_SIGN_KEY];
      setPendingConnect(pendingConnectReq?.requestId ? pendingConnectReq : null);
      setPendingSign(
        pendingSignReq?.requestId && typeof pendingSignReq?.message === "string"
          ? pendingSignReq
          : null,
      );
    }).catch(() => {});
  }, []);

  useEffect(() => {
    readPendingApprovals();
  }, [readPendingApprovals]);

  useEffect(() => {
    const onChanged = (_changes: unknown, areaName: string) => {
      if (areaName !== "session") return;
      readPendingApprovals();
    };
    chrome.storage.onChanged.addListener(onChanged as any);
    return () => chrome.storage.onChanged.removeListener(onChanged as any);
  }, [readPendingApprovals]);

  useEffect(() => {
    setSiteSignError(null);
  }, [pendingSign?.requestId]);

  // ── Auto-lock listener ──────────────────────────────────────────────────────
  useEffect(() => {
    const listener = (msg: unknown) => {
      if ((msg as { type?: string })?.type === "AUTOLOCK_FIRED") {
        handleLock();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // ── Session TTL check ────────────────────────────────────────────────────────
  useEffect(() => {
    if (screen.type !== "unlocked" || !session) return;
    const interval = setInterval(() => {
      const s = getSession();
      if (!s) handleLock();
    }, 30_000);
    return () => clearInterval(interval);
  }, [screen.type, session]);

  const syncEndpointHealth = useCallback((targetNetwork: string) => {
    const snapshots = getKaspaEndpointHealth(targetNetwork) as Array<{
      base: string;
      lastOkAt: number;
      lastFailAt: number;
      consecutiveFails: number;
    }>;
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      setActiveRpcEndpoint(null);
      return;
    }

    const ranked = [...snapshots].sort((a, b) => {
      if (a.lastOkAt !== b.lastOkAt) return b.lastOkAt - a.lastOkAt;
      if (a.consecutiveFails !== b.consecutiveFails) return a.consecutiveFails - b.consecutiveFails;
      return b.lastFailAt - a.lastFailAt;
    });

    setActiveRpcEndpoint(ranked[0]?.base ?? null);
  }, []);

  // ── Live DAG score ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (screen.type !== "unlocked") return;
    const poll = async () => {
      const info = await fetchDagInfo(network);
      if (info?.virtualDaaScore) {
        setDagScore(info.virtualDaaScore);
        setDagUpdatedAt(Date.now());
        setFeedStatusMessage((prev) => (
          prev?.startsWith("Live BlockDAG feed") ? null : prev
        ));
      } else {
        setFeedStatusMessage("Live BlockDAG feed unavailable — retrying…");
      }
      syncEndpointHealth(network);
    };
    poll();
    const id = setInterval(poll, 20_000); // refresh every 20 s
    return () => clearInterval(id);
  }, [screen.type, network, syncEndpointHealth]);

  // ── Balance fetch ────────────────────────────────────────────────────────────
  const fetchBalances = useCallback(async (address: string, targetNetwork: string) => {
    try {
      const networkAddress = withKaspaAddressNetwork(address, targetNetwork);
      const [balanceResult, priceResult] = await Promise.allSettled([
        fetchKasBalance(networkAddress, targetNetwork),
        fetchKasUsdPrice(targetNetwork),
      ]);

      const now = Date.now();
      let degraded = false;

      if (balanceResult.status === "fulfilled") {
        setBalance(balanceResult.value);
        setBalanceUpdatedAt(now);
      } else {
        degraded = true;
      }

      if (priceResult.status === "fulfilled") {
        setUsdPrice(priceResult.value);
        setPriceUpdatedAt(now);
      } else {
        degraded = true;
      }

      setFeedStatusMessage((prev) => {
        if (degraded) return "Live balance/price feed degraded — retrying…";
        return prev?.startsWith("Live balance/price feed") ? null : prev;
      });
      syncEndpointHealth(targetNetwork);
    } catch { /* non-fatal */ }
  }, [syncEndpointHealth]);

  // ── Live balance + price polling ───────────────────────────────────────────
  useEffect(() => {
    if (screen.type !== "unlocked" || !session?.address) return;
    const poll = () => {
      fetchBalances(session.address, network);
    };
    poll();
    const id = setInterval(poll, 15_000);
    return () => clearInterval(id);
  }, [screen.type, session?.address, network, fetchBalances]);

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const handleUnlock = (s: UnlockedSession) => {
    setLockedAddress(null);
    setSession(s);
    fetchBalances(s.address, network);
    setScreen({ type: "unlocked" });
  };

  const handleLock = () => {
    // Persist the address so the lock screen shows "Welcome back, kaspa:qp…"
    setLockedAddress(session?.address ?? null);
    lockWallet();
    setSession(null);
    setBalance(null);
    setUsdPrice(0);
    setDagScore(null);
    setActiveRpcEndpoint(null);
    setBalanceUpdatedAt(null);
    setPriceUpdatedAt(null);
    setDagUpdatedAt(null);
    setFeedStatusMessage(null);
    setScreen({ type: "locked" });
  };

  const handleReset = async () => {
    const { resetWallet } = await import("../vault/vault");
    await resetWallet();
    setSession(null);
    setBalance(null);
    setUsdPrice(0);
    setDagScore(null);
    setActiveRpcEndpoint(null);
    setBalanceUpdatedAt(null);
    setPriceUpdatedAt(null);
    setDagUpdatedAt(null);
    setFeedStatusMessage(null);
    setScreen({ type: "first_run" });
  };

  const handleFirstRunComplete = (s: UnlockedSession) => {
    setSession(s);
    fetchBalances(s.address, network);
    setScreen({ type: "unlocked" });
  };

  const activeAddress = (() => {
    if (!session?.address) return null;
    try {
      return withKaspaAddressNetwork(session.address, network);
    } catch {
      return session.address;
    }
  })();

  const copyAddress = async () => {
    if (!activeAddress) return;
    try {
      await navigator.clipboard.writeText(activeAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* non-fatal */ }
  };

  // ── Network cycling ──────────────────────────────────────────────────────────
  const handleCycleNetwork = async () => {
    const idx = NETWORKS.indexOf(network as typeof NETWORKS[number]);
    const next = NETWORKS[(idx + 1) % NETWORKS.length];
    setNetwork(next);
    await saveNetwork(next);
    setBalance(null);
    setDagScore(null);
    setActiveRpcEndpoint(null);
    setBalanceUpdatedAt(null);
    setPriceUpdatedAt(null);
    setDagUpdatedAt(null);
    setFeedStatusMessage(null);
    if (session?.address) {
      try {
        await setWalletMeta({ address: withKaspaAddressNetwork(session.address, next), network: next });
      } catch { /* non-fatal */ }
      fetchBalances(session.address, next);
    }
  };

  // ── User activity → extend session TTL ───────────────────────────────────────
  const onUserActivity = () => {
    if (screen.type === "unlocked") {
      extendSession(autoLockMinutes, { persistSession: persistUnlockSessionEnabled });
    }
  };

  const handleAutoLockMinutesChanged = async (minutes: number) => {
    setAutoLockMinutes(minutes);
    await saveAutoLockMinutes(minutes);
    if (screen.type === "unlocked") {
      extendSession(minutes, { persistSession: persistUnlockSessionEnabled });
    }
  };

  const handlePersistUnlockSessionChanged = async (enabled: boolean) => {
    setPersistUnlockSessionEnabled(enabled);
    await setPersistUnlockSession(enabled);
    await setSessionPersistence(enabled);
    if (screen.type === "unlocked") {
      extendSession(autoLockMinutes, { persistSession: enabled });
    }
  };

  const handleToggleHidePortfolioBalances = async () => {
    const next = !hidePortfolioBalances;
    setHidePortfolioBalancesState(next);
    try {
      await setHidePortfolioBalances(next);
    } catch {
      // Keep local state optimistic; storage write can retry on next toggle.
    }
  };

  // If a site asks to sign but the active account is external (no vault mnemonic),
  // reject immediately because only managed vault accounts can sign here.
  useEffect(() => {
    if (screen.type !== "unlocked" || !pendingSign) return;
    if (session?.mnemonic) return;
    chrome.runtime.sendMessage({
      type: "FORGEOS_SIGN_REJECT",
      requestId: pendingSign.requestId,
      error: "Managed wallet is required for site signing",
    }).catch(() => {});
    setPendingSign(null);
  }, [screen.type, pendingSign, session?.mnemonic]);

  const handleApproveSiteSign = async () => {
    const request = pendingSign;
    if (!request) return;
    if (!session?.mnemonic) {
      setSiteSignError("Wallet is locked. Unlock to sign.");
      return;
    }

    setSigningSiteRequest(true);
    setSiteSignError(null);

    try {
      const signature = await signManagedMessage(session.mnemonic, request.message, {
        mnemonicPassphrase: session.mnemonicPassphrase,
        derivation: session.derivation,
      });
      await chrome.runtime.sendMessage({
        type: "FORGEOS_SIGN_APPROVE",
        requestId: request.requestId,
        signature,
      });
      setPendingSign(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSiteSignError(msg || "Signing failed");
    } finally {
      setSigningSiteRequest(false);
    }
  };

  const handleRejectSiteSign = () => {
    if (!pendingSign) return;
    chrome.runtime.sendMessage({
      type: "FORGEOS_SIGN_REJECT",
      requestId: pendingSign.requestId,
      error: "Signing rejected by user",
    }).catch(() => {});
    // Close the popup immediately — avoids a flash of the wallet UI before the window closes.
    window.close();
  };

  // ── Screen renders ────────────────────────────────────────────────────────────
  if (screen.type === "loading") {
    return (
      <div style={{
        width: EXTENSION_POPUP_BASE_WIDTH,
        height: EXTENSION_POPUP_BASE_MIN_HEIGHT,
        ...popupShellBackground(),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...mono,
        position: "relative",
        overflowX: "hidden",
        overflowY: "auto",
        zoom: EXTENSION_POPUP_UI_SCALE,
      }}>
        {/* Atmospheric blob */}
        <div style={{ position: "absolute", top: "30%", left: "50%", transform: "translate(-50%,-50%)", width: 260, height: 260, borderRadius: "50%", background: `radial-gradient(ellipse, ${C.accent}12 0%, transparent 70%)`, pointerEvents: "none" }} />
        <div style={{ textAlign: "center", position: "relative" }}>
          <img src="../icons/icon48.png" alt="" style={{ width: 36, height: 36, objectFit: "contain", opacity: 0.7, filter: "drop-shadow(0 0 10px rgba(57,221,182,0.5))" }} />
          <div style={{ fontSize: 9, color: C.dim, marginTop: 10, letterSpacing: "0.14em" }}>LOADING…</div>
        </div>
      </div>
    );
  }

  if (screen.type === "first_run") {
    return <FirstRunScreen network={network} onComplete={handleFirstRunComplete} />;
  }

  if (screen.type === "locked") {
    return (
      <LockScreen
        walletAddress={lockedAddress}
        autoLockMinutes={autoLockMinutes}
        persistSession={persistUnlockSessionEnabled}
        onUnlock={handleUnlock}
        onReset={handleReset}
      />
    );
  }

  const isManagedWallet = Boolean(session?.mnemonic);

  // ── Pending sign approval (MetaMask-style) ───────────────────────────────────
  if (pendingSign && activeAddress && isManagedWallet) {
    return (
      <SignApprovalScreen
        address={activeAddress}
        network={network}
        origin={pendingSign.origin}
        message={pendingSign.message}
        loading={signingSiteRequest}
        error={siteSignError}
        onApprove={handleApproveSiteSign}
        onReject={handleRejectSiteSign}
      />
    );
  }

  // ── Pending connect approval (MetaMask-style) ────────────────────────────────
  if (pendingConnect && activeAddress) {
    return (
      <ConnectApprovalScreen
        address={activeAddress}
        network={network}
        origin={pendingConnect.origin}
        onApprove={() => {
          chrome.runtime.sendMessage({
            type: "FORGEOS_CONNECT_APPROVE",
            requestId: pendingConnect.requestId,
            address: activeAddress,
            network,
          }).catch(() => {});
          setPendingConnect(null);
        }}
        onReject={() => {
          chrome.runtime.sendMessage({
            type: "FORGEOS_CONNECT_REJECT",
            requestId: pendingConnect.requestId,
          }).catch(() => {});
          window.close();
        }}
      />
    );
  }

  // ── UNLOCKED — main popup UI ─────────────────────────────────────────────────
  const address = activeAddress;
  const displayCurrency: DisplayCurrency = "USD";
  const portfolioUsdValue = balance !== null && usdPrice > 0 ? balance * usdPrice : null;
  const portfolioDisplayValue =
    portfolioUsdValue !== null ? formatFiatFromUsd(portfolioUsdValue, displayCurrency) : "—";
  const maskedPortfolioDisplayValue = hidePortfolioBalances ? "••••••" : portfolioDisplayValue;
  const isMainnet = network === "mainnet";
  const now = Date.now();

  const isFeedFresh = (updatedAt: number | null, staleMs: number) =>
    updatedAt !== null && now - updatedAt <= staleMs;
  const balanceLive = isFeedFresh(balanceUpdatedAt, BALANCE_FEED_STALE_MS);
  const priceLive = isFeedFresh(priceUpdatedAt, PRICE_FEED_STALE_MS);
  const dagLive = isFeedFresh(dagUpdatedAt, DAG_FEED_STALE_MS);
  const allFeedsLive = balanceLive && priceLive && dagLive;
  const anyFeedLive = balanceLive || priceLive || dagLive;
  const feedLabel = allFeedsLive ? "LIVE FEED" : anyFeedLive ? "PARTIAL FEED" : "FEED OFFLINE";
  const feedColor = allFeedsLive ? C.ok : anyFeedLive ? C.warn : C.danger;
  const latestFeedAt = Math.max(balanceUpdatedAt ?? 0, priceUpdatedAt ?? 0, dagUpdatedAt ?? 0);
  const feedUpdatedLabel = latestFeedAt > 0
    ? new Date(latestFeedAt).toLocaleTimeString([], { hour12: false })
    : "never";
  const activeEndpointLabel = (() => {
    if (!activeRpcEndpoint) return "endpoint unknown";
    try { return new URL(activeRpcEndpoint).host; } catch { return activeRpcEndpoint; }
  })();

  // Network badge: mainnet = green (ok), testnets = amber (warn)
  const netColor = isMainnet ? C.ok : C.warn;

  return (
    <div
      onClick={onUserActivity}
      style={{
        width: EXTENSION_POPUP_BASE_WIDTH,
        minHeight: EXTENSION_POPUP_BASE_MIN_HEIGHT,
        ...popupShellBackground(),
        display: "flex",
        flexDirection: "column",
        ...mono,
        position: "relative",
        overflowX: "hidden",
        overflowY: "auto",
        zoom: EXTENSION_POPUP_UI_SCALE,
      }}
    >
      {/* Atmospheric background blobs */}
      <div style={{ position: "absolute", top: -60, left: "50%", transform: "translateX(-50%)", width: 320, height: 320, borderRadius: "50%", background: `radial-gradient(ellipse, ${C.accent}0D 0%, transparent 70%)`, pointerEvents: "none", zIndex: 0 }} />
      <div style={{ position: "absolute", bottom: 40, right: -60, width: 200, height: 200, borderRadius: "50%", background: `radial-gradient(ellipse, ${C.accent}07 0%, transparent 70%)`, pointerEvents: "none", zIndex: 0 }} />

      {/* Header */}
      <div style={{ padding: "13px 16px 11px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative", zIndex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <img src="../icons/icon48.png" alt="Forge-OS" style={{ width: 24, height: 24, objectFit: "contain", filter: "drop-shadow(0 0 8px rgba(57,221,182,0.55))" }} />
          <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.1em" }}>
            <span style={{ color: C.accent }}>FORGE</span><span style={{ color: C.text }}>-OS</span>
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={handleCycleNetwork}
            title="Click to switch network"
            style={{
              fontSize: 9, color: netColor, fontWeight: 700, letterSpacing: "0.1em",
              background: `${netColor}15`,
              border: `1px solid ${netColor}35`,
              borderRadius: 4, padding: "3px 8px", cursor: "pointer", ...mono,
            }}
          >{NETWORK_LABELS[network] ?? network.toUpperCase()}</button>

          {isManagedWallet && (
            <button
              onClick={handleLock}
              title="Lock wallet"
              style={{
                background: "rgba(33,48,67,0.5)", border: `1px solid ${C.border}`,
                borderRadius: 4, padding: "3px 8px",
                color: C.dim, fontSize: 10, cursor: "pointer", ...mono,
              }}
            >🔒</button>
          )}
        </div>
      </div>

      {/* Address + balance hero */}
      {address ? (
        <div style={{ padding: "20px 16px 16px", borderBottom: `1px solid ${C.border}`, textAlign: "center", position: "relative", zIndex: 1 }}>
          {/* Address row */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 16 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: C.ok, flexShrink: 0, boxShadow: `0 0 6px ${C.ok}` }} />
            <span style={{ fontSize: 10, color: C.dim, letterSpacing: "0.04em" }}>{shortAddr(address)}</span>
            <button
              onClick={copyAddress}
              style={{
                ...outlineButton(copied ? C.ok : C.dim, true),
                padding: "3px 8px",
                fontSize: 9,
                letterSpacing: "0.08em",
                color: copied ? C.ok : C.dim,
                minWidth: 56,
              }}
            >{copied ? "COPIED" : "COPY"}</button>
            <button
              onClick={handleToggleHidePortfolioBalances}
              aria-label={hidePortfolioBalances ? "Show portfolio balances" : "Hide portfolio balances"}
              title={hidePortfolioBalances ? "Show portfolio balances" : "Hide portfolio balances"}
              style={{
                ...outlineButton(hidePortfolioBalances ? C.warn : C.dim, true),
                padding: "3px 0",
                fontSize: 9,
                letterSpacing: "0.08em",
                color: hidePortfolioBalances ? C.warn : C.dim,
                minWidth: 34,
                width: 34,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
                style={{ flexShrink: 0 }}
              >
                <path
                  d="M1 6C1 6 2.8 3.4 6 3.4C9.2 3.4 11 6 11 6C11 6 9.2 8.6 6 8.6C2.8 8.6 1 6 1 6Z"
                  stroke="currentColor"
                  strokeWidth="1"
                />
                <circle cx="6" cy="6" r="1.3" fill="currentColor" />
                {hidePortfolioBalances && (
                  <path d="M1.3 1.3L10.7 10.7" stroke="currentColor" strokeWidth="1.2" />
                )}
              </svg>
            </button>
          </div>

          {/* Portfolio value (fiat primary) */}
          <div style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 8, color: C.dim, letterSpacing: "0.1em", marginBottom: 6 }}>
              TOTAL PORTFOLIO VALUE
            </div>
            <div style={{ fontSize: 38, fontWeight: 700, color: C.text, letterSpacing: "0.005em", lineHeight: 1 }}>
              {maskedPortfolioDisplayValue}
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            {[
              { label: "SEND",    action: () => { setTab("wallet"); setWalletMode("send"); } },
              { label: "RECEIVE", action: () => { setTab("wallet"); setWalletMode("receive"); } },
              { label: "SWAP",  action: () => setTab("swap") },
            ].map(btn => (
              <button
                key={btn.label}
                onClick={btn.action}
                style={{
                  flex: 1,
                  background: `linear-gradient(145deg, ${C.accent}1A, rgba(8,13,20,0.7))`,
                  border: `1px solid ${C.accent}40`,
                  borderRadius: 10, padding: "9px 0",
                  color: C.accent, fontSize: 10, fontWeight: 700, cursor: "pointer", ...mono,
                  letterSpacing: "0.1em",
                  transition: "background 0.15s, border-color 0.15s",
                }}
              >{btn.label}</button>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ padding: "28px 16px", textAlign: "center", borderBottom: `1px solid ${C.border}`, position: "relative", zIndex: 1 }}>
          <div style={{ fontSize: 11, color: C.dim, marginBottom: 12 }}>No wallet connected</div>
          <button
            onClick={() => chrome.tabs.create({ url: "https://forge-os.xyz" })}
            style={{
              background: `linear-gradient(90deg, ${C.accent}, #7BE9CF)`, color: "#04110E",
              border: "none", borderRadius: 10, padding: "10px 20px", fontSize: 11,
              fontWeight: 700, cursor: "pointer", ...mono, letterSpacing: "0.08em",
            }}
          >OPEN FORGE-OS →</button>
        </div>
      )}

      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, position: "relative", zIndex: 1 }}>
        {(["wallet", "swap", "agents", "security"] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1, background: tab === t ? `${C.accent}08` : "none", border: "none",
              borderBottom: `2px solid ${tab === t ? C.accent : "transparent"}`,
              color: tab === t ? C.accent : C.dim,
              fontSize: 10, fontWeight: 700, cursor: "pointer",
              padding: "9px 0", letterSpacing: "0.1em", ...mono,
              textTransform: "uppercase", transition: "color 0.15s, border-color 0.15s, background 0.15s",
              boxShadow: tab === t ? `0 2px 12px ${C.accent}25` : "none",
            }}
          >{t}</button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: "auto", position: "relative", zIndex: 1 }}>
        {tab === "wallet" && (
          <WalletTab
            address={address}
            balance={balance}
            usdPrice={usdPrice}
            network={network}
            onOpenSwap={() => setTab("swap")}
            mode={walletMode}
            onModeConsumed={() => setWalletMode(undefined)}
            onBalanceInvalidated={() => session?.address && fetchBalances(session.address, network)}
            hideBalances={hidePortfolioBalances}
          />
        )}
        {tab === "swap" && <SwapTab />}
        {tab === "agents" && <AgentsTab network={network} />}
        {tab === "security" && (
          <SecurityTab
            address={address}
            network={network}
            isManagedWallet={isManagedWallet}
            autoLockMinutes={autoLockMinutes}
            persistUnlockSessionEnabled={persistUnlockSessionEnabled}
            onAutoLockMinutesChange={handleAutoLockMinutesChanged}
            onPersistUnlockSessionChange={handlePersistUnlockSessionChanged}
            onLock={handleLock}
          />
        )}
      </div>

      {/* Footer — live DAG info */}
      <div style={{ padding: "7px 16px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", position: "relative", zIndex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 8, color: C.muted, letterSpacing: "0.06em" }}>FORGE-OS</span>
          <span style={{ fontSize: 8, color: feedColor, letterSpacing: "0.05em", fontWeight: 700 }}>
            · {feedLabel}
          </span>
          {dagScore && (
            <span style={{ fontSize: 8, color: C.dim, letterSpacing: "0.04em" }}>
              · {NETWORK_BPS[network] ?? 10} BPS · DAA {(parseInt(dagScore, 10) / 1_000_000).toFixed(1)}M
            </span>
          )}
          <span style={{ fontSize: 8, color: C.dim, letterSpacing: "0.04em" }}>
            · RPC {activeEndpointLabel}
          </span>
          <span style={{ fontSize: 8, color: C.dim, letterSpacing: "0.04em" }}>
            · UPDATE {feedUpdatedLabel}
          </span>
        </div>
        <button
          onClick={() => chrome.tabs.create({ url: "https://forge-os.xyz" })}
          style={{ background: "none", border: "none", color: C.accent, fontSize: 8, cursor: "pointer", ...mono, letterSpacing: "0.06em" }}
        >OPEN SITE ↗</button>
      </div>
      {feedStatusMessage && (
        <div style={{ padding: "0 16px 7px", fontSize: 8, color: C.warn, letterSpacing: "0.03em", position: "relative", zIndex: 1 }}>
          {feedStatusMessage}
        </div>
      )}
    </div>
  );
}
