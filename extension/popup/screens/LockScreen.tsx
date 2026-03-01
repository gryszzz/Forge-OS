import { useState, useRef, useEffect } from "react";
import { C, mono } from "../../../src/tokens";
import { shortAddr } from "../../../src/helpers";
import { unlockVault } from "../../vault/vault";
import type { UnlockedSession } from "../../vault/types";
import { EXTENSION_POPUP_BASE_MIN_HEIGHT, EXTENSION_POPUP_BASE_WIDTH, EXTENSION_POPUP_UI_SCALE } from "../layout";
import { popupShellBackground } from "../surfaces";

interface Props {
  autoLockMinutes: number;
  persistSession: boolean;
  onUnlock: (session: UnlockedSession) => void;
  onReset: () => void;
  /** When provided, shows "Welcome back" with the wallet address. */
  walletAddress?: string | null;
}

export function LockScreen({
  autoLockMinutes,
  persistSession,
  onUnlock,
  onReset,
  walletAddress,
}: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || loading) return;

    setLoading(true);
    setError(null);

    try {
      const session = await unlockVault(password, autoLockMinutes, { persistSession });
      onUnlock(session);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg === "INVALID_PASSWORD" ? "Incorrect password." : "Failed to unlock. Try again.");
      setPassword("");
      inputRef.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      data-testid="lock-screen"
      style={{
      width: EXTENSION_POPUP_BASE_WIDTH, minHeight: EXTENSION_POPUP_BASE_MIN_HEIGHT, ...popupShellBackground(), display: "flex",
      flexDirection: "column", alignItems: "center", justifyContent: "flex-start",
      padding: "28px 30px 24px", ...mono, position: "relative", overflow: "hidden",
      overflowX: "hidden", overflowY: "auto",
      zoom: EXTENSION_POPUP_UI_SCALE,
      }}
    >
      {/* Atmospheric blobs */}
      <div style={{ position: "absolute", top: "-12%", left: "50%", transform: "translateX(-50%)", width: 360, height: 360, borderRadius: "50%", background: `radial-gradient(ellipse, ${C.accent}18 0%, transparent 70%)`, pointerEvents: "none" }} />
      <div style={{ position: "absolute", bottom: "-10%", right: "-32%", width: 260, height: 260, borderRadius: "50%", background: `radial-gradient(ellipse, ${C.accent}0A 0%, transparent 72%)`, pointerEvents: "none" }} />
      {/* Content — sits above blobs */}
      <div style={{ position: "relative", zIndex: 1, width: "100%", display: "flex", flexDirection: "column", alignItems: "center", marginTop: 4 }}>

      {/* Logo */}
      <div style={{ marginBottom: walletAddress ? 14 : 22, textAlign: "center" }}>
        <img
          src="../icons/icon128.png"
          alt="Forge-OS"
          style={{
            width: 58,
            height: 58,
            objectFit: "contain",
            imageRendering: "auto",
            filter: "drop-shadow(0 0 8px rgba(57,221,182,0.52))",
            marginBottom: 12,
          }}
        />
        <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "0.12em" }}>
          <span style={{ color: C.accent }}>FORGE</span>
          <span style={{ color: C.text }}>-OS</span>
        </div>
        <div style={{ fontSize: 10, color: C.dim, marginTop: 5, letterSpacing: "0.12em" }}>
          {walletAddress ? "WELCOME BACK" : "WALLET LOCKED"}
        </div>
      </div>

      {/* Wallet address chip — shown when returning to a known account */}
      {walletAddress && (
        <div style={{
          display: "flex", alignItems: "center", gap: 6, marginBottom: 16,
          background: `${C.accent}0A`, border: `1px solid ${C.accent}25`,
          borderRadius: 20, padding: "6px 14px",
        }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: C.ok, flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: C.text, fontWeight: 600 }}>{shortAddr(walletAddress)}</span>
        </div>
      )}

      {/* Lock icon */}
      <div style={{
        width: 48, height: 48, borderRadius: "50%",
        background: `${C.accent}15`, border: `1px solid ${C.accent}30`,
        display: "flex", alignItems: "center", justifyContent: "center",
        marginBottom: 18,
      }}>
        <span style={{ fontSize: 22 }}>🔒</span>
      </div>

      {/* Unlock form */}
      <form onSubmit={handleUnlock} style={{ width: "100%" }}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 8, color: C.dim, letterSpacing: "0.1em", marginBottom: 6 }}>
            {walletAddress ? "ENTER PASSWORD TO SIGN IN" : "PASSWORD"}
          </div>
          <input
            data-testid="lock-screen-password-input"
            ref={inputRef}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            disabled={loading}
            style={{
              width: "100%", boxSizing: "border-box",
              background: "rgba(8,13,20,0.7)", border: `1px solid ${error ? C.danger : C.border}`,
              borderRadius: 8, padding: "10px 12px",
              color: C.text, fontSize: 11, ...mono,
              outline: "none",
            }}
          />
        </div>

        {error && (
          <div style={{ fontSize: 8, color: C.danger, marginBottom: 10, textAlign: "center" }}>
            {error}
          </div>
        )}

        <button
          data-testid="lock-screen-unlock-button"
          type="submit"
          disabled={!password || loading}
          style={{
            width: "100%", padding: "10px 0",
            background: password && !loading
              ? `linear-gradient(90deg, ${C.accent}, #7BE9CF)`
              : `${C.accent}30`,
            border: "none", borderRadius: 8,
            color: password && !loading ? "#04110E" : C.dim,
            fontSize: 10, fontWeight: 700, cursor: password && !loading ? "pointer" : "not-allowed",
            letterSpacing: "0.1em", ...mono,
            transition: "background 0.15s, color 0.15s",
          }}
        >
          {loading ? "UNLOCKING…" : "UNLOCK WALLET"}
        </button>
      </form>

      {/* Forgot password / reset */}
      <div style={{ marginTop: 20, textAlign: "center" }}>
        {!showReset ? (
          <button
            data-testid="lock-screen-forgot-password"
            onClick={() => setShowReset(true)}
            style={{ background: "none", border: "none", color: C.dim, fontSize: 8, cursor: "pointer", ...mono }}
          >
            Forgot password?
          </button>
        ) : (
          <div style={{
            background: C.dLow, border: `1px solid ${C.danger}40`,
            borderRadius: 8, padding: "12px 14px", marginTop: 4,
          }}>
            <div style={{ fontSize: 9, color: C.warn, fontWeight: 700, marginBottom: 6, letterSpacing: "0.08em" }}>
              ⚠ RESET WALLET
            </div>
            <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.5, marginBottom: 10 }}>
              This will permanently delete your encrypted vault. Make sure you have your seed phrase backed up before proceeding.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                data-testid="lock-screen-reset-cancel"
                onClick={() => setShowReset(false)}
                style={{
                  flex: 1, padding: "7px 0", background: "rgba(33,48,67,0.5)",
                  border: `1px solid ${C.border}`, borderRadius: 6,
                  color: C.dim, fontSize: 8, cursor: "pointer", ...mono,
                }}
              >CANCEL</button>
              <button
                data-testid="lock-screen-reset-confirm"
                onClick={onReset}
                style={{
                  flex: 1, padding: "7px 0", background: C.dLow,
                  border: `1px solid ${C.danger}60`, borderRadius: 6,
                  color: C.danger, fontSize: 8, fontWeight: 700, cursor: "pointer", ...mono,
                }}
              >RESET WALLET</button>
            </div>
          </div>
        )}
      </div>

      </div>{/* end content wrapper */}
    </div>
  );
}
