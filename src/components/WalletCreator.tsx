// WalletCreator — in-browser wallet generation and import.
// Steps (generate flow): choose → seed_length → backup → verify → ready
// Steps (import flow):   choose → import → ready
//
// Interoperability:
//   Generated wallets use BIP39 mnemonics (12 or 24 words) and
//   derivation path m/44'/111'/0'/0/0 — compatible with Kasware, Kastle,
//   Kaspium, and any BIP44 Kaspa wallet using the same path.

import { useState, useMemo } from "react";
import { DEFAULT_NETWORK } from "../constants";
import { shortAddr } from "../helpers";
import { C, mono } from "../tokens";
import { Btn, Card, Divider } from "./ui";
import {
  generateWallet,
  importWallet,
  saveManagedWallet,
  type ManagedWalletData,
} from "../wallet/KaspaWalletManager";

type Step = "choose" | "seed_length" | "backup" | "verify" | "import" | "ready";

interface Props {
  onConnect: (session: any) => void;
  onClose: () => void;
}

// ── Backup quiz helpers ────────────────────────────────────────────────────────

/**
 * Pick 3 random 1-based word indices from the phrase to quiz the user.
 * For 12-word phrases we use indices from 1-12; for 24-word phrases 1-24.
 * Indices are sorted ascending for a natural left-to-right feel.
 */
function pickQuizIndices(wordCount: number): number[] {
  const pool = Array.from({ length: wordCount }, (_, i) => i + 1);
  const picks: number[] = [];
  while (picks.length < 3) {
    const idx = Math.floor(Math.random() * pool.length);
    picks.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picks.sort((a, b) => a - b);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function WalletCreator({ onConnect, onClose }: Props) {
  const [step, setStep] = useState<Step>("choose");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [wallet, setWallet] = useState<ManagedWalletData | null>(null);
  const [wordCount, setWordCount] = useState<12 | 24>(12);
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [importPhrase, setImportPhrase] = useState("");
  const [copied, setCopied] = useState(false);

  // Backup quiz state
  const [quizIndices, setQuizIndices] = useState<number[]>([]);
  const [quizAnswers, setQuizAnswers] = useState<Record<number, string>>({});
  const [quizErrors, setQuizErrors] = useState<Record<number, boolean>>({});

  const words = wallet?.phrase?.split(" ") ?? [];

  // ── Generate ──────────────────────────────────────────────────────────────

  const handleGenerate = async () => {
    setBusy(true);
    setErr("");
    try {
      const data = await generateWallet(DEFAULT_NETWORK, wordCount);
      const indices = pickQuizIndices(data.phrase.split(" ").length);
      setWallet(data);
      setQuizIndices(indices);
      setQuizAnswers({});
      setQuizErrors({});
      setBackupConfirmed(false);
      setStep("backup");
    } catch (e: any) {
      setErr(e?.message || "Wallet generation failed.");
    }
    setBusy(false);
  };

  // ── Backup quiz validation ─────────────────────────────────────────────────

  const quizComplete = useMemo(() => {
    return quizIndices.every((idx) => (quizAnswers[idx] ?? "").trim().length > 0);
  }, [quizIndices, quizAnswers]);

  const handleVerify = () => {
    if (!wallet) return;
    const phraseWords = wallet.phrase.split(" ");
    const errors: Record<number, boolean> = {};
    let allCorrect = true;
    quizIndices.forEach((idx) => {
      const expected = phraseWords[idx - 1].toLowerCase();
      const given = (quizAnswers[idx] ?? "").trim().toLowerCase();
      if (given !== expected) {
        errors[idx] = true;
        allCorrect = false;
      }
    });
    setQuizErrors(errors);
    if (allCorrect) setStep("ready");
  };

  // ── Import ────────────────────────────────────────────────────────────────

  const handleImport = async () => {
    setBusy(true);
    setErr("");
    try {
      const data = await importWallet(importPhrase, DEFAULT_NETWORK);
      setWallet(data);
      setStep("ready");
    } catch (e: any) {
      setErr(e?.message || "Invalid seed phrase.");
    }
    setBusy(false);
  };

  // ── Connect ───────────────────────────────────────────────────────────────

  const handleConnect = () => {
    if (!wallet) return;
    saveManagedWallet(wallet);
    onConnect({ address: wallet.address, network: wallet.network, provider: "managed" });
  };

  const copyAddress = async () => {
    if (!wallet) return;
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  // ── Shared input style ────────────────────────────────────────────────────

  const inputStyle: React.CSSProperties = {
    background: "rgba(8,13,20,0.7)",
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: "7px 10px",
    color: C.text,
    fontSize: 10,
    ...mono,
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.88)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 20,
        overflowY: "auto",
      }}
    >
      <Card p={28} style={{ maxWidth: 560, width: "100%", position: "relative" }}>
        {/* Close */}
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: 14,
            right: 16,
            background: "none",
            border: "none",
            color: C.dim,
            fontSize: 18,
            cursor: "pointer",
            lineHeight: 1,
          }}
        >
          ×
        </button>

        {/* ── CHOOSE ────────────────────────────────────────────────────────── */}
        {step === "choose" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, ...mono, marginBottom: 4 }}>
                Kaspa Wallet Setup
              </div>
              <div style={{ fontSize: 10, color: C.dim }}>
                Create a new wallet or import one using your seed phrase.
              </div>
            </div>
            <Divider m={4} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button
                onClick={() => setStep("seed_length")}
                style={{
                  background: `linear-gradient(145deg, ${C.accent}18 0%, rgba(8,13,20,0.6) 100%)`,
                  border: `1px solid ${C.accent}40`,
                  borderRadius: 10,
                  padding: "18px 14px",
                  cursor: "pointer",
                  textAlign: "left",
                  color: C.text,
                  transition: "border-color 0.15s",
                }}
              >
                <div style={{ fontSize: 22, marginBottom: 8 }}>✦</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.accent, ...mono, marginBottom: 4 }}>
                  GENERATE NEW
                </div>
                <div style={{ fontSize: 9, color: C.dim, lineHeight: 1.5 }}>
                  Create a fresh Kaspa wallet. Choose 12 or 24-word seed phrase.
                </div>
              </button>
              <button
                onClick={() => setStep("import")}
                style={{
                  background: "linear-gradient(145deg, rgba(16,25,35,0.7) 0%, rgba(8,13,20,0.5) 100%)",
                  border: `1px solid rgba(33,48,67,0.7)`,
                  borderRadius: 10,
                  padding: "18px 14px",
                  cursor: "pointer",
                  textAlign: "left",
                  color: C.text,
                  transition: "border-color 0.15s",
                }}
              >
                <div style={{ fontSize: 22, marginBottom: 8 }}>↓</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.text, ...mono, marginBottom: 4 }}>
                  IMPORT EXISTING
                </div>
                <div style={{ fontSize: 9, color: C.dim, lineHeight: 1.5 }}>
                  Paste your 12 or 24-word seed phrase to restore a wallet.
                </div>
              </button>
            </div>
            {err && <ErrorBanner message={err} />}
          </div>
        )}

        {/* ── SEED LENGTH picker ─────────────────────────────────────────────── */}
        {step === "seed_length" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, ...mono, marginBottom: 4 }}>
                Choose Seed Phrase Length
              </div>
              <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.5 }}>
                Both lengths use BIP39 standard and are compatible with all Kaspa wallets
                (Kasware, Kastle, Kaspium) via derivation path{" "}
                <span style={{ color: C.accent, ...mono }}>m/44'/111'/0'/0/0</span>.
              </div>
            </div>
            <Divider m={4} />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {(
                [
                  {
                    count: 12 as const,
                    label: "12 Words",
                    sub: "128-bit entropy",
                    note: "Standard security. Easier to write down. Good for most users.",
                    color: C.accent,
                    recommended: true,
                  },
                  {
                    count: 24 as const,
                    label: "24 Words",
                    sub: "256-bit entropy",
                    note: "Maximum security. Recommended for large holdings.",
                    color: C.purple,
                  },
                ] as { count: 12|24; label: string; sub: string; note: string; color: string; recommended?: boolean }[]
              ).map(({ count, label, sub, note, color, recommended }) => (
                <button
                  key={count}
                  onClick={() => setWordCount(count)}
                  style={{
                    background:
                      wordCount === count
                        ? `linear-gradient(145deg, ${color}18 0%, rgba(8,13,20,0.6) 100%)`
                        : "rgba(11,17,24,0.6)",
                    border: `1px solid ${wordCount === count ? color + "60" : C.border}`,
                    borderRadius: 10,
                    padding: "16px 14px",
                    cursor: "pointer",
                    textAlign: "left",
                    color: C.text,
                    transition: "all 0.15s",
                  }}
                >
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      color: wordCount === count ? color : C.dim,
                      ...mono,
                      marginBottom: 3,
                    }}
                  >
                    {label}
                  </div>
                  <div style={{ fontSize: 8, color: C.muted, ...mono, marginBottom: 8 }}>
                    {sub}
                  </div>
                  <div style={{ fontSize: 9, color: C.dim, lineHeight: 1.4 }}>{note}</div>
                  {recommended && (
                    <div
                      style={{
                        marginTop: 8,
                        fontSize: 7,
                        color: C.purple,
                        border: `1px solid ${C.purple}40`,
                        borderRadius: 3,
                        padding: "2px 6px",
                        display: "inline-block",
                        letterSpacing: "0.08em",
                        ...mono,
                      }}
                    >
                      RECOMMENDED
                    </div>
                  )}
                </button>
              ))}
            </div>

            {err && <ErrorBanner message={err} />}

            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={() => setStep("choose")} variant="ghost" size="sm" style={{ flex: 1 }}>
                ← BACK
              </Btn>
              <Btn
                onClick={handleGenerate}
                disabled={busy}
                variant="primary"
                size="sm"
                style={{ flex: 2 }}
              >
                {busy ? "GENERATING…" : `GENERATE ${wordCount}-WORD WALLET →`}
              </Btn>
            </div>
          </div>
        )}

        {/* ── BACKUP (show seed phrase) ──────────────────────────────────────── */}
        {step === "backup" && wallet && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, ...mono, marginBottom: 4 }}>
                Back Up Your Seed Phrase
              </div>
              <div style={{ fontSize: 10, color: C.dim }}>
                This is your wallet recovery key. Forge-OS cannot recover it for you.
              </div>
            </div>

            {/* Warning banner */}
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
                  fontSize: 10,
                  color: C.warn,
                  fontWeight: 700,
                  ...mono,
                  marginBottom: 3,
                }}
              >
                ⚠ WRITE THESE WORDS DOWN OFFLINE
              </div>
              <div style={{ fontSize: 9, color: C.dim, lineHeight: 1.5 }}>
                Anyone with this phrase controls your wallet. Never share it.
                Do not take a screenshot. Store it somewhere safe and offline.
              </div>
            </div>

            {/* Mnemonic grid — 4 columns for 12 words, 4 columns for 24 */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 5,
              }}
            >
              {words.map((word, i) => (
                <div
                  key={i}
                  style={{
                    background: "rgba(8,13,20,0.7)",
                    border: `1px solid ${C.border}`,
                    borderRadius: 6,
                    padding: "6px 8px",
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  <span style={{ fontSize: 7, color: C.muted, ...mono, minWidth: 14 }}>
                    {i + 1}.
                  </span>
                  <span style={{ fontSize: 10, color: C.text, ...mono, fontWeight: 600 }}>
                    {word}
                  </span>
                </div>
              ))}
            </div>

            {/* Confirm checkbox */}
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={backupConfirmed}
                onChange={(e) => setBackupConfirmed(e.target.checked)}
                style={{ marginTop: 2, accentColor: C.accent }}
              />
              <span style={{ fontSize: 10, color: C.dim, lineHeight: 1.5 }}>
                I have written down all {words.length} words in order and stored them securely offline.
                I understand Forge-OS cannot recover this phrase.
              </span>
            </label>

            <Btn
              onClick={() => setStep("verify")}
              disabled={!backupConfirmed}
              variant="primary"
              size="sm"
            >
              I'VE SAVED MY PHRASE — CONTINUE →
            </Btn>
          </div>
        )}

        {/* ── VERIFY (backup quiz) ───────────────────────────────────────────── */}
        {step === "verify" && wallet && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: C.text,
                  ...mono,
                  marginBottom: 4,
                }}
              >
                Verify Your Backup
              </div>
              <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.5 }}>
                Enter the words at the positions below to confirm you've saved your phrase correctly.
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {quizIndices.map((idx) => (
                <div key={idx}>
                  <div
                    style={{
                      fontSize: 8,
                      color: C.dim,
                      ...mono,
                      letterSpacing: "0.1em",
                      marginBottom: 4,
                    }}
                  >
                    WORD #{idx}
                  </div>
                  <input
                    type="text"
                    value={quizAnswers[idx] ?? ""}
                    onChange={(e) => {
                      setQuizAnswers((prev) => ({ ...prev, [idx]: e.target.value }));
                      setQuizErrors((prev) => ({ ...prev, [idx]: false }));
                    }}
                    placeholder={`Enter word #${idx}`}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    style={{
                      ...inputStyle,
                      borderColor: quizErrors[idx] ? C.danger : C.border,
                    }}
                  />
                  {quizErrors[idx] && (
                    <div style={{ fontSize: 8, color: C.danger, marginTop: 4 }}>
                      Incorrect — check your written phrase and try again.
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <Btn
                onClick={() => { setStep("backup"); setQuizErrors({}); setQuizAnswers({}); }}
                variant="ghost"
                size="sm"
                style={{ flex: 1 }}
              >
                ← SHOW PHRASE
              </Btn>
              <Btn
                onClick={handleVerify}
                disabled={!quizComplete}
                variant="primary"
                size="sm"
                style={{ flex: 2 }}
              >
                VERIFY →
              </Btn>
            </div>
          </div>
        )}

        {/* ── IMPORT ────────────────────────────────────────────────────────── */}
        {step === "import" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: C.text,
                  ...mono,
                  marginBottom: 4,
                }}
              >
                Import Seed Phrase
              </div>
              <div style={{ fontSize: 10, color: C.dim }}>
                Paste your 12 or 24-word Kaspa BIP39 seed phrase to derive your address.
              </div>
            </div>

            <textarea
              value={importPhrase}
              onChange={(e) => {
                setImportPhrase(e.target.value);
                setErr("");
              }}
              placeholder="word1 word2 word3 … word24"
              rows={4}
              style={{
                background: "rgba(8,13,20,0.8)",
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                padding: "10px 12px",
                color: C.text,
                fontSize: 11,
                ...mono,
                resize: "vertical",
                lineHeight: 1.6,
                outline: "none",
                width: "100%",
                boxSizing: "border-box",
              }}
            />

            {/* Word count indicator */}
            {importPhrase.trim() && (() => {
              const n = importPhrase.trim().split(/\s+/).length;
              const valid = n === 12 || n === 24;
              return (
                <div style={{ fontSize: 9, color: valid ? C.ok : C.warn, ...mono }}>
                  {n} words {valid ? "✓" : "(need 12 or 24)"}
                </div>
              );
            })()}

            {err && <ErrorBanner message={err} />}

            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={() => setStep("choose")} variant="ghost" size="sm" style={{ flex: 1 }}>
                ← BACK
              </Btn>
              <Btn
                onClick={handleImport}
                disabled={
                  busy ||
                  !(
                    importPhrase.trim().split(/\s+/).length === 12 ||
                    importPhrase.trim().split(/\s+/).length === 24
                  )
                }
                variant="primary"
                size="sm"
                style={{ flex: 2 }}
              >
                {busy ? "IMPORTING…" : "IMPORT WALLET →"}
              </Btn>
            </div>
          </div>
        )}

        {/* ── READY ─────────────────────────────────────────────────────────── */}
        {step === "ready" && wallet && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: C.accent,
                  ...mono,
                  marginBottom: 4,
                }}
              >
                ✓ Wallet Ready
              </div>
              <div style={{ fontSize: 10, color: C.dim }}>
                Your Kaspa address is ready. Send KAS here to fund your agent.
              </div>
            </div>

            {/* Address block */}
            <div
              style={{
                background: "rgba(8,13,20,0.8)",
                border: `1px solid ${C.accent}30`,
                borderRadius: 10,
                padding: "14px 16px",
              }}
            >
              <div
                style={{
                  fontSize: 8,
                  color: C.dim,
                  ...mono,
                  letterSpacing: "0.1em",
                  marginBottom: 6,
                }}
              >
                DEPOSIT ADDRESS · KASPA {wallet.network.toUpperCase()}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: C.text,
                  ...mono,
                  wordBreak: "break-all",
                  lineHeight: 1.6,
                  marginBottom: 10,
                }}
              >
                {wallet.address}
              </div>
              <button
                onClick={copyAddress}
                style={{
                  background: copied ? `${C.ok}20` : "rgba(33,48,67,0.5)",
                  border: `1px solid ${copied ? C.ok : C.border}`,
                  borderRadius: 6,
                  padding: "5px 14px",
                  color: copied ? C.ok : C.dim,
                  fontSize: 10,
                  cursor: "pointer",
                  ...mono,
                  transition: "all 0.15s",
                }}
              >
                {copied ? "✓ COPIED" : "COPY ADDRESS"}
              </button>
            </div>

            {/* Deposit instructions */}
            <div
              style={{
                background: `${C.purple}0D`,
                border: `1px solid ${C.purple}28`,
                borderRadius: 8,
                padding: "10px 14px",
              }}
            >
              <div
                style={{
                  fontSize: 9,
                  color: C.purple,
                  fontWeight: 700,
                  ...mono,
                  marginBottom: 4,
                }}
              >
                HOW TO DEPOSIT
              </div>
              <div style={{ fontSize: 9, color: C.dim, lineHeight: 1.6 }}>
                1. Copy the address above.<br />
                2. Open Kasware, Kastle, Kaspium, or any Kaspa wallet.<br />
                3. Send KAS to this address.<br />
                4. Click Connect — your balance will appear once confirmed.
              </div>
            </div>

            {/* Interop note */}
            <div
              style={{
                background: `${C.accent}08`,
                border: `1px solid ${C.accent}20`,
                borderRadius: 8,
                padding: "8px 12px",
              }}
            >
              <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.5 }}>
                <span style={{ color: C.accent, fontWeight: 700 }}>Fully interoperable: </span>
                This wallet uses BIP39 + derivation path{" "}
                <span style={{ ...mono, color: C.accent }}>m/44'/111'/0'/0/0</span>.
                Import your seed phrase into Kasware, Kastle, or Kaspium to sign transactions
                directly from those wallets.
              </div>
            </div>

            {/* Short address badge */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 9,
                color: C.dim,
                ...mono,
              }}
            >
              <div
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: C.ok,
                  flexShrink: 0,
                }}
              />
              {shortAddr(wallet.address)} · {wallet.network} · {words.length} words
            </div>

            <Btn onClick={handleConnect} variant="primary" size="sm">
              CONNECT WALLET →
            </Btn>

            <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.5 }}>
              This wallet connects in read-only mode. To sign transactions, import your seed
              phrase into Kasware or Kastle, or use the Forge-OS extension.
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Error banner ──────────────────────────────────────────────────────────────

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        fontSize: 10,
        color: C.danger,
        padding: "8px 12px",
        background: `${C.danger}12`,
        border: `1px solid ${C.danger}30`,
        borderRadius: 6,
        lineHeight: 1.5,
      }}
    >
      {message}
    </div>
  );
}
