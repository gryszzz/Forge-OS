export function createGhostProvider(deps: any) {
  const {
    resolveKaspaNetwork,
    DEFAULT_NETWORK,
    normalizeKaspaAddress,
    ALL_KASPA_ADDRESS_PREFIXES,
    ALLOWED_ADDRESS_PREFIXES,
    ENFORCE_WALLET_NETWORK,
    NETWORK_LABEL,
    isAddressPrefixCompatible,
    normalizeWalletError,
    withTimeout,
    GHOST_CONNECT_TIMEOUT_MS,
    WALLET_SEND_TIMEOUT_MS,
    ghostInvoke,
    probeGhostProviders,
    formatKasAmountString,
    parseAnyTxid,
    promptForTxidIfNeeded,
    normalizeOutputList,
  } = deps;

  return {
    async probeProviders(timeoutMs?: number) {
      try {
        return await probeGhostProviders(timeoutMs);
      } catch {
        return [];
      }
    },

    async connect() {
      try {
        const account = await withTimeout(
          ghostInvoke("account", [], GHOST_CONNECT_TIMEOUT_MS),
          GHOST_CONNECT_TIMEOUT_MS + 1000,
          "ghost_connect_account"
        );
        const addresses = Array.isArray(account?.addresses) ? account.addresses : [];
        if (!addresses.length) throw new Error("Ghost Wallet did not return any accounts");
        const expectedNetwork = resolveKaspaNetwork(DEFAULT_NETWORK);
        const walletNetwork = resolveKaspaNetwork(account?.networkId || expectedNetwork.id);
        const address = normalizeKaspaAddress(addresses[0], ALL_KASPA_ADDRESS_PREFIXES);

        if (!isAddressPrefixCompatible(address, walletNetwork)) {
          throw new Error(
            `Ghost Wallet returned an address prefix that does not match ${walletNetwork.label}. Check wallet network/account and retry.`
          );
        }
        if (ENFORCE_WALLET_NETWORK && walletNetwork.id !== expectedNetwork.id) {
          throw new Error(`Ghost Wallet is on ${walletNetwork.label}. Expected ${NETWORK_LABEL}. Switch network in wallet and retry.`);
        }
        if (!isAddressPrefixCompatible(address, expectedNetwork)) {
          throw new Error(
            `Ghost Wallet returned a ${walletNetwork.label} address, but ForgeOS is using ${NETWORK_LABEL}. Switch the app profile or wallet network and retry.`
          );
        }
        return { address, network: walletNetwork.id, provider: "ghost" };
      } catch (e: any) {
        throw normalizeWalletError(e, "Ghost Wallet connect failed");
      }
    },

    async send(toAddress: string, amountKas: number) {
      if (!(Number(amountKas) > 0)) throw new Error("Amount must be greater than zero");
      const normalizedAddress = normalizeKaspaAddress(toAddress, ALLOWED_ADDRESS_PREFIXES);
      try {
        const payload = await withTimeout(
          ghostInvoke("transact", [[[normalizedAddress, formatKasAmountString(amountKas)]]], WALLET_SEND_TIMEOUT_MS),
          WALLET_SEND_TIMEOUT_MS + 1000,
          "ghost_transact"
        );
        const txidCandidate = parseAnyTxid(payload);
        return await promptForTxidIfNeeded(txidCandidate, "Ghost Wallet", typeof payload === "string" ? payload : JSON.stringify(payload));
      } catch (e: any) {
        throw normalizeWalletError(e, "Ghost Wallet send failed");
      }
    },

    async sendOutputs(outputs: Array<{ to: string; amount_kas: number }>, _purpose?: string) {
      const normalizedOutputs = normalizeOutputList(outputs);
      if (!normalizedOutputs.length) throw new Error("Ghost Wallet outputs are required");
      if (normalizedOutputs.length === 1) {
        return this.send(normalizedOutputs[0].to, normalizedOutputs[0].amount_kas);
      }
      try {
        const payload = await withTimeout(
          ghostInvoke(
            "transact",
            [normalizedOutputs.map((o) => [o.to, formatKasAmountString(o.amount_kas)])],
            WALLET_SEND_TIMEOUT_MS
          ),
          WALLET_SEND_TIMEOUT_MS + 1000,
          "ghost_transact_multi"
        );
        const txidCandidate = parseAnyTxid(payload);
        return await promptForTxidIfNeeded(
          txidCandidate,
          "Ghost Wallet (multi-output)",
          typeof payload === "string" ? payload : JSON.stringify(payload)
        );
      } catch (e: any) {
        throw normalizeWalletError(e, "Ghost Wallet multi-output send failed");
      }
    },
  };
}
