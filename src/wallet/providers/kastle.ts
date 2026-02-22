export function createKastleProvider(deps: any) {
  const {
    getKastleProvider,
    withTimeout,
    WALLET_CALL_TIMEOUT_MS,
    WALLET_SEND_TIMEOUT_MS,
    KASTLE_CONNECT_TIMEOUT_MS,
    resolveKaspaNetwork,
    DEFAULT_NETWORK,
    normalizeKaspaAddress,
    ALL_KASPA_ADDRESS_PREFIXES,
    ALLOWED_ADDRESS_PREFIXES,
    ENFORCE_WALLET_NETWORK,
    NETWORK_LABEL,
    isAddressPrefixCompatible,
    normalizeWalletError,
    toSompi,
    parseAnyTxid,
    isLikelyTxid,
    KASTLE_RAW_TX_ENABLED,
    KASTLE_TX_BUILDER_URL,
    KASTLE_RAW_TX_MANUAL_JSON_PROMPT_ENABLED,
    getKastleRawTxJsonBuilderBridge,
    buildKastleRawTxJson,
    normalizeOutputList,
    kastleNetworkIdForCurrentProfile,
    setKastleAccountCacheAddress,
    getKastleCachedAccountAddress,
  } = deps;

  return {
    async connect() {
      const w = getKastleProvider();
      try {
        if (typeof w.connect === "function") {
          await withTimeout(Promise.resolve(w.connect()), KASTLE_CONNECT_TIMEOUT_MS, "kastle_connect");
        }

        let account = null as any;
        if (typeof w.getAccount === "function") {
          account = await withTimeout(Promise.resolve(w.getAccount()), WALLET_CALL_TIMEOUT_MS, "kastle_get_account");
        } else if (typeof w.request === "function") {
          account = await withTimeout(Promise.resolve(w.request("kas:get_account")), WALLET_CALL_TIMEOUT_MS, "kastle_request_get_account");
        } else {
          throw new Error("Kastle provider missing getAccount()/request()");
        }

        const address = normalizeKaspaAddress(String(account?.address || account?.addresses?.[0] || ""), ALL_KASPA_ADDRESS_PREFIXES);
        setKastleAccountCacheAddress(address);
        const expectedNetwork = resolveKaspaNetwork(DEFAULT_NETWORK);

        let walletNetwork = expectedNetwork;
        if (typeof w.request === "function") {
          try {
            const rawNetwork = await withTimeout(
              Promise.resolve(w.request("kas:get_network")),
              WALLET_CALL_TIMEOUT_MS,
              "kastle_get_network"
            );
            walletNetwork = resolveKaspaNetwork(rawNetwork?.networkId || rawNetwork);
          } catch {
            walletNetwork = expectedNetwork;
          }
        }

        if (!isAddressPrefixCompatible(address, walletNetwork)) {
          throw new Error(
            `Kastle returned an address prefix that does not match ${walletNetwork.label}. Check wallet network/account and retry.`
          );
        }
        if (ENFORCE_WALLET_NETWORK && walletNetwork.id !== expectedNetwork.id) {
          throw new Error(`Kastle is on ${walletNetwork.label}. Expected ${NETWORK_LABEL}. Switch network in wallet and retry.`);
        }
        if (!isAddressPrefixCompatible(address, expectedNetwork)) {
          throw new Error(
            `Kastle returned a ${walletNetwork.label} address, but ForgeOS is using ${NETWORK_LABEL}. Switch the app profile or wallet network and retry.`
          );
        }
        return { address, network: walletNetwork.id, provider: "kastle" };
      } catch (e: any) {
        throw normalizeWalletError(e, "Kastle connect failed");
      }
    },

    async send(toAddress: string, amountKas: number) {
      const w = getKastleProvider();
      if (!(Number(amountKas) > 0)) throw new Error("Amount must be greater than zero");
      const normalizedAddress = normalizeKaspaAddress(toAddress, ALLOWED_ADDRESS_PREFIXES);
      const sompi = toSompi(amountKas);

      try {
        if (typeof w.sendKaspa !== "function") {
          throw new Error("Kastle provider missing sendKaspa()");
        }
        const payload = await withTimeout(
          Promise.resolve(w.sendKaspa(normalizedAddress, sompi)),
          WALLET_SEND_TIMEOUT_MS,
          "kastle_send_kaspa"
        );
        const txid = parseAnyTxid(payload);
        if (!txid || !isLikelyTxid(txid)) throw new Error("Kastle did not return a transaction id");
        return txid;
      } catch (e: any) {
        throw normalizeWalletError(e, "Kastle send failed");
      }
    },

    canSignAndBroadcastRawTx() {
      if (!KASTLE_RAW_TX_ENABLED) return false;
      try {
        const w = typeof window !== "undefined" ? (window as any).kastle : null;
        return Boolean(w && typeof w.signAndBroadcastTx === "function");
      } catch {
        return false;
      }
    },

    canMultiOutputRawTxPath() {
      if (!this.canSignAndBroadcastRawTx()) return false;
      if (KASTLE_TX_BUILDER_URL) return true;
      if (getKastleRawTxJsonBuilderBridge()) return true;
      if (typeof window === "undefined") return false;
      return Boolean(KASTLE_RAW_TX_MANUAL_JSON_PROMPT_ENABLED && typeof window.prompt === "function");
    },

    async sendRawTx(outputs: Array<{ to: string; amount_kas: number }>, purpose?: string) {
      const normalizedOutputs = normalizeOutputList(outputs);
      if (normalizedOutputs.length <= 1) {
        const first = normalizedOutputs[0];
        if (!first) throw new Error("Kastle raw tx requires at least one output");
        return this.send(first.to, first.amount_kas);
      }
      if (!this.canSignAndBroadcastRawTx()) {
        throw new Error("Kastle raw multi-output path unavailable (feature disabled or signAndBroadcastTx not detected)");
      }
      const w = getKastleProvider();
      const networkId = kastleNetworkIdForCurrentProfile();
      try {
        const txJson = await buildKastleRawTxJson(normalizedOutputs, purpose, getKastleCachedAccountAddress());
        const payload = await withTimeout(
          Promise.resolve(w.signAndBroadcastTx(networkId, txJson)),
          WALLET_SEND_TIMEOUT_MS,
          "kastle_sign_and_broadcast_tx"
        );
        const txid = parseAnyTxid(payload);
        if (!txid || !isLikelyTxid(txid)) {
          throw new Error("Kastle signAndBroadcastTx did not return a transaction id");
        }
        return txid;
      } catch (e: any) {
        throw normalizeWalletError(e, "Kastle raw multi-output send failed");
      }
    },

    async signMessage(message: string) {
      const w = getKastleProvider();
      if (typeof w.signMessage !== "function" && typeof w.request !== "function") {
        throw new Error("Kastle provider missing signMessage/request");
      }
      try {
        if (typeof w.signMessage === "function") {
          return withTimeout(Promise.resolve(w.signMessage(message)), WALLET_CALL_TIMEOUT_MS, "kastle_sign_message");
        }
        return withTimeout(
          Promise.resolve(w.request("kas:sign_message", message)),
          WALLET_CALL_TIMEOUT_MS,
          "kastle_request_sign_message"
        );
      } catch (e: any) {
        throw normalizeWalletError(e, "Kastle sign failed");
      }
    },
  };
}
