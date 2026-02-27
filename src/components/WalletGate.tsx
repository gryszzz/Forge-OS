import { useState } from "react";
import { DEFAULT_NETWORK, DEMO_ADDRESS, NETWORK_LABEL } from "../constants";
import { C, mono } from "../tokens";
import { Badge, Card, Divider } from "./ui";
import { ForgeAtmosphere } from "./chrome/ForgeAtmosphere";
import { WalletCreator } from "./WalletCreator";
import { WalletAdapter } from "../wallet/WalletAdapter";

// Protocol capability blocks
const PROTOCOL_STACK = [
  {
    status: "LIVE",
    statusColor: "#39DDB6",
    title: "KAS Accumulation",
    desc: "AI agents accumulate KAS now — Kelly-sized entries, regime-aware execution on the BlockDAG.",
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
    title: "KAS / USDC Profit Trading",
    desc: "When Kaspa stablecoins launch, agents flip from accumulation to active buy/sell — profiting on KAS price swings.",
    icon: "⇄",
    iconColor: "#8F7BFF",
  },
  {
    status: "READY",
    statusColor: "#F7B267",
    title: "KRC-20 Token Support",
    desc: "Engine ready for KRC-20 tokens on Kaspa. Buy the dip, sell the strength — across any KRC-20/KAS pair.",
    icon: "⬡",
    iconColor: "#F7B267",
  },
  {
    status: "READY",
    statusColor: "#F7B267",
    title: "Kaspa 0x Swaps",
    desc: "Built for Kaspa's 0x-style DEX layer. Agents route capital across pools — KAS, kUSD, kBTC and beyond.",
    icon: "⊕",
    iconColor: "#F7B267",
  },
];

export function WalletGate({ onConnect, onSignInClick }: { onConnect: (session: any) => void; onSignInClick?: () => void }) {
  const [showCreator, setShowCreator] = useState(false);
  const [quickConnectBusy, setQuickConnectBusy] = useState<"kasware" | null>(null);
  const [quickConnectError, setQuickConnectError] = useState<string | null>(null);

  const connectKaswareQuick = async () => {
    setQuickConnectError(null);
    setQuickConnectBusy("kasware");
    try {
      const session = await WalletAdapter.connectKasware();
      onConnect(session);
    } catch (err: any) {
      const message = String(err?.message || err || "Kasware connection failed.");
      setQuickConnectError(message);
    } finally {
      setQuickConnectBusy(null);
    }
  };

  const enterDemoMode = () => {
    setQuickConnectError(null);
    onConnect({
      address: DEMO_ADDRESS,
      network: DEFAULT_NETWORK,
      provider: "demo",
    });
  };

  return (
    <div className="forge-shell" style={{ display: "flex", flexDirection: "column", alignItems: "center", minHeight: "100vh", padding: "clamp(8px, 2vw, 12px)", backgroundColor: C.bg }}>
      <ForgeAtmosphere />

      {/* Top brand row (no tab/chrome background) */}
      <div style={{ width: "100%", maxWidth: 1600, display: "flex", alignItems: "center", padding: "4px clamp(16px, 3vw, 36px) 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <img
            src="/forge-os-icon3.png"
            alt="Forge-OS"
            style={{
              width: 44,
              height: 44,
              objectFit: "contain",
              filter: "drop-shadow(0 0 8px rgba(57,221,182,0.5))",
            }}
          />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", ...mono }}>
            <span style={{ color: C.accent }}>FORGE</span>
            <span style={{ color: C.text }}>-OS</span>
          </span>
        </div>
      </div>

      {/* ── FULL-WIDTH CENTERED HERO ── */}
      <div style={{ width: "100%", maxWidth: 1100, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "clamp(28px,5vw,56px) clamp(16px,3vw,32px) clamp(20px,3vw,36px)" }}>
        <div aria-hidden style={{ height: 12 }} />
        <h1 style={{ font: `700 clamp(32px,5.5vw,64px)/1.1 'IBM Plex Mono',monospace`, letterSpacing: "0.03em", margin: 0, color: C.text, textWrap: "balance" as any }}>
          <span style={{ color: C.accent, textShadow: "0 0 30px rgba(57,221,182,0.55)" }}>KAS / USDC</span>
          <span style={{ color: C.text, fontWeight: 800 }}> AI TRADING</span>
          <br />
          <span style={{ color: C.dim, fontWeight: 500, fontSize: "0.65em", letterSpacing: "0.06em" }}>⚡ BLOCKDAG SPEED</span>
        </h1>
        <p style={{ font: `500 15px/1.6 'Space Grotesk','Segoe UI',sans-serif`, color: "#9db0c6", maxWidth: "64ch", margin: 0 }}>
          Full-stack DeFi for Kaspa. Agents accumulate KAS today — and flip to active profit trading the moment stablecoins, KRC-20, and Kaspa 0x swaps go live.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
          <Badge text={`${NETWORK_LABEL}`} color={C.ok} dot />
          <Badge text="KRC-20 READY" color={C.purple} dot />
          <Badge text="NON-CUSTODIAL" color={C.warn} dot />
          <Badge text="DAG-SPEED EXECUTION" color={C.accent} dot />
        </div>
      </div>

      {/* ── MAIN CONTENT GRID ── */}
      <div className="forge-content forge-gate-responsive" style={{ width: "100%", maxWidth: 1600, display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(360px,520px)", gap: "clamp(20px, 3vw, 40px)", alignItems: "flex-start", padding: "0 clamp(12px,2vw,24px)" }}>

        {/* ── INFO COLUMN ── */}
        <section style={{ display: "flex", flexDirection: "column", gap: 6, justifySelf: "center", width: "100%", maxWidth: 910, textAlign: "center" }}>

          {/* Protocol stack grid */}
          <div style={{ width: "100%" }}>
            <div style={{ fontSize: 10, color: C.dim, ...mono, letterSpacing: "0.16em", marginBottom: 8, textAlign: "center" }}>PROTOCOL CAPABILITIES</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6 }}>
              {PROTOCOL_STACK.map((item) => (
                <div key={item.title}
                  style={{
                    background: `linear-gradient(145deg, ${item.iconColor}10 0%, rgba(8,13,20,0.55) 100%)`,
                    border: `1px solid ${item.iconColor}22`,
                    borderRadius: 8, padding: "12px 14px",
                  }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                    <span style={{ fontSize: 18, color: item.iconColor, lineHeight: 1 }}>{item.icon}</span>
                    <span style={{
                      fontSize: 8, color: item.statusColor, fontWeight: 700, ...mono,
                      background: `${item.statusColor}15`, padding: "2px 6px", borderRadius: 3,
                      border: `1px solid ${item.statusColor}30`,
                    }}>{item.status}</span>
                  </div>
                  <div style={{ fontSize: 11, color: C.text, fontWeight: 700, ...mono, marginBottom: 4 }}>{item.title}</div>
                  <div style={{ fontSize: 9, color: C.dim, lineHeight: 1.4 }}>{item.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Architecture strip */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, width: "100%" }}>
            {[
              ["EXECUTION", "Wallet-native signing + queue lifecycle management"],
              ["TRUTH", "Receipt-aware P&L attribution + consistency checks"],
              ["ROUTING", "DAG-aware capital allocation + Kelly-fraction sizing"],
            ].map(([k, v]) => (
              <div key={k} style={{ border: `1px solid rgba(33,48,67,0.72)`, borderRadius: 10, background: "linear-gradient(180deg, rgba(11,20,30,0.78) 0%, rgba(9,15,23,0.7) 100%)", padding: "12px 14px" }}>
                <div style={{ font: `700 11px/1.2 'IBM Plex Mono',monospace`, color: C.accent, letterSpacing: "0.1em", marginBottom: 4 }}>{k}</div>
                <div style={{ font: `500 9px/1.4 'IBM Plex Mono',monospace`, color: C.dim }}>{v}</div>
              </div>
            ))}
          </div>

          {/* Key numbers */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, width: "100%" }}>
            {[
              { v: "BlockDAG", l: "Settlement speed" },
              { v: "Non-Custodial", l: "Keys stay in wallet" },
              { v: "KAS/USDC", l: "Pair architecture" },
            ].map(item => (
              <div key={item.v} style={{ border: `1px solid rgba(33,48,67,0.82)`, borderRadius: 10, background: "rgba(10,17,24,0.72)", padding: "12px" }}>
                <div style={{ font: `700 18px/1.2 'IBM Plex Mono',monospace`, color: C.accent, marginBottom: 4 }}>{item.v}</div>
                <div style={{ font: `500 10px/1.3 'IBM Plex Mono',monospace`, letterSpacing: "0.08em", color: C.dim }}>{item.l}</div>
              </div>
            ))}
          </div>

          {/* Social links */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
            {[
              { href: "https://x.com/ForgeOSxyz", icon: "𝕏", label: "@ForgeOSxyz", c: C.text },
              { href: "https://github.com/Forge-OS", icon: "⌘", label: "GitHub", c: C.dim },
              { href: "https://t.me/ForgeOSDefi", icon: "✈", label: "Telegram", c: C.dim },
            ].map(item => (
              <a key={item.label} href={item.href} target="_blank" rel="noopener noreferrer"
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "6px 10px", borderRadius: 6,
                  background: "rgba(16,25,35,0.5)", border: `1px solid rgba(33,48,67,0.7)`,
                  color: item.c, textDecoration: "none", fontSize: 10, fontWeight: 600, ...mono,
                }}>
                <span style={{ fontSize: 12 }}>{item.icon}</span>
                <span>{item.label}</span>
              </a>
            ))}
          </div>
        </section>

        {/* ── CONNECT COLUMN ── */}
        <div className="forge-connect-column" style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: "clamp(-35px,-3vw,-18px)" }}>
          <div aria-hidden style={{ height: "clamp(34px, 5vw, 52px)" }} />

          {/* Connect card */}
          <Card p={20} style={{ border: `1px solid rgba(57,221,182,0.14)` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div style={{ fontSize: 16, color: C.text, fontWeight: 700, ...mono }}>Connect Wallet</div>
              <Badge text={NETWORK_LABEL} color={C.ok} dot />
            </div>
            <div style={{ fontSize: 12, color: C.dim, marginBottom: 16 }}>
              All operations are wallet-native. Forge-OS never stores private keys or signs on your behalf.
            </div>

            {/* Primary CTA — Sign In / Connect opens extension popup + wallet list */}
            <button
              onClick={onSignInClick}
              style={{
                width: "100%",
                background: `linear-gradient(90deg, ${C.accent}, #7BE9CF)`,
                border: "none",
                borderRadius: 10,
                cursor: "pointer",
                color: "#04110E",
                fontSize: 14,
                ...mono,
                fontWeight: 700,
                letterSpacing: "0.08em",
                padding: "16px 0",
                boxShadow: "0 4px 20px rgba(57,221,182,0.28)",
                marginBottom: 10,
                transition: "box-shadow 0.15s",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 6px 28px rgba(57,221,182,0.44)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.boxShadow = "0 4px 20px rgba(57,221,182,0.28)"; }}
            >
              CONNECT WALLET →
            </button>

            {/* Quick paths kept for fast testing + power users */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              <button
                onClick={connectKaswareQuick}
                disabled={quickConnectBusy === "kasware"}
                style={{
                  width: "100%",
                  background: "rgba(11,17,24,0.85)",
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  cursor: quickConnectBusy === "kasware" ? "not-allowed" : "pointer",
                  color: quickConnectBusy === "kasware" ? C.dim : C.text,
                  fontSize: 10,
                  ...mono,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  padding: "10px 0",
                }}
              >
                {quickConnectBusy === "kasware" ? "CONNECTING…" : "CONNECT KASWARE"}
              </button>
              <button
                onClick={enterDemoMode}
                style={{
                  width: "100%",
                  background: "rgba(11,17,24,0.85)",
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  cursor: "pointer",
                  color: C.text,
                  fontSize: 10,
                  ...mono,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  padding: "10px 0",
                }}
              >
                ENTER DEMO MODE
              </button>
            </div>

            {quickConnectError && (
              <div style={{ fontSize: 9, color: C.danger, lineHeight: 1.5, marginBottom: 10 }}>
                {quickConnectError}
              </div>
            )}

            {/* Secondary option — create / import wallet */}
            <button
              onClick={() => setShowCreator(true)}
              style={{
                width: "100%",
                background: "linear-gradient(135deg, rgba(57,221,182,0.06) 0%, rgba(8,13,20,0.55) 100%)",
                border: `1px solid ${C.accent}28`,
                borderRadius: 10,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 16px",
                marginBottom: 16,
                transition: "border-color 0.15s",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = `${C.accent}55`; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = `${C.accent}28`; }}
            >
              <div style={{ textAlign: "left" }}>
                <div style={{ fontSize: 11, color: C.text, ...mono, fontWeight: 700, marginBottom: 2 }}>New to Kaspa?</div>
                <div style={{ fontSize: 10, color: C.dim }}>Create or import a wallet</div>
              </div>
              <span style={{ fontSize: 11, color: C.accent, ...mono, fontWeight: 700, letterSpacing: "0.06em", flexShrink: 0, marginLeft: 8 }}>
                CREATE ›
              </span>
            </button>

            <Divider m={14} />
            <div style={{ fontSize: 10, color: C.dim, ...mono, lineHeight: 1.5 }}>
              Forge-OS never requests your private key · All signing happens inside your wallet · {NETWORK_LABEL}
            </div>
          </Card>

          {/* KAS/USDC readiness notice */}
          <div style={{
            background: `linear-gradient(135deg, ${C.purple}10 0%, rgba(8,13,20,0.5) 100%)`,
            border: `1px solid ${C.purple}28`,
            borderRadius: 10, padding: "14px 18px",
          }}>
            <div style={{ fontSize: 10, color: C.purple, fontWeight: 700, ...mono, letterSpacing: "0.12em", marginBottom: 6 }}>KASPA STABLECOIN UPGRADE · READY</div>
            <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.5 }}>
              Agents accumulate KAS now. When Kaspa stablecoins launch at L1, agents automatically
              switch to active buy/sell — buying dips, selling strength, and booking profit in USD.
              KRC-20 tokens and Kaspa 0x swaps are already in the engine. No migration, no downtime.
            </div>
          </div>
        </div>
      </div>

      {/* Responsive override */}
      <style>{`
        @media (max-width: 1200px) {
          .forge-gate-responsive { grid-template-columns: 1fr !important; max-width: 800px; }
          .forge-connect-column { margin-top: 10px !important; }
        }
      `}</style>

      {showCreator && (
        <WalletCreator
          onConnect={(session) => { setShowCreator(false); onConnect(session); }}
          onClose={() => setShowCreator(false)}
        />
      )}
    </div>
  );
}
