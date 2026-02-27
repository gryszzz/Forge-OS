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
} from "../swap/types";
import {
  connectEvmSidecarSigner,
  executeSwapQuote,
  getSwapGatingStatus,
  getSwapQuote,
  recoverPendingSwapSettlements,
} from "../swap/swap";
import { getConfiguredSwapRouteInfo } from "../swap/routeSource";
import { getAllTokens } from "../tokens/registry";
import type { TokenId } from "../tokens/types";
import { clearEvmSidecarSession, getEvmSidecarSession, type EvmSidecarSession } from "../swap/evmSidecar";
import { listSwapSettlements } from "../swap/settlementStore";
import type { SwapSettlementRecord } from "../swap/settlement";
import { getNetwork } from "../shared/storage";
import { resolveTokenFromAddress } from "../swap/tokenResolver";
import {
  insetCard,
  outlineButton,
  popupTabStack,
  primaryButton,
  sectionCard,
  sectionKicker,
} from "../popup/surfaces";

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
  const routeInfo = getConfiguredSwapRouteInfo();
  const tokens = getAllTokens();

  const [tokenIn, setTokenIn] = useState<TokenId>("KAS");
  const [tokenOut, setTokenOut] = useState<TokenId>("USDC");
  const [amountIn, setAmountIn] = useState("");
  const [slippageBps, setSlippageBps] = useState(SWAP_CONFIG.defaultSlippageBps);
  const [tokenAddressInput, setTokenAddressInput] = useState("");
  const [tokenStandard, setTokenStandard] = useState<KaspaTokenStandard>("krc20");
  const [resolvedToken, setResolvedToken] = useState<SwapCustomToken | null>(null);
  const [tokenResolveBusy, setTokenResolveBusy] = useState(false);
  const [tokenResolveError, setTokenResolveError] = useState<string | null>(null);
  const [tokenClipboardBusy, setTokenClipboardBusy] = useState(false);
  const [tokenAddressCopied, setTokenAddressCopied] = useState(false);

  const isDisabled = !gating.enabled;
  const evmRoute = SWAP_CONFIG.routeSource === "evm_0x";

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
      setTokenAddressInput(trimmed);
      setResolvedToken(token);
      resetQuoteState();
    } catch (err) {
      setResolvedToken(null);
      setTokenResolveError(err instanceof Error ? err.message : String(err));
    } finally {
      setTokenResolveBusy(false);
    }
  };

  const resolveCustomToken = async () => resolveCustomTokenFromAddress(tokenAddressInput);

  const clearResolvedToken = () => {
    setResolvedToken(null);
    setTokenResolveError(null);
    setTokenAddressCopied(false);
    resetQuoteState();
  };

  const pasteTokenAddress = async () => {
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
      setTokenAddressInput(trimmed);
      setResolvedToken(null);
      setTokenAddressCopied(false);
      resetQuoteState();
    } catch (err) {
      setTokenResolveError(err instanceof Error ? err.message : "Failed to read clipboard.");
    } finally {
      setTokenClipboardBusy(false);
    }
  };

  const pasteAndResolveTokenAddress = async () => {
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
      await resolveCustomTokenFromAddress(trimmed);
    } catch (err) {
      setTokenResolveError(err instanceof Error ? err.message : "Failed to read clipboard.");
    } finally {
      setTokenClipboardBusy(false);
    }
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

  const inputStyle = (disabled: boolean): React.CSSProperties => ({
    width: "100%",
    boxSizing: "border-box" as const,
    background: disabled ? "rgba(8,13,20,0.4)" : "rgba(8,13,20,0.7)",
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: "10px 12px",
    color: disabled ? C.dim : C.text,
    fontSize: 11,
    cursor: disabled ? "not-allowed" : "text",
    ...mono,
    outline: "none",
  });

  const selectStyle = (disabled: boolean): React.CSSProperties => ({
    ...inputStyle(disabled),
    cursor: disabled ? "not-allowed" : "pointer",
    appearance: "none" as const,
  });

  return (
    <div style={popupTabStack}>

      {/* Disabled overlay banner */}
      {isDisabled && (
        <div style={{
          ...sectionCard("purple"),
          display: "flex", alignItems: "flex-start", gap: 10,
        }}>
          <span style={{ fontSize: 18, flexShrink: 0 }}>⏳</span>
          <div>
            <div style={{ fontSize: 9, color: C.purple, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 4 }}>
              SWAP UNAVAILABLE
            </div>
            <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.5 }}>
              {gating.reason ?? "Swap functionality not yet active on Kaspa."}
            </div>
            <div style={{ fontSize: 8, color: C.muted, lineHeight: 1.4, marginTop: 6 }}>
              Route source: {routeInfo.label}
            </div>
          </div>
        </div>
      )}

      {evmRoute && (
        <div style={sectionCard("default", true)}>
          <div style={{ ...sectionKicker, marginBottom: 6 }}>EVM SIDECAR SIGNER</div>
          {sidecarSession ? (
            <>
              <div style={{ fontSize: 8, color: C.text, marginBottom: 6 }}>
                Connected: {sidecarSession.address.slice(0, 8)}…{sidecarSession.address.slice(-6)} (chain {sidecarSession.chainId})
              </div>
              <button
                onClick={disconnectSidecar}
                style={{ ...outlineButton(C.warn), width: "100%", padding: "8px 0" }}
              >
                DISCONNECT EVM SIGNER
              </button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.5, marginBottom: 7 }}>
                Required for `0x` route. Kaspa managed signer remains isolated.
              </div>
              {!showConnectConsent ? (
                <button
                  onClick={() => setShowConnectConsent(true)}
                  style={{ ...outlineButton(C.accent), width: "100%", padding: "8px 0" }}
                  disabled={connectBusy}
                >
                  CONNECT METAMASK SIDECAR
                </button>
              ) : (
                <div style={{ ...insetCard(), padding: "8px 10px" }}>
                  <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.5, marginBottom: 6 }}>
                    You are connecting an EVM signer domain. Forge-OS Kaspa wallet keys are not shared with this signer.
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={connectSidecar}
                      style={{ ...primaryButton(true), flex: 1, padding: "7px 0" }}
                      disabled={connectBusy}
                    >
                      {connectBusy ? "CONNECTING…" : "I AGREE, CONNECT"}
                    </button>
                    <button
                      onClick={() => setShowConnectConsent(false)}
                      style={{ ...outlineButton(C.dim), flex: 1, padding: "7px 0" }}
                      disabled={connectBusy}
                    >
                      CANCEL
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Token In */}
      <div style={sectionCard("default")}>
        <div style={{ ...sectionKicker, marginBottom: 6 }}>
          YOU PAY
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <select
            value={tokenIn}
            onChange={(e) => {
              setTokenIn(e.target.value as TokenId);
              resetQuoteState();
            }}
            disabled={isDisabled}
            style={{ ...selectStyle(isDisabled), flex: "0 0 100px" }}
          >
            {tokens.filter((t) => t.enabled).map((t) => (
              <option key={t.id} value={t.id}>{t.symbol}</option>
            ))}
          </select>
          <input
            type="number"
            min="0"
            value={amountIn}
            onChange={(e) => setAmountIn(e.target.value)}
            placeholder={isDisabled ? "—" : "0.00"}
            disabled={isDisabled}
            style={{ ...inputStyle(isDisabled), flex: 1 }}
          />
        </div>
      </div>

      {/* Swap direction arrow */}
      <div style={{ textAlign: "center" }}>
        <button
          disabled={isDisabled}
          onClick={flipSwapDirection}
          style={{
            background: "linear-gradient(180deg, rgba(16,25,35,0.7), rgba(8,13,20,0.7))", border: `1px solid ${C.border}`,
            borderRadius: "50%", width: 28, height: 28,
            color: isDisabled ? C.muted : C.accent, fontSize: 14,
            cursor: isDisabled ? "not-allowed" : "pointer",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 8px 16px rgba(0,0,0,0.16)",
          }}
        >⇅</button>
      </div>

      {/* Token Out */}
      <div style={sectionCard("default")}>
        <div style={{ ...sectionKicker, marginBottom: 6 }}>
          YOU RECEIVE (ESTIMATED)
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <select
            value={tokenOut}
            onChange={(e) => {
              setTokenOut(e.target.value as TokenId);
              resetQuoteState();
            }}
            disabled={isDisabled}
            style={{ ...selectStyle(isDisabled), flex: "0 0 100px" }}
          >
            {getAllTokens().map((t) => (
              <option key={t.id} value={t.id} disabled={!t.enabled}>
                {t.symbol}{!t.enabled ? " (soon)" : ""}
              </option>
            ))}
          </select>
          <div style={{
            ...inputStyle(true), flex: 1,
            display: "flex", alignItems: "center",
            color: C.muted, fontSize: 11,
          }}>
            —
          </div>
        </div>

        <div style={{ ...insetCard(), marginTop: 8, padding: "8px 10px" }}>
          <div style={{ fontSize: 8, color: C.dim, letterSpacing: "0.08em", marginBottom: 6 }}>
            PASTE KRC TOKEN ADDRESS (KRC20 / KRC721)
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            {(["krc20", "krc721"] as KaspaTokenStandard[]).map((standard) => {
              const active = tokenStandard === standard;
              return (
                <button
                  key={standard}
                  onClick={() => setTokenStandard(standard)}
                  disabled={isDisabled}
                  style={{
                    ...outlineButton(active ? C.accent : C.dim),
                    flex: 1,
                    padding: "5px 0",
                    fontSize: 8,
                    background: active ? `${C.accent}20` : "rgba(16,25,35,0.45)",
                    borderColor: active ? `${C.accent}55` : C.border,
                    color: active ? C.accent : C.dim,
                  }}
                >
                  {standard.toUpperCase()}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={tokenAddressInput}
              onChange={(e) => {
                setTokenAddressInput(e.target.value);
                if (resolvedToken) {
                  setResolvedToken(null);
                  setTokenAddressCopied(false);
                }
                resetQuoteState();
              }}
              placeholder="Paste token address"
              disabled={isDisabled}
              style={{ ...inputStyle(isDisabled), flex: 1, padding: "8px 10px", fontSize: 9 }}
            />
            <button
              onClick={pasteAndResolveTokenAddress}
              disabled={isDisabled || tokenClipboardBusy}
              style={{ ...outlineButton(C.dim), padding: "0 10px", fontSize: 8, whiteSpace: "nowrap" }}
            >
              {tokenClipboardBusy ? "..." : "PASTE+RESOLVE"}
            </button>
            <button
              onClick={pasteTokenAddress}
              disabled={isDisabled || tokenClipboardBusy}
              style={{ ...outlineButton(C.dim), padding: "0 10px", fontSize: 8 }}
            >
              PASTE
            </button>
            <button
              onClick={resolveCustomToken}
              disabled={isDisabled || tokenResolveBusy}
              style={{ ...outlineButton(C.accent), padding: "0 10px", fontSize: 8 }}
            >
              {tokenResolveBusy ? "..." : "RESOLVE"}
            </button>
          </div>
          {tokenResolveError && (
            <div style={{ fontSize: 8, color: C.danger, marginTop: 6 }}>
              {tokenResolveError}
            </div>
          )}

          {resolvedToken && (
            <div style={{ ...insetCard(), marginTop: 8, padding: "8px 9px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <img
                    src={resolvedToken.logoUri}
                    alt={resolvedToken.symbol}
                    style={{ width: 26, height: 26, borderRadius: 6, objectFit: "cover", flexShrink: 0 }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 9, color: C.text, fontWeight: 700, letterSpacing: "0.06em" }}>
                      {resolvedToken.symbol} · {resolvedToken.standard.toUpperCase()}
                    </div>
                    <div style={{ fontSize: 8, color: C.dim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {resolvedToken.address}
                    </div>
                  </div>
                </div>
                <button
                  onClick={copyResolvedTokenAddress}
                  style={{ ...outlineButton(tokenAddressCopied ? C.ok : C.dim), padding: "4px 7px", fontSize: 8 }}
                >
                  {tokenAddressCopied ? "COPIED" : "COPY"}
                </button>
                <button
                  onClick={clearResolvedToken}
                  style={{ ...outlineButton(C.dim), padding: "4px 7px", fontSize: 8 }}
                >
                  CLEAR
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Slippage control */}
      <div style={sectionCard("default", true)}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={sectionKicker}>SLIPPAGE TOLERANCE</div>
          <div style={{ fontSize: 8, color: isDisabled ? C.muted : C.text, fontWeight: 700 }}>
            {(slippageBps / 100).toFixed(1)}%
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {[25, 50, 100].map((bps) => (
            <button
              key={bps}
              onClick={() => setSlippageBps(bps)}
              disabled={isDisabled}
              style={{
                ...outlineButton(slippageBps === bps && !isDisabled ? C.accent : C.dim),
                flex: 1, padding: "5px 0", borderRadius: 6,
                background: slippageBps === bps && !isDisabled ? `${C.accent}20` : "rgba(33,48,67,0.4)",
                border: `1px solid ${slippageBps === bps && !isDisabled ? C.accent : C.border}`,
                color: slippageBps === bps && !isDisabled ? C.accent : C.dim,
                fontSize: 8, fontWeight: 700, cursor: isDisabled ? "not-allowed" : "pointer",
              }}
            >{(bps / 100).toFixed(1)}%</button>
          ))}
        </div>
      </div>

      {/* Quote / action area */}
      {!isDisabled ? (
        <>
          <button
            onClick={requestQuote}
            style={{
              ...primaryButton(true),
              width: "100%", padding: "11px 0",
              fontSize: 10,
              letterSpacing: "0.1em",
            }}
            disabled={quoteBusy}
          >
            {quoteBusy ? "REQUESTING QUOTE…" : "GET QUOTE →"}
          </button>

          {quote && (
            <div style={sectionCard("default", true)}>
              <div style={{ ...sectionKicker, marginBottom: 6 }}>QUOTE PREVIEW</div>
              {quote.customTokenOut && (
                <div style={{ fontSize: 8, color: C.text, marginBottom: 6 }}>
                  Output token: {quote.customTokenOut.symbol} ({quote.customTokenOut.standard.toUpperCase()}) · {quote.customTokenOut.address}
                </div>
              )}
              <div style={{ fontSize: 8, color: C.text, marginBottom: 6 }}>
                Route: {quote.route.join(" -> ")} | Valid ~30s
              </div>
              <div style={{ fontSize: 8, color: C.text, marginBottom: 8 }}>
                Min output units: {quote.amountOut.toString()}
              </div>
              {!showExecuteConsent ? (
                <button
                  onClick={() => setShowExecuteConsent(true)}
                  style={{ ...primaryButton(true), width: "100%", padding: "8px 0" }}
                  disabled={executeBusy}
                >
                  SIGN & EXECUTE SWAP
                </button>
              ) : (
                <div style={{ ...insetCard(), padding: "8px 10px" }}>
                  <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.5, marginBottom: 6 }}>
                    Confirm execution in the external EVM signer. Settlement is persisted and recovered after restart.
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={executeQuote}
                      style={{ ...primaryButton(true), flex: 1, padding: "7px 0" }}
                      disabled={executeBusy}
                    >
                      {executeBusy ? "EXECUTING…" : "CONFIRM EXECUTION"}
                    </button>
                    <button
                      onClick={() => setShowExecuteConsent(false)}
                      style={{ ...outlineButton(C.dim), flex: 1, padding: "7px 0" }}
                      disabled={executeBusy}
                    >
                      CANCEL
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 8, color: C.muted, letterSpacing: "0.08em" }}>
            SWAP COMING SOON
          </div>
        </div>
      )}

      {error && (
        <div style={{ ...insetCard(), border: `1px solid ${C.danger}60`, color: C.danger, fontSize: 8 }}>
          {error}
        </div>
      )}

      {settlements.length > 0 && (
        <div style={{ ...insetCard(), padding: "9px 12px" }}>
          <div style={{ ...sectionKicker, marginBottom: 6 }}>SWAP SETTLEMENTS</div>
          {settlements.map((s, i) => (
            <div key={s.id} style={{ marginBottom: i < settlements.length - 1 ? 4 : 0, fontSize: 8, color: C.dim }}>
              <span style={{ color: C.text }}>{s.state}</span>
              {" · "}
              {s.txHash ? `${s.txHash.slice(0, 10)}…` : "tx pending"}
              {" · "}
              {new Date(s.updatedAt).toLocaleTimeString()}
            </div>
          ))}
        </div>
      )}

      {/* Info footer */}
      <div style={{ ...insetCard(), padding: "9px 12px" }}>
        <div style={{ ...sectionKicker, marginBottom: 5 }}>SWAP NOTES</div>
        {[
          `Route source: ${routeInfo.label}.`,
          routeInfo.requiresEvmSigner
            ? "This route requires a dedicated EVM signer (Kaspa signer is isolated)."
            : "Signing domain remains inside Kaspa managed wallet boundaries.",
          "Use PASTE+RESOLVE (one-click) or manual paste + RESOLVE for KRC20/KRC721 metadata + token image.",
          "Output preview required before any signature.",
          `Max slippage cap: ${SWAP_CONFIG.maxSlippageBps / 100}%.`,
          "No silent token redirection — destination enforced.",
          "Swap routes verified against active network only.",
        ].map((note, i) => (
          <div key={i} style={{ display: "flex", gap: 6, marginBottom: i < 6 ? 3 : 0 }}>
            <span style={{ color: isDisabled ? C.muted : C.ok, fontSize: 8, flexShrink: 0 }}>•</span>
            <span style={{ fontSize: 8, color: C.muted, lineHeight: 1.4 }}>{note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
