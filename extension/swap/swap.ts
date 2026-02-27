// Swap gating logic + real quote/execution adapters.
// All public functions are safe to call regardless of SWAP_CONFIG.enabled;
// they return appropriate disabled/null responses rather than throwing.

import type { SwapRequest, SwapQuote } from "./types";
import { SWAP_CONFIG } from "./types";
import { isTokenEnabled } from "../tokens/registry";
import { getSession } from "../vault/vault";
import { getNetwork } from "../shared/storage";
import { resolveSwapRouteSource } from "./routeSource";
import { validateSwapTransactionTarget } from "./signingDomain";
import { withKaspaAddressNetwork } from "../../src/helpers";
import { fetchTransaction } from "../network/kaspaClient";
import {
  connectMetaMaskSidecar,
  extractReceiptBlockNumber,
  extractReceiptStatus,
  fetchEvmBlockNumber,
  fetchEvmTransactionReceipt,
  getEvmSidecarSession,
  isEvmChainAllowed,
  sendEvmTransaction,
  type EvmSidecarSession,
} from "./evmSidecar";
import {
  buildZeroExQuoteFetchConfig,
  fetchZeroExQuote,
} from "./0xAdapter";
import {
  extractKaspaNativeQuoteMeta,
  fetchKaspaNativeExecutionStatus,
  fetchKaspaNativeQuote,
  submitKaspaNativeExecution,
} from "./kaspaNativeAdapter";
import {
  advanceSwapSettlement,
  createSwapSettlementRecord,
  type SwapSettlementRecord,
} from "./settlement";
import {
  isPendingSettlement,
  listSwapSettlements,
  upsertSwapSettlement,
} from "./settlementStore";
import { addPendingTx, updatePendingTx } from "../tx/store";
import { buildTransaction } from "../tx/builder";
import { dryRunValidate } from "../tx/dryRun";
import { signTransaction } from "../tx/signer";
import { broadcastTransaction } from "../tx/broadcast";

export interface SwapGatingStatus {
  enabled: boolean;
  reason: string | null; // Non-null explains why swap is disabled
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getActiveEvmSession(): EvmSidecarSession | null {
  const s = getEvmSidecarSession();
  if (!s) return null;
  return isEvmChainAllowed(s.chainId) ? s : null;
}

const KASPA_NETWORKS = ["mainnet", "testnet-10", "testnet-11", "testnet-12"] as const;
const SOMPI_PER_KAS = 100_000_000;

function kasFromSompi(sompi: bigint): number {
  const kas = Number(sompi) / SOMPI_PER_KAS;
  if (!Number.isFinite(kas) || kas <= 0) {
    throw new Error("KASPA_NATIVE_EXECUTION_INVALID_AMOUNT");
  }
  return kas;
}

async function currentSwapNetwork(): Promise<string> {
  const net = await getNetwork().catch(() => "mainnet");
  if (net === "mainnet" || net === "testnet-10" || net === "testnet-11" || net === "testnet-12") return net;
  return "mainnet";
}

function failSettlement(
  settlement: SwapSettlementRecord,
  message: string,
  state: "FAILED_BRIDGE" | "FAILED_TIMEOUT" | "FAILED_REVERT" = "FAILED_BRIDGE",
): SwapSettlementRecord {
  return advanceSwapSettlement(settlement, state, { error: message });
}

async function isKaspaTxConfirmed(txId: string): Promise<boolean> {
  for (const network of KASPA_NETWORKS) {
    const tx = await fetchTransaction(txId, network).catch(() => null);
    if (tx?.acceptingBlockHash) return true;
  }
  return false;
}

function isEvmRouteConfigured(): { ok: boolean; reason: string | null } {
  if (!SWAP_CONFIG.zeroExQuoteEndpoint) {
    return { ok: false, reason: "0x quote endpoint is not configured." };
  }
  if (!SWAP_CONFIG.zeroExExpectedSettlerTo) {
    return { ok: false, reason: "0x settler target is not configured." };
  }
  return { ok: true, reason: null };
}

/**
 * Return the current gating status for the swap feature.
 * Call this before rendering any interactive swap UI.
 */
export function getSwapGatingStatus(): SwapGatingStatus {
  if (!SWAP_CONFIG.enabled) {
    return { enabled: false, reason: "Swap functionality not yet active on Kaspa." };
  }

  if (SWAP_CONFIG.routeSource === "blocked") {
    return { enabled: false, reason: "Swap routes are currently disabled on Kaspa." };
  }

  if (SWAP_CONFIG.routeSource === "kaspa_native") return { enabled: true, reason: null };

  const routeCfg = isEvmRouteConfigured();
  if (!routeCfg.ok) return { enabled: false, reason: routeCfg.reason };

  return { enabled: true, reason: null };
}

/**
 * Validate a swap request before requesting a quote.
 * Returns a list of errors (empty = valid).
 */
export function validateSwapRequest(req: SwapRequest): string[] {
  const errors: string[] = [];
  const customOut = req.customTokenOut ?? null;
  const usesCustomOut = Boolean(customOut);
  const routeTokenOut = usesCustomOut ? "USDC" : req.tokenOut;

  if (!usesCustomOut && req.tokenIn === req.tokenOut) {
    errors.push("Token in and token out must be different.");
  }

  const route = resolveSwapRouteSource(req.tokenIn, routeTokenOut, SWAP_CONFIG.routeSource);
  if (!route.allowed && route.reason) {
    errors.push(route.reason);
  }

  if (!isTokenEnabled(req.tokenIn)) {
    errors.push(`${req.tokenIn} is not currently available.`);
  }

  if (!usesCustomOut && !isTokenEnabled(req.tokenOut)) {
    errors.push(`${req.tokenOut} is not currently available.`);
  }

  if (usesCustomOut) {
    const address = String(customOut?.address ?? "").trim();
    if (!address) {
      errors.push("Custom token address is required.");
    }
    if (customOut?.standard !== "krc20" && customOut?.standard !== "krc721") {
      errors.push("Custom token standard must be KRC20 or KRC721.");
    }
  }

  if (req.amountIn <= 0n) {
    errors.push("Amount must be greater than zero.");
  }

  if (req.slippageBps < 0 || req.slippageBps > SWAP_CONFIG.maxSlippageBps) {
    errors.push(
      `Slippage must be between 0 and ${SWAP_CONFIG.maxSlippageBps} bps (${SWAP_CONFIG.maxSlippageBps / 100}%).`,
    );
  }

  if (route.source === "evm_0x") {
    const routeCfg = isEvmRouteConfigured();
    if (!routeCfg.ok && routeCfg.reason) errors.push(routeCfg.reason);
  }

  if (route.source === "kaspa_native") {
    if (!SWAP_CONFIG.dexEndpoint) {
      errors.push("Kaspa-native DEX endpoint is not configured.");
    }
    if (req.tokenIn !== "KAS") {
      errors.push("Kaspa-native swap currently supports KAS as the input token.");
    }
  } else if (usesCustomOut) {
    errors.push("Custom KRC token output requires kaspa-native swap route.");
  }

  return errors;
}

/**
 * Fetch a swap quote from the configured DEX.
 * Always returns null when SWAP_CONFIG.enabled = false.
 * Throws on network/validation error when enabled.
 */
export async function getSwapQuote(req: SwapRequest): Promise<SwapQuote | null> {
  const gating = getSwapGatingStatus();
  if (!gating.enabled) return null;

  const validationErrors = validateSwapRequest(req);
  if (validationErrors.length > 0) {
    throw new Error(`SWAP_VALIDATION: ${validationErrors.join("; ")}`);
  }

  const routeTokenOut = req.customTokenOut ? "USDC" : req.tokenOut;
  const route = resolveSwapRouteSource(req.tokenIn, routeTokenOut, SWAP_CONFIG.routeSource);
  if (route.source === "kaspa_native") {
    const endpoint = SWAP_CONFIG.dexEndpoint;
    if (!endpoint) {
      throw new Error("KASPA_NATIVE_ROUTE_UNAVAILABLE: dex endpoint is not configured.");
    }
    const session = getSession();
    if (!session?.mnemonic) {
      throw new Error("KASPA_NATIVE_SIGNER_REQUIRED: unlock managed Kaspa wallet.");
    }
    const network = await currentSwapNetwork();
    const walletAddress = withKaspaAddressNetwork(session.address, network);
    const quote = await fetchKaspaNativeQuote(req, {
      endpoint,
      network,
      walletAddress,
    });
    return {
      ...quote,
      customTokenOut: req.customTokenOut ?? null,
    };
  }

  if (route.source === "evm_0x") {
    const evmSession = getActiveEvmSession();
    if (!evmSession) {
      throw new Error("EVM_SIDECAR_REQUIRED: connect external EVM signer first.");
    }
    const quoteCfg = buildZeroExQuoteFetchConfig(
      req,
      evmSession,
      {
        endpoint: SWAP_CONFIG.zeroExQuoteEndpoint || "",
        apiKey: SWAP_CONFIG.zeroExApiKey || undefined,
        expectedSettlerTo: SWAP_CONFIG.zeroExExpectedSettlerTo,
        expectedAllowanceSpender: SWAP_CONFIG.zeroExExpectedAllowanceSpender || undefined,
      },
    );
    const raw = await fetchZeroExQuote(
      quoteCfg,
      SWAP_CONFIG.evmChainIdAllowlist,
      evmSession.chainId,
    );
    const amountOut = BigInt(raw.minBuyAmount || raw.buyAmount || "0");
    const txTo = typeof raw.transaction?.to === "string" ? raw.transaction.to : "";
    const txData = typeof raw.transaction?.data === "string" ? raw.transaction.data : "";
    if (!txTo || !txData) {
      throw new Error("ZEROX_QUOTE_INVALID: missing transaction payload.");
    }
    return {
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      amountIn: req.amountIn,
      amountOut,
      priceImpact: 0,
      fee: 0n,
      route: raw.route?.fills?.map((f) => String(f?.source || "0x")) || ["0x"],
      validUntil: Date.now() + 30_000,
      dexEndpoint: SWAP_CONFIG.zeroExQuoteEndpoint || "https://api.0x.org",
      routeSource: "evm_0x",
      transaction: {
        to: txTo,
        data: txData,
        value: typeof raw.transaction?.value === "string" ? raw.transaction.value : "0x0",
      },
      allowanceSpender: raw.issues?.allowance?.spender,
      rawQuote: raw,
      customTokenOut: req.customTokenOut ?? null,
    };
  }

  throw new Error(`SWAP_ROUTE_UNSUPPORTED: ${route.source}`);
}

async function refreshEvmSettlement(record: SwapSettlementRecord): Promise<SwapSettlementRecord> {
  if (!record.txHash || record.routeSource !== "evm_0x" || !isPendingSettlement(record)) return record;
  if ((record.createdAt + SWAP_CONFIG.settlementTimeoutMs) <= Date.now()) {
    const timedOut = advanceSwapSettlement(
      record,
      "FAILED_TIMEOUT",
      { error: "Swap timed out waiting for confirmations." },
    );
    await upsertSwapSettlement(timedOut);
    return timedOut;
  }

  const receipt = await fetchEvmTransactionReceipt(record.txHash).catch(() => null);
  if (!receipt) return record;

  const status = extractReceiptStatus(receipt);
  if (status === "revert") {
    const reverted = advanceSwapSettlement(
      record,
      "FAILED_REVERT",
      { error: "EVM transaction reverted." },
    );
    await upsertSwapSettlement(reverted);
    return reverted;
  }
  const minedBlock = extractReceiptBlockNumber(receipt);
  const latestBlock = await fetchEvmBlockNumber().catch(() => null);
  const confirmations =
    minedBlock && latestBlock && latestBlock >= minedBlock
      ? latestBlock - minedBlock + 1
      : (record.confirmations || 1);

  if (confirmations >= SWAP_CONFIG.settlementRequiredConfirmations) {
    const confirmed = advanceSwapSettlement(
      record,
      "CONFIRMED",
      { confirmations, error: null },
    );
    await upsertSwapSettlement(confirmed);
    return confirmed;
  }

  const pendingState = advanceSwapSettlement(
    record,
    "PENDING_CONFIRMATION",
    { confirmations },
  );
  await upsertSwapSettlement(pendingState);
  return pendingState;
}

async function refreshKaspaNativeSettlement(record: SwapSettlementRecord): Promise<SwapSettlementRecord> {
  if (!record.txHash || record.routeSource !== "kaspa_native" || !isPendingSettlement(record)) return record;
  if ((record.createdAt + SWAP_CONFIG.settlementTimeoutMs) <= Date.now()) {
    const timedOut = advanceSwapSettlement(
      record,
      "FAILED_TIMEOUT",
      { error: "Swap timed out waiting for confirmations." },
    );
    await upsertSwapSettlement(timedOut);
    return timedOut;
  }

  const quoteId = record.bridgeTransferId || "";
  if (!quoteId) {
    const failed = failSettlement(record, "KASPA_NATIVE_SETTLEMENT_MISSING_QUOTE_ID");
    await upsertSwapSettlement(failed);
    return failed;
  }

  const endpoint = SWAP_CONFIG.dexEndpoint;
  if (!endpoint) {
    return record;
  }

  let status;
  try {
    const network = await currentSwapNetwork();
    status = await fetchKaspaNativeExecutionStatus({
      endpoint,
      network,
      quoteId,
      depositTxId: record.txHash,
    });
  } catch (err) {
    // Transient endpoint/network failures are non-fatal; keep polling.
    return record;
  }

  if (status.state === "failed") {
    const failed = failSettlement(record, status.error || "KASPA_NATIVE_EXECUTION_FAILED");
    await upsertSwapSettlement(failed);
    return failed;
  }

  const chainConfirmed = await isKaspaTxConfirmed(record.txHash);
  if (chainConfirmed && status.state === "confirmed") {
    const confirmed = advanceSwapSettlement(
      record,
      "CONFIRMED",
      {
        confirmations: Math.max(1, status.confirmations || 1),
        error: null,
      },
    );
    await upsertSwapSettlement(confirmed);
    return confirmed;
  }

  const pendingState = advanceSwapSettlement(
    record,
    "PENDING_CONFIRMATION",
    { confirmations: chainConfirmed ? 1 : 0 },
  );
  await upsertSwapSettlement(pendingState);
  return pendingState;
}

async function refreshSingleSettlement(record: SwapSettlementRecord): Promise<SwapSettlementRecord> {
  if (record.routeSource === "evm_0x") return refreshEvmSettlement(record);
  if (record.routeSource === "kaspa_native") return refreshKaspaNativeSettlement(record);
  return record;
}

export async function recoverPendingSwapSettlements(): Promise<SwapSettlementRecord[]> {
  const all = await listSwapSettlements();
  const pending = all.filter(
    (r) =>
      isPendingSettlement(r)
      && (r.routeSource === "evm_0x" || r.routeSource === "kaspa_native"),
  );
  const updated: SwapSettlementRecord[] = [];
  for (const record of pending) {
    updated.push(await refreshSingleSettlement(record));
  }
  return updated;
}

export async function connectEvmSidecarSigner(): Promise<EvmSidecarSession> {
  return connectMetaMaskSidecar();
}

async function executeEvmSwapQuote(quote: SwapQuote): Promise<SwapSettlementRecord> {
  if (!quote.transaction) {
    throw new Error("SWAP_EXECUTION_UNSUPPORTED: missing EVM transaction payload.");
  }
  const session = getActiveEvmSession();
  if (!session) {
    throw new Error("EVM_SIDECAR_REQUIRED: connect external EVM signer first.");
  }
  if (!validateSwapTransactionTarget(quote.transaction.to, SWAP_CONFIG.zeroExExpectedSettlerTo)) {
    throw new Error("ZEROX_SETTLER_MISMATCH: refusing to execute unexpected transaction target.");
  }
  const id = randomId("swap");
  let settlement = createSwapSettlementRecord(id, "evm_0x");
  settlement = advanceSwapSettlement(settlement, "QUOTED");
  await upsertSwapSettlement(settlement);
  settlement = advanceSwapSettlement(settlement, "SIGNED");
  await upsertSwapSettlement(settlement);

  let txHash = "";
  try {
    txHash = await sendEvmTransaction({
      from: session.address,
      to: quote.transaction.to,
      data: quote.transaction.data,
      value: quote.transaction.value || "0x0",
    });
  } catch (err) {
    const failed = advanceSwapSettlement(
      settlement,
      "FAILED_BRIDGE",
      { error: err instanceof Error ? err.message : String(err) },
    );
    await upsertSwapSettlement(failed);
    return failed;
  }
  settlement = advanceSwapSettlement(settlement, "SUBMITTED", {
    txHash,
    confirmations: 0,
    error: null,
  });
  await upsertSwapSettlement(settlement);

  const deadline = Date.now() + SWAP_CONFIG.settlementTimeoutMs;
  while (Date.now() < deadline) {
    const refreshed = await refreshSingleSettlement(settlement);
    settlement = refreshed;
    if (
      settlement.state === "CONFIRMED"
      || settlement.state === "FAILED_REVERT"
      || settlement.state === "FAILED_BRIDGE"
    ) {
      return settlement;
    }
    await new Promise((r) => setTimeout(r, SWAP_CONFIG.settlementPollIntervalMs));
  }

  const timedOut = advanceSwapSettlement(
    settlement,
    "FAILED_TIMEOUT",
    { error: "Swap timed out waiting for confirmations." },
  );
  await upsertSwapSettlement(timedOut);
  return timedOut;
}

async function executeKaspaNativeSwapQuote(quote: SwapQuote): Promise<SwapSettlementRecord> {
  if (quote.routeSource !== "kaspa_native") {
    throw new Error("KASPA_NATIVE_ROUTE_REQUIRED");
  }
  if (quote.tokenIn !== "KAS") {
    throw new Error("KASPA_NATIVE_INPUT_UNSUPPORTED: only KAS input is supported.");
  }
  if (Date.now() > quote.validUntil) {
    throw new Error("KASPA_NATIVE_QUOTE_EXPIRED");
  }
  const endpoint = SWAP_CONFIG.dexEndpoint;
  if (!endpoint) {
    throw new Error("KASPA_NATIVE_ENDPOINT_MISSING");
  }

  const session = getSession();
  if (!session?.mnemonic) {
    throw new Error("KASPA_NATIVE_SIGNER_REQUIRED: unlock managed Kaspa wallet.");
  }

  const network = await currentSwapNetwork();
  const fromAddress = withKaspaAddressNetwork(session.address, network);
  const quoteMeta = extractKaspaNativeQuoteMeta(quote);
  const amountKas = kasFromSompi(quote.amountIn);

  const id = randomId("swap");
  let settlement = createSwapSettlementRecord(id, "kaspa_native");
  settlement = advanceSwapSettlement(settlement, "QUOTED");
  await upsertSwapSettlement(settlement);
  settlement = advanceSwapSettlement(settlement, "SIGNED");
  await upsertSwapSettlement(settlement);

  let depositTxId = "";
  try {
    let tx = await buildTransaction(
      fromAddress,
      quoteMeta.settlementAddress,
      amountKas,
      network,
    );
    await addPendingTx(tx);

    const dryRun = await dryRunValidate(tx);
    if (!dryRun.valid) {
      const err = dryRun.errors.join("; ");
      await updatePendingTx({ ...tx, state: "DRY_RUN_FAIL", error: err });
      const failed = failSettlement(settlement, `KASPA_NATIVE_DRY_RUN_FAILED: ${err}`);
      await upsertSwapSettlement(failed);
      return failed;
    }

    tx = { ...tx, state: "DRY_RUN_OK", fee: dryRun.estimatedFee };
    await updatePendingTx(tx);

    const signed = await signTransaction(tx);
    await updatePendingTx(signed);

    const confirming = await broadcastTransaction(signed);
    await updatePendingTx(confirming);
    depositTxId = confirming.txId || signed.txId || "";
  } catch (err) {
    const failed = failSettlement(
      settlement,
      err instanceof Error ? err.message : String(err),
    );
    await upsertSwapSettlement(failed);
    return failed;
  }

  if (!depositTxId) {
    const failed = failSettlement(settlement, "KASPA_NATIVE_EXECUTION_NO_TXID");
    await upsertSwapSettlement(failed);
    return failed;
  }

  settlement = advanceSwapSettlement(settlement, "SUBMITTED", {
    txHash: depositTxId,
    bridgeTransferId: quoteMeta.quoteId,
    confirmations: 0,
    error: null,
  });
  await upsertSwapSettlement(settlement);

  try {
    await submitKaspaNativeExecution({
      endpoint,
      network,
      quoteId: quoteMeta.quoteId,
      depositTxId,
      walletAddress: fromAddress,
      amountIn: quote.amountIn,
    });
  } catch {
    // Endpoint ack can fail transiently; execution can still be reconciled by status polling.
  }

  const deadline = Date.now() + SWAP_CONFIG.settlementTimeoutMs;
  while (Date.now() < deadline) {
    settlement = await refreshKaspaNativeSettlement(settlement);
    if (
      settlement.state === "CONFIRMED"
      || settlement.state === "FAILED_REVERT"
      || settlement.state === "FAILED_BRIDGE"
      || settlement.state === "FAILED_TIMEOUT"
    ) {
      return settlement;
    }
    await new Promise((r) => setTimeout(r, SWAP_CONFIG.settlementPollIntervalMs));
  }

  const timedOut = failSettlement(
    settlement,
    "Swap timed out waiting for confirmations.",
    "FAILED_TIMEOUT",
  );
  await upsertSwapSettlement(timedOut);
  return timedOut;
}

export async function executeSwapQuote(quote: SwapQuote): Promise<SwapSettlementRecord> {
  if (quote.routeSource === "kaspa_native") {
    return executeKaspaNativeSwapQuote(quote);
  }
  if (quote.routeSource === "evm_0x") {
    return executeEvmSwapQuote(quote);
  }
  throw new Error(`SWAP_EXECUTION_UNSUPPORTED: ${quote.routeSource || "unknown route"}`);
}

/**
 * Enforce max slippage before requesting user signature.
 * Fail-closed: throws if actual slippage exceeds cap.
 */
export function enforceMaxSlippage(quote: SwapQuote, requestedBps: number): void {
  if (requestedBps > SWAP_CONFIG.maxSlippageBps) {
    throw new Error(
      `SLIPPAGE_EXCEEDED: requested ${requestedBps} bps exceeds max ${SWAP_CONFIG.maxSlippageBps} bps`,
    );
  }

  // Check actual price impact derived from quote
  const actualBps = Math.round(quote.priceImpact * 10_000);
  if (actualBps > SWAP_CONFIG.maxSlippageBps) {
    throw new Error(
      `PRICE_IMPACT_TOO_HIGH: actual impact ${actualBps} bps exceeds max ${SWAP_CONFIG.maxSlippageBps} bps`,
    );
  }
}
