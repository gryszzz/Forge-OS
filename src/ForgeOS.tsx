import { useEffect, useMemo, useState } from "react";
import { DEFAULT_NETWORK, NETWORK_LABEL, NETWORK_PROFILE } from "./constants";
import { shortAddr } from "./helpers";
import { C, mono } from "./tokens";
import { WalletGate } from "./components/WalletGate";
import { Wizard } from "./components/wizard/Wizard";
import { Dashboard } from "./components/dashboard/Dashboard";
import { Btn } from "./components/ui";
import { KASPA_NETWORK_PROFILES } from "./kaspa/network";
import { ForgeAtmosphere } from "./components/chrome/ForgeAtmosphere";
import { SignInModal } from "./components/SignInModal";
import { ForgeOSConnectModal } from "./components/ForgeOSConnectModal";
import { loadSession, clearSession, type ForgeSession } from "./auth/siwa";
import { WalletAdapter } from "./wallet/WalletAdapter";

const FORGE_AGENTS_KEY = "forgeos.session.agents.v2";
const FORGE_ACTIVE_KEY = "forgeos.session.activeAgent.v2";

export default function ForgeOS() {
  const [wallet, setWallet] = useState(null as any);
  const [siwaSession, setSiwaSession] = useState<ForgeSession | null>(() => loadSession());
  const [showSignIn, setShowSignIn] = useState(false);
  const [showForgeConnect, setShowForgeConnect] = useState(false);
  const [autoConnectAttempted, setAutoConnectAttempted] = useState(false);
  const [agents, setAgents] = useState<any[]>(() => {
    try {
      if (typeof window === "undefined") return [];
      const raw = window.localStorage.getItem(FORGE_AGENTS_KEY);
      if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) return p.slice(0, 24); }
    } catch {}
    return [];
  });
  const [activeAgentId, setActiveAgentId] = useState<string>(() => {
    try {
      if (typeof window === "undefined") return "";
      return window.localStorage.getItem(FORGE_ACTIVE_KEY) || "";
    } catch { return ""; }
  });
  const [view, setView] = useState<string>(() => {
    try {
      if (typeof window === "undefined") return "create";
      const raw = window.localStorage.getItem(FORGE_AGENTS_KEY);
      if (raw) { const p = JSON.parse(raw); if (Array.isArray(p) && p.length > 0) return "dashboard"; }
    } catch {}
    return "create";
  });
  const [editingAgent, setEditingAgent] = useState<any>(null);
  const [switchingNetwork, setSwitchingNetwork] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(
    typeof window !== "undefined" ? window.innerWidth : 1280
  );

  const handleConnect = (session: any) => {
    setWallet(session);
    setView(agents.length > 0 ? "dashboard" : "create");
  };

  /** Called by SignInModal after connect + SIWA sign completes. */
  const handleSignIn = (session: ForgeSession, walletInfo: any) => {
    setSiwaSession(session);
    setWallet(walletInfo);
    setShowSignIn(false);
    setView(agents.length > 0 ? "dashboard" : "create");
  };

  const handleDisconnect = () => {
    const confirmed = window.confirm(
      "Disconnect wallet?\n\nYour agent configurations will be preserved and restored on next connect."
    );
    if (!confirmed) return;
    clearSession();
    setSiwaSession(null);
    setWallet(null);
  };

  const handleDeploy = (a: any) => {
    setAgents((prev: any[]) => {
      // If updating existing agent, replace it; otherwise add new
      const filtered = prev.filter((item) => item?.agentId !== a?.agentId);
      const next = [...filtered, a];
      return next.slice(-24);
    });
    setActiveAgentId(String(a?.agentId || ""));
    setEditingAgent(null);
    setView("dashboard");
  };
  const activeAgent = useMemo(
    () => agents.find((item: any) => String(item?.agentId) === String(activeAgentId)) || agents[agents.length - 1] || null,
    [activeAgentId, agents]
  );
  const isMainnet = DEFAULT_NETWORK === "mainnet";
  const networkOptions = useMemo(
    () => KASPA_NETWORK_PROFILES.filter((profile) => profile.id === "mainnet" || profile.id.startsWith("testnet")),
    []
  );
  const isMobile = viewportWidth < 860;

  const switchNetwork = (targetNetwork: string) => {
    if (typeof window === "undefined" || switchingNetwork || targetNetwork === DEFAULT_NETWORK) return;
    const hasSessionState = !!wallet || agents.length > 0;
    if (hasSessionState) {
      const confirmed = window.confirm(
        "Switching networks will reset the current wallet session and agent state. Continue?"
      );
      if (!confirmed) return;
    }

    setSwitchingNetwork(true);
    try {
      window.localStorage.setItem("forgeos.network", targetNetwork);
      const next = new URL(window.location.href);
      next.searchParams.set("network", targetNetwork);
      window.location.assign(next.toString());
    } catch {
      setSwitchingNetwork(false);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(FORGE_AGENTS_KEY, JSON.stringify(agents));
      window.postMessage(
        {
          __forgeos__: true,
          type: "FORGEOS_AGENT_SNAPSHOT",
          agents,
          activeAgentId,
          network: DEFAULT_NETWORK,
          updatedAt: Date.now(),
        },
        "*",
      );
    } catch {}
  }, [agents, activeAgentId]);

  useEffect(() => {
    try { window.localStorage.setItem(FORGE_ACTIVE_KEY, activeAgentId); } catch {}
  }, [activeAgentId]);

  useEffect(() => {
    if (wallet || autoConnectAttempted || showSignIn || showForgeConnect) return;
    let cancelled = false;
    setAutoConnectAttempted(true);

    (async () => {
      const status = await WalletAdapter.probeForgeOSBridgeStatus(900).catch(() => null);
      if (cancelled || !status) return;
      if (status.transport !== "none") {
        setShowForgeConnect(true);
      }
    })();

    return () => { cancelled = true; };
  }, [wallet, autoConnectAttempted, showSignIn, showForgeConnect]);

  if (!wallet) return (
    <>
      <ForgeAtmosphere />
      <div className="forge-ui-scale">
        <WalletGate onConnect={handleConnect} onSignInClick={() => setShowSignIn(true)} />
        {showForgeConnect && (
          <ForgeOSConnectModal
            onSignIn={(session, walletInfo) => {
              setShowForgeConnect(false);
              handleSignIn(session, walletInfo);
            }}
            onOpenFullModal={() => {
              setShowForgeConnect(false);
              setShowSignIn(true);
            }}
            onClose={() => setShowForgeConnect(false)}
          />
        )}
        {showSignIn && (
          <SignInModal onSignIn={handleSignIn} onClose={() => setShowSignIn(false)} />
        )}
      </div>
    </>
  );

  return(
    <div className="forge-shell forge-ui-scale" style={{color:C.text}}>
      <ForgeAtmosphere />
      <div className="forge-content" style={{minHeight:"100vh"}}>
      {/* Topbar */}
      <div className="forge-topbar" style={{borderBottom:`1px solid ${C.border}`, padding:"10px clamp(12px, 2vw, 20px)", display:"flex", flexDirection:isMobile ? "column" : "row", alignItems:isMobile ? "stretch" : "center", justifyContent:"space-between", gap:isMobile ? 10 : 0}}>
        <div style={{display:"flex", alignItems:"center", gap:12, justifyContent:isMobile ? "space-between" : "flex-start"}}>
          <div style={{display:"flex", alignItems:"center", gap:6, flexShrink:0}}>
            <img src="/forge-os-icon3.png" alt="Forge-OS" style={{width:22, height:22, objectFit:"contain", filter:"drop-shadow(0 0 8px rgba(57,221,182,0.5))"}} />
            <div style={{fontSize:12, fontWeight:700, letterSpacing:"0.12em", ...mono}}>
              <span style={{color:C.accent}}>FORGE</span><span style={{color:C.text}}>-OS</span>
            </div>
          </div>
          {!isMobile && <div style={{width:1, height:14, background:"transparent", margin:"0 4px"}}/>}
        </div>
        <div style={{display:"flex", gap:6, alignItems:"center", flexWrap:"wrap", justifyContent:isMobile ? "flex-start" : "flex-end"}}>
          <div style={{display:"flex", alignItems:"center", gap:6, border:`1px solid ${isMainnet ? C.warn : C.ok}50`, background:isMainnet?C.wLow:C.oLow, borderRadius:6, padding:"4px 6px"}}>
            <span style={{fontSize:10, color:isMainnet?C.warn:C.ok, letterSpacing:"0.08em", ...mono}}>
              {NETWORK_LABEL.toUpperCase()}
            </span>
            <select
              data-testid="network-select"
              value={NETWORK_PROFILE.id}
              onChange={(event) => switchNetwork(event.target.value)}
              disabled={switchingNetwork}
              style={{
                background: "transparent",
                color: C.text,
                border: `1px solid ${C.border}`,
                borderRadius: 4,
                padding: "4px 8px",
                fontSize: 10,
                letterSpacing: "0.05em",
                ...mono,
              }}
              title="Switch runtime Kaspa network profile"
            >
              {networkOptions.map((profile) => (
                <option key={profile.id} value={profile.id} style={{ background: C.s1, color: C.text }}>
                  {profile.label}
                </option>
              ))}
            </select>
          </div>
          <button onClick={()=>setView("create")} style={{background:view==="create"?C.s2:"none", border:`1px solid ${view==="create"?C.border:"transparent"}`, color:view==="create"?C.text:C.dim, padding:"5px 14px", borderRadius:4, fontSize:11, cursor:"pointer", ...mono}}>NEW AGENT</button>
          {agents.map((row: any) => {
            const isActive = String(activeAgent?.agentId || "") === String(row?.agentId || "");
            return (
              <button
                key={String(row?.agentId || row?.name || Math.random())}
                onClick={() => { setActiveAgentId(String(row?.agentId || "")); setView("dashboard"); }}
                style={{
                  background:isActive && view==="dashboard"?C.s2:"none",
                  border:`1px solid ${isActive && view==="dashboard"?C.accent:"transparent"}`,
                  color:isActive?C.accent:C.dim,
                  padding:"5px 10px",
                  borderRadius:4,
                  fontSize:11,
                  cursor:"pointer",
                  maxWidth:140,
                  overflow:"hidden",
                  textOverflow:"ellipsis",
                  whiteSpace:"nowrap",
                  ...mono
                }}
                title={String(row?.name || "Agent")}
              >
                {String(row?.name || "AGENT")}
              </button>
            );
          })}
          <div style={{display:"flex", alignItems:"center", gap:6, padding:"5px 12px", border:`1px solid ${C.border}`, borderRadius:4}}>
            <div style={{width:6, height:6, borderRadius:"50%", background:wallet?.provider==="demo"?C.warn:C.ok}}/>
            <span style={{fontSize:10, color:C.dim, letterSpacing:"0.08em", ...mono}}>{shortAddr(wallet?.address)}</span>
          </div>
          <Btn onClick={handleDisconnect} variant="ghost" size="sm">DISCONNECT</Btn>
        </div>
      </div>
      {view === "create" ? (
        <Wizard wallet={wallet} onComplete={handleDeploy} editAgent={editingAgent} onCancel={() => { setEditingAgent(null); setView("dashboard"); }}/>
      ) : !activeAgent && agents.length === 0 ? (
        // No agents yet - show dashboard with empty state (user can create via "NEW AGENT")
        <Dashboard
          agent={{
            name: "",
            agentId: "",
            capitalLimit: "0",
            risk: "",
            strategyLabel: "",
            strategyTemplate: "",
            strategyClass: "",
            horizon: 0,
            kpiTarget: "",
            autoApproveThreshold: "",
            execMode: "manual"
          }}
          agents={[]}
          activeAgentId=""
          onSelectAgent={() => {}}
          onDeleteAgent={() => {}}
          onEditAgent={() => {}}
          wallet={wallet}
        />
      ) : (
        <Dashboard
          agent={activeAgent}
          agents={agents}
          activeAgentId={activeAgentId}
          onSelectAgent={(id: string) => { setActiveAgentId(id); setView("dashboard"); }}
          onDeleteAgent={(id: string) => {
            setAgents((prev: any[]) => prev.filter((a) => String(a?.agentId) !== String(id)));
            if (String(activeAgentId) === String(id)) {
              setActiveAgentId("");
              setView("create");
            }
          }}
          onEditAgent={(agent: any) => {
            setEditingAgent(agent);
            setActiveAgentId(String(agent?.agentId || ""));
            setView("create");
          }}
          wallet={wallet}
        />
      )}
      </div>
    </div>
  );
}
