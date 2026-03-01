/// <reference path="../../chrome.d.ts" />
import { C, mono } from "../../../src/tokens";
import { shortAddr } from "../../../src/helpers";
import {
  EXTENSION_CONNECT_APPROVAL_BASE_MIN_HEIGHT,
  EXTENSION_CONNECT_APPROVAL_BASE_WIDTH,
  EXTENSION_POPUP_UI_SCALE,
} from "../layout";
import { popupShellBackground } from "../surfaces";

interface Props {
  address: string;
  network: string;
  origin?: string;
  message: string;
  loading?: boolean;
  error?: string | null;
  onApprove: () => void;
  onReject: () => void;
}

export function SignApprovalScreen({
  address,
  network,
  origin,
  message,
  loading = false,
  error,
  onApprove,
  onReject,
}: Props) {
  const displayOrigin = origin ?? "forge-os.xyz";

  return (
    <div
      data-testid="sign-approval-screen"
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
      <div style={{ padding: "12px 14px 10px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 8 }}>
        <img src="../icons/icon48.png" alt="Forge-OS" style={{ width: 22, height: 22, objectFit: "contain", filter: "drop-shadow(0 0 6px rgba(57,221,182,0.5))" }} />
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.1em" }}>
          <span style={{ color: C.accent }}>FORGE</span><span style={{ color: C.text }}>-OS</span>
        </span>
      </div>

      <div style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        padding: "18px 16px",
        gap: 12,
        overflowY: "auto",
      }}>
        <div style={{ textAlign: "center" }}>
          <div style={{
            width: 52, height: 52, borderRadius: "50%",
            background: `${C.warn}18`, border: `2px solid ${C.warn}40`,
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 12px",
          }}>
            <span style={{ fontSize: 22 }}>✍</span>
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 3 }}>
            Signature Request
          </div>
          <div style={{ fontSize: 10, color: C.dim, letterSpacing: "0.06em" }}>
            {displayOrigin}
          </div>
        </div>

        <div style={{
          background: "rgba(11,17,24,0.9)",
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          padding: "10px 12px",
          minWidth: 0,
        }}>
          <div style={{ fontSize: 8, color: C.dim, letterSpacing: "0.12em", marginBottom: 6 }}>
            MESSAGE TO SIGN
          </div>
          <div style={{
            maxHeight: 180,
            overflowY: "auto",
            background: "rgba(5,7,10,0.7)",
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: "10px",
            fontSize: 9,
            color: C.text,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflowWrap: "anywhere",
          }}>
            {message}
          </div>
        </div>

        <div style={{
          background: `${C.accent}08`,
          border: `1px solid ${C.accent}20`,
          borderRadius: 8,
          padding: "10px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          minWidth: 0,
        }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.ok, flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 9, color: C.dim, marginBottom: 2 }}>SIGNING WITH</div>
            <div style={{ fontSize: 11, color: C.text, fontWeight: 600 }}>{shortAddr(address)}</div>
            <div style={{ fontSize: 8, color: C.dim }}>{network}</div>
          </div>
        </div>

        {error && (
          <div style={{ fontSize: 9, color: C.danger, lineHeight: 1.5, textAlign: "center" }}>
            {error}
          </div>
        )}
      </div>

      <div style={{ padding: "12px 16px", borderTop: `1px solid ${C.border}`, display: "flex", gap: 10 }}>
        <button
          data-testid="sign-approval-reject"
          onClick={onReject}
          disabled={loading}
          style={{
            flex: 1,
            background: "rgba(33,48,67,0.5)",
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: "10px 0",
            color: C.dim,
            fontSize: 10,
            fontWeight: 700,
            cursor: loading ? "not-allowed" : "pointer",
            letterSpacing: "0.08em",
            ...mono,
          }}
        >
          REJECT
        </button>
        <button
          data-testid="sign-approval-approve"
          onClick={onApprove}
          disabled={loading}
          style={{
            flex: 2,
            background: loading ? `${C.accent}35` : `linear-gradient(90deg, ${C.accent}, #7BE9CF)`,
            border: "none",
            borderRadius: 8,
            padding: "10px 0",
            color: loading ? C.dim : "#04110E",
            fontSize: 11,
            fontWeight: 700,
            cursor: loading ? "not-allowed" : "pointer",
            letterSpacing: "0.08em",
            ...mono,
          }}
        >
          {loading ? "SIGNING…" : "SIGN MESSAGE →"}
        </button>
      </div>
    </div>
  );
}
