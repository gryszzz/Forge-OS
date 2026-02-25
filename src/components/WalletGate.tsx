import { useMemo, useState } from "react";
import { ALLOWED_ADDRESS_PREFIXES, DEFAULT_NETWORK, DEMO_ADDRESS, NETWORK_LABEL } from "../constants";
import { C, mono } from "../tokens";
import { isKaspaAddress, normalizeKaspaAddress, shortAddr } from "../helpers";
import { WalletAdapter } from "../wallet/WalletAdapter";
import {
  FORGEOS_CONNECTABLE_WALLETS,
  walletClassLabel,
} from "../wallet/walletCapabilityRegistry";
import { formatForgeError } from "../runtime/errorTaxonomy";
import { Badge, Btn, Card, Divider, ExtLink } from "./ui";
import { ForgeAtmosphere } from "./chrome/ForgeAtmosphere";

// Protocol capability blocks
const PROTOCOL_STACK = [
  {
    status: "LIVE",
    statusColor: "#39DDB6",
    title: "KAS Accumulation",
    desc: "AI-guided accumulation on the Kaspa BlockDAG. Kelly-sized entries, regime-aware execution.",
    icon: "◆",
    iconColor: "#39DDB6",
  },
  {
    status: "LIVE",
    statusColor: "#39DDB6",
    title: "DAG-Speed Settlement",
    desc: "Transactions confirm at Kaspa BlockDAG speed — parallel block lattice, sub-second finality.",
    icon: "⚡",
    iconColor: "#39DDB6",
  },
  {
    status: "LIVE",
    statusColor: "#39DDB6",
    title: "Stable PnL Tracking",
    desc: "All agent P&L tracked in USD equivalent. KAS/USDC rate computed on every cycle.",
    icon: "$",
    iconColor: "#39DDB6",
  },
  {
    status: "READY",
    statusColor: "#8F7BFF",
    title: "KAS / USDC Pairs",
    desc: "Engine prepared for native KAS/USDC L1 pairs. When USDC lands on Kaspa, agents activate pair trading automatically.",
    icon: "⇄",
    iconColor: "#8F7BFF",
  },
  {
    status: "READY",
    statusColor: "#F7B267",
    title: "Stable Buy/Sell Logic",
    desc: "Cleaner entry/exit against stable liquidity. Buy KAS with USDC on dips. Sell KAS to USDC on strength.",
    icon: "↑↓",
    iconColor: "#F7B267",
  },
  {
    status: "READY",
    statusColor: "#F7B267",
    title: "Multi-Pair Routing",
    desc: "Capital router prepared for multi-asset allocation. Extend to KAS/kUSD, KAS/kBTC as Kaspa's DeFi layer grows.",
    icon: "⊕",
    iconColor: "#F7B267",
  },
];

export function WalletGate({onConnect}: any) {
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [err, setErr] = useState(null as any);
  const [info, setInfo] = useState("");
  const [kaspiumAddress, setKaspiumAddress] = useState("");
  const [savedKaspiumAddress, setSavedKaspiumAddress] = useState("");
  const [lastProvider, setLastProvider] = useState("");
  const detected = WalletAdapter.detect();
  const kaspiumStorageKey = useMemo(() => `forgeos.kaspium.address.${DEFAULT_NETWORK}`, []);
  const providerStorageKey = useMemo(() => `forgeos.wallet.lastProvider.${DEFAULT_NETWORK}`, []);
  const activeKaspiumAddress = kaspiumAddress.trim();
  const kaspiumAddressValid = isKaspaAddress(activeKaspiumAddress, ALLOWED_ADDRESS_PREFIXES);
  const busy = Boolean(busyProvider);

  const persistKaspiumAddress = (value: string) => {
    const normalized = value.trim();
    if (!normalized || !isKaspaAddress(normalized, ALLOWED_ADDRESS_PREFIXES)) return;
    setSavedKaspiumAddress(normalized);
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(kaspiumStorageKey, normalized); } catch {}
  };

  const persistProvider = (provider: string) => {
    setLastProvider(provider);
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(providerStorageKey, provider); } catch {}
  };

  const resolveKaspiumAddress = async () => {
    const active = (kaspiumAddress.trim() || savedKaspiumAddress.trim()).trim();
    if (active && isKaspaAddress(active, ALLOWED_ADDRESS_PREFIXES)) {
      return normalizeKaspaAddress(active, ALLOWED_ADDRESS_PREFIXES);
    }
    if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      try {
        const clipboardRaw = await navigator.clipboard.readText();
        const candidate = String(clipboardRaw || "").trim().split(/\s+/)[0] || "";
        if (candidate && isKaspaAddress(candidate, ALLOWED_ADDRESS_PREFIXES)) {
          const normalized = normalizeKaspaAddress(candidate, ALLOWED_ADDRESS_PREFIXES);
          setKaspiumAddress(normalized);
          persistKaspiumAddress(normalized);
          return normalized;
        }
      } catch {}
    }
    const raw = window.prompt(`Paste your ${NETWORK_LABEL} Kaspium address (${ALLOWED_ADDRESS_PREFIXES.join(", ")}).`) || "";
    const normalized = normalizeKaspaAddress(raw, ALLOWED_ADDRESS_PREFIXES);
    setKaspiumAddress(normalized);
    persistKaspiumAddress(normalized);
    return normalized;
  };

  const resolveManualBridgeAddress = async (walletName: string) => {
    const raw = window.prompt(`Paste your ${NETWORK_LABEL} ${walletName} receive address (${ALLOWED_ADDRESS_PREFIXES.join(", ")}).`) || "";
    return normalizeKaspaAddress(raw, ALLOWED_ADDRESS_PREFIXES);
  };

  const connect = async (provider: string) => {
    setBusyProvider(provider);
    setErr(null);
    setInfo("");
    try {
      let session: any;
      if (provider === "kasware") {
        session = await WalletAdapter.connectKasware();
        setInfo("Kasware session ready. Extension signing is armed.");
      } else if (provider === "kastle") {
        session = await WalletAdapter.connectKastle();
        setInfo("Kastle session ready. Extension signing is armed.");
      } else if (provider === "tangem" || provider === "onekey") {
        const resolvedAddress = await resolveManualBridgeAddress(provider === "tangem" ? "Tangem" : "OneKey");
        session = await WalletAdapter.connectHardwareBridge(provider as "tangem" | "onekey", resolvedAddress);
        setInfo(`${provider === "tangem" ? "Tangem" : "OneKey"} bridge session ready for ${shortAddr(session.address)}.`);
      } else if (provider === "kaspium") {
        const resolvedAddress = await resolveKaspiumAddress();
        session = WalletAdapter.connectKaspium(resolvedAddress);
        persistKaspiumAddress(session.address);
        setInfo(`Kaspium session ready for ${shortAddr(session.address)}.`);
      } else {
        session = { address: DEMO_ADDRESS, network: DEFAULT_NETWORK, provider: "demo" };
        setInfo("Demo session ready.");
      }
      persistProvider(provider);
      onConnect(session);
    } catch (e: any) {
      setErr(formatForgeError(e) || e?.message || "Wallet connection failed.");
    }
    setBusyProvider(null);
  };

  const wallets = FORGEOS_CONNECTABLE_WALLETS.filter(w => w.id !== "ghost").map((w) => {
    if (w.id === "kasware") return { ...w, statusText: detected.kasware ? "Detected in this tab" : "Not detected", statusColor: detected.kasware ? C.ok : C.warn, cta: "Connect Kasware" };
    if (w.id === "kastle") return { ...w, statusText: detected.kastle ? "Detected in this tab" : "Not detected", statusColor: detected.kastle ? C.ok : C.warn, cta: "Connect Kastle" };
    if (w.id === "kaspium") return { ...w, statusText: kaspiumAddressValid ? `Ready · ${shortAddr(activeKaspiumAddress)}` : "Address resolves on connect", statusColor: kaspiumAddressValid ? C.ok : C.warn, cta: kaspiumAddressValid ? "Connect Kaspium" : "Connect + Pair Address" };
    if (w.id === "tangem" || w.id === "onekey") return { ...w, statusText: "Manual bridge · address + txid handoff", statusColor: C.warn, cta: `Connect ${w.name}` };
    return { ...w, statusText: "No blockchain broadcast", statusColor: C.dim, cta: "Enter Demo Mode" };
  });

  const walletSections = useMemo(() => {
    const ordered = Array.isArray(wallets) ? wallets : [];
    const direct = ordered.filter((w) => ["kasware", "kastle"].includes(String(w.id)));
    const mobileBridge = ordered.filter((w) => ["kaspium", "tangem", "onekey"].includes(String(w.id)));
    const sandbox = ordered.filter((w) => String(w.id) === "demo");
    const other = ordered.filter((w) => !direct.includes(w) && !mobileBridge.includes(w) && !sandbox.includes(w));
    return [
      { key: "direct", title: "Browser Wallets", subtitle: "Native Kaspa signing + broadcast in this session.", items: [...direct, ...other.filter((w) => String(w.class) === "extension")] },
      { key: "mobile-bridge", title: "Mobile & Hardware", subtitle: "Deep-link or manual bridge/handoff flows.", items: [...mobileBridge, ...other.filter((w) => String(w.class) !== "extension" && String(w.id) !== "demo")] },
      { key: "sandbox", title: "Sandbox", subtitle: "UI validation — no on-chain broadcast.", items: sandbox },
    ].filter((section) => section.items.length > 0);
  }, [wallets]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="forge-shell" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: "clamp(12px, 2vw, 20px)" }}>
      <ForgeAtmosphere />
      {/* Top-left logo mark */}
      <div style={{ position: "fixed", top: 16, left: 18, zIndex: 10, display: "flex", alignItems: "center", gap: 8 }}>
        <img src="/forge-os-icon2.png" alt="Forge-OS" style={{ width: 42, height: 42, objectFit: "contain", filter: "drop-shadow(0 0 8px rgba(57,221,182,0.5))" }} />
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", ...mono, color: C.text }}>
          <span style={{ color: C.accent }}>FORGE</span>-OS
        </span>
      </div>
      <div className="forge-content forge-gate-responsive" style={{ width: "100%", maxWidth: 1380, display: "grid", gridTemplateColumns: "minmax(0,1.1fr) minmax(320px,520px)", gap: "clamp(16px, 3vw, 28px)", alignItems: "start" }}>

        {/* ── HERO COLUMN ── */}
        <section style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>

          {/* Kicker + title */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
            <div style={{ fontSize: 9, color: C.accent, fontWeight: 700, ...mono, letterSpacing: "0.2em", marginBottom: 12 }}>
              FORGE-OS // KASPA-NATIVE QUANT STACK
            </div>
            <h1 style={{ font: `700 clamp(24px,4vw,48px)/1.1 'IBM Plex Mono',monospace`, letterSpacing: "0.03em", margin: "0 0 10px", color: C.text, textWrap: "balance" as any }}>
              <span style={{ color: C.accent, textShadow: "0 0 25px rgba(57,221,182,0.5)" }}>KAS / USDC</span><br />
              <span style={{ color: C.text, fontWeight: 800 }}>AI TRADING</span><br />
              <span style={{ color: C.dim, fontWeight: 500, fontSize: "0.85em" }}>⚡ BLOCKDAG SPEED</span>
            </h1>
            <p style={{ font: `500 13px/1.5 'Space Grotesk','Segoe UI',sans-serif`, color: "#9db0c6", maxWidth: "52ch", margin: "0 0 12px" }}>
              Full-stack DeFi for Kaspa. AI agents accumulate KAS now & execute KAS/USDC pairs when stablecoins launch on L1.
            </p>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
              <Badge text={`${NETWORK_LABEL}`} color={C.ok} dot />
              <Badge text="KAS / USDC READY" color={C.purple} dot />
              <Badge text="NON-CUSTODIAL" color={C.warn} dot />
              <Badge text="DAG-SPEED EXECUTION" color={C.accent} dot />
            </div>
          </div>

          {/* Protocol stack grid */}
          <div>
            <div style={{ fontSize: 9, color: C.dim, ...mono, letterSpacing: "0.16em", marginBottom: 8 }}>PROTOCOL CAPABILITIES</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6 }}>
              {PROTOCOL_STACK.map((item) => (
                <div key={item.title}
                  style={{
                    background: `linear-gradient(145deg, ${item.iconColor}10 0%, rgba(8,13,20,0.55) 100%)`,
                    border: `1px solid ${item.iconColor}22`,
                    borderRadius: 8, padding: "10px 12px",
                  }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                    <span style={{ fontSize: 16, color: item.iconColor, lineHeight: 1 }}>{item.icon}</span>
                    <span style={{
                      fontSize: 7, color: item.statusColor, fontWeight: 700, ...mono,
                      background: `${item.statusColor}15`, padding: "2px 5px", borderRadius: 3,
                      border: `1px solid ${item.statusColor}30`,
                    }}>{item.status}</span>
                  </div>
                  <div style={{ fontSize: 10, color: C.text, fontWeight: 700, ...mono, marginBottom: 3 }}>{item.title}</div>
                  <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.4 }}>{item.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Architecture strip */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
            {[
              ["EXECUTION", "Wallet-native signing + queue lifecycle management"],
              ["TRUTH", "Receipt-aware P&L attribution + consistency checks"],
              ["ROUTING", "DAG-aware capital allocation + Kelly-fraction sizing"],
            ].map(([k, v]) => (
              <div key={k} style={{ border: `1px solid rgba(33,48,67,0.72)`, borderRadius: 10, background: "linear-gradient(180deg, rgba(11,20,30,0.78) 0%, rgba(9,15,23,0.7) 100%)", padding: "10px 12px" }}>
                <div style={{ font: `700 10px/1.2 'IBM Plex Mono',monospace`, color: C.accent, letterSpacing: "0.1em", marginBottom: 4 }}>{k}</div>
                <div style={{ font: `500 9px/1.4 'IBM Plex Mono',monospace`, color: C.dim }}>{v}</div>
              </div>
            ))}
          </div>

          {/* Key numbers */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
            {[
              { v: "BlockDAG", l: "Settlement speed" },
              { v: "Non-Custodial", l: "Keys stay in wallet" },
              { v: "KAS/USDC", l: "Pair architecture" },
            ].map(item => (
              <div key={item.v} style={{ border: `1px solid rgba(33,48,67,0.82)`, borderRadius: 12, background: "rgba(10,17,24,0.72)", padding: "12px" }}>
                <div style={{ font: `700 16px/1.2 'IBM Plex Mono',monospace`, color: C.accent, marginBottom: 4 }}>{item.v}</div>
                <div style={{ font: `500 10px/1.4 'IBM Plex Mono',monospace`, letterSpacing: "0.08em", color: C.dim }}>{item.l}</div>
              </div>
            ))}
          </div>

          {/* Social links */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[
              { href: "https://x.com/ForgeOSDefi", icon: "𝕏", label: "@ForgeOSDefi", c: C.text },
              { href: "https://github.com/Forge-OS", icon: "⌘", label: "GitHub", c: C.dim },
              { href: "https://t.me/ForgeOSDefi", icon: "✈", label: "Telegram", c: C.dim },
            ].map(item => (
              <a key={item.label} href={item.href} target="_blank" rel="noopener noreferrer"
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  padding: "8px 14px", borderRadius: 8,
                  background: "rgba(16,25,35,0.5)", border: `1px solid rgba(33,48,67,0.7)`,
                  color: item.c, textDecoration: "none", fontSize: 11, fontWeight: 600, ...mono,
                }}>
                <span style={{ fontSize: 14 }}>{item.icon}</span>
                <span>{item.label}</span>
              </a>
            ))}
          </div>
        </section>

        {/* ── CONNECT COLUMN ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Branding lockup */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, justifyContent: "center" }}>
            <img src="/forge-os-icon2.png" alt="Forge-OS" style={{ width: 48, height: 48, objectFit: "contain", filter: "drop-shadow(0 0 10px rgba(57,221,182,0.5))" }} />
            <div>
              <div style={{ fontSize: "clamp(18px,3vw,24px)", fontWeight: 700, ...mono, letterSpacing: "0.12em", lineHeight: 1.2 }}>
                <span style={{ color: C.accent }}>FORGE</span><span style={{ color: C.text }}>-OS</span>
              </div>
              <div style={{ fontSize: 9, color: C.dim, letterSpacing: "0.1em", ...mono }}>AI-NATIVE FINANCIAL OPERATING SYSTEM · POWERED BY KASPA</div>
            </div>
          </div>

          {/* Connect card */}
          <Card p={22} style={{ border: `1px solid rgba(57,221,182,0.14)` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div style={{ fontSize: 14, color: C.text, fontWeight: 700, ...mono }}>Connect Wallet</div>
              <Badge text={NETWORK_LABEL} color={C.ok} dot />
            </div>
            <div style={{ fontSize: 11, color: C.dim, marginBottom: 16 }}>
              All operations are wallet-native. Forge-OS never stores private keys or signs on your behalf.
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {walletSections.map((section) => (
                <div key={section.key}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 10, color: C.text, fontWeight: 700, ...mono, letterSpacing: "0.1em" }}>{section.title.toUpperCase()}</div>
                      <div style={{ fontSize: 9, color: C.dim, marginTop: 2 }}>{section.subtitle}</div>
                    </div>
                    <Badge text={`${section.items.length}`} color={C.dim} />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: section.items.length > 1 ? "repeat(2,1fr)" : "1fr", gap: 8 }}>
                    {section.items.map((w: any) => (
                      <div key={w.id}
                        style={{
                          borderRadius: 10, padding: "12px 14px 10px",
                          background: lastProvider === w.id
                            ? `linear-gradient(165deg, rgba(57,221,182,0.1) 0%, rgba(8,13,20,0.6) 100%)`
                            : `linear-gradient(165deg, rgba(16,25,35,0.7) 0%, rgba(8,13,20,0.5) 100%)`,
                          border: `1px solid ${lastProvider === w.id ? `${C.accent}50` : "rgba(33,48,67,0.72)"}`,
                          boxShadow: lastProvider === w.id ? `inset 0 0 0 1px rgba(57,221,182,0.18)` : "none",
                          display: "flex", flexDirection: "column", gap: 0,
                          transition: "border-color 0.15s, box-shadow 0.15s",
                        }}>
                        {/* Wallet head */}
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                          {w.logoSrc ? (
                            <div style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.02)", border: `1px solid ${C.border}`, borderRadius: 6, overflow: "hidden", flexShrink: 0 }}>
                              <img src={w.logoSrc} alt={`${w.name} logo`} style={{ width: 22, height: 22, objectFit: "contain" }} />
                            </div>
                          ) : (
                            <div style={{ fontSize: 20, width: 28, display: "flex", justifyContent: "center", flexShrink: 0 }}>{w.uiIcon}</div>
                          )}
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                              <div style={{ fontSize: 11, color: C.text, fontWeight: 700, ...mono }}>{w.name}</div>
                              {lastProvider === w.id && <Badge text="LAST" color={C.accent} />}
                            </div>
                            <div style={{ fontSize: 9, color: w.statusColor, marginTop: 1, ...mono }}>{w.statusText}</div>
                          </div>
                        </div>

                        {/* Description */}
                        <div style={{ fontSize: 9, color: C.dim, lineHeight: 1.45, marginBottom: 8, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as any, overflow: "hidden" }} title={w.description}>
                          {w.description}
                        </div>

                        {/* Caps row */}
                        <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
                          <Badge text={walletClassLabel(w.class)} color={C.dim} />
                          {w.capabilities.network && <Badge text="NETWORK" color={C.ok} />}
                          {w.capabilities.manualTxid && <Badge text="MANUAL TXID" color={C.warn} />}
                        </div>

                        {/* CTA */}
                        <div style={{ display: "flex", gap: 6, marginTop: "auto" }}>
                          <Btn
                            onClick={() => connect(w.id)}
                            disabled={busy && busyProvider !== w.id}
                            variant={w.id === "demo" ? "ghost" : "primary"}
                            size="sm"
                            style={{ flex: 1, minWidth: 0 }}>
                            {busyProvider === w.id ? "CONNECTING…" : w.cta}
                          </Btn>
                          {w.docsUrl && <ExtLink href={w.docsUrl} label="↗" />}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {info && <div style={{ marginTop: 12, padding: "10px 14px", background: `${C.ok}12`, border: `1px solid ${C.ok}44`, borderRadius: 6, fontSize: 11, color: C.ok, ...mono }}>{info}</div>}
            {err && <div style={{ marginTop: 12, padding: "10px 14px", background: C.dLow, border: `1px solid ${C.danger}40`, borderRadius: 6, fontSize: 11, color: C.danger, ...mono }}>{err}</div>}

            <Divider m={16} />
            <div style={{ fontSize: 9, color: C.dim, ...mono, lineHeight: 1.6 }}>
              Forge-OS never requests your private key · All signing happens inside your wallet · {NETWORK_LABEL}
            </div>
          </Card>

          {/* KAS/USDC readiness notice */}
          <div style={{
            background: `linear-gradient(135deg, ${C.purple}10 0%, rgba(8,13,20,0.5) 100%)`,
            border: `1px solid ${C.purple}28`,
            borderRadius: 10, padding: "12px 16px",
          }}>
            <div style={{ fontSize: 9, color: C.purple, fontWeight: 700, ...mono, letterSpacing: "0.12em", marginBottom: 6 }}>KAS / USDC PAIR READINESS</div>
            <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.55 }}>
              Forge-OS agents are architected for native KAS/USDC pairs. When Kaspa enables stablecoins at L1,
              agents switch from accumulation-only to full buy/sell logic — stable PnL tracking, cleaner entry/exit,
              and USDC-denominated risk management. No migration required.
            </div>
          </div>
        </div>
      </div>

      {/* Responsive override */}
      <style>{`
        @media (max-width: 1080px) {
          .forge-gate-responsive { grid-template-columns: 1fr !important; max-width: 720px; }
        }
      `}</style>
    </div>
  );
}
