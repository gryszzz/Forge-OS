export function createHardwareBridgeProvider(deps: any) {
  const {
    normalizeKaspaAddress,
    ALLOWED_ADDRESS_PREFIXES,
    DEFAULT_NETWORK,
    normalizeOutputList,
    isLikelyTxid,
  } = deps;

  return {
    connect(provider: "tangem" | "onekey", address: string) {
      const normalized = normalizeKaspaAddress(address, ALLOWED_ADDRESS_PREFIXES);
      return { address: normalized, network: DEFAULT_NETWORK, provider };
    },

    async send(
      provider: string,
      toAddress: string,
      amountKas: number,
      note?: string,
      outputs?: Array<{ to: string; amount_kas: number }>
    ) {
      const normalizedAddress = normalizeKaspaAddress(toAddress, ALLOWED_ADDRESS_PREFIXES);
      const outList = normalizeOutputList(outputs || []);
      if (!(Number(amountKas) > 0) && !outList.length) throw new Error("Amount must be greater than zero");
      if (typeof window === "undefined" || typeof window.prompt !== "function") {
        throw new Error(`${String(provider || "Hardware")} bridge flow requires a browser prompt context`);
      }
      const lines = outList.length
        ? outList.map((o) => `${o.to}  ${o.amount_kas} KAS`).join("\n")
        : `${normalizedAddress}  ${Number(amountKas).toFixed(8)} KAS`;
      const txid = window.prompt(
        `${String(provider || "Hardware").toUpperCase()} bridge flow\n\nCreate and broadcast this transaction in your wallet/device, then paste txid.\n\nOutputs:\n${lines}\n\nNote: ${String(note || "").slice(0, 120)}`
      );
      if (!txid) throw new Error("Transaction not confirmed. No txid provided.");
      if (!isLikelyTxid(String(txid).trim())) throw new Error("Invalid txid format. Expected a 64-char hex transaction id.");
      return String(txid).trim();
    },
  };
}
