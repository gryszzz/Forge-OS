// Swap Tab — gated UI.
// Renders in disabled state when SWAP_CONFIG.enabled = false.
// All interactive elements are present but non-functional (clearly labelled).
// No fake quotes, no simulated swaps, no placeholder amounts.

import { useEffect, useState } from "react";
import { C, mono } from "../../src/tokens";
import {
  SWAP_CONFIG,
  type KaspaTokenStandard,
  type SwapCustomToken,
  type SwapQuote,
  type SwapRouteSource,
} from "../swap/types";
import {
  connectEvmSidecarSigner,
  executeSwapQuote,
  getSwapGatingStatus,
  getSwapQuote,
  recoverPendingSwapSettlements,
} from "../swap/swap";
import { resolveSwapRouteSource } from "../swap/routeSource";
import { getAllTokens } from "../tokens/registry";
import type { TokenId } from "../tokens/types";
import { clearEvmSidecarSession, getEvmSidecarSession, type EvmSidecarSession } from "../swap/evmSidecar";
import { listSwapSettlements } from "../swap/settlementStore";
import type { SwapSettlementRecord } from "../swap/settlement";
import { getNetwork } from "../shared/storage";
import { resolveTokenFromAddress, resolveTokenFromQuery } from "../swap/tokenResolver";
import {
  insetCard,
  outlineButton,
  popupTabStack,
  primaryButton,
  sectionCard,
  sectionKicker,
} from "../popup/surfaces";

// Logo paths relative to popup HTML (extension/popup/index.html)
const TOKEN_LOGOS: Partial<Record<string, string>> = {
  KAS:  "../icons/kaspa-logo.png",
  USDC: "../icons/usdc.png",
  USDT: "../icons/usdt.png",
};

function TokenAvatar({ symbol, logoUri, size = 22 }: { symbol: string; logoUri?: string; size?: number }) {
  const src = logoUri ?? TOKEN_LOGOS[symbol];
  if (src) {
    return (
      <img
        src={src}
        alt={symbol}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "contain", flexShrink: 0, background: "rgba(57,221,182,0.08)" }}
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
      />
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: "rgba(57,221,182,0.18)", border: "1px solid rgba(57,221,182,0.35)",
      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    }}>
      <span style={{ color: "#39DDB6", fontSize: size * 0.45, fontWeight: 800 }}>
        {symbol.slice(0, 1)}
      </span>
    </div>
  );
}

function mainSwapAvatarSize(symbol: string | undefined): number {
  return 36;
}

function parseAmountToUnits(value: string, decimals: number): bigint | null {
  const v = String(value || "").trim();
  if (!v || !/^\d+(\.\d+)?$/.test(v)) return null;
  const [whole, frac = ""] = v.split(".");
  const wholePart = whole.replace(/^0+(?=\d)/, "") || "0";
  const fracPart = frac.slice(0, decimals).padEnd(decimals, "0");
  const digits = `${wholePart}${fracPart}`.replace(/^0+(?=\d)/, "") || "0";
  try {
    return BigInt(digits);
  } catch {
    return null;
  }
}

function formatUnitsDisplay(value: bigint, decimals: number, maxFraction = 6): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(Math.max(0, decimals));
  const whole = abs / base;
  const frac = abs % base;
  let wholeStr = whole.toString();
  if (wholeStr.length > 15) {
    wholeStr = `${wholeStr.slice(0, 6)}…${wholeStr.slice(-4)}`;
  }
  if (frac === 0n || decimals <= 0) return `${negative ? "-" : ""}${wholeStr}`;
  let fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFraction);
  fracStr = fracStr.replace(/0+$/, "");
  if (!fracStr) return `${negative ? "-" : ""}${wholeStr}`;
  return `${negative ? "-" : ""}${wholeStr}.${fracStr}`;
}

export function SwapTab() {
  const [sidecarSession, setSidecarSession] = useState<EvmSidecarSession | null>(() => getEvmSidecarSession());
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [settlements, setSettlements] = useState<SwapSettlementRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [executeBusy, setExecuteBusy] = useState(false);
  const [showConnectConsent, setShowConnectConsent] = useState(false);
  const [showExecuteConsent, setShowExecuteConsent] = useState(false);

  const gating = getSwapGatingStatus();
  const tokens = getAllTokens();

  const [tokenIn, setTokenIn] = useState<TokenId>("KAS");
  const [tokenOut, setTokenOut] = useState<TokenId>("USDC");
  const [amountIn, setAmountIn] = useState("");
  const [slippageBps, setSlippageBps] = useState(SWAP_CONFIG.defaultSlippageBps);
  const [tokenSearch, setTokenSearch] = useState("");
  const [tokenStandard, setTokenStandard] = useState<KaspaTokenStandard>("krc20");
  const [resolvedToken, setResolvedToken] = useState<SwapCustomToken | null>(null);
  const [tokenResolveBusy, setTokenResolveBusy] = useState(false);
  const [tokenResolveError, setTokenResolveError] = useState<string | null>(null);
  const [tokenClipboardBusy, setTokenClipboardBusy] = useState(false);
  const [tokenAddressCopied, setTokenAddressCopied] = useState(false);
  // 'from' | 'to' | null — which token picker is open
  const [tokenSelectMode, setTokenSelectMode] = useState<"from" | "to" | null>(null);
  const [showSettings, setShowSettings] = useState(true);
  const [customSlippage, setCustomSlippage] = useState("");
  const deadlineMinutes = "20";
  const routeMode: "auto" = "auto";

  const isDisabled = !gating.enabled;
  const normalizedTokenSearch = tokenSearch.trim().toLowerCase();
  const tokenSearchResults = normalizedTokenSearch
    ? tokens
      .filter((t) => `${t.symbol} ${t.name} ${t.id}`.toLowerCase().includes(normalizedTokenSearch))
      .slice(0, 8)
    : [];
  const selectedListedTokenOut = tokens.find((t) => t.id === tokenOut) ?? null;

  useEffect(() => {
    setSidecarSession(getEvmSidecarSession());
    recoverPendingSwapSettlements().catch(() => {});
    listSwapSettlements().then(setSettlements).catch(() => {});
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      recoverPendingSwapSettlements()
        .then(() => listSwapSettlements().then((items) => setSettlements(items.slice(0, 4))))
        .catch(() => {});
    }, SWAP_CONFIG.settlementPollIntervalMs);
    return () => clearInterval(id);
  }, []);

  const refreshSettlements = async () => {
    const items = await listSwapSettlements();
    setSettlements(items.slice(0, 4));
  };

  const resetQuoteState = () => {
    setQuote(null);
    setError(null);
    setShowExecuteConsent(false);
  };

  const requestQuote = async () => {
    setError(null);
    const tokenMeta = tokens.find((t) => t.id === tokenIn);
    const units = parseAmountToUnits(amountIn, tokenMeta?.decimals ?? 8);
    if (!units || units <= 0n) {
      setError("Enter a valid amount.");
      return;
    }
    setQuoteBusy(true);
    try {
      const q = await getSwapQuote({
        tokenIn,
        tokenOut,
        amountIn: units,
        slippageBps,
        customTokenOut: resolvedToken,
      }, {
        routeSource: requestedRouteSource,
        allowHybridAuto: routeMode === "auto",
      });
      if (!q) {
        setError(gating.reason ?? "Swap is currently unavailable.");
        return;
      }
      setQuote(q);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setQuoteBusy(false);
    }
  };

  const resolveCustomTokenFromAddress = async (addressRaw: string) => {
    setTokenResolveError(null);
    setError(null);
    const trimmed = String(addressRaw || "").trim();
    if (!trimmed) {
      setTokenResolveError("Paste a token address first.");
      return;
    }
    setTokenResolveBusy(true);
    try {
      const network = await getNetwork().catch(() => "mainnet");
      const token = await resolveTokenFromAddress(trimmed, tokenStandard, network);
      setTokenSearch(trimmed);
      setResolvedToken(token);
      setTokenOut("USDC");
      setTokenAddressCopied(false);
      resetQuoteState();
    } catch (err) {
      setResolvedToken(null);
      setTokenResolveError(err instanceof Error ? err.message : String(err));
    } finally {
      setTokenResolveBusy(false);
    }
  };

  const clearResolvedToken = () => {
    setResolvedToken(null);
    setTokenResolveError(null);
    setTokenAddressCopied(false);
    resetQuoteState();
  };

  const pasteTokenAddressToSearch = async () => {
    setTokenResolveError(null);
    setError(null);
    if (!navigator?.clipboard?.readText) {
      setTokenResolveError("Clipboard read is unavailable in this browser.");
      return;
    }
    setTokenClipboardBusy(true);
    try {
      const text = await navigator.clipboard.readText();
      const trimmed = text.trim();
      if (!trimmed) {
        setTokenResolveError("Clipboard is empty.");
        return;
      }
      setTokenSearch(trimmed);
      setResolvedToken(null);
      setTokenAddressCopied(false);
      resetQuoteState();
      await runTokenSearch(trimmed);
    } catch (err) {
      setTokenResolveError(err instanceof Error ? err.message : "Failed to read clipboard.");
    } finally {
      setTokenClipboardBusy(false);
    }
  };

  const selectListedTokenOut = (id: TokenId) => {
    setTokenOut(id);
    setResolvedToken(null);
    setTokenResolveError(null);
    setTokenAddressCopied(false);
    setTokenSearch("");
    resetQuoteState();
  };

  const runTokenSearch = async (overrideQuery?: string) => {
    setTokenResolveError(null);
    setError(null);
    const trimmed = String(overrideQuery ?? tokenSearch).trim();
    if (!trimmed) {
      setTokenResolveError("Type a token name/symbol or paste a token address.");
      return;
    }
    const lower = trimmed.toLowerCase();
    const exact = tokens.find((t) => (
      t.id.toLowerCase() === lower
      || t.symbol.toLowerCase() === lower
      || t.name.toLowerCase() === lower
    ));
    if (exact) {
      if (!exact.enabled) {
        setTokenResolveError(exact.disabledReason ?? `${exact.symbol} is not currently available.`);
        return;
      }
      selectListedTokenOut(exact.id);
      return;
    }
    const partial = tokens.find((t) => (
      (`${t.symbol} ${t.name} ${t.id}`).toLowerCase().includes(lower)
    ));
    if (partial) {
      if (!partial.enabled) {
        setTokenResolveError(partial.disabledReason ?? `${partial.symbol} is not currently available.`);
        return;
      }
      selectListedTokenOut(partial.id);
      return;
    }

    const network = await getNetwork().catch(() => "mainnet");
    const queryResolved = await resolveTokenFromQuery(trimmed, tokenStandard, network);
    if (queryResolved) {
      setResolvedToken(queryResolved);
      setTokenOut("USDC");
      setTokenAddressCopied(false);
      resetQuoteState();
      return;
    }

    await resolveCustomTokenFromAddress(trimmed);
  };

  const copyResolvedTokenAddress = async () => {
    if (!resolvedToken?.address) return;
    if (!navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(resolvedToken.address);
      setTokenAddressCopied(true);
      setTimeout(() => setTokenAddressCopied(false), 1400);
    } catch {
      // no-op: keep UX fail-safe
    }
  };

  const connectSidecar = async () => {
    setError(null);
    setConnectBusy(true);
    try {
      const session = await connectEvmSidecarSigner();
      setSidecarSession(session);
      setShowConnectConsent(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnectBusy(false);
    }
  };

  const disconnectSidecar = () => {
    clearEvmSidecarSession();
    setSidecarSession(null);
  };

  const executeQuote = async () => {
    if (!quote) return;
    setError(null);
    setExecuteBusy(true);
    try {
      await executeSwapQuote(quote);
      setShowExecuteConsent(false);
      await refreshSettlements();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuteBusy(false);
    }
  };

  const flipSwapDirection = () => {
    const enabledInputIds = new Set(tokens.filter((t) => t.enabled).map((t) => t.id));
    if (!enabledInputIds.has(tokenOut)) {
      setError(`Cannot flip while ${tokenOut} is disabled for input.`);
      return;
    }
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    clearResolvedToken();
    resetQuoteState();
  };

  const fromToken = tokens.find((t) => t.id === tokenIn);
  const toTokenMeta = resolvedToken
    ? { symbol: resolvedToken.symbol, name: resolvedToken.name, logoUri: resolvedToken.logoUri }
    : selectedListedTokenOut ? { symbol: selectedListedTokenOut.symbol, name: selectedListedTokenOut.name, logoUri: undefined }
    : null;
  const requestedRouteSource: SwapRouteSource = routeMode === "auto" ? SWAP_CONFIG.routeSource : routeMode;
  const activeRouteInfo = resolveSwapRouteSource(
    tokenIn,
    resolvedToken ? "USDC" : tokenOut,
    requestedRouteSource,
    { allowHybridAuto: routeMode === "auto" },
  );
  const fromTokenDecimals = fromToken?.decimals ?? 8;
  const toTokenDecimals = resolvedToken?.decimals ?? selectedListedTokenOut?.decimals ?? 8;
  const quoteAmountOutDisplay = quote ? formatUnitsDisplay(quote.amountOut, toTokenDecimals, 6) : "0.00";

  // Filtered list for picker — shows all tokens by default, filters as user types
  const pickerResults = normalizedTokenSearch
    ? tokens.filter((t) => `${t.symbol} ${t.name} ${t.id}`.toLowerCase().includes(normalizedTokenSearch))
    : tokens;

  const closeTokenPicker = () => {
    setTokenSelectMode(null);
    setTokenSearch("");
    setTokenResolveError(null);
  };

  const selectToken = (id: TokenId) => {
    if (tokenSelectMode === "from") {
      setTokenIn(id);
      resetQuoteState();
    } else {
      selectListedTokenOut(id);
    }
    closeTokenPicker();
  };

  // ── Shared styles ─────────────────────────────────────────────────────────
  const swapCard: React.CSSProperties = {
    background: "linear-gradient(155deg, rgba(14,20,29,0.97) 0%, rgba(10,15,22,0.94) 100%)",
    border: `1px solid rgba(28,42,58,0.9)`,
    borderRadius: 18,
    padding: "16px 16px 14px",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 28px rgba(0,0,0,0.32)",
  };

  const tokenBtn = (hasToken: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", gap: 7,
    background: hasToken ? "rgba(24,34,48,0.95)" : `linear-gradient(90deg, rgba(57,221,182,0.12), rgba(57,221,182,0.06))`,
    border: `1px solid ${hasToken ? "rgba(28,42,58,0.9)" : "rgba(57,221,182,0.3)"}`,
    borderRadius: 999,
    padding: hasToken ? "8px 12px 8px 9px" : "8px 14px",
    color: hasToken ? C.text : C.accent,
    fontSize: 13, fontWeight: 700,
    cursor: isDisabled ? "not-allowed" : "pointer",
    flexShrink: 0, whiteSpace: "nowrap" as const,
    ...mono,
  });

  // ── Token picker overlay ──────────────────────────────────────────────────
  if (tokenSelectMode !== null) {
    const isPasting = tokenClipboardBusy || tokenResolveBusy;

    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 440 }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "14px 15px 12px",
          borderBottom: `1px solid ${C.border}`,
        }}>
          <button
            onClick={closeTokenPicker}
            style={{
              background: "none", border: "none", color: C.dim, cursor: "pointer",
              fontSize: 18, display: "flex", alignItems: "center", padding: "0 4px 0 0",
            }}
          >←</button>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text, letterSpacing: "0.04em" }}>
            Select a Token
          </span>
          <span style={{
            marginLeft: "auto", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
            color: tokenSelectMode === "from" ? C.accent : C.dim,
            background: tokenSelectMode === "from" ? `${C.accent}15` : "rgba(28,42,58,0.5)",
            border: `1px solid ${tokenSelectMode === "from" ? `${C.accent}30` : C.border}`,
            borderRadius: 4, padding: "2px 7px",
          }}>
            {tokenSelectMode === "from" ? "FROM" : "TO"}
          </span>
        </div>

        {/* Search / paste row */}
        <div style={{ padding: "12px 15px 0" }}>
          {/* Search input */}
          <div style={{
            display: "flex", alignItems: "center", gap: 0,
            background: "rgba(10,15,22,0.9)",
            border: `1px solid ${C.border}`,
            borderRadius: 12, overflow: "hidden",
          }}>
            <span style={{ padding: "0 10px", color: C.dim, fontSize: 14, flexShrink: 0 }}>🔍</span>
            <input
              autoFocus
              value={tokenSearch}
              onChange={(e) => {
                setTokenSearch(e.target.value);
                if (resolvedToken) { setResolvedToken(null); setTokenAddressCopied(false); }
                setTokenResolveError(null);
                resetQuoteState();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); if (!isPasting) runTokenSearch().catch(() => {}); }
              }}
              placeholder="Search name or symbol…"
              style={{
                flex: 1, background: "none", border: "none", outline: "none",
                color: C.text, fontSize: 11, padding: "11px 0",
                ...mono,
              }}
            />
            <button
              onClick={pasteTokenAddressToSearch}
              disabled={isPasting}
              style={{
                marginRight: 6,
                background: isPasting ? "rgba(22,32,45,0.8)" : "rgba(57,221,182,0.12)",
                border: `1px solid ${isPasting ? C.border : `${C.accent}35`}`,
                borderRadius: 8,
                color: isPasting ? C.dim : C.accent,
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.08em",
                padding: "6px 9px",
                cursor: isPasting ? "wait" : "pointer",
                ...mono,
              }}
            >
              {isPasting ? "…" : "PASTE"}
            </button>
            <button
              onClick={() => { if (!isPasting) runTokenSearch().catch(() => {}); }}
              disabled={isPasting}
              style={{
                marginRight: 6,
                background: "rgba(22,32,45,0.8)",
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                color: C.text,
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.08em",
                padding: "6px 9px",
                cursor: isPasting ? "wait" : "pointer",
                ...mono,
              }}
            >
              GO
            </button>
          </div>
          <div style={{ fontSize: 8, color: C.muted, marginTop: 7, paddingLeft: 2 }}>
            Paste token address, then press GO (or Enter) to resolve.
          </div>

          {/* KRC20 / KRC721 tabs */}
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            {(["krc20", "krc721"] as KaspaTokenStandard[]).map((std) => {
              const active = tokenStandard === std;
              return (
                <button
                  key={std}
                  onClick={() => setTokenStandard(std)}
                  style={{
                    flex: 1, padding: "5px 0", fontSize: 9, fontWeight: 700,
                    letterSpacing: "0.08em", borderRadius: 8, cursor: "pointer",
                    background: active ? `${C.accent}18` : "rgba(16,25,35,0.5)",
                    border: `1px solid ${active ? `${C.accent}45` : C.border}`,
                    color: active ? C.accent : C.dim,
                    ...mono,
                  }}
                >{std.toUpperCase()}</button>
              );
            })}
          </div>
        </div>

        {/* Error */}
        {tokenResolveError && (
          <div style={{ margin: "8px 15px 0", fontSize: 9, color: C.danger, padding: "6px 10px", background: `${C.danger}0D`, borderRadius: 8, border: `1px solid ${C.danger}30` }}>
            {tokenResolveError}
          </div>
        )}

        {/* Resolved custom token result */}
        {resolvedToken && (
          <div style={{
            margin: "10px 15px 0",
            background: `${C.accent}0A`,
            border: `1px solid ${C.accent}30`,
            borderRadius: 12, padding: "10px 12px",
          }}>
            <div style={{ fontSize: 8, color: C.accent, letterSpacing: "0.1em", marginBottom: 8 }}>RESOLVED TOKEN</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <TokenAvatar symbol={resolvedToken.symbol} logoUri={resolvedToken.logoUri} size={34} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: C.text, fontWeight: 700 }}>{resolvedToken.symbol}</div>
                <div style={{ fontSize: 9, color: C.dim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {resolvedToken.address}
                </div>
              </div>
              <button
                onClick={copyResolvedTokenAddress}
                style={{ ...outlineButton(tokenAddressCopied ? C.ok : C.dim), padding: "4px 8px", fontSize: 8 }}
              >{tokenAddressCopied ? "✓" : "COPY ADDR"}</button>
            </div>
            <button
              onClick={() => {
                if (tokenSelectMode === "to") {
                  // keep resolvedToken, close picker
                  setTokenSelectMode(null);
                  setTokenSearch("");
                  setTokenResolveError(null);
                }
              }}
              style={{ ...primaryButton(true), width: "100%", padding: "9px 0", marginTop: 10, fontSize: 10 }}
            >
              SELECT {resolvedToken.symbol} →
            </button>
          </div>
        )}

        {/* Token list */}
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 15px 16px" }}>
          {!normalizedTokenSearch && (
            <div style={{ fontSize: 8, color: C.dim, letterSpacing: "0.1em", marginBottom: 8 }}>POPULAR TOKENS</div>
          )}
          {pickerResults.map((t, i) => (
            <button
              key={t.id}
              onClick={() => selectToken(t.id)}
              disabled={!t.enabled}
              style={{
                width: "100%", background: "none", border: "none",
                display: "flex", alignItems: "center", gap: 12,
                padding: "9px 4px",
                borderBottom: i < pickerResults.length - 1 ? `1px solid rgba(28,42,58,0.6)` : "none",
                cursor: t.enabled ? "pointer" : "not-allowed",
                borderRadius: 0,
              }}
            >
              <TokenAvatar symbol={t.symbol} size={36} />
              <div style={{ flex: 1, textAlign: "left" }}>
                <div style={{ fontSize: 13, color: t.enabled ? C.text : C.dim, fontWeight: 700, ...mono }}>{t.symbol}</div>
                <div style={{ fontSize: 10, color: C.dim, marginTop: 1 }}>{t.name}</div>
              </div>
              {!t.enabled && (
                <span style={{
                  fontSize: 8, fontWeight: 700, letterSpacing: "0.08em",
                  color: C.warn, background: `${C.warn}12`,
                  border: `1px solid ${C.warn}30`, borderRadius: 4, padding: "2px 7px",
                  ...mono,
                }}>SOON</span>
              )}
              {t.enabled && (tokenIn === t.id && tokenSelectMode === "from" || tokenOut === t.id && tokenSelectMode === "to") && (
                <span style={{ fontSize: 12, color: C.accent }}>✓</span>
              )}
            </button>
          ))}

          {normalizedTokenSearch && pickerResults.length === 0 && !tokenResolveBusy && !resolvedToken && (
            <div style={{ textAlign: "center", padding: "24px 0", color: C.dim, fontSize: 10 }}>
              <div style={{ marginBottom: 6 }}>No token found.</div>
              <div style={{ fontSize: 9, color: C.muted }}>Paste a KRC20 contract address to add it.</div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Main swap view ────────────────────────────────────────────────────────
  return (
    <div style={{ ...popupTabStack, gap: 8 }}>

      {/* Disabled banner */}
      {isDisabled && (
        <div style={{ ...sectionCard("purple"), display: "flex", alignItems: "flex-start", gap: 10 }}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>⏳</span>
          <div>
            <div style={{ fontSize: 9, color: C.purple, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 3 }}>SWAP UNAVAILABLE</div>
            <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.5 }}>{gating.reason ?? "Swap coming soon to Kaspa."}</div>
          </div>
        </div>
      )}

      {/* EVM sidecar */}
      {activeRouteInfo.requiresEvmSigner && (
        <div style={sectionCard("default", true)}>
          <div style={{ ...sectionKicker, marginBottom: 6 }}>EVM SIDECAR</div>
          {sidecarSession ? (
            <>
              <div style={{ fontSize: 8, color: C.text, marginBottom: 6 }}>
                {sidecarSession.address.slice(0, 8)}…{sidecarSession.address.slice(-6)} (chain {sidecarSession.chainId})
              </div>
              <button onClick={disconnectSidecar} style={{ ...outlineButton(C.warn), width: "100%", padding: "7px 0" }}>DISCONNECT</button>
            </>
          ) : !showConnectConsent ? (
            <button onClick={() => setShowConnectConsent(true)} style={{ ...outlineButton(C.accent), width: "100%", padding: "7px 0" }} disabled={connectBusy}>
              CONNECT METAMASK SIDECAR
            </button>
          ) : (
            <div style={{ ...insetCard(), padding: "8px 10px" }}>
              <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.5, marginBottom: 6 }}>Forge-OS Kaspa keys are not shared with this signer.</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={connectSidecar} style={{ ...primaryButton(true), flex: 1, padding: "7px 0" }} disabled={connectBusy}>
                  {connectBusy ? "CONNECTING…" : "CONNECT"}
                </button>
                <button onClick={() => setShowConnectConsent(false)} style={{ ...outlineButton(C.dim), flex: 1, padding: "7px 0" }}>CANCEL</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── FROM card ── */}
      <div style={swapCard}>
        <div style={{ fontSize: 11, color: C.dim, marginBottom: 12, letterSpacing: "0.04em" }}>from</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minWidth: 0 }}>
          <button
            onClick={() => !isDisabled && setTokenSelectMode("from")}
            style={tokenBtn(true)}
          >
            <TokenAvatar symbol={fromToken?.symbol ?? "KAS"} size={mainSwapAvatarSize(fromToken?.symbol)} />
            <span>{fromToken?.symbol ?? "KAS"}</span>
            <span style={{ color: C.dim, fontSize: 11 }}>▾</span>
          </button>
        </div>
        <input
          type="number" min="0"
          value={amountIn}
          onChange={(e) => setAmountIn(e.target.value)}
          placeholder="0.00"
          disabled={isDisabled}
          style={{
            width: "100%", minWidth: 0, marginTop: 12, background: "none", border: "none", outline: "none",
            color: isDisabled ? C.dim : C.text,
            fontSize: 20, fontWeight: 600, textAlign: "center",
            cursor: isDisabled ? "not-allowed" : "text",
            lineHeight: 1.1,
            ...mono,
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
          <div style={{ fontSize: 10, color: C.dim }}>
            Available: 0 {fromToken?.symbol ?? "KAS"}
          </div>
          <button
            onClick={() => {/* MAX — needs balance wired in */}}
            style={{
              background: `${C.accent}12`, border: `1px solid ${C.accent}30`,
              borderRadius: 6, color: C.accent, fontSize: 9, fontWeight: 700,
              padding: "2px 8px", cursor: "pointer", letterSpacing: "0.06em", ...mono,
            }}
          >MAX</button>
        </div>
      </div>

      {/* ── Flip button ── */}
      <div style={{ display: "flex", justifyContent: "center", margin: "-4px 0", zIndex: 1 }}>
        <button
          disabled={isDisabled}
          onClick={flipSwapDirection}
          style={{
            background: "rgba(14,20,29,0.98)",
            border: `1px solid rgba(28,42,58,0.9)`,
            borderRadius: "50%", width: 34, height: 34,
            color: isDisabled ? C.muted : C.text,
            fontSize: 16,
            cursor: isDisabled ? "not-allowed" : "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          }}
        >⇅</button>
      </div>

      {/* ── TO card ── */}
      <div style={swapCard}>
        <div style={{ fontSize: 11, color: C.dim, marginBottom: 12, letterSpacing: "0.04em" }}>to</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minWidth: 0 }}>
          {toTokenMeta ? (
            <button onClick={() => !isDisabled && setTokenSelectMode("to")} style={tokenBtn(true)}>
              <TokenAvatar symbol={toTokenMeta.symbol} logoUri={toTokenMeta.logoUri} size={mainSwapAvatarSize(toTokenMeta.symbol)} />
              <span>{toTokenMeta.symbol}</span>
              <span style={{ color: C.dim, fontSize: 11 }}>▾</span>
            </button>
          ) : (
            <button onClick={() => !isDisabled && setTokenSelectMode("to")} style={tokenBtn(false)}>
              <span>Select Token</span>
              <span style={{ fontSize: 11 }}>▾</span>
            </button>
          )}
        </div>
        <div style={{
          width: "100%", minWidth: 0, marginTop: 12, textAlign: "center",
          color: quote ? C.text : C.dim,
          fontSize: 20, fontWeight: 600, ...mono,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          lineHeight: 1.1,
        }}>
          {quoteAmountOutDisplay}
        </div>
        <div style={{ fontSize: 10, color: C.dim, marginTop: 10 }}>
          Available: 0 {toTokenMeta?.symbol ?? ""}
        </div>
      </div>

      {/* ── Rate + Settings ── */}
      <div style={{ padding: "2px 4px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 10, color: C.dim }}>
            Rate: <span style={{ color: C.text }}>1 {fromToken?.symbol ?? "KAS"} ≈ {quote ? `~${formatUnitsDisplay(quote.amountOut, toTokenDecimals, 4)}` : "—"} {toTokenMeta?.symbol ?? "—"}</span>
          </div>
          <button
            onClick={() => setShowSettings(!showSettings)}
            style={{
              background: showSettings ? `${C.accent}12` : "none",
              border: `1px solid ${showSettings ? `${C.accent}35` : C.border}`,
              borderRadius: 8, padding: "4px 10px",
              color: showSettings ? C.accent : C.dim,
              fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
              cursor: "pointer", ...mono,
            }}
          >⚙ SETTINGS</button>
        </div>

        {showSettings && (
          <div style={{
            marginTop: 8, padding: "12px 14px",
            background: "linear-gradient(155deg, rgba(14,20,29,0.97) 0%, rgba(10,15,22,0.94) 100%)",
            border: `1px solid rgba(28,42,58,0.9)`,
            borderRadius: 14,
          }}>
            {/* Slippage */}
            <div style={{ fontSize: 9, color: C.dim, letterSpacing: "0.1em", marginBottom: 8, fontWeight: 700 }}>
              SLIPPAGE TOLERANCE
            </div>
            <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
              {[25, 50, 100, 200].map((bps) => {
                const active = slippageBps === bps && !customSlippage;
                return (
                  <button
                    key={bps}
                    onClick={() => { setSlippageBps(bps); setCustomSlippage(""); }}
                    style={{
                      flex: 1, padding: "7px 0", borderRadius: 8, fontSize: 10, fontWeight: 700,
                      background: active ? `${C.accent}20` : "rgba(22,32,45,0.8)",
                      border: `1px solid ${active ? `${C.accent}55` : C.border}`,
                      color: active ? C.accent : C.dim,
                      cursor: "pointer", ...mono,
                    }}
                  >{bps === 200 ? "2%" : `${(bps / 100).toFixed(2).replace(".00", "")}%`}</button>
                );
              })}
              <input
                value={customSlippage}
                onChange={(e) => {
                  setCustomSlippage(e.target.value);
                  const n = parseFloat(e.target.value);
                  if (!isNaN(n) && n > 0 && n <= 50) setSlippageBps(Math.round(n * 100));
                }}
                placeholder="Custom"
                style={{
                  flex: 1, background: customSlippage ? `${C.accent}10` : "rgba(22,32,45,0.8)",
                  border: `1px solid ${customSlippage ? `${C.accent}55` : C.border}`,
                  borderRadius: 8, color: C.text,
                  fontSize: 10, textAlign: "center", padding: "7px 4px",
                  outline: "none", ...mono,
                }}
              />
            </div>
            <div style={{ fontSize: 9, color: C.muted, marginTop: 8 }}>
              Current slippage:{" "}
              <span style={{ color: slippageBps > 150 ? C.warn : C.text, fontWeight: 600 }}>
                {(slippageBps / 100).toFixed(2)}%
              </span>
              {slippageBps > 150 && (
                <span style={{ color: C.warn }}> — High slippage. Proceed with caution.</span>
              )}
            </div>

            {/* Network info */}
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid rgba(28,42,58,0.7)` }}>
              <div style={{ fontSize: 9, color: C.dim, letterSpacing: "0.1em", marginBottom: 6, fontWeight: 700 }}>
                NETWORK
              </div>
              <div style={{ fontSize: 10, color: C.text }}>
                Kaspa Mainnet · BlockDAG · 10 BPS
              </div>
              <div style={{ fontSize: 9, color: C.dim, marginTop: 3 }}>
                Transactions confirm in ~1 second on average.
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Action / quote ── */}
      {!isDisabled ? (
        <>
          <button
            onClick={requestQuote}
            style={{ ...primaryButton(true), width: "100%", padding: "14px 0", fontSize: 12, letterSpacing: "0.08em", borderRadius: 14 }}
            disabled={quoteBusy}
          >
            {quoteBusy ? "PREPARING SWAP…" : "SWAP"}
          </button>

          {quote && (
            <div style={{ ...sectionCard("accent", true) }}>
              <div style={{ ...sectionKicker, marginBottom: 8, color: C.accent }}>SWAP PREVIEW</div>
              {quote.customTokenOut && (
                <div style={{ fontSize: 9, color: C.dim, marginBottom: 4 }}>
                  Output: <span style={{ color: C.text }}>{quote.customTokenOut.symbol} ({quote.customTokenOut.standard.toUpperCase()})</span>
                </div>
              )}
              <div style={{ fontSize: 9, color: C.dim, marginBottom: 3 }}>
                Route: <span style={{ color: C.text }}>{quote.route.join(" → ")}</span>
              </div>
              <div style={{ fontSize: 9, color: C.dim, marginBottom: 10 }}>
                Min received: <span style={{ color: C.text }}>{formatUnitsDisplay(quote.amountOut, toTokenDecimals, 6)} {toTokenMeta?.symbol ?? tokenOut}</span>
              </div>
              <div style={{ fontSize: 9, color: C.dim, marginBottom: 10 }}>
                Deadline: <span style={{ color: C.text }}>{deadlineMinutes || "20"}m</span>
              </div>
              {!showExecuteConsent ? (
                <button onClick={() => setShowExecuteConsent(true)} style={{ ...primaryButton(true), width: "100%", padding: "10px 0", borderRadius: 10 }} disabled={executeBusy}>
                  SIGN & EXECUTE SWAP
                </button>
              ) : (
                <div style={{ ...insetCard(), padding: "10px 12px" }}>
                  <div style={{ fontSize: 9, color: C.dim, lineHeight: 1.6, marginBottom: 8 }}>
                    {quote.routeSource === "kaspa_native"
                      ? "This will sign and broadcast via the managed Kaspa signer. Settlement is saved and recovers after restart."
                      : "This will sign and broadcast via the external EVM signer. Settlement is saved and recovers after restart."}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={executeQuote} style={{ ...primaryButton(true), flex: 1, padding: "9px 0" }} disabled={executeBusy}>
                      {executeBusy ? "EXECUTING…" : "CONFIRM"}
                    </button>
                    <button onClick={() => setShowExecuteConsent(false)} style={{ ...outlineButton(C.dim), flex: 1, padding: "9px 0" }}>CANCEL</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div style={{ textAlign: "center", padding: "8px 0" }}>
          <div style={{ fontSize: 9, color: C.muted, letterSpacing: "0.1em" }}>SWAP COMING SOON TO KASPA</div>
        </div>
      )}

      {error && (
        <div style={{ ...insetCard(), border: `1px solid ${C.danger}50`, color: C.danger, fontSize: 9, lineHeight: 1.5 }}>
          {error}
        </div>
      )}

      {settlements.length > 0 && (
        <div style={{ ...insetCard(), padding: "10px 12px" }}>
          <div style={{ ...sectionKicker, marginBottom: 6 }}>RECENT SWAPS</div>
          {settlements.map((s, i) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: i < settlements.length - 1 ? 6 : 0 }}>
              <div style={{
                width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                background: s.state === "settled" ? C.ok : s.state === "failed" ? C.danger : C.warn,
              }} />
              <span style={{ fontSize: 9, color: C.text, flex: 1 }}>{s.state}</span>
              <span style={{ fontSize: 8, color: C.dim }}>
                {s.txHash ? `${s.txHash.slice(0, 8)}…` : "pending"}
              </span>
              <span style={{ fontSize: 8, color: C.muted }}>{new Date(s.updatedAt).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
