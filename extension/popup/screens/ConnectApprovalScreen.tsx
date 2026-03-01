/// <reference path="../../chrome.d.ts" />
import { useState } from "react";
import { C, mono } from "../../../src/tokens";
import { shortAddr } from "../../../src/helpers";
import {
  EXTENSION_CONNECT_APPROVAL_BASE_MIN_HEIGHT,
  EXTENSION_CONNECT_APPROVAL_BASE_WIDTH,
  EXTENSION_POPUP_UI_SCALE,
} from "../layout";
import { popupShellBackground } from "../surfaces";
import { addConnectedSite } from "../../shared/storage";

interface Props {
  address: string;
  network: string;
  origin?: string;
  onApprove: () => void;
  onReject: () => void;
}

export function ConnectApprovalScreen({ address, network, origin, onApprove, onReject }: Props) {
  const displayOrigin = origin ?? "forge-os.xyz";
  const [rememberSite, setRememberSite] = useState(false);

  function handleApprove() {
    if (rememberSite && origin) {
      addConnectedSite(origin, { address, network, connectedAt: Date.now() }).catch(() => {});
    }
    onApprove();
  }

  return (
    <div
      data-testid="connect-approval-screen"
      style={{
      width: "100%",
      maxWidth: EXTENSION_CONNECT_APPROVAL_BASE_WIDTH,
      height: "100%",
      minHeight: EXTENSION_CONNECT_APPROVAL_BASE_MIN_HEIGHT,
      ...popupShellBackground(),
      display: "flex",
      flexDirection: "column",
      ...mono,
      overflow: "hidden",
      zoom: EXTENSION_POPUP_UI_SCALE,
      }}
    >
      {/* Header */}
      <div style={{ padding: "12px 14px 10px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 8 }}>
        <img src="../icons/icon48.png" alt="Forge-OS" style={{ width: 22, height: 22, objectFit: "contain", filter: "drop-shadow(0 0 6px rgba(57,221,182,0.5))" }} />
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.1em" }}>
          <span style={{ color: C.accent }}>FORGE</span><span style={{ color: C.text }}>-OS</span>
        </span>
      </div>

      {/* Body */}
      <div style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        padding: "14px 16px 12px",
        gap: 12,
        overflowY: "auto",
      }}>
        {/* Connection request info */}
        <div style={{ textAlign: "center" }}>
          <div style={{
            width: 52, height: 52, borderRadius: "50%",
            background: `${C.accent}18`, border: `2px solid ${C.accent}40`,
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 10px",
          }}>
            <img src="../icons/icon48.png" alt="" style={{ width: 30, height: 30, objectFit: "contain" }} />
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 4 }}>
            Connect to Site
          </div>
          <div style={{ fontSize: 10, color: C.dim, letterSpacing: "0.06em", wordBreak: "break-word", overflowWrap: "anywhere" }}>
            {displayOrigin}
          </div>
        </div>

        {/* What this grants */}
        <div style={{
          background: "rgba(11,17,24,0.8)",
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          padding: "12px 14px",
        }}>
          <div style={{ fontSize: 8, color: C.dim, letterSpacing: "0.12em", marginBottom: 10 }}>
            THIS SITE WILL BE ABLE TO
          </div>
          {[
            { icon: "◆", label: "View your wallet address" },
            { icon: "◆", label: "Request message signatures" },
          ].map((item) => (
            <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 10, color: C.text }}>
              <span style={{ color: C.ok, fontSize: 9, flexShrink: 0 }}>{item.icon}</span>
              {item.label}
            </div>
          ))}
          <div style={{ height: 1, background: C.border, margin: "10px 0" }} />
          <div style={{ fontSize: 8, color: C.dim, letterSpacing: "0.12em", marginBottom: 6 }}>
            THIS SITE WILL NOT BE ABLE TO
          </div>
          {[
            { icon: "✕", label: "Access your private keys or seed phrase" },
            { icon: "✕", label: "Send transactions without your approval" },
          ].map((item) => (
            <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 10, color: C.muted }}>
              <span style={{ color: C.danger, fontSize: 9, flexShrink: 0 }}>{item.icon}</span>
              {item.label}
            </div>
          ))}
        </div>

        {/* Wallet being connected */}
        <div style={{
          background: `${C.accent}08`,
          border: `1px solid ${C.accent}20`,
          borderRadius: 8,
          padding: "10px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.ok, flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 9, color: C.dim, marginBottom: 2 }}>CONNECTING WITH</div>
            <div style={{ fontSize: 11, color: C.text, fontWeight: 600 }}>{shortAddr(address)}</div>
            <div style={{ fontSize: 8, color: C.dim }}>{network}</div>
          </div>
        </div>

        {/* Remember site toggle */}
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 10, color: C.dim }}>
          <input
            data-testid="connect-approval-remember-site"
            type="checkbox"
            checked={rememberSite}
            onChange={(e) => setRememberSite(e.target.checked)}
            style={{ accentColor: C.accent, width: 13, height: 13, cursor: "pointer" }}
          />
          Remember this site (skip approval next time)
        </label>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
          <button
            data-testid="connect-approval-reject"
            onClick={onReject}
            style={{
              flex: 1,
              background: "rgba(33,48,67,0.5)",
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              padding: "10px 0",
              color: C.dim,
              fontSize: 10,
              fontWeight: 700,
              cursor: "pointer",
              letterSpacing: "0.08em",
              ...mono,
            }}
          >
            REJECT
          </button>
          <button
            data-testid="connect-approval-approve"
            onClick={handleApprove}
            style={{
              flex: 2,
              background: `linear-gradient(90deg, ${C.accent}, #7BE9CF)`,
              border: "none",
              borderRadius: 8,
              padding: "10px 0",
              color: "#04110E",
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
              letterSpacing: "0.08em",
              ...mono,
            }}
          >
            CONNECT →
          </button>
        </div>
      </div>
    </div>
  );
}
