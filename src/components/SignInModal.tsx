// Sign In modal — wallet-based authentication (Sign-In With Kaspa Address).
// Flow: select wallet → connect → sign SIWA message → create session → done.
// Wallets that don't support signMessage (Kaspium, hardware) skip the signing
// step and use connection as proof-of-ownership (skipSigning: true).
//
// Error handling:
//   - User cancels connect   → back to wallet list with error
//   - User rejects signature → offer "Connect without signing" fallback
//   - Wrong network          → error with expected network shown
//   - Provider not found     → install prompt with link

import { useState } from "react";
import { C, mono } from "../tokens";
import { isKaspaAddress } from "../helpers";
import { ALLOWED_ADDRESS_PREFIXES, DEFAULT_NETWORK } from "../constants";
import { WalletAdapter } from "../wallet/WalletAdapter";
import { WalletCreator } from "./WalletCreator";
import { Card } from "./ui";
import {
  generateNonce,
  buildSignInMessage,
  createSession,
  saveSession,
  type ForgeSession,
} from "../auth/siwa";

// ── Types ─────────────────────────────────────────────────────────────────────

type ModalStep =
  | "wallet_list"   // initial: show wallet options
  | "address_input" // Kaspium / hardware: ask for address
  | "connecting"    // waiting for wallet to respond
  | "signing"       // wallet connected, requesting SIWA signature
  | "creating";     // user chose "Create New Wallet"

interface WalletOption {
  id: string;
  label: string;
  icon: string;
  desc: string;
  detected?: boolean;
  supportsSign: boolean;
  needsAddressInput?: boolean;
  installUrl?: string;
}

interface Props {
  /** Called after successful sign-in with the session + a wallet info object. */
  onSignIn: (
    session: ForgeSession,
    wallet: { address: string; network: string; provider: string },
  ) => void;
  onClose: () => void;
}

// ── Wallet logo images ────────────────────────────────────────────────────────

const logoStyle: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 6,
  display: "block", objectFit: "cover" as const,
};

function ForgeOSLogo() {
  return <img src="/forge-os-icon3.png" style={logoStyle} alt="" />;
}
function KaswareLogo() {
  return <img src="/wallets/kasware.png" style={logoStyle} alt="" />;
}
function KastleLogo() {
  return <img src="/wallets/kastle.svg" style={{ ...logoStyle, objectFit: "contain" as const }} alt="" />;
}
function KaspiumLogo() {
  return <img src="/wallets/kaspium.png" style={logoStyle} alt="" />;
}
function TangemLogo() {
  return <img src="/wallets/tangem.webp" style={logoStyle} alt="" />;
}
function OneKeyLogo() {
  return <img src="/wallets/onekey.png" style={logoStyle} alt="" />;
}

const WALLET_LOGOS: Record<string, () => JSX.Element> = {
  forgeos:  ForgeOSLogo,
  kasware:  KaswareLogo,
  kastle:   KastleLogo,
  kaspium:  KaspiumLogo,
  tangem:   TangemLogo,
  onekey:   OneKeyLogo,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildOptions(detected: ReturnType<typeof WalletAdapter.detect>): WalletOption[] {
  return [
    {
      id: "forgeos",
      label: "Forge-OS",
      icon: "⚡",
      desc: "Your Forge-OS wallet — connect approval proves ownership",
      detected: true,  // Always show — works with managed wallet in localStorage
      supportsSign: false, // Connect approval (extension popup) is sufficient proof; no second sign popup
    },
    {
      id: "kasware",
      label: "Kasware",
      icon: "⬡",
      desc: "Browser extension — direct signing",
      detected: detected.kasware,
      supportsSign: Boolean(detected.kaswareMethods?.signMessage),
      installUrl: "https://kasware.xyz",
    },
    {
      id: "kastle",
      label: "Kastle",
      icon: "◆",
      desc: "Browser extension — direct signing",
      detected: detected.kastle,
      supportsSign: Boolean(detected.kastleMethods?.signMessage),
      installUrl: "https://kastle.xyz",
    },
    {
      id: "kaspium",
      label: "Kaspium",
      icon: "📱",
      desc: "Mobile wallet — paste your address",
      detected: true,
      supportsSign: false,
      needsAddressInput: true,
    },
    {
      id: "tangem",
      label: "Tangem",
      icon: "💳",
      desc: "Hardware card — paste your address",
      detected: true,
      supportsSign: false,
      needsAddressInput: true,
    },
    {
      id: "onekey",
      label: "OneKey",
      icon: "🔑",
      desc: "Hardware wallet — paste your address",
      detected: true,
      supportsSign: false,
      needsAddressInput: true,
    },
  ];
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SignInModal({ onSignIn, onClose }: Props) {
  const detected = WalletAdapter.detect();
  const options = buildOptions(detected);

  const [step, setStep] = useState<ModalStep>("wallet_list");
  const [selected, setSelected] = useState<WalletOption | null>(null);
  const [manualAddress, setManualAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sigRejected, setSigRejected] = useState(false);
  const [connectingWallet, setConnectingWallet] = useState<{
    address: string;
    provider: string;
    nonce: string;
  } | null>(null);

  // ── Connect step ────────────────────────────────────────────────────────────

  const startConnect = async (option: WalletOption) => {
    setSelected(option);
    setError(null);
    setSigRejected(false);

    if (option.needsAddressInput) {
      setStep("address_input");
      return;
    }

    setStep("connecting");
    try {
      let address = "";
      if (option.id === "forgeos") {
        const session = await WalletAdapter.connectForgeOS();
        address = session?.address ?? "";
      } else if (option.id === "kasware") {
        const session = await WalletAdapter.connectKasware();
        address = session?.address ?? "";
      } else if (option.id === "kastle") {
        const session = await WalletAdapter.connectKastle();
        address = session?.address ?? "";
      }

      if (!address) throw new Error("No address returned from wallet.");
      const nonce = generateNonce();
      setConnectingWallet({ address, provider: option.id, nonce });

      if (option.supportsSign) {
        setStep("signing");
        await doSign(address, option.id, nonce, false);
      } else {
        finalize(address, option.id, nonce, true);
      }
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (msg.toLowerCase().includes("cancel") || msg.toLowerCase().includes("denied") || msg.toLowerCase().includes("reject")) {
        setError("Wallet connection cancelled.");
      } else if (msg.toLowerCase().includes("network")) {
        setError(`Wrong network. Please switch your wallet to ${DEFAULT_NETWORK}.`);
      } else {
        setError(`Connection failed: ${msg}`);
      }
      setStep("wallet_list");
    }
  };

  const startConnectManualAddress = async () => {
    if (!selected) return;
    const addr = manualAddress.trim();
    if (!isKaspaAddress(addr, ALLOWED_ADDRESS_PREFIXES)) {
      setError("Please enter a valid Kaspa address.");
      return;
    }
    setStep("connecting");
    setError(null);
    try {
      let session: any;
      if (selected.id === "kaspium") {
        session = WalletAdapter.connectKaspium(addr);
      } else {
        session = await WalletAdapter.connectHardwareBridge(
          selected.id as "tangem" | "onekey",
          addr,
        );
      }
      const address = session?.address ?? addr;
      const nonce = generateNonce();
      finalize(address, selected.id, nonce, true /* skipSigning */);
    } catch (err) {
      setError(`Connection failed: ${String((err as Error)?.message ?? err)}`);
      setStep("address_input");
    }
  };

  // ── Sign step ───────────────────────────────────────────────────────────────

  const doSign = async (
    address: string,
    provider: string,
    nonce: string,
    skip: boolean,
  ) => {
    if (skip) {
      finalize(address, provider, nonce, true);
      return;
    }
    try {
      const message = buildSignInMessage(address, DEFAULT_NETWORK, nonce);
      if (provider === "kasware") {
        await WalletAdapter.signMessageKasware(message);
      } else if (provider === "kastle") {
        await WalletAdapter.signMessageKastle(message);
      } else if (provider === "forgeos") {
        await WalletAdapter.signMessageForgeOS(message);
      }
      finalize(address, provider, nonce, false);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (msg.toLowerCase().includes("cancel") || msg.toLowerCase().includes("reject") || msg.toLowerCase().includes("denied")) {
        // User rejected signature — show fallback option
        setSigRejected(true);
        setStep("signing"); // stay on signing step with fallback UI
      } else {
        setError(`Signature failed: ${msg}`);
        setStep("wallet_list");
      }
    }
  };

  const finalize = (
    address: string,
    provider: string,
    nonce: string,
    skipSigning: boolean,
  ) => {
    const session = createSession(address, DEFAULT_NETWORK, provider, nonce, skipSigning);
    saveSession(session);
    onSignIn(session, { address, network: DEFAULT_NETWORK, provider });
  };

  // ── WalletCreator callback ──────────────────────────────────────────────────

  const handleCreatorConnect = (walletInfo: any) => {
    const nonce = generateNonce();
    finalize(walletInfo.address, walletInfo.provider ?? "managed", nonce, true);
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  // Overlay backdrop
  const backdrop: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.82)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 500,
    padding: "clamp(8px, 2vw, 20px)",
  };

  // ── WalletCreator sub-flow (no extra backdrop — WalletCreator has its own) ──
  if (step === "creating") {
    return (
      <WalletCreator
        onConnect={handleCreatorConnect}
        onClose={onClose}
      />
    );
  }

  return (
    <div data-testid="signin-modal" style={backdrop} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <Card
        data-testid="signin-modal-card"
        p={0}
        style={{
          maxWidth: "min(520px, calc(100vw - 16px))",
          width: "100%",
          position: "relative",
          maxHeight: "calc(100dvh - 16px)",
          overflowX: "hidden",
          overflowY: "auto",
          boxSizing: "border-box",
        }}
      >
        {/* Header bar */}
        <div
          style={{
            padding: "18px 20px 14px",
            borderBottom: `1px solid ${C.border}`,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: C.text,
                ...mono,
                marginBottom: 3,
              }}
            >
              {step === "address_input"
                ? `Connect ${selected?.label ?? "Wallet"}`
                : step === "connecting" || step === "signing"
                  ? "Connecting…"
                  : "Sign In to Forge.OS"}
            </div>
            <div style={{ fontSize: 9, color: C.dim }}>
              {step === "wallet_list"
                ? "Connect your Kaspa wallet to authenticate. No email, no password."
                : step === "address_input"
                  ? "Paste your wallet address to connect."
                  : step === "signing"
                    ? "Confirm the sign-in message in your wallet."
                    : ""}
            </div>
          </div>
          <button
            data-testid="signin-modal-close"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: C.dim,
              fontSize: 18,
              cursor: "pointer",
              lineHeight: 1,
              padding: "0 0 0 12px",
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "clamp(12px, 2vw, 16px) clamp(14px, 3vw, 20px) clamp(14px, 2vw, 20px)", boxSizing: "border-box" }}>
          {/* ── WALLET LIST ─────────────────────────────────────────────────── */}
          {step === "wallet_list" && (
            <div data-testid="signin-wallet-list" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {/* Forge-OS — primary option */}
              <WalletRow
                key="forgeos"
                option={options[0]}
                onSelect={() => startConnect(options[0])}
                primary
              />

              {/* Other extension wallets */}
              <div style={{ fontSize: 7, color: C.dim, ...mono, letterSpacing: "0.1em", marginTop: 4, marginBottom: 2 }}>
                OTHER BROWSER WALLETS
              </div>
              {options.slice(1, 3).map((opt) => (
                <WalletRow
                  key={opt.id}
                  option={opt}
                  onSelect={() => startConnect(opt)}
                />
              ))}

              {/* Mobile & hardware */}
              <div style={{ fontSize: 7, color: C.dim, ...mono, letterSpacing: "0.1em", marginTop: 4, marginBottom: 2 }}>
                HARDWARE & MOBILE
              </div>
              {options.slice(3).map((opt) => (
                <WalletRow
                  key={opt.id}
                  option={opt}
                  onSelect={() => startConnect(opt)}
                />
              ))}

              {/* Divider */}
              <div
                style={{
                  height: 1,
                  background: C.border,
                  margin: "6px 0",
                }}
              />

              {/* Create new wallet */}
              <button
                data-testid="signin-create-wallet"
                onClick={() => setStep("creating")}
                style={{
                  background: `linear-gradient(145deg, ${C.accent}12 0%, rgba(8,13,20,0.5) 100%)`,
                  border: `1px solid ${C.accent}30`,
                  borderRadius: 10,
                  padding: "12px 14px",
                  cursor: "pointer",
                  textAlign: "left",
                  color: C.text,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  transition: "border-color 0.15s",
                }}
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLButtonElement).style.borderColor = `${C.accent}60`)
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLButtonElement).style.borderColor = `${C.accent}30`)
                }
              >
                <span style={{ fontSize: 20, flexShrink: 0 }}>✦</span>
                <div>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: C.accent,
                      ...mono,
                      marginBottom: 2,
                    }}
                  >
                    CREATE NEW WALLET
                  </div>
                  <div style={{ fontSize: 9, color: C.dim }}>
                    Generate a new 12 or 24-word Kaspa wallet — compatible with all Kaspa wallets.
                  </div>
                </div>
              </button>

              {/* Error */}
              {error && <ErrorBanner message={error} />}

              {/* Security footnote */}
              <div style={{ fontSize: 8, color: C.muted, lineHeight: 1.5, marginTop: 4 }}>
                Your wallet signs a one-time message to prove ownership of your address.
                No keys are shared. No transactions are made.
              </div>
            </div>
          )}

          {/* ── ADDRESS INPUT (Kaspium / hardware) ──────────────────────────── */}
          {step === "address_input" && selected && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div
                style={{
                  fontSize: 9,
                  color: C.dim,
                  lineHeight: 1.6,
                }}
              >
                {selected.id === "kaspium"
                  ? "Open Kaspium on your phone, copy your Kaspa address, then paste it below."
                  : `Open your ${selected.label} app, find your Kaspa address, and paste it below.`}
              </div>

              <textarea
                data-testid="signin-manual-address-input"
                value={manualAddress}
                onChange={(e) => {
                  setManualAddress(e.target.value);
                  setError(null);
                }}
                placeholder="kaspa:qqe..."
                rows={3}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  background: "rgba(8,13,20,0.7)",
                  border: `1px solid ${error ? C.danger : C.border}`,
                  borderRadius: 8,
                  padding: "10px 12px",
                  color: C.text,
                  fontSize: 10,
                  ...mono,
                  resize: "none",
                  lineHeight: 1.5,
                  outline: "none",
                }}
              />

              {error && <ErrorBanner message={error} />}

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  data-testid="signin-manual-address-back"
                  onClick={() => { setStep("wallet_list"); setError(null); }}
                  style={ghostBtnStyle}
                >
                  ← BACK
                </button>
                <button
                  data-testid="signin-manual-address-connect"
                  onClick={startConnectManualAddress}
                  disabled={!isKaspaAddress(manualAddress.trim(), ALLOWED_ADDRESS_PREFIXES)}
                  style={primaryBtnStyle(
                    isKaspaAddress(manualAddress.trim(), ALLOWED_ADDRESS_PREFIXES),
                  )}
                >
                  CONNECT →
                </button>
              </div>
            </div>
          )}

          {/* ── CONNECTING spinner ───────────────────────────────────────────── */}
          {step === "connecting" && (
            <div style={{ textAlign: "center", padding: "28px 0" }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  border: `2px solid ${C.border}`,
                  borderTopColor: C.accent,
                  animation: "spin 0.8s linear infinite",
                  margin: "0 auto 14px",
                }}
              />
              <div style={{ fontSize: 10, color: C.dim, ...mono }}>Connecting to wallet…</div>
              <div style={{ fontSize: 8, color: C.muted, marginTop: 6 }}>
                Check your wallet extension for a connection prompt.
              </div>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {/* ── SIGNING step ─────────────────────────────────────────────────── */}
          {step === "signing" && connectingWallet && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {!sigRejected ? (
                <>
                  <div style={{ textAlign: "center", padding: "14px 0" }}>
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: "50%",
                        border: `2px solid ${C.border}`,
                        borderTopColor: C.accent,
                        animation: "spin 0.8s linear infinite",
                        margin: "0 auto 14px",
                      }}
                    />
                    <div style={{ fontSize: 10, color: C.dim, ...mono }}>
                      Waiting for signature…
                    </div>
                    <div style={{ fontSize: 8, color: C.muted, marginTop: 6 }}>
                      Approve the sign-in message in your wallet. No transaction will be sent.
                    </div>
                    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                  </div>

                  {/* Show message preview */}
                  <div
                    style={{
                      background: "rgba(8,13,20,0.7)",
                      border: `1px solid ${C.border}`,
                      borderRadius: 8,
                      padding: "10px 12px",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 7,
                        color: C.dim,
                        ...mono,
                        letterSpacing: "0.1em",
                        marginBottom: 6,
                      }}
                    >
                      MESSAGE BEING SIGNED
                    </div>
                    <pre
                      style={{
                        fontSize: 8,
                        color: C.text,
                        ...mono,
                        margin: 0,
                        whiteSpace: "pre-wrap",
                        lineHeight: 1.6,
                        wordBreak: "break-all",
                      }}
                    >
                      {buildSignInMessage(
                        connectingWallet.address,
                        DEFAULT_NETWORK,
                        connectingWallet.nonce,
                      )}
                    </pre>
                  </div>

                  <div style={{ fontSize: 8, color: C.muted, lineHeight: 1.5 }}>
                    ✓ Domain-bound — this message only works on forge-os.xyz.<br />
                    ✓ No transaction — signing a message has no gas fee.<br />
                    ✓ One-time nonce — prevents replay attacks.
                  </div>
                </>
              ) : (
                /* Signature rejected — offer fallback */
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div
                    style={{
                      background: `${C.warn}12`,
                      border: `1px solid ${C.warn}40`,
                      borderRadius: 8,
                      padding: "10px 14px",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 9,
                        color: C.warn,
                        fontWeight: 700,
                        ...mono,
                        marginBottom: 4,
                      }}
                    >
                      ⚠ Signature Declined
                    </div>
                    <div style={{ fontSize: 9, color: C.dim, lineHeight: 1.5 }}>
                      You rejected the sign-in message. You can connect without signing,
                      but ownership cannot be cryptographically verified.
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      data-testid="signin-signature-back"
                      onClick={() => { setStep("wallet_list"); setSigRejected(false); }}
                      style={ghostBtnStyle}
                    >
                      ← BACK
                    </button>
                    <button
                      data-testid="signin-connect-anyway"
                      onClick={() =>
                        finalize(
                          connectingWallet.address,
                          connectingWallet.provider,
                          connectingWallet.nonce,
                          true,
                        )
                      }
                      style={primaryBtnStyle(true)}
                    >
                      CONNECT ANYWAY →
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function WalletRow({
  option,
  onSelect,
  primary = false,
}: {
  option: WalletOption;
  onSelect: () => void;
  primary?: boolean;
}) {
  const notInstalled = !option.detected;
  const LogoComponent = WALLET_LOGOS[option.id];

  const borderColor = primary ? `${C.accent}50` : C.border;
  const bg = primary
    ? `linear-gradient(145deg, ${C.accent}10 0%, rgba(8,13,20,0.7) 100%)`
    : "rgba(11,17,24,0.7)";

  return (
    <button
      data-testid={`signin-wallet-option-${option.id}`}
      onClick={notInstalled ? () => window.open(option.installUrl, "_blank") : onSelect}
      style={{
        background: bg,
        border: `1px solid ${borderColor}`,
        borderRadius: primary ? 10 : 8,
        padding: primary ? "12px 14px" : "9px 12px",
        cursor: notInstalled ? "default" : "pointer",
        textAlign: "left",
        color: C.text,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        transition: "border-color 0.15s, background 0.15s",
        width: "100%",
      }}
      onMouseEnter={(e) => {
        if (!notInstalled) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = `${C.accent}70`;
        }
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = borderColor;
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
        {/* Wallet logo — SVG component or fallback emoji */}
        <div style={{ width: 28, height: 28, flexShrink: 0, opacity: notInstalled ? 0.45 : 1 }}>
          {LogoComponent ? <LogoComponent /> : (
            <span style={{ fontSize: 20, lineHeight: "28px", display: "block", textAlign: "center" }}>
              {option.icon}
            </span>
          )}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: primary ? 11 : 10,
            fontWeight: 700,
            color: notInstalled ? C.dim : C.text,
            ...mono,
            marginBottom: 2,
            overflowWrap: "anywhere",
          }}>
            {option.label}
            {primary && !notInstalled && (
              <span style={{
                fontSize: 7, color: C.accent, marginLeft: 7,
                background: `${C.accent}15`, border: `1px solid ${C.accent}35`,
                borderRadius: 3, padding: "1px 5px", letterSpacing: "0.08em",
              }}>
                NATIVE
              </span>
            )}
            {!primary && option.supportsSign && !notInstalled && (
              <span style={{
                fontSize: 7, color: C.ok, marginLeft: 6,
                border: `1px solid ${C.ok}40`, borderRadius: 3,
                padding: "1px 4px", letterSpacing: "0.08em",
              }}>
                SIGN
              </span>
            )}
          </div>
          <div style={{ fontSize: 8, color: C.muted, overflowWrap: "anywhere" }}>{option.desc}</div>
        </div>
      </div>

      {notInstalled ? (
        <span style={{ fontSize: 8, color: C.accent, ...mono, letterSpacing: "0.06em", flexShrink: 0 }}>
          INSTALL ↗
        </span>
      ) : (
        <span style={{ fontSize: primary ? 14 : 12, color: primary ? C.accent : C.dim, flexShrink: 0 }}>›</span>
      )}
    </button>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        background: `${C.danger}12`,
        border: `1px solid ${C.danger}40`,
        borderRadius: 8,
        padding: "8px 12px",
        fontSize: 9,
        color: C.danger,
        lineHeight: 1.5,
      }}
    >
      {message}
    </div>
  );
}

// ── Shared button styles ──────────────────────────────────────────────────────

const ghostBtnStyle: React.CSSProperties = {
  flex: 1,
  background: "rgba(33,48,67,0.4)",
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  padding: "8px 0",
  color: C.dim,
  fontSize: 9,
  cursor: "pointer",
  fontFamily: "inherit",
  letterSpacing: "0.08em",
};

const primaryBtnStyle = (enabled: boolean): React.CSSProperties => ({
  flex: 2,
  background: enabled ? `linear-gradient(90deg, ${C.accent}, #7BE9CF)` : `${C.accent}30`,
  border: "none",
  borderRadius: 6,
  padding: "8px 0",
  color: enabled ? "#04110E" : C.dim,
  fontSize: 9,
  fontWeight: 700,
  cursor: enabled ? "pointer" : "not-allowed",
  fontFamily: "inherit",
  letterSpacing: "0.08em",
});
