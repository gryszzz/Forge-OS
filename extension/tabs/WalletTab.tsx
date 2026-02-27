// WalletTab — full send pipeline (Build → DryRun → Confirm → Sign → Broadcast → Poll)
// for managed wallets, and address-display receive for all wallets.
// Stablecoin rows are scaffolded via TokenRegistry; enabled=false shows disabled state.

import { useState, useEffect } from "react";
import QRCode from "qrcode";
import { C, mono } from "../../src/tokens";
import { fmt, isKaspaAddress } from "../../src/helpers";
import { fetchKasUsdPrice } from "../shared/api";
import { fetchDagInfo, NETWORK_BPS } from "../network/kaspaClient";
import { getSession } from "../vault/vault";
import { buildTransaction } from "../tx/builder";
import { dryRunValidate } from "../tx/dryRun";
import { signTransaction } from "../tx/signer";
import { broadcastAndPoll } from "../tx/broadcast";
import { addPendingTx, updatePendingTx } from "../tx/store";
import { getOrSyncUtxos, sompiToKas, syncUtxos } from "../utxo/utxoSync";
import { getAllTokens } from "../tokens/registry";
import { resolveTokenFromAddress, resolveTokenFromQuery } from "../swap/tokenResolver";
import type { KaspaTokenStandard, SwapCustomToken } from "../swap/types";
import type { PendingTx } from "../tx/types";
import type { TokenId } from "../tokens/types";
import type { Utxo } from "../utxo/types";
import {
  divider,
  insetCard,
  monoInput,
  outlineButton,
  popupTabStack,
  primaryButton,
  sectionCard,
  sectionKicker,
  sectionTitle,
} from "../popup/surfaces";

interface Props {
  address: string | null;
  balance: number | null;
  usdPrice: number;
  network: string;
  hideBalances?: boolean;
  /** When set, immediately opens the send or receive panel */
  mode?: "send" | "receive";
  modeRequestId?: number;
  onModeConsumed?: () => void;
  onBalanceInvalidated?: () => void;
}

type SendStep =
  | "idle"
  | "form"
  | "building"
  | "dry_run"
  | "confirm"
  | "signing"
  | "broadcast"
  | "done"
  | "error";

const EXPLORERS: Record<string, string> = {
  mainnet:      "https://explorer.kaspa.org",
  "testnet-10": "https://explorer-tn10.kaspa.org",
  "testnet-11": "https://explorer-tn11.kaspa.org",
  "testnet-12": "https://explorer-tn12.kaspa.org",
};

const KAS_CHART_MAX_POINTS = 900; // ~15m at 1s cadence
const KAS_FEED_POLL_MS = 1_000;

type PricePoint = { ts: number; price: number };

export function WalletTab({
  address,
  balance,
  usdPrice,
  network,
  hideBalances = false,
  mode,
  modeRequestId,
  onModeConsumed,
  onBalanceInvalidated,
}: Props) {
  const [sendStep, setSendStep] = useState<SendStep>("idle");
  const [showReceive, setShowReceive] = useState(false);
  const [sendTo, setSendTo] = useState("");
  const [sendAmt, setSendAmt] = useState("");
  const [pendingTx, setPendingTx] = useState<PendingTx | null>(null);
  const [dryRunErrors, setDryRunErrors] = useState<string[]>([]);
  const [resultTxId, setResultTxId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [addrCopied, setAddrCopied] = useState(false);
  const [receiveQrDataUrl, setReceiveQrDataUrl] = useState<string | null>(null);
  const [receiveQrError, setReceiveQrError] = useState<string | null>(null);
  const [utxos, setUtxos] = useState<Utxo[]>([]);
  const [utxoLoading, setUtxoLoading] = useState(false);
  const [utxoError, setUtxoError] = useState<string | null>(null);
  const [utxoUpdatedAt, setUtxoUpdatedAt] = useState<number | null>(null);
  const [utxoReloadNonce, setUtxoReloadNonce] = useState(0);
  const [selectedTokenId, setSelectedTokenId] = useState<TokenId | null>(null);
  const [liveKasPrice, setLiveKasPrice] = useState(usdPrice);
  const [kasPriceSeries, setKasPriceSeries] = useState<PricePoint[]>([]);
  const [kasFeedUpdatedAt, setKasFeedUpdatedAt] = useState<number | null>(null);
  const [kasFeedError, setKasFeedError] = useState<string | null>(null);
  const [kasChartWindow, setKasChartWindow] = useState<number>(300);
  const [kasFeedRefreshNonce, setKasFeedRefreshNonce] = useState(0);
  const [networkDaaScore, setNetworkDaaScore] = useState<string | null>(null);
  const [metadataAddressInput, setMetadataAddressInput] = useState("");
  const [metadataStandard, setMetadataStandard] = useState<KaspaTokenStandard>("krc20");
  const [resolvedMetadata, setResolvedMetadata] = useState<SwapCustomToken | null>(null);
  const [metadataResolveBusy, setMetadataResolveBusy] = useState(false);
  const [metadataResolveError, setMetadataResolveError] = useState<string | null>(null);

  // Open send/receive panel when triggered from parent (hero buttons)
  useEffect(() => {
    if (!mode) return;
    setSelectedTokenId(null);
    if (mode === "send") {
      setShowReceive(false);
      setSendStep("form");
      setPendingTx(null);
      setDryRunErrors([]);
      setErrorMsg(null);
      setResultTxId(null);
    } else {
      setShowReceive(true);
      setSendStep("idle");
    }
    onModeConsumed?.();
  }, [mode, modeRequestId, onModeConsumed]);

  useEffect(() => {
    let cancelled = false;

    const makeReceiveQr = async () => {
      if (!showReceive || !address) {
        setReceiveQrDataUrl(null);
        setReceiveQrError(null);
        return;
      }
      setReceiveQrError(null);
      try {
        const dataUrl = await QRCode.toDataURL(address, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 220,
          color: {
            dark: "#39DDB6",
            light: "#0A1118",
          },
        });
        if (cancelled) return;
        setReceiveQrDataUrl(dataUrl);
      } catch (err) {
        if (cancelled) return;
        setReceiveQrDataUrl(null);
        setReceiveQrError(err instanceof Error ? err.message : "Failed to generate QR code.");
      }
    };

    makeReceiveQr().catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [showReceive, address]);

  useEffect(() => {
    let alive = true;

    const loadUtxos = async (force = false) => {
      if (!address) {
        if (!alive) return;
        setUtxos([]);
        setUtxoError(null);
        setUtxoUpdatedAt(null);
        setUtxoLoading(false);
        return;
      }

      if (!alive) return;
      setUtxoLoading(true);
      if (force) setUtxoError(null);

      try {
        const utxoSet = force
          ? await syncUtxos(address, network)
          : await getOrSyncUtxos(address, network);
        if (!alive) return;

        const sorted = [...utxoSet.utxos].sort((a, b) => {
          if (a.amount === b.amount) return 0;
          return a.amount > b.amount ? -1 : 1;
        });

        setUtxos(sorted);
        setUtxoUpdatedAt(Date.now());
        setUtxoError(null);
      } catch (err) {
        if (!alive) return;
        setUtxoError(err instanceof Error ? err.message : "Failed to load UTXOs.");
      } finally {
        if (alive) setUtxoLoading(false);
      }
    };

    loadUtxos(true).catch(() => {});
    const pollId = window.setInterval(() => {
      loadUtxos(false).catch(() => {});
    }, 25_000);

    return () => {
      alive = false;
      clearInterval(pollId);
    };
  }, [address, network, utxoReloadNonce]);

  useEffect(() => {
    if (usdPrice <= 0) return;
    setLiveKasPrice(usdPrice);
    setKasPriceSeries((prev) => {
      const now = Date.now();
      const next = [...prev, { ts: now, price: usdPrice }];
      return next.slice(-KAS_CHART_MAX_POINTS);
    });
    setKasFeedUpdatedAt(Date.now());
  }, [usdPrice]);

  useEffect(() => {
    if (selectedTokenId !== "KAS") return;
    let alive = true;

    const pollKasFeed = async () => {
      try {
        const [price, dagInfo] = await Promise.all([
          fetchKasUsdPrice(network),
          fetchDagInfo(network),
        ]);
        if (!alive) return;
        const now = Date.now();
        if (price > 0) {
          setLiveKasPrice(price);
        }
        setKasPriceSeries((prev) => {
          const fallbackPrice = prev.length > 0 ? prev[prev.length - 1].price : 0;
          const plotPrice = price > 0 ? price : fallbackPrice;
          if (plotPrice <= 0) return prev;
          const next = [...prev, { ts: now, price: plotPrice }];
          return next.slice(-KAS_CHART_MAX_POINTS);
        });
        setKasFeedUpdatedAt(now);
        setKasFeedError(price > 0 ? null : "Price endpoint stale — plotting last known value.");
        if (dagInfo?.virtualDaaScore) {
          setNetworkDaaScore(dagInfo.virtualDaaScore);
        }
      } catch (err) {
        if (!alive) return;
        setKasFeedError(err instanceof Error ? err.message : "Live feed unavailable.");
      }
    };

    pollKasFeed().catch(() => {});
    const pollId = window.setInterval(() => {
      pollKasFeed().catch(() => {});
    }, KAS_FEED_POLL_MS);

    return () => {
      alive = false;
      clearInterval(pollId);
    };
  }, [network, selectedTokenId, kasFeedRefreshNonce]);

  useEffect(() => {
    if (!selectedTokenId) return;
    setMetadataAddressInput("");
    setResolvedMetadata(null);
    setMetadataResolveError(null);
  }, [selectedTokenId, network]);

  const session = getSession();
  const isManaged = Boolean(session?.mnemonic);

  const networkPrefix = network === "mainnet" ? "kaspa:" : "kaspatest:";
  const addressValid = isKaspaAddress(sendTo) && sendTo.toLowerCase().startsWith(networkPrefix);
  const amountNum = parseFloat(sendAmt);
  const amountValid = amountNum > 0 && (balance === null || amountNum <= balance);
  const formReady = addressValid && amountValid;

  // ── Pipeline ─────────────────────────────────────────────────────────────────

  const handleBuildAndValidate = async () => {
    if (!address || !formReady) return;
    setSendStep("building");
    setDryRunErrors([]);
    setErrorMsg(null);

    let built: PendingTx;
    try {
      built = await buildTransaction(address, sendTo.trim(), amountNum, network);
      await addPendingTx(built);
      setPendingTx(built);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(
        msg === "INSUFFICIENT_FUNDS"
          ? "Insufficient balance including fees."
          : msg === "COVENANT_ONLY_FUNDS"
            ? "Funds are currently locked in covenant outputs. Standard send only spends standard UTXOs."
            : `Build failed: ${msg}`,
      );
      setSendStep("error");
      return;
    }

    setSendStep("dry_run");
    try {
      const result = await dryRunValidate(built);
      if (!result.valid) {
        setDryRunErrors(result.errors);
        setSendStep("error");
        await updatePendingTx({ ...built, state: "DRY_RUN_FAIL", error: result.errors.join("; ") });
        return;
      }
      const validated: PendingTx = { ...built, state: "DRY_RUN_OK", fee: result.estimatedFee };
      setPendingTx(validated);
      await updatePendingTx(validated);
    } catch (err) {
      setErrorMsg(`Validation failed: ${err instanceof Error ? err.message : String(err)}`);
      setSendStep("error");
      return;
    }

    setSendStep("confirm");
  };

  const handleSign = async () => {
    if (!pendingTx || !isManaged) return;
    setSendStep("signing");

    let signed: PendingTx;
    try {
      signed = await signTransaction(pendingTx);
      setPendingTx(signed);
      await updatePendingTx(signed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg === "WALLET_LOCKED" ? "Wallet locked — please unlock first." : `Signing failed: ${msg}`);
      setSendStep("error");
      return;
    }

    setSendStep("broadcast");
    try {
      await broadcastAndPoll(signed, async (updated) => {
        setPendingTx(updated);
        await updatePendingTx(updated);
        if (updated.state === "CONFIRMED") {
          setResultTxId(updated.txId ?? null);
          setSendStep("done");
          setUtxoReloadNonce((v) => v + 1);
          onBalanceInvalidated?.();
        }
        if (updated.state === "FAILED") {
          setErrorMsg(updated.error ?? "Transaction failed.");
          setSendStep("error");
        }
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Transaction timed out awaiting confirmation.");
      setSendStep("error");
    }
  };

  const handleCancel = async () => {
    if (pendingTx) await updatePendingTx({ ...pendingTx, state: "CANCELLED" });
    resetSend();
  };

  const resetSend = () => {
    setSendStep("idle");
    setPendingTx(null);
    setDryRunErrors([]);
    setErrorMsg(null);
    setResultTxId(null);
  };

  const copyAddress = async () => {
    if (!address) return;
    try { await navigator.clipboard.writeText(address); setAddrCopied(true); setTimeout(() => setAddrCopied(false), 2000); } catch { /* noop */ }
  };

  const openTokenDetails = (tokenId: TokenId) => {
    setSelectedTokenId(tokenId);
  };

  const closeTokenDetails = () => {
    setSelectedTokenId(null);
  };

  const resolveMetadataToken = async () => {
    const candidate = metadataAddressInput.trim();
    if (!candidate) {
      setMetadataResolveError("Paste a token address or search by symbol.");
      return;
    }
    setMetadataResolveBusy(true);
    setMetadataResolveError(null);
    try {
      const queryHit = await resolveTokenFromQuery(candidate, metadataStandard, network);
      const resolved = queryHit ?? await resolveTokenFromAddress(candidate, metadataStandard, network);
      setResolvedMetadata(resolved);
    } catch (err) {
      setResolvedMetadata(null);
      setMetadataResolveError(err instanceof Error ? err.message : "Metadata lookup failed.");
    } finally {
      setMetadataResolveBusy(false);
    }
  };

  const pasteTokenAddress = async () => {
    if (!navigator?.clipboard?.readText) {
      setMetadataResolveError("Clipboard read is unavailable in this browser.");
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      const trimmed = text.trim();
      if (!trimmed) {
        setMetadataResolveError("Clipboard is empty.");
        return;
      }
      setMetadataAddressInput(trimmed);
      setMetadataResolveError(null);
      setResolvedMetadata(null);
    } catch {
      setMetadataResolveError("Failed to read clipboard.");
    }
  };

  const displayTokens = [...getAllTokens()].sort((a, b) => {
    if (a.id === "KAS") return -1;
    if (b.id === "KAS") return 1;
    return 0;
  });
  const tokenLogoById: Record<string, string> = {
    KAS: "../icons/kaspa-logo.png",
    USDT: "../icons/usdt.png",
    USDC: "../icons/usdc.png",
  };
  const tokenBalanceById: Partial<Record<TokenId, number>> = {
    KAS: balance ?? 0,
    USDT: 0,
    USDC: 0,
    ZRX: 0,
  };
  const explorerBase = EXPLORERS[network] ?? EXPLORERS.mainnet;
  const explorerUrl = address ? `${explorerBase}/addresses/${address}` : explorerBase;
  const utxoTotalSompi = utxos.reduce((acc, u) => acc + u.amount, 0n);
  const utxoTotalKas = sompiToKas(utxoTotalSompi);
  const utxoLargestKas = utxos.length ? sompiToKas(utxos[0].amount) : 0;
  const utxoAverageKas = utxos.length ? utxoTotalKas / utxos.length : 0;
  const covenantUtxoCount = utxos.filter((u) => (u.scriptClass ?? "standard") === "covenant").length;
  const standardUtxoCount = utxos.length - covenantUtxoCount;
  const utxoUpdatedLabel = utxoUpdatedAt
    ? new Date(utxoUpdatedAt).toLocaleTimeString([], { hour12: false })
    : "—";
  const onChainVerified = Boolean(address && !utxoLoading && !utxoError && utxoUpdatedAt !== null);
  const verificationLabel = onChainVerified
    ? `ON-CHAIN VERIFIED · ${network.toUpperCase()} · ${utxoUpdatedLabel}`
    : utxoLoading
      ? "VERIFYING ON-CHAIN STATE…"
      : "ON-CHAIN VERIFICATION PENDING";
  const masked = (value: string) => (hideBalances ? "••••" : value);
  const maskedKas = (amount: number, digits: number) => (hideBalances ? "•••• KAS" : `${fmt(amount, digits)} KAS`);
  const maskedUsd = (amount: number, digits: number) => (hideBalances ? "$••••" : `$${fmt(amount, digits)}`);
  const selectedToken = selectedTokenId ? displayTokens.find((t) => t.id === selectedTokenId) ?? null : null;
  const showTokenOverlay = Boolean(selectedToken);
  const showActionOverlay = sendStep !== "idle" || showReceive;
  const kasSeries = kasPriceSeries.length > 0
    ? kasPriceSeries
    : liveKasPrice > 0
      ? [{ ts: Date.now(), price: liveKasPrice }]
      : [];
  const displayedKasSeries = kasSeries.slice(-Math.max(2, kasChartWindow));
  const kasFirstPrice = displayedKasSeries.length > 0 ? displayedKasSeries[0].price : 0;
  const kasLastPrice = displayedKasSeries.length > 0 ? displayedKasSeries[displayedKasSeries.length - 1].price : 0;
  const kasPriceDeltaPct = kasFirstPrice > 0
    ? ((kasLastPrice - kasFirstPrice) / kasFirstPrice) * 100
    : 0;
  const kasSeriesHigh = displayedKasSeries.length > 0 ? Math.max(...displayedKasSeries.map((p) => p.price)) : 0;
  const kasSeriesLow = displayedKasSeries.length > 0 ? Math.min(...displayedKasSeries.map((p) => p.price)) : 0;
  const kasWalletBalance = balance ?? 0;
  const kasWalletUsdValue = kasWalletBalance * (liveKasPrice > 0 ? liveKasPrice : 0);
  const canDismissSendOverlay = sendStep === "form" || sendStep === "error" || sendStep === "done";
  const canDismissOverlay = showTokenOverlay || showReceive || canDismissSendOverlay;
  const dismissOverlay = () => {
    if (showTokenOverlay) {
      closeTokenDetails();
      return;
    }
    if (showReceive) setShowReceive(false);
    if (sendStep !== "idle" && canDismissSendOverlay) resetSend();
  };
  const actionPanels = (
    <>
      {/* FORM */}
      {sendStep === "form" && (
        <div style={panel()}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
            <div style={sectionTitle}>SEND KAS</div>
            <div style={{ display: "flex", gap: 8 }}>
              {balance !== null && (
                <div style={{ fontSize: 8, color: C.dim }}>
                  Bal: {maskedKas(balance, 2)}
                  {usdPrice > 0 ? ` ≈ ${maskedUsd(balance * usdPrice, 2)}` : ""}
                </div>
              )}
              <button onClick={() => setSendStep("idle")} style={{ background: "none", border: "none", color: C.dim, fontSize: 8, cursor: "pointer", ...mono }}>✕</button>
            </div>
          </div>
          {!isManaged && <div style={{ ...insetCard(), fontSize: 8, color: C.dim, marginBottom: 6, lineHeight: 1.4 }}>External wallet: signing opens in Forge-OS.</div>}
          <input value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder={`Recipient ${networkPrefix}qp…`} style={inputStyle(Boolean(sendTo && !addressValid))} />
          {sendTo && !addressValid && <div style={{ fontSize: 8, color: C.danger }}>{!sendTo.toLowerCase().startsWith(networkPrefix) ? `Must start with "${networkPrefix}" on ${network}` : "Invalid Kaspa address"}</div>}
          {/* Amount input + MAX button */}
          <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <input
              value={sendAmt}
              onChange={(e) => setSendAmt(e.target.value)}
              placeholder="Amount (KAS)"
              type="number"
              min="0"
              style={{ ...inputStyle(false), paddingRight: 48 }}
            />
            {balance !== null && balance > 0 && (
              <button
                onClick={() => {
                  // Reserve ~0.01 KAS buffer for network fee
                  const maxAmt = Math.max(0, balance - 0.01);
                  setSendAmt(maxAmt > 0 ? String(parseFloat(maxAmt.toFixed(4))) : "");
                }}
                style={{
                  position: "absolute", right: 6, background: `${C.accent}20`,
                  border: `1px solid ${C.accent}50`, borderRadius: 4, padding: "2px 6px",
                  color: C.accent, fontSize: 8, fontWeight: 700, cursor: "pointer", ...mono,
                  letterSpacing: "0.06em",
                }}
              >MAX</button>
            )}
          </div>
          {amountNum > 0 && usdPrice > 0 && (
            <div style={{ fontSize: 8, color: C.dim }}>
              ≈ {maskedUsd(amountNum * usdPrice, 2)}
            </div>
          )}
          <button onClick={isManaged ? handleBuildAndValidate : () => chrome.tabs.create({ url: `https://forge-os.xyz?send=1&to=${encodeURIComponent(sendTo)}&amount=${encodeURIComponent(sendAmt)}` })} disabled={!formReady} style={submitBtn(formReady)}>
            {isManaged ? "PREVIEW SEND →" : "OPEN IN FORGE-OS →"}
          </button>
        </div>
      )}

      {/* Building / Dry-run */}
      {(sendStep === "building" || sendStep === "dry_run") && (
        <StatusCard icon="⚙" title={sendStep === "building" ? "SELECTING INPUTS…" : "VALIDATING…"} sub={sendStep === "building" ? "Fetching UTXOs and estimating network fee." : "Running 5 security checks."} color={C.accent} />
      )}

      {/* Confirm */}
      {sendStep === "confirm" && pendingTx && (
        <ConfirmPanel tx={pendingTx} usdPrice={usdPrice} onConfirm={handleSign} onCancel={handleCancel} />
      )}

      {/* Signing */}
      {sendStep === "signing" && <StatusCard icon="🔑" title="SIGNING…" sub="Deriving key and signing inputs with kaspa-wasm." color={C.warn} />}

      {/* Broadcast */}
      {sendStep === "broadcast" && (
        <StatusCard icon="📡" title="BROADCASTING…" sub={`Polling for confirmation. TxID: ${pendingTx?.txId ? pendingTx.txId.slice(0, 20) + "…" : "pending"}`} color={C.accent} />
      )}

      {/* Done */}
      {sendStep === "done" && (
        <div style={{ ...panel(), background: `${C.ok}0A`, borderColor: `${C.ok}30` }}>
          <div style={{ fontSize: 10, color: C.ok, fontWeight: 700, marginBottom: 6 }}>✓ TRANSACTION CONFIRMED</div>
          {resultTxId && (
            <>
              <div style={{ fontSize: 8, color: C.dim, marginBottom: 3 }}>Transaction ID</div>
              <div style={{ fontSize: 8, color: C.text, wordBreak: "break-all", marginBottom: 8 }}>{resultTxId}</div>
              <button onClick={() => chrome.tabs.create({ url: `${explorerBase}/txs/${resultTxId}` })} style={{ background: "none", border: "none", color: C.accent, fontSize: 8, cursor: "pointer", ...mono }}>View on Explorer ↗</button>
            </>
          )}
          <button onClick={resetSend} style={{ ...submitBtn(true), marginTop: 10, background: `${C.ok}20`, color: C.ok }}>DONE</button>
        </div>
      )}

      {/* Error */}
      {sendStep === "error" && (
        <div style={{ ...panel(), background: C.dLow, borderColor: `${C.danger}40` }}>
          <div style={{ fontSize: 9, color: C.danger, fontWeight: 700, marginBottom: 6 }}>TRANSACTION FAILED</div>
          {errorMsg && <div style={{ fontSize: 8, color: C.dim, marginBottom: 6, lineHeight: 1.5 }}>{errorMsg}</div>}
          {dryRunErrors.map((e, i) => <div key={i} style={{ fontSize: 8, color: C.danger, marginBottom: 2 }}>• {e}</div>)}
          <button onClick={resetSend} style={{ ...submitBtn(true), marginTop: 8, background: C.dLow, border: `1px solid ${C.danger}50`, color: C.danger }}>TRY AGAIN</button>
        </div>
      )}

      {/* Receive */}
      {showReceive && address && (
        <div style={panel()}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <div style={sectionTitle}>RECEIVE KAS</div>
            <button onClick={() => setShowReceive(false)} style={{ background: "none", border: "none", color: C.dim, fontSize: 8, cursor: "pointer", ...mono }}>✕</button>
          </div>
          <div style={{ ...insetCard(), display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
            <div style={{ fontSize: 8, color: onChainVerified ? C.ok : C.warn, fontWeight: 700, letterSpacing: "0.06em" }}>
              {verificationLabel}
            </div>
            <button
              onClick={() => chrome.tabs.create({ url: explorerUrl })}
              style={{ ...outlineButton(C.accent, true), padding: "4px 7px", fontSize: 8, color: C.accent, flexShrink: 0 }}
            >
              EXPLORER ↗
            </button>
          </div>
          <div style={{ ...insetCard(), display: "flex", justifyContent: "center", alignItems: "center", minHeight: 140, marginBottom: 6 }}>
            {receiveQrDataUrl ? (
              <img
                src={receiveQrDataUrl}
                alt="Wallet receive QR"
                style={{ width: 138, height: 138, borderRadius: 8, border: `1px solid ${C.border}` }}
              />
            ) : (
              <div style={{ fontSize: 8, color: receiveQrError ? C.danger : C.dim }}>
                {receiveQrError ? "QR ERROR" : "GENERATING QR…"}
              </div>
            )}
          </div>
          <div style={{ fontSize: 8, color: C.muted, letterSpacing: "0.08em" }}>CONNECTED WALLET ADDRESS</div>
          <div style={{ ...insetCard(), fontSize: 8, color: C.dim, lineHeight: 1.6, wordBreak: "break-all", marginBottom: 6 }}>{address}</div>
          <button onClick={copyAddress} style={{ ...outlineButton(addrCopied ? C.ok : C.dim, true), padding: "7px 8px", color: addrCopied ? C.ok : C.dim, width: "100%" }}>
            {addrCopied ? "✓ COPIED" : "COPY ADDRESS"}
          </button>
          <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.5, marginTop: 4 }}>
            Send KAS to this address from any Kaspa wallet. Funds and UTXO state are verified against live on-chain data.
          </div>
        </div>
      )}
    </>
  );

  const tokenDetailsPanel = selectedToken ? (
    <div style={panel()}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={sectionTitle}>TOKEN ANALYTICS</div>
        <button
          onClick={closeTokenDetails}
          style={{ background: "none", border: "none", color: C.dim, fontSize: 9, cursor: "pointer", ...mono }}
        >
          ✕
        </button>
      </div>

      <div style={{ ...insetCard(), display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <img
            src={tokenLogoById[selectedToken.id] ?? tokenLogoById.KAS}
            alt={`${selectedToken.symbol} logo`}
            style={{ width: 32, height: 32, borderRadius: "50%", objectFit: "contain" }}
          />
          <div>
            <div style={{ fontSize: 11, color: C.text, fontWeight: 700, letterSpacing: "0.05em", ...mono }}>
              {selectedToken.symbol}
            </div>
            <div style={{ fontSize: 8, color: C.dim }}>
              {selectedToken.name} · {network.toUpperCase()}
            </div>
          </div>
        </div>
        <div
          style={{
            ...outlineButton(selectedToken.id === "KAS" ? C.ok : C.warn, true),
            padding: "4px 7px",
            fontSize: 8,
            color: selectedToken.id === "KAS" ? C.ok : C.warn,
          }}
        >
          {selectedToken.id === "KAS" ? "LIVE FEED" : "METADATA FEED"}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
        <MetricTile
          label={selectedToken.id === "KAS" ? "LIVE PRICE" : "TOKEN STATUS"}
          value={selectedToken.id === "KAS" ? maskedUsd(liveKasPrice || usdPrice || 0, 4) : (selectedToken.enabled ? "ENABLED" : "READ-ONLY")}
          tone={selectedToken.id === "KAS" ? C.accent : selectedToken.enabled ? C.ok : C.warn}
        />
        <MetricTile
          label={selectedToken.id === "KAS" ? "SESSION Δ" : "DECIMALS"}
          value={selectedToken.id === "KAS" ? `${hideBalances ? "••••" : `${kasPriceDeltaPct >= 0 ? "+" : ""}${fmt(kasPriceDeltaPct, 2)}%`}` : String(selectedToken.decimals)}
          tone={selectedToken.id === "KAS" ? (kasPriceDeltaPct >= 0 ? C.ok : C.danger) : C.text}
        />
        <MetricTile
          label={selectedToken.id === "KAS" ? "BALANCE" : "TOKEN ID"}
          value={selectedToken.id === "KAS"
            ? maskedKas(kasWalletBalance, 4)
            : selectedToken.id}
          tone={C.text}
        />
        <MetricTile
          label={selectedToken.id === "KAS" ? "USD VALUE" : "FEED UPDATE"}
          value={selectedToken.id === "KAS"
            ? maskedUsd(kasWalletUsdValue, 2)
            : (kasFeedUpdatedAt ? new Date(kasFeedUpdatedAt).toLocaleTimeString([], { hour12: false }) : "—")}
          tone={selectedToken.id === "KAS" ? C.accent : C.dim}
        />
      </div>

      <div style={insetCard()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ fontSize: 8, color: C.dim, letterSpacing: "0.08em", display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: kasFeedError ? C.danger : C.ok,
                boxShadow: kasFeedError ? `0 0 6px ${C.danger}` : `0 0 6px ${C.ok}`,
              }}
            />
            {selectedToken.id === "KAS" ? "REAL-TIME KAS/USD CHART" : "BASE LAYER LIVE CHART"}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {([60, 300, KAS_CHART_MAX_POINTS] as const).map((windowSize) => (
              <button
                key={windowSize}
                onClick={() => setKasChartWindow(windowSize)}
                style={{
                  ...outlineButton(kasChartWindow === windowSize ? C.accent : C.dim, true),
                  padding: "3px 6px",
                  fontSize: 8,
                  color: kasChartWindow === windowSize ? C.accent : C.dim,
                }}
              >
                {windowSize === 60 ? "1M" : windowSize === 300 ? "5M" : "15M"}
              </button>
            ))}
            <button
              onClick={() => setKasFeedRefreshNonce((value) => value + 1)}
              style={{ ...outlineButton(C.dim, true), padding: "3px 6px", fontSize: 8, color: C.dim }}
            >
              REFRESH
            </button>
          </div>
        </div>
        <LiveLineChart points={displayedKasSeries} color={C.accent} />
        <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", fontSize: 8, color: C.dim }}>
          <span>LOW {maskedUsd(kasSeriesLow, 4)}</span>
          <span>HIGH {maskedUsd(kasSeriesHigh, 4)}</span>
        </div>
        <div style={{ marginTop: 4, display: "flex", justifyContent: "space-between", fontSize: 8, color: C.muted }}>
          <span>{kasFeedUpdatedAt ? `updated ${new Date(kasFeedUpdatedAt).toLocaleTimeString([], { hour12: false })}` : "awaiting feed"}</span>
          <span>{displayedKasSeries.length} ticks · 1s cadence</span>
        </div>
        {selectedToken.id !== "KAS" && (
          <div style={{ marginTop: 6, fontSize: 8, color: C.dim, lineHeight: 1.45 }}>
            Spot chart reflects live Kaspa base feed. Token-specific pricing requires a trusted market route.
          </div>
        )}
      </div>

      <div style={insetCard()}>
        <div style={{ fontSize: 8, color: C.dim, letterSpacing: "0.08em", marginBottom: 5 }}>ON-CHAIN TECHNICALS</div>
        <div style={{ fontSize: 8, color: C.text, lineHeight: 1.55 }}>
          Network BPS: <span style={{ color: C.accent }}>{NETWORK_BPS[network] ?? 10}</span>
        </div>
        <div style={{ fontSize: 8, color: C.text, lineHeight: 1.55 }}>
          Virtual DAA: <span style={{ color: C.accent }}>{networkDaaScore ?? "—"}</span>
        </div>
        <div style={{ fontSize: 8, color: C.text, lineHeight: 1.55 }}>
          Spendable UTXOs: <span style={{ color: C.ok }}>{standardUtxoCount}</span> · Covenant UTXOs:{" "}
          <span style={{ color: covenantUtxoCount > 0 ? C.warn : C.dim }}>{covenantUtxoCount}</span>
        </div>
        <div style={{ fontSize: 8, color: C.text, lineHeight: 1.55 }}>
          Largest UTXO: <span style={{ color: C.accent }}>{maskedKas(utxoLargestKas, 4)}</span> · Avg UTXO:{" "}
          <span style={{ color: C.accent }}>{maskedKas(utxoAverageKas, 4)}</span>
        </div>
        {kasFeedError && (
          <div style={{ fontSize: 8, color: C.danger, marginTop: 5, lineHeight: 1.45 }}>
            Feed warning: {kasFeedError}
          </div>
        )}
      </div>

      {selectedToken.id !== "KAS" && (
        <div style={insetCard()}>
          <div style={{ fontSize: 8, color: C.dim, letterSpacing: "0.08em", marginBottom: 6 }}>
            KRC TOKEN ADDRESS LOOKUP
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input
              value={metadataAddressInput}
              onChange={(event) => setMetadataAddressInput(event.target.value)}
              placeholder="Search symbol/name or paste token address…"
              style={{ ...inputStyle(Boolean(metadataResolveError)), flex: 1, marginBottom: 0 }}
            />
            <button
              onClick={pasteTokenAddress}
              style={{ ...outlineButton(C.dim, true), padding: "7px 8px", color: C.dim, fontSize: 8 }}
            >
              PASTE
            </button>
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            {(["krc20", "krc721"] as KaspaTokenStandard[]).map((standard) => (
              <button
                key={standard}
                onClick={() => setMetadataStandard(standard)}
                style={{
                  ...outlineButton(metadataStandard === standard ? C.accent : C.dim, true),
                  padding: "6px 8px",
                  color: metadataStandard === standard ? C.accent : C.dim,
                  fontSize: 8,
                  flex: 1,
                }}
              >
                {standard.toUpperCase()}
              </button>
            ))}
          </div>
          <button
            onClick={resolveMetadataToken}
            disabled={metadataResolveBusy || !metadataAddressInput.trim()}
            style={{ ...submitBtn(Boolean(metadataAddressInput.trim()) && !metadataResolveBusy), marginTop: 0 }}
          >
            {metadataResolveBusy ? "RESOLVING…" : "RESOLVE TOKEN METADATA"}
          </button>
          {metadataResolveError && (
            <div style={{ fontSize: 8, color: C.danger, marginTop: 6, lineHeight: 1.45 }}>
              {metadataResolveError}
            </div>
          )}
          {resolvedMetadata && (
            <div style={{ ...insetCard(), marginTop: 7 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                <img
                  src={resolvedMetadata.logoUri}
                  alt={`${resolvedMetadata.symbol} logo`}
                  style={{ width: 26, height: 26, borderRadius: "50%", objectFit: "cover", border: `1px solid ${C.border}` }}
                />
                <div>
                  <div style={{ fontSize: 10, color: C.text, fontWeight: 700, ...mono }}>{resolvedMetadata.symbol}</div>
                  <div style={{ fontSize: 8, color: C.dim }}>{resolvedMetadata.name}</div>
                </div>
              </div>
              <div style={{ fontSize: 8, color: C.text, lineHeight: 1.5, wordBreak: "break-all" }}>
                {resolvedMetadata.address}
              </div>
              <div style={{ fontSize: 8, color: C.dim, marginTop: 4 }}>
                Standard: {resolvedMetadata.standard.toUpperCase()} · Decimals: {resolvedMetadata.decimals}
              </div>
            </div>
          )}
          <div style={{ fontSize: 7, color: C.muted, lineHeight: 1.45, marginTop: 6 }}>
            Resolver is env-driven with bounded LRU + endpoint health scoring for low-latency repeated lookups.
          </div>
        </div>
      )}
    </div>
  ) : null;

  return (
    <div style={{ ...popupTabStack, position: "relative" }}>
      {(showActionOverlay || showTokenOverlay) && (
        <div
          style={overlayBackdrop}
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            if (!canDismissOverlay) return;
            dismissOverlay();
          }}
        >
          <div style={overlayCard}>
            {showTokenOverlay ? tokenDetailsPanel : actionPanels}
          </div>
        </div>
      )}

      {/* Token card */}
      <div style={{
        ...sectionCard("purple"),
        background: "linear-gradient(165deg, rgba(10,18,28,0.96) 0%, rgba(7,13,22,0.93) 52%, rgba(5,10,18,0.94) 100%)",
        border: `1px solid ${C.accent}3A`,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06), 0 12px 26px rgba(0,0,0,0.28), 0 0 24px rgba(57,221,182,0.09)",
      }}>
        <div
          style={{
            position: "absolute",
            top: -32,
            right: -26,
            width: 130,
            height: 130,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(57,221,182,0.26) 0%, rgba(57,221,182,0.05) 48%, transparent 75%)",
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent 0px, transparent 23px, rgba(57,221,182,0.05) 24px), repeating-linear-gradient(90deg, transparent 0px, transparent 23px, rgba(57,221,182,0.04) 24px)",
            opacity: 0.45,
          }}
        />

        <div style={{ marginBottom: 11, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, position: "relative" }}>
          <div style={sectionKicker}>TOKEN BALANCES</div>
        </div>

        {displayTokens.map((token, idx) => {
          const tokenLogo = tokenLogoById[token.id] ?? tokenLogoById.KAS;
          const isKasToken = token.id === "KAS";
          const logoBadgeSize = isKasToken ? 48 : 30;
          const logoSize = isKasToken ? 40 : 20;
          const tokenBalanceUnits = tokenBalanceById[token.id as TokenId] ?? 0;
          const tokenAmountLabelRaw = token.id === "KAS" ? fmt(tokenBalanceUnits, 4) : fmt(tokenBalanceUnits, 2);
          const tokenAmountLabel = masked(tokenAmountLabelRaw);
          return (
          <button
            key={token.id}
            onClick={() => openTokenDetails(token.id as TokenId)}
            style={{
              width: "100%",
              border: "none",
              textAlign: "left",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "linear-gradient(160deg, rgba(15,24,36,0.86), rgba(8,14,22,0.88))",
              borderRadius: 12,
              padding: "10px 11px",
              marginTop: idx > 0 ? 8 : 0,
              opacity: isKasToken ? 1 : token.enabled ? 1 : 0.58,
              position: "relative",
              zIndex: 1,
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                border: `1px solid ${selectedTokenId === token.id ? `${C.accent}75` : C.border}`,
                borderRadius: 12,
                pointerEvents: "none",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: logoBadgeSize,
                height: logoBadgeSize,
                borderRadius: "50%",
                flexShrink: 0,
                background: "transparent",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "none",
                boxShadow: "none",
                overflow: "hidden",
              }}>
                <img
                  src={tokenLogo}
                  alt={`${token.symbol} logo`}
                  style={{
                    width: logoSize,
                    height: logoSize,
                    objectFit: "contain",
                    borderRadius: "50%",
                    filter: "none",
                  }}
                />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.text, letterSpacing: "0.05em", ...mono }}>{token.symbol}</div>
                <div style={{ fontSize: 9, color: C.dim, letterSpacing: "0.03em" }}>{token.name}</div>
              </div>
            </div>
            <div style={{ textAlign: "right", paddingRight: 12 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>
                {tokenAmountLabel}
              </div>
              {!token.enabled && token.disabledReason && (
                <div style={{ fontSize: 8, color: C.dim, maxWidth: 140, lineHeight: 1.35, marginTop: 3 }}>
                  {token.disabledReason}
                </div>
              )}
            </div>
            <div style={{ fontSize: 10, color: C.dim, ...mono }}>→</div>
          </button>
        )})}

        {address && (
          <div style={{ marginTop: 11, textAlign: "right", position: "relative", zIndex: 1 }}>
            <button
              onClick={() => chrome.tabs.create({ url: explorerUrl })}
              style={{ ...outlineButton(C.accent, true), padding: "6px 9px", fontSize: 9, color: C.accent }}
            >
              EXPLORER ↗
            </button>
          </div>
        )}
      </div>

      {/* UTXO card */}
      <div style={sectionCard("default")}>
        <div style={{ marginBottom: 9, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={sectionKicker}>UTXO SET</div>
          <button
            onClick={() => setUtxoReloadNonce((v) => v + 1)}
            disabled={utxoLoading}
            style={{ ...outlineButton(C.accent, true), padding: "5px 8px", fontSize: 8, color: C.accent }}
          >
            {utxoLoading ? "SYNC…" : "REFRESH"}
          </button>
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 9 }}>
          <div style={{ ...insetCard(), flex: 1, padding: "6px 7px" }}>
            <div style={{ fontSize: 8, color: C.muted, letterSpacing: "0.08em" }}>COUNT</div>
            <div style={{ fontSize: 11, color: C.text, fontWeight: 700, ...mono }}>{utxos.length}</div>
          </div>
          <div style={{ ...insetCard(), flex: 1, padding: "6px 7px" }}>
            <div style={{ fontSize: 8, color: C.muted, letterSpacing: "0.08em" }}>TOTAL</div>
            <div style={{ fontSize: 11, color: C.text, fontWeight: 700, ...mono }}>{maskedKas(utxoTotalKas, 4)}</div>
          </div>
          <div style={{ ...insetCard(), flex: 1, padding: "6px 7px" }}>
            <div style={{ fontSize: 8, color: C.muted, letterSpacing: "0.08em" }}>LARGEST</div>
            <div style={{ fontSize: 11, color: C.text, fontWeight: 700, ...mono }}>{maskedKas(utxoLargestKas, 4)}</div>
          </div>
        </div>

        {covenantUtxoCount > 0 && (
          <div style={{ ...insetCard(), fontSize: 8, color: C.warn, padding: "8px 10px", marginBottom: 8, lineHeight: 1.45 }}>
            Covenant outputs detected: {covenantUtxoCount}. Standard send currently uses spendable UTXOs only ({standardUtxoCount} available).
          </div>
        )}

        {utxoLoading && utxos.length === 0 && (
          <div style={{ ...insetCard(), fontSize: 8, color: C.dim, padding: "9px 10px" }}>
            Fetching UTXOs from {network}…
          </div>
        )}

        {!utxoLoading && utxos.length === 0 && !utxoError && (
          <div style={{ ...insetCard(), fontSize: 8, color: C.dim, padding: "9px 10px" }}>
            No UTXOs found for this wallet on {network}.
          </div>
        )}

        {utxoError && (
          <div style={{ ...insetCard(), fontSize: 8, color: C.danger, padding: "9px 10px", marginBottom: utxos.length ? 8 : 0 }}>
            {utxoError}
          </div>
        )}

        {utxos.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {utxos.slice(0, 6).map((u, idx) => {
              const utxoKas = sompiToKas(u.amount);
              return (
                <div key={`${u.txId}:${u.outputIndex}`} style={{ ...insetCard(), padding: "8px 9px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 8, color: C.dim, ...mono, letterSpacing: "0.04em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        #{idx + 1} {u.txId.slice(0, 16)}…:{u.outputIndex}
                      </div>
                      <div style={{ fontSize: 8, color: C.muted, marginTop: 2 }}>
                        DAA {u.blockDaaScore.toString()} {u.isCoinbase ? "· COINBASE" : ""} {(u.scriptClass ?? "standard") === "covenant" ? "· COVENANT" : ""}
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: C.accent, fontWeight: 700, ...mono }}>
                      {maskedKas(utxoKas, 4)}
                    </div>
                  </div>
                </div>
              );
            })}

            {utxos.length > 6 && (
              <div style={{ fontSize: 8, color: C.dim, textAlign: "right", paddingTop: 1 }}>
                +{utxos.length - 6} more UTXOs
              </div>
            )}
          </div>
        )}

        <div style={{ ...divider(), margin: "9px 0 6px" }} />
        <div style={{ fontSize: 8, color: C.muted, letterSpacing: "0.06em", textAlign: "right" }}>
          UPDATED {utxoUpdatedLabel}
        </div>
      </div>

    </div>
  );
}

// ── Style helpers ─────────────────────────────────────────────────────────────

const panel = (): React.CSSProperties => ({
  ...sectionCard("default"),
  display: "flex", flexDirection: "column", gap: 7,
});

const inputStyle = (hasError: boolean): React.CSSProperties => ({
  ...monoInput(hasError),
});

const submitBtn = (active: boolean): React.CSSProperties => ({
  ...primaryButton(active),
  padding: "9px",
  width: "100%",
});

const overlayBackdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 50,
  background: "rgba(3, 7, 12, 0.78)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "12px 10px 14px",
  backdropFilter: "blur(1px)",
};

const overlayCard: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  maxHeight: "calc(100vh - 26px)",
  overflowY: "auto",
};

function MetricTile({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div style={{ ...insetCard(), padding: "7px 8px" }}>
      <div style={{ fontSize: 8, color: C.dim, letterSpacing: "0.07em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 10, color: tone, fontWeight: 700, ...mono }}>{value}</div>
    </div>
  );
}

function LiveLineChart({ points, color }: { points: PricePoint[]; color: string }) {
  const width = 340;
  const height = 118;
  const pad = 10;
  if (points.length < 2) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: C.dim, fontSize: 8 }}>
        Waiting for enough live points…
      </div>
    );
  }

  const min = Math.min(...points.map((point) => point.price));
  const max = Math.max(...points.map((point) => point.price));
  const range = Math.max(1e-9, max - min);
  const usableW = width - pad * 2;
  const usableH = height - pad * 2;
  const stepX = usableW / Math.max(1, points.length - 1);

  const line = points
    .map((point, index) => {
      const x = pad + stepX * index;
      const y = pad + (max - point.price) / range * usableH;
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");

  const area = `${line} L ${pad + usableW} ${height - pad} L ${pad} ${height - pad} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="Live token chart">
      <defs>
        <linearGradient id="wallet-chart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#wallet-chart-fill)" />
      <path d={line} fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatusCard({ icon, title, sub, color }: { icon: string; title: string; sub: string; color: string }) {
  return (
    <div style={{ ...panel(), textAlign: "center" as const }}>
      <div style={{ fontSize: 20 }}>{icon}</div>
      <div style={{ fontSize: 9, color, fontWeight: 700, letterSpacing: "0.1em" }}>{title}</div>
      <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.5 }}>{sub}</div>
    </div>
  );
}

function ConfirmPanel({ tx, usdPrice, onConfirm, onCancel }: { tx: PendingTx; usdPrice: number; onConfirm: () => void; onCancel: () => void }) {
  const toAmt = tx.outputs[0];
  const toKas = toAmt ? sompiToKas(toAmt.amount) : 0;
  const feeKas = sompiToKas(tx.fee);
  const platformFeeKas = tx.platformFee ? sompiToKas(tx.platformFee) : 0;
  const changeKas = tx.changeOutput ? sompiToKas(tx.changeOutput.amount) : 0;
  const totalCost = toKas + feeKas + platformFeeKas;

  const row = (label: string, value: string, color = C.text, sub?: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
      <span style={{ fontSize: 8, color: C.dim }}>
        {label}
        {sub && <span style={{ fontSize: 8, color: C.muted, marginLeft: 4 }}>{sub}</span>}
      </span>
      <span style={{ fontSize: 9, color, fontWeight: 700 }}>{value}</span>
    </div>
  );

  return (
    <div style={{ ...panel(), borderColor: `${C.accent}30` }}>
      <div style={{ ...sectionTitle, color: C.accent }}>CONFIRM TRANSACTION</div>
      <div style={insetCard()}>
        {row("TO", tx.outputs[0]?.address ? tx.outputs[0].address.slice(0, 22) + "…" : "—")}
        {row("AMOUNT", `${fmt(toKas, 4)} KAS${usdPrice > 0 ? ` ≈ $${fmt(toKas * usdPrice, 2)}` : ""}`)}
        {row("NETWORK FEE", `${fmt(feeKas, 8)} KAS`, C.warn, "→ miners")}
        {platformFeeKas > 0 && row("PLATFORM FEE", `${fmt(platformFeeKas, 6)} KAS`, C.dim, "→ treasury")}
        {changeKas > 0 && row("CHANGE", `${fmt(changeKas, 4)} KAS`, C.dim)}
        <div style={{ ...divider(), margin: "6px 0" }} />
        {row("TOTAL COST", `${fmt(totalCost, 4)} KAS`, C.accent)}
      </div>
      <div style={{ fontSize: 8, color: C.warn, lineHeight: 1.5 }}>⚠ Kaspa transactions are irreversible once confirmed.</div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onCancel} style={{ ...outlineButton(C.dim, true), flex: 1, padding: "8px 0" }}>CANCEL</button>
        <button onClick={onConfirm} style={{ ...primaryButton(true), flex: 2, padding: "8px 0" }}>SIGN & SEND →</button>
      </div>
    </div>
  );
}
