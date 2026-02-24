export type ForgeWalletClass = "extension" | "mobile" | "hardware" | "desktop" | "web";
export type ForgeWalletIntegrationStatus = "live" | "planned" | "research";
export type ForgeWalletMultiOutputSupport =
  | "supported"
  | "unsupported"
  | "pskt_path"
  | "unknown"
  | "not_applicable";

export type ForgeWalletCapabilities = {
  detect: boolean;
  connect: boolean;
  send: boolean;
  network: boolean;
  signMessage: boolean;
  deeplink: boolean;
  manualTxid: boolean;
  psktSign: boolean;
  nativeMultiOutputSend: ForgeWalletMultiOutputSupport;
};

export type ForgeWalletRegistryItem = {
  id: string;
  name: string;
  class: ForgeWalletClass;
  status: ForgeWalletIntegrationStatus;
  connectMode: "injected" | "deeplink" | "demo" | "manual" | "bridge";
  description: string;
  uiIcon: string;
  logoSrc?: string;
  docsUrl?: string;
  websiteUrl?: string;
  sourceUrls?: string[];
  tags?: string[];
  capabilities: ForgeWalletCapabilities;
  notes?: string[];
};

const KASTLE_LOGO_SRC = new URL("../assets/wallets/kastle.svg", import.meta.url).href;

export const FORGEOS_WALLET_CAPABILITY_REGISTRY: readonly ForgeWalletRegistryItem[] = [
  {
    id: "kasware",
    name: "Kasware",
    class: "extension",
    status: "live",
    connectMode: "injected",
    description: "Injected browser wallet for direct Kaspa signing and broadcast.",
    uiIcon: "🧩",
    docsUrl: "https://docs.kasware.xyz/wallet/dev-base/kaspa",
    websiteUrl: "https://www.kasware.xyz",
    sourceUrls: [
      "https://docs.kasware.xyz/wallet/dev-base/kaspa",
      "https://github.com/kasware-wallet/extension",
      "https://kaspa.org/directory/kasware/",
    ],
    tags: ["kaspa", "browser-extension", "dapp"],
    capabilities: {
      detect: true,
      connect: true,
      send: true,
      network: true,
      signMessage: true,
      deeplink: false,
      manualTxid: false,
      psktSign: true,
      nativeMultiOutputSend: "unsupported",
    },
    notes: [
      "Kasware docs expose sendKaspa(toAddress, sompi[, options]) single-recipient send.",
      "Kasware exposes signPskt and some KRC20 methods with extra output arrays; a PSKT-based multi-output path may be possible in a future adapter.",
    ],
  },
  {
    id: "kaspium",
    name: "Kaspium",
    class: "mobile",
    status: "live",
    connectMode: "deeplink",
    description: "Mobile wallet via deep-link handoff with manual txid confirmation in Forge.OS.",
    uiIcon: "📱",
    docsUrl: "https://github.com/azbuky/kaspium_wallet",
    websiteUrl: "https://kaspium.io",
    sourceUrls: [
      "https://github.com/azbuky/kaspium_wallet",
      "https://kaspa.org/kaspium-v1-0-1-release/",
    ],
    tags: ["kaspa", "mobile", "deeplink"],
    capabilities: {
      detect: false,
      connect: true,
      send: true,
      network: false,
      signMessage: false,
      deeplink: true,
      manualTxid: true,
      psktSign: false,
      nativeMultiOutputSend: "unsupported",
    },
    notes: [
      "Current Forge.OS integration is a single-recipient deep-link + pasted txid flow.",
      "No public injected dApp provider API documented in the Kaspium repo.",
    ],
  },
  {
    id: "kastle",
    name: "Kastle",
    class: "extension",
    status: "live",
    connectMode: "injected",
    description: "Kaspa browser extension wallet with injected dApp API and direct signing/broadcast.",
    uiIcon: "🏰",
    logoSrc: KASTLE_LOGO_SRC,
    docsUrl: "https://github.com/forbole/kastle",
    websiteUrl: "https://kastle.cc/",
    sourceUrls: [
      "https://github.com/forbole/kastle",
    ],
    tags: ["kaspa", "browser-extension", "dapp"],
    capabilities: {
      detect: true,
      connect: true,
      send: true,
      network: true,
      signMessage: true,
      deeplink: false,
      manualTxid: false,
      psktSign: false,
      nativeMultiOutputSend: "pskt_path",
    },
    notes: [
      "Injected `window.kastle` API supports connect/getAccount/request/sendKaspa/signMessage.",
      "Native sendKaspa is single-recipient; multi-output may be possible via signAndBroadcastTx(txJson) with a Forge.OS transaction builder path.",
    ],
  },
  {
    id: "demo",
    name: "Demo Mode",
    class: "web",
    status: "live",
    connectMode: "demo",
    description: "Simulated signer for UI testing, E2E flows, and onboarding.",
    uiIcon: "🧪",
    tags: ["simulation", "test"],
    capabilities: {
      detect: false,
      connect: true,
      send: true,
      network: true,
      signMessage: false,
      deeplink: false,
      manualTxid: false,
      psktSign: false,
      nativeMultiOutputSend: "not_applicable",
    },
    notes: ["No blockchain broadcast. Used for UI/QA only."],
  },
  {
    id: "kasperia",
    name: "Kasperia",
    class: "extension",
    status: "research",
    connectMode: "injected",
    description: "Kaspa/Kasplex browser extension wallet with developer docs and SDK messaging.",
    uiIcon: "🌉",
    docsUrl: "https://kasperia-doc.github.io/",
    websiteUrl: "https://kasperia-doc.github.io/",
    sourceUrls: ["https://kasperia-doc.github.io/"],
    tags: ["browser-extension", "kasplex", "l2"],
    capabilities: {
      detect: false,
      connect: false,
      send: false,
      network: false,
      signMessage: false,
      deeplink: false,
      manualTxid: false,
      psktSign: false,
      nativeMultiOutputSend: "unknown",
    },
    notes: ["Promising for future dApp integration, but Forge.OS adapter work depends on stable injected provider docs/API shape."],
  },
  {
    id: "tangem",
    name: "Tangem",
    class: "hardware",
    status: "live",
    connectMode: "bridge",
    description: "Hardware bridge flow (manual sign/broadcast + txid handoff) for accumulation-focused cold custody operations.",
    uiIcon: "💳",
    websiteUrl: "https://tangem.com/",
    sourceUrls: [
      "https://kaspa.org/kaspa-integrated-on-tangem/",
      "https://kaspa.org/directory/tangem-ag/",
    ],
    tags: ["hardware", "cold-storage", "accumulation"],
    capabilities: {
      detect: false,
      connect: true,
      send: true,
      network: false,
      signMessage: false,
      deeplink: false,
      manualTxid: true,
      psktSign: false,
      nativeMultiOutputSend: "unknown",
    },
    notes: ["Forge.OS uses a manual hardware bridge flow today (address pairing + external signing/broadcast + pasted txid)."],
  },
  {
    id: "onekey",
    name: "OneKey",
    class: "hardware",
    status: "live",
    connectMode: "bridge",
    description: "Hardware bridge flow (manual sign/broadcast + txid handoff) for secure accumulation and large-balance operations.",
    uiIcon: "🔐",
    websiteUrl: "https://shop.onekey.so/",
    sourceUrls: ["https://kaspa.org/kaspa-integrated-on-onekey/"],
    tags: ["hardware", "cold-storage"],
    capabilities: {
      detect: false,
      connect: true,
      send: true,
      network: false,
      signMessage: false,
      deeplink: false,
      manualTxid: true,
      psktSign: false,
      nativeMultiOutputSend: "unknown",
    },
    notes: ["Forge.OS uses a manual hardware bridge flow today (address pairing + external signing/broadcast + pasted txid)."],
  },
  {
    id: "zelcore",
    name: "Zelcore",
    class: "desktop",
    status: "research",
    connectMode: "manual",
    description: "Multi-asset wallet with Kaspa support; useful for operator holdings and portfolio visibility.",
    uiIcon: "🖥️",
    sourceUrls: ["https://kaspa.org/kaspa-on-zelcore-wallet-and-defi/"],
    tags: ["desktop", "multi-asset"],
    capabilities: {
      detect: false,
      connect: false,
      send: false,
      network: false,
      signMessage: false,
      deeplink: false,
      manualTxid: true,
      psktSign: false,
      nativeMultiOutputSend: "unknown",
    },
    notes: ["No Forge.OS dApp signing path yet; candidate for watch-only/import workflows first."],
  },
];

export const FORGEOS_CONNECTABLE_WALLETS = FORGEOS_WALLET_CAPABILITY_REGISTRY.filter(
  (wallet) => wallet.status === "live" && wallet.capabilities.connect
);

export const FORGEOS_UPCOMING_WALLET_CANDIDATES = FORGEOS_WALLET_CAPABILITY_REGISTRY.filter(
  (wallet) => wallet.status !== "live" && wallet.id !== "demo"
);

export function walletStatusLabel(status: ForgeWalletIntegrationStatus) {
  if (status === "live") return "LIVE";
  if (status === "planned") return "PLANNED";
  return "RESEARCH";
}

export function walletClassLabel(kind: ForgeWalletClass) {
  if (kind === "extension") return "EXTENSION";
  if (kind === "mobile") return "MOBILE";
  if (kind === "hardware") return "HARDWARE";
  if (kind === "desktop") return "DESKTOP";
  return "WEB";
}

export function walletMultiOutputLabel(kind: ForgeWalletMultiOutputSupport) {
  if (kind === "supported") return "MULTI-OUTPUT: YES";
  if (kind === "unsupported") return "MULTI-OUTPUT: NO (NATIVE SEND)";
  if (kind === "pskt_path") return "MULTI-OUTPUT: PSKT PATH";
  if (kind === "not_applicable") return "MULTI-OUTPUT: N/A";
  return "MULTI-OUTPUT: UNKNOWN";
}
