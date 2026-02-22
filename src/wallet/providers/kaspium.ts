export function createKaspiumProvider(deps: any) {
  const {
    normalizeKaspaAddress,
    ALLOWED_ADDRESS_PREFIXES,
    DEFAULT_NETWORK,
    KASPIUM_DEEP_LINK_SCHEME,
    isLikelyTxid,
  } = deps;

  return {
    connect(address: string) {
      const normalized = normalizeKaspaAddress(address, ALLOWED_ADDRESS_PREFIXES);
      return { address: normalized, network: DEFAULT_NETWORK, provider: "kaspium" };
    },

    async send(toAddress: string, amountKas: number, note?: string) {
      const normalizedAddress = normalizeKaspaAddress(toAddress, ALLOWED_ADDRESS_PREFIXES);
      if (!(Number(amountKas) > 0)) throw new Error("Amount must be greater than zero");
      if (typeof window === "undefined") throw new Error("Kaspium deep-link is only available in browser environments");

      const encodedAmount = encodeURIComponent(String(amountKas));
      const encodedNote = note ? encodeURIComponent(note) : "";
      const kaspaUri = `${normalizedAddress}?amount=${encodedAmount}${note ? `&message=${encodedNote}` : ""}`;

      let deepLink = kaspaUri;
      if (KASPIUM_DEEP_LINK_SCHEME && !KASPIUM_DEEP_LINK_SCHEME.toLowerCase().startsWith("kaspa")) {
        const scheme = KASPIUM_DEEP_LINK_SCHEME.endsWith("://")
          ? KASPIUM_DEEP_LINK_SCHEME
          : `${KASPIUM_DEEP_LINK_SCHEME}://`;
        deepLink = `${scheme}send?address=${encodeURIComponent(normalizedAddress)}&amount=${encodedAmount}${note ? `&note=${encodedNote}` : ""}`;
      }

      window.location.href = deepLink;
      const promptFn = typeof window.prompt === "function" ? window.prompt.bind(window) : null;
      if (!promptFn) throw new Error("Kaspium confirmation prompt unavailable in this browser context");
      const txid = promptFn(`Complete transfer in Kaspium and paste txid.\nDeep link:\n${deepLink}\n\nFallback URI:\n${kaspaUri}`);
      if (!txid) throw new Error("Transaction not confirmed. No txid provided.");
      if (!isLikelyTxid(txid)) throw new Error("Invalid txid format. Expected a 64-char hex transaction id.");
      return txid.trim();
    },
  };
}

