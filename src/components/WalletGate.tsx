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

export function WalletGate({onConnect}: any) {
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [err,  setErr]  = useState(null as any);
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
    try {
      window.localStorage.setItem(kaspiumStorageKey, normalized);
    } catch {
      // Ignore storage failures in strict browser contexts.
    }
  };

  const persistProvider = (provider: string) => {
    setLastProvider(provider);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(providerStorageKey, provider);
    } catch {
      // Ignore storage failures in strict browser contexts.
    }
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
      } catch {
        // Clipboard can fail in strict browser permission modes.
      }
    }

    const raw = window.prompt(
      `Paste your ${NETWORK_LABEL} Kaspium address (${ALLOWED_ADDRESS_PREFIXES.join(", ")}).`
    ) || "";
    const normalized = normalizeKaspaAddress(raw, ALLOWED_ADDRESS_PREFIXES);
    setKaspiumAddress(normalized);
    persistKaspiumAddress(normalized);
    return normalized;
  };

  const resolveManualBridgeAddress = async (walletName: string) => {
    const raw = window.prompt(
      `Paste your ${NETWORK_LABEL} ${walletName} receive address (${ALLOWED_ADDRESS_PREFIXES.join(", ")}).`
    ) || "";
    return normalizeKaspaAddress(raw, ALLOWED_ADDRESS_PREFIXES);
  };

  const connect = async (provider: string) => {
    setBusyProvider(provider);
    setErr(null);
    setInfo("");
    try {
      let session;
      if(provider === "kasware") {
        session = await WalletAdapter.connectKasware();
        setInfo("Kasware session ready. Extension signing is armed.");
      } else if(provider === "kastle") {
        session = await WalletAdapter.connectKastle();
        setInfo("Kastle session ready. Extension signing is armed.");
      } else if(provider === "tangem" || provider === "onekey") {
        const resolvedAddress = await resolveManualBridgeAddress(provider === "tangem" ? "Tangem" : "OneKey");
        session = await WalletAdapter.connectHardwareBridge(provider as "tangem" | "onekey", resolvedAddress);
        setInfo(`${provider === "tangem" ? "Tangem" : "OneKey"} bridge session ready for ${shortAddr(session.address)}.`);
      } else if(provider === "kaspium") {
        const resolvedAddress = await resolveKaspiumAddress();
        session = WalletAdapter.connectKaspium(resolvedAddress);
        persistKaspiumAddress(session.address);
        setInfo(`Kaspium session ready for ${shortAddr(session.address)}.`);
      } else {
        // Demo mode — no extension
        session = { address: DEMO_ADDRESS, network:DEFAULT_NETWORK, provider:"demo" };
        setInfo("Demo session ready.");
      }
      persistProvider(provider);
      onConnect(session);
    } catch(e: any) {
      setErr(formatForgeError(e) || e?.message || "Wallet connection failed.");
    }
    setBusyProvider(null);
  };

  const wallets = FORGEOS_CONNECTABLE_WALLETS.filter(w => w.id !== "ghost").map((w) => {
    if (w.id === "kasware") {
      return {
        ...w,
        statusText: detected.kasware ? "Detected in this tab" : "Not detected in this tab",
        statusColor: detected.kasware ? C.ok : C.warn,
        cta: "Connect Kasware",
      };
    }
    if (w.id === "kastle") {
      return {
        ...w,
        statusText: detected.kastle ? "Detected in this tab" : "Not detected in this tab",
        statusColor: detected.kastle ? C.ok : C.warn,
        cta: "Connect Kastle",
      };
    }
    if (w.id === "kaspium") {
      return {
        ...w,
        statusText: kaspiumAddressValid ? `Address ready · ${shortAddr(activeKaspiumAddress)}` : "Address resolves on connect",
        statusColor: kaspiumAddressValid ? C.ok : C.warn,
        cta: kaspiumAddressValid ? "Connect Kaspium" : "Connect + Pair Address",
      };
    }
    if (w.id === "tangem" || w.id === "onekey") {
      return {
        ...w,
        statusText: "Manual bridge (address + txid handoff)",
        statusColor: C.warn,
        cta: `Connect ${w.name}`,
      };
    }
    return {
      ...w,
      statusText: "No blockchain broadcast",
      statusColor: C.dim,
      cta: "Enter Demo Mode",
    };
  });

  const walletSections = useMemo(() => {
    const ordered = Array.isArray(wallets) ? wallets : [];
    const direct = ordered.filter((w) => ["kasware", "kastle"].includes(String(w.id)));
    const mobileBridge = ordered.filter((w) => ["kaspium", "tangem", "onekey"].includes(String(w.id)));
    const sandbox = ordered.filter((w) => String(w.id) === "demo");
    const other = ordered.filter(
      (w) => !direct.includes(w) && !mobileBridge.includes(w) && !sandbox.includes(w)
    );
    return [
      {
        key: "direct",
        title: "Direct Wallets",
        subtitle: "Browser-native Kaspa signing and broadcast in this session.",
        items: [...direct, ...other.filter((w) => String(w.class) === "extension")],
      },
      {
        key: "mobile-bridge",
        title: "Mobile & Hardware Bridge",
        subtitle: "Deep-link or bridge/manual handoff flows with non-custodial signing.",
        items: [...mobileBridge, ...other.filter((w) => String(w.class) !== "extension" && String(w.id) !== "demo")],
      },
      {
        key: "sandbox",
        title: "Sandbox",
        subtitle: "UI / workflow validation with no on-chain broadcast.",
        items: sandbox,
      },
    ].filter((section) => section.items.length > 0);
  }, [wallets]);

  return (
    <div className="forge-shell" style={{display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"clamp(18px, 2vw, 28px)"}}>
      <ForgeAtmosphere />
      <div className="forge-content forge-gate-layout">
        <section className="forge-gate-hero">
          <div className="forge-gate-hero-main">
            <div className="forge-gate-kicker">FORGE.OS // KASPA-NATIVE QUANT STACK</div>
            <h1 className="forge-gate-title">
              <span style={{color:C.accent}}>FORGE</span>.OS TRADING CONTROL SURFACE
            </h1>
            <p className="forge-gate-copy">
              Full-screen command center for wallet-native execution, AI-guided quant cycles, and DAG-aware capital routing.
              Connect a supported wallet to operate the system. Signing remains inside your wallet at all times.
            </p>
            <div style={{display:"flex", gap:8, flexWrap:"wrap", marginTop:16}}>
              <Badge text={`${NETWORK_LABEL} SESSION`} color={C.ok} dot/>
              <Badge text="WALLET-NATIVE AUTHORIZATION" color={C.purple} dot/>
              <Badge text="SESSION CONTINUITY" color={C.warn} dot/>
            </div>

            <div className="forge-gate-hero-strip">
              {[
                ["EXECUTION", "Wallet-native signing + queue lifecycle"],
                ["TRUTH", "Receipt-aware attribution + consistency checks"],
                ["ROUTING", "DAG-aware capital allocation + guardrails"],
              ].map(([k, v]) => (
                <div key={k} className="forge-gate-hero-strip-item">
                  <div className="forge-gate-hero-strip-k">{k}</div>
                  <div className="forge-gate-hero-strip-v">{v}</div>
                </div>
              ))}
            </div>
            
            {/* Social Links */}
            <div style={{display:"flex", gap:12, marginTop:20, justifyContent:"center", flexWrap:"wrap"}}>
              <a 
                href="https://x.com/ForgeOSDefi" 
                target="_blank" 
                rel="noopener noreferrer"
                style={{
                  display:"flex", alignItems:"center", gap:8,
                  padding:"8px 14px", borderRadius:6,
                  background:C.s2, border:`1px solid ${C.border}`,
                  color:C.text, textDecoration:"none",
                  fontSize:11, fontWeight:600, ...mono,
                  transition:"all 0.15s"
                }}
              >
                <span style={{fontSize:14}}>𝕏</span>
                <span>@ForgeOSDefi</span>
              </a>
              <a 
                href="https://github.com/Forge-OS" 
                target="_blank" 
                rel="noopener noreferrer"
                style={{
                  display:"flex", alignItems:"center", gap:8,
                  padding:"8px 14px", borderRadius:6,
                  background:C.s2, border:`1px solid ${C.border}`,
                  color:C.text, textDecoration:"none",
                  fontSize:11, fontWeight:600, ...mono,
                  transition:"all 0.15s"
                }}
              >
                <span style={{fontSize:14}}>⌘</span>
                <span>GitHub</span>
              </a>
              <a 
                href="https://t.me/ForgeOSDefi" 
                target="_blank" 
                rel="noopener noreferrer"
                style={{
                  display:"flex", alignItems:"center", gap:8,
                  padding:"8px 14px", borderRadius:6,
                  background:C.s2, border:`1px solid ${C.border}`,
                  color:C.text, textDecoration:"none",
                  fontSize:11, fontWeight:600, ...mono,
                  transition:"all 0.15s"
                }}
              >
                <span style={{fontSize:14}}>✈</span>
                <span>Telegram</span>
              </a>
            </div>
          </div>
          <div className="forge-gate-points">
            <div className="forge-gate-point">
              <div className="forge-gate-point-value">UTXO-Native</div>
              <div className="forge-gate-point-label">Kaspa-first architecture</div>
            </div>
            <div className="forge-gate-point">
              <div className="forge-gate-point-value">Non-Custodial</div>
              <div className="forge-gate-point-label">Private keys stay in wallet</div>
            </div>
            <div className="forge-gate-point">
              <div className="forge-gate-point-value">{NETWORK_LABEL}</div>
              <div className="forge-gate-point-label">Active network profile</div>
            </div>
          </div>
        </section>

        <div style={{display:"flex", flexDirection:"column", justifyContent:"center"}}>
          <div style={{marginBottom:18, textAlign:"center"}}>
            <div style={{fontSize:"clamp(24px, 4vw, 34px)", fontWeight:700, ...mono, letterSpacing:"0.12em", marginBottom:6}}>
              <span style={{color:C.accent}}>FORGE</span><span style={{color:C.text}}>.OS</span>
            </div>
            <div style={{fontSize:11, color:C.dim, letterSpacing:"0.08em", ...mono}}>AI-NATIVE FINANCIAL OPERATING SYSTEM · POWERED BY KASPA</div>
          </div>
          <div className="forge-content" style={{width:"100%", maxWidth:760}}>
            <Card p={24} style={{width:"100%"}}>
              <div style={{fontSize:14, color:C.text, fontWeight:700, ...mono, marginBottom:4}}>Connect Wallet</div>
              <div style={{fontSize:12, color:C.dim, marginBottom:14}}>
                All operations are wallet-native. Forge.OS never stores private keys or signs transactions on your behalf.
              </div>
              <div style={{fontSize:11, color:C.dim, ...mono, marginBottom:14}}>
                Runtime network: {NETWORK_LABEL} · accepted prefixes: {ALLOWED_ADDRESS_PREFIXES.join(", ")}
              </div>

              <div className="forge-wallet-sections">
                {walletSections.map((section) => (
                  <div key={section.key} className="forge-wallet-section">
                    <div style={{display:"flex", justifyContent:"space-between", gap:8, alignItems:"center", marginBottom:8, flexWrap:"wrap"}}>
                      <div>
                        <div style={{fontSize:12, color:C.text, fontWeight:700, ...mono, letterSpacing:"0.08em"}}>{section.title}</div>
                        <div style={{fontSize:10, color:C.dim, marginTop:2}}>{section.subtitle}</div>
                      </div>
                      <Badge text={`${section.items.length} WALLET${section.items.length === 1 ? "" : "S"}`} color={C.dim} />
                    </div>
                    <div className="forge-wallet-grid forge-wallet-grid--matrix">
                      {section.items.map((w: any) => (
                        <div
                          key={w.id}
                          className={`forge-wallet-card ${lastProvider === w.id ? "forge-wallet-card--preferred" : ""}`}
                        >
                          <div className="forge-wallet-card-head">
                            {w.logoSrc ? (
                              <div
                                style={{
                                  width: 32,
                                  height: 32,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  background: "rgba(255,255,255,0.02)",
                                  border: `1px solid ${C.border}`,
                                  borderRadius: 6,
                                  overflow: "hidden",
                                  flexShrink: 0,
                                }}
                              >
                                <img src={w.logoSrc} alt={`${w.name} logo`} style={{width: 28, height: 28, objectFit: "contain"}} />
                              </div>
                            ) : (
                              <div style={{fontSize:22, width:32, display:"flex", justifyContent:"center", flexShrink:0}}>{w.uiIcon}</div>
                            )}
                            <div style={{minWidth:0, flex:1}}>
                              <div style={{display:"flex", gap:6, alignItems:"center", flexWrap:"wrap"}}>
                                <div style={{fontSize:12, color:C.text, fontWeight:700, ...mono}}>{w.name}</div>
                                {lastProvider === w.id ? <Badge text="LAST USED" color={C.accent}/> : null}
                                <Badge text={walletClassLabel(w.class)} color={C.dim} />
                              </div>
                              <div style={{fontSize:10, color:w.statusColor, marginTop:4, ...mono}}>
                                {w.statusText}
                              </div>
                            </div>
                          </div>

                          <div
                            style={{
                              fontSize: 11,
                              color: C.dim,
                              marginTop: 8,
                              lineHeight: 1.35,
                              display: "-webkit-box",
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical",
                              overflow: "hidden",
                            }}
                            title={w.description}
                          >
                            {w.description}
                          </div>

                          <div style={{display:"flex", gap:6, marginTop:8, flexWrap:"wrap"}}>
                            {w.capabilities.network ? <Badge text="NETWORK AWARE" color={C.ok} /> : null}
                            {w.capabilities.manualTxid ? <Badge text="MANUAL TXID" color={C.warn} /> : null}
                          </div>

                          <div className="forge-wallet-card-actions">
                            <Btn
                              onClick={() => connect(w.id)}
                              disabled={busy && busyProvider !== w.id}
                              variant={w.id === "demo" ? "ghost" : "primary"}
                              size="sm"
                              style={{flex:1, minWidth:0}}
                            >
                              {busyProvider === w.id ? "CONNECTING..." : w.cta}
                            </Btn>
                            {w.docsUrl ? <ExtLink href={w.docsUrl} label="DOCS ↗" /> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {info ? <div style={{marginTop:12, padding:"10px 14px", background:C.oLow, border:`1px solid ${C.ok}44`, borderRadius:4, fontSize:12, color:C.ok, ...mono}}>{info}</div> : null}
              {err && <div style={{marginTop:14, padding:"10px 14px", background:C.dLow, borderRadius:4, fontSize:12, color:C.danger, ...mono}}>{err}</div>}
              <Divider m={18}/>
              <div style={{fontSize:11, color:C.dim, ...mono, lineHeight:1.6}}>
                Forge.OS never requests your private key · All transaction signing happens in your wallet · {NETWORK_LABEL} only
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

