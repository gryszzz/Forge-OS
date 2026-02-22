import {
  ALLOWED_ADDRESS_PREFIXES,
  DEFAULT_NETWORK,
  ENFORCE_WALLET_NETWORK,
  KASPIUM_DEEP_LINK_SCHEME,
  NETWORK_LABEL,
} from "../constants";
import { fmt, normalizeKaspaAddress } from "../helpers";
import { isAddressPrefixCompatible, resolveKaspaNetwork } from "../kaspa/network";

const ALL_KASPA_ADDRESS_PREFIXES = ["kaspa", "kaspatest", "kaspadev", "kaspasim"];

function toSompi(amountKas: number) {
  return Math.floor(Number(amountKas || 0) * 1e8);
}

function parseKaswareBalance(payload: any) {
  const totalSompi = Number(payload?.total ?? payload?.confirmed ?? payload?.balance ?? 0);
  if (!Number.isFinite(totalSompi)) return "0.0000";
  return fmt(totalSompi / 1e8, 4);
}

function parseKaswareTxid(payload: any) {
  if (typeof payload === "string") return payload;
  return payload?.txid || payload?.hash || payload?.transactionId || "";
}

function isLikelyTxid(value: string) {
  return /^[a-fA-F0-9]{64}$/.test(String(value || "").trim());
}

export const WalletAdapter = {
  detect() {
    const kasware = typeof window !== "undefined" ? (window as any).kasware : undefined;
    return {
      kasware: !!kasware,
      // Kaspium is an external mobile wallet/deep-link flow, so keep available.
      kaspium: true,
      kaswareMethods: kasware
        ? {
            requestAccounts: typeof kasware.requestAccounts === "function",
            getNetwork: typeof kasware.getNetwork === "function",
            getBalance: typeof kasware.getBalance === "function",
            signMessage: typeof kasware.signMessage === "function",
            sendKaspa: typeof kasware.sendKaspa === "function",
          }
        : null,
    };
  },

  async connectKasware() {
    const w = (window as any).kasware;
    if(!w) throw new Error("Kasware extension not detected. Install from kasware.org");
    if (typeof w.requestAccounts !== "function") {
      throw new Error("Kasware provider missing requestAccounts()");
    }
    const accounts = await w.requestAccounts();
    if(!accounts?.length) throw new Error("No accounts returned from Kasware");
    const rawNetwork = typeof w.getNetwork === "function" ? await w.getNetwork() : DEFAULT_NETWORK;
    const walletNetwork = resolveKaspaNetwork(rawNetwork);
    const expectedNetwork = resolveKaspaNetwork(DEFAULT_NETWORK);
    const address = normalizeKaspaAddress(accounts[0], ALL_KASPA_ADDRESS_PREFIXES);

    if (!isAddressPrefixCompatible(address, walletNetwork)) {
      throw new Error(
        `Kasware returned an address prefix that does not match ${walletNetwork.label}. Check wallet network/account and retry.`
      );
    }

    if (ENFORCE_WALLET_NETWORK && walletNetwork.id !== expectedNetwork.id) {
      throw new Error(
        `Kasware is on ${walletNetwork.label}. Expected ${NETWORK_LABEL}. Switch network in wallet and retry.`
      );
    }

    if (!isAddressPrefixCompatible(address, expectedNetwork)) {
      throw new Error(
        `Kasware returned a ${walletNetwork.label} address, but ForgeOS is using ${NETWORK_LABEL}. Switch the app profile or wallet network and retry.`
      );
    }

    return { address, network: walletNetwork.id, provider: "kasware" };
  },

  connectKaspium(address: string) {
    const normalized = normalizeKaspaAddress(address, ALLOWED_ADDRESS_PREFIXES);
    return { address: normalized, network: DEFAULT_NETWORK, provider: "kaspium" };
  },

  async getKaswareBalance() {
    const w = (window as any).kasware;
    if(!w) throw new Error("Kasware not connected");
    if (typeof w.getBalance !== "function") throw new Error("Kasware provider missing getBalance()");
    const b = await w.getBalance();
    return parseKaswareBalance(b);
  },

  async sendKasware(toAddress: string, amountKas: number) {
    const w = (window as any).kasware;
    if(!w) throw new Error("Kasware not connected");
    if (!(Number(amountKas) > 0)) throw new Error("Amount must be greater than zero");
    const normalizedAddress = normalizeKaspaAddress(toAddress, ALLOWED_ADDRESS_PREFIXES);
    const sompi = toSompi(amountKas);

    let payload;
    if (typeof w.sendKaspa === "function") {
      payload = await w.sendKaspa(normalizedAddress, sompi);
    } else if (typeof w.sendKAS === "function") {
      payload = await w.sendKAS(normalizedAddress, sompi);
    } else {
      throw new Error("Kasware provider missing sendKaspa()/sendKAS()");
    }

    const txid = parseKaswareTxid(payload);
    if (!txid || !isLikelyTxid(txid)) {
      throw new Error("Kasware did not return a transaction id");
    }
    return txid;
  },

  // Kaspium currently uses a manual deep-link + txid confirmation flow.
  async sendKaspium(toAddress: string, amountKas: number, note?: string) {
    const normalizedAddress = normalizeKaspaAddress(toAddress, ALLOWED_ADDRESS_PREFIXES);
    if (!(Number(amountKas) > 0)) throw new Error("Amount must be greater than zero");
    if(typeof window === "undefined") throw new Error("Kaspium deep-link is only available in browser environments");

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

    const txid = window.prompt(
      `Complete transfer in Kaspium and paste txid.\nDeep link:\n${deepLink}\n\nFallback URI:\n${kaspaUri}`
    );
    if(!txid) throw new Error("Transaction not confirmed. No txid provided.");
    if(!isLikelyTxid(txid)) throw new Error("Invalid txid format. Expected a 64-char hex transaction id.");

    return txid.trim();
  },

  async signMessageKasware(message: string) {
    const w = (window as any).kasware;
    if(!w) throw new Error("Kasware not connected");
    if (typeof w.signMessage !== "function" && typeof w.signData !== "function") {
      throw new Error("Kasware provider missing signMessage/signData");
    }
    if (typeof w.signMessage === "function") return w.signMessage(message);
    return w.signData(message);
  }
};
