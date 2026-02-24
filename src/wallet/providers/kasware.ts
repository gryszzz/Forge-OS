export function createKaswareProvider(deps: any) {
  const {
    getKaswareProvider,
    withTimeout,
    WALLET_CALL_TIMEOUT_MS,
    WALLET_SEND_TIMEOUT_MS,
    resolveKaspaNetwork,
    DEFAULT_NETWORK,
    normalizeKaspaAddress,
    ALL_KASPA_ADDRESS_PREFIXES,
    ALLOWED_ADDRESS_PREFIXES,
    ENFORCE_WALLET_NETWORK,
    NETWORK_LABEL,
    isAddressPrefixCompatible,
    normalizeWalletError,
    parseKaswareBalance,
    parseKaswareTxid,
    isLikelyTxid,
    toSompi,
  } = deps;

  return {
    async connect() {
      const w = getKaswareProvider();
      if (typeof w.requestAccounts !== "function") throw new Error("Kasware provider missing requestAccounts()");
      try {
        const accounts = await withTimeout(Promise.resolve(w.requestAccounts()), WALLET_CALL_TIMEOUT_MS, "kasware_request_accounts");
        if (!accounts?.length) throw new Error("No accounts returned from Kasware");
        const expectedNetwork = resolveKaspaNetwork(DEFAULT_NETWORK);
        const address = normalizeKaspaAddress(accounts[0], ALL_KASPA_ADDRESS_PREFIXES);

        let walletNetwork = expectedNetwork;
        if (typeof w.getNetwork === "function") {
          try {
            const rawNetwork = await withTimeout(Promise.resolve(w.getNetwork()), WALLET_CALL_TIMEOUT_MS, "kasware_get_network");
            walletNetwork = resolveKaspaNetwork(rawNetwork);
          } catch {
            walletNetwork = expectedNetwork;
          }
        }

        if (!isAddressPrefixCompatible(address, walletNetwork)) {
          throw new Error(
            `Kasware returned an address prefix that does not match ${walletNetwork.label}. Check wallet network/account and retry.`
          );
        }
        if (ENFORCE_WALLET_NETWORK && walletNetwork.id !== expectedNetwork.id) {
          throw new Error(`Kasware is on ${walletNetwork.label}. Expected ${NETWORK_LABEL}. Switch network in wallet and retry.`);
        }
        if (!isAddressPrefixCompatible(address, expectedNetwork)) {
          throw new Error(
            `Kasware returned a ${walletNetwork.label} address, but ForgeOS is using ${NETWORK_LABEL}. Switch the app profile or wallet network and retry.`
          );
        }

        return { address, network: walletNetwork.id, provider: "kasware" };
      } catch (e: any) {
        throw normalizeWalletError(e, "Kasware connect failed");
      }
    },

    async getBalance() {
      const w = getKaswareProvider();
      if (typeof w.getBalance !== "function") throw new Error("Kasware provider missing getBalance()");
      try {
        const b = await withTimeout(Promise.resolve(w.getBalance()), WALLET_CALL_TIMEOUT_MS, "kasware_get_balance");
        return parseKaswareBalance(b);
      } catch (e: any) {
        throw normalizeWalletError(e, "Kasware balance failed");
      }
    },

    async send(toAddress: string, amountKas: number) {
      const w = getKaswareProvider();
      if (!(Number(amountKas) > 0)) throw new Error("Amount must be greater than zero");
      const normalizedAddress = normalizeKaspaAddress(toAddress, ALLOWED_ADDRESS_PREFIXES);
      const sompi = toSompi(amountKas);

      // Kaspa mainnet fee rate is 10 sompi/gram (up from the old 1 sompi/gram).
      // Pass a priorityFee option when the wallet API supports it (Kasware v2+).
      // A safe priority fee of ~10 000 sompi (0.0001 KAS) ensures fast DAG inclusion.
      const PRIORITY_FEE_SOMPI = 10000;

      let payload;
      try {
        if (typeof w.sendKaspa === "function") {
          // Try with options object first (Kasware v2+); fall back silently if not supported.
          try {
            payload = await withTimeout(
              Promise.resolve(w.sendKaspa(normalizedAddress, sompi, { priorityFee: PRIORITY_FEE_SOMPI })),
              WALLET_SEND_TIMEOUT_MS,
              "kasware_send_kaspa_prio"
            );
          } catch {
            payload = await withTimeout(
              Promise.resolve(w.sendKaspa(normalizedAddress, sompi)),
              WALLET_SEND_TIMEOUT_MS,
              "kasware_send_kaspa"
            );
          }
        } else if (typeof w.sendKAS === "function") {
          payload = await withTimeout(Promise.resolve(w.sendKAS(normalizedAddress, sompi)), WALLET_SEND_TIMEOUT_MS, "kasware_send_kas");
        } else {
          throw new Error("Kasware provider missing sendKaspa()/sendKAS()");
        }
      } catch (e: any) {
        throw normalizeWalletError(e, "Kasware send failed");
      }

      const txid = parseKaswareTxid(payload);
      if (!txid || !isLikelyTxid(txid)) throw new Error("Kasware did not return a transaction id");
      return txid;
    },

    async signMessage(message: string) {
      const w = getKaswareProvider();
      if (typeof w.signMessage !== "function" && typeof w.signData !== "function") {
        throw new Error("Kasware provider missing signMessage/signData");
      }
      try {
        if (typeof w.signMessage === "function") {
          return withTimeout(Promise.resolve(w.signMessage(message)), WALLET_CALL_TIMEOUT_MS, "kasware_sign_message");
        }
        return withTimeout(Promise.resolve(w.signData(message)), WALLET_CALL_TIMEOUT_MS, "kasware_sign_data");
      } catch (e: any) {
        throw normalizeWalletError(e, "Kasware sign failed");
      }
    },
  };
}

