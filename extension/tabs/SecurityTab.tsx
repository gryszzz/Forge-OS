// SecurityTab — password-gated phrase reveal, change password, reset wallet.
// The mnemonic is NEVER passed as a prop; it is read from the in-memory
// session (unlockVault) only when the user explicitly authenticates here.

import { useEffect, useMemo, useState } from "react";
import { C, mono } from "../../src/tokens";
import { fmt, shortAddr } from "../../src/helpers";
import { unlockVault, changePassword, resetWallet } from "../vault/vault";
import {
  describeKaspaProviderPreset,
  invalidateEndpointPoolCache,
  probeKaspaEndpointPool,
  type KaspaEndpointHealthSnapshot,
} from "../network/kaspaClient";
import {
  getCustomKaspaRpc,
  getKaspaRpcPoolOverride,
  getLocalNodeDataDir,
  getLocalNodeEnabled,
  getLocalNodeNetworkProfile,
  getKaspaRpcProviderPreset,
  setLocalNodeDataDir,
  setLocalNodeEnabled,
  setLocalNodeNetworkProfile,
  setKaspaRpcPoolOverride,
  setCustomKaspaRpc,
  setKaspaRpcProviderPreset,
  type LocalNodeNetworkProfile,
  type KaspaRpcPoolOverridePreset,
  type KaspaRpcProviderPreset,
} from "../shared/storage";
import { ensureHostPermissionsForEndpoints } from "../shared/hostPermissions";
import {
  getLocalNodeControlBaseUrl,
  getLocalNodeLogsTail,
  getLocalNodeMetrics,
  getLocalNodeStatus,
  restartLocalNode,
  subscribeLocalNodeEvents,
  startLocalNode,
  stopLocalNode,
  type LocalNodeMetricsResponse,
  type LocalNodeStatusResponse,
  type LocalNodeStatus,
} from "../network/localNodeClient";
import {
  insetCard,
  monoInput,
  outlineButton,
  popupTabStack,
  primaryButton,
  sectionCard,
  sectionKicker,
  sectionTitle,
} from "../popup/surfaces";

interface Props {
  address: string | null;
  network: string;
  isManagedWallet: boolean;
  autoLockMinutes: number;
  persistUnlockSessionEnabled: boolean;
  onAutoLockMinutesChange: (minutes: number) => Promise<void> | void;
  onPersistUnlockSessionChange: (enabled: boolean) => Promise<void> | void;
  onLock: () => void;
}

type Panel = "none" | "reveal" | "change_pw" | "reset";

const LOCAL_NODE_PROFILES: LocalNodeNetworkProfile[] = ["mainnet", "testnet-10", "testnet-11", "testnet-12"];
const RPC_POOL_OVERRIDE_PRESETS: KaspaRpcPoolOverridePreset[] = ["official", "igra", "kasplex"];

const LOCAL_NODE_REASON_LABELS: Record<string, string> = {
  local_node_enabled_and_healthy: "Local node selected",
  local_node_disabled: "Local mode disabled",
  local_node_unhealthy: "Local RPC unhealthy",
  local_node_syncing: "Local node syncing (remote fallback)",
  local_profile_mismatch: "Profile does not match active network",
  local_rpc_missing: "Local RPC endpoint missing",
  local_endpoint_missing: "Local RPC endpoint missing",
};

function networkToLocalProfile(value: string): LocalNodeNetworkProfile {
  const normalized = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "testnet-10" || normalized === "tn10") return "testnet-10";
  if (normalized === "testnet-11" || normalized === "tn11") return "testnet-11";
  if (normalized === "testnet-12" || normalized === "tn12") return "testnet-12";
  return "mainnet";
}

function profileLabel(profile: LocalNodeNetworkProfile): string {
  return profile === "mainnet" ? "MAINNET" : profile.toUpperCase().replace("TESTNET-", "TN");
}

function relativeSeconds(ts: number | null): string {
  if (!ts || !Number.isFinite(ts)) return "never";
  const deltaMs = Math.max(0, Date.now() - ts);
  if (deltaMs < 1_000) return "just now";
  if (deltaMs < 60_000) return `${Math.floor(deltaMs / 1_000)}s ago`;
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m ago`;
  return `${Math.floor(deltaMs / 3_600_000)}h ago`;
}

export function SecurityTab({
  address,
  network,
  isManagedWallet,
  autoLockMinutes,
  persistUnlockSessionEnabled,
  onAutoLockMinutesChange,
  onPersistUnlockSessionChange,
  onLock,
}: Props) {
  const [panel, setPanel] = useState<Panel>("none");
  const [revealWords, setRevealWords] = useState<string[]>([]);

  // Reveal phrase state
  const [revealPw, setRevealPw] = useState("");
  const [revealErr, setRevealErr] = useState<string | null>(null);
  const [revealLoading, setRevealLoading] = useState(false);

  // Change password state
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [changePwErr, setChangePwErr] = useState<string | null>(null);
  const [changePwOk, setChangePwOk] = useState(false);
  const [changePwLoading, setChangePwLoading] = useState(false);

  // Reset state
  const [resetConfirm, setResetConfirm] = useState(false);
  const [sessionPrefsLoading, setSessionPrefsLoading] = useState(false);
  const [rpcPreset, setRpcPreset] = useState<KaspaRpcProviderPreset>("official");
  const [customRpcInput, setCustomRpcInput] = useState("");
  const [customRpcLoading, setCustomRpcLoading] = useState(false);
  const [customRpcError, setCustomRpcError] = useState<string | null>(null);
  const [customRpcSaved, setCustomRpcSaved] = useState(false);
  const [rpcPoolOverrides, setRpcPoolOverrides] = useState<Partial<Record<KaspaRpcPoolOverridePreset, string[]>>>({});
  const [rpcPoolOverrideInput, setRpcPoolOverrideInput] = useState("");
  const [rpcPoolOverrideLoading, setRpcPoolOverrideLoading] = useState(false);
  const [rpcPoolOverrideError, setRpcPoolOverrideError] = useState<string | null>(null);
  const [rpcPoolOverrideSaved, setRpcPoolOverrideSaved] = useState(false);
  const [localNodeEnabled, setLocalNodeEnabledState] = useState(false);
  const [localNodeProfile, setLocalNodeProfileState] = useState<LocalNodeNetworkProfile>("mainnet");
  const [localNodeDataDir, setLocalNodeDataDirState] = useState("");
  const [localNodeStatus, setLocalNodeStatus] = useState<LocalNodeStatus | null>(null);
  const [localNodeBackend, setLocalNodeBackend] = useState<LocalNodeStatusResponse["backend"] | null>(null);
  const [localNodeMetrics, setLocalNodeMetrics] = useState<LocalNodeMetricsResponse | null>(null);
  const [localNodeLogs, setLocalNodeLogs] = useState("");
  const [localNodeShowLogs, setLocalNodeShowLogs] = useState(false);
  const [localNodeStreamConnected, setLocalNodeStreamConnected] = useState(false);
  const [localNodeLastUpdatedAt, setLocalNodeLastUpdatedAt] = useState<number | null>(null);
  const [localNodeBusy, setLocalNodeBusy] = useState(false);
  const [localNodeError, setLocalNodeError] = useState<string | null>(null);
  const [providerProbeBusy, setProviderProbeBusy] = useState(false);
  const [providerProbeError, setProviderProbeError] = useState<string | null>(null);
  const [providerProbeRows, setProviderProbeRows] = useState<KaspaEndpointHealthSnapshot[]>([]);
  const [providerProbeAt, setProviderProbeAt] = useState<number | null>(null);

  const rpcPresetLabels: Record<KaspaRpcProviderPreset, string> = {
    official: "OFFICIAL",
    igra: "IGRA",
    kasplex: "KASPLEX",
    custom: "CUSTOM",
    local: "LOCAL NODE",
  };

  const provider = isManagedWallet ? "managed" : address ? "watch-only" : "none";
  const autoLockOptions: Array<{ label: string; value: number }> = [
    { label: "1m", value: 1 },
    { label: "15m", value: 15 },
    { label: "1h", value: 60 },
    { label: "4h", value: 240 },
    { label: "Never", value: -1 },
  ];

  const activeNetworkProfile = useMemo(
    () => networkToLocalProfile(network),
    [network],
  );
  const localProfileMatchesActive = localNodeProfile === activeNetworkProfile;
  const localDataDirNormalized = localNodeDataDir.trim();
  const runtimeProfile = networkToLocalProfile(localNodeStatus?.networkProfile || localNodeProfile);
  const runtimeDataRootNormalized = (localNodeStatus?.dataDirBase || "").trim();
  const managedDataRoot = (localNodeStatus?.dataDirManagedDefault || "").trim();
  const desiredDataRoot = localDataDirNormalized || managedDataRoot;
  const hasPendingRuntimeChanges = Boolean(
    localNodeStatus?.running && (
      runtimeProfile !== localNodeProfile
      || (
        desiredDataRoot.length > 0
        && runtimeDataRootNormalized.length > 0
        && desiredDataRoot !== runtimeDataRootNormalized
      )
    ),
  );
  const localControlBaseUrl = getLocalNodeControlBaseUrl();
  const localConnectionState = localNodeStatus?.connectionState || "stopped";
  const localSyncProgressPct = localNodeStatus?.sync?.progressPct ?? null;
  const providerDescriptor = useMemo(
    () => describeKaspaProviderPreset(network, rpcPreset, customRpcInput.trim() || null, rpcPoolOverrides),
    [network, rpcPreset, customRpcInput, rpcPoolOverrides],
  );
  const editablePoolPreset = (rpcPreset === "official" || rpcPreset === "igra" || rpcPreset === "kasplex")
    ? rpcPreset
    : null;
  const invalidateRpcPoolRuntime = () => invalidateEndpointPoolCache(network);

  const applyLocalNodeSnapshot = (
    statusResponse: LocalNodeStatusResponse | null,
    options?: {
      logs?: string;
      metrics?: LocalNodeMetricsResponse | null;
    },
  ) => {
    setLocalNodeStatus(statusResponse?.status ?? null);
    setLocalNodeBackend(statusResponse?.backend ?? null);
    if (typeof options?.logs === "string") setLocalNodeLogs(options.logs);
    if (options && Object.prototype.hasOwnProperty.call(options, "metrics")) {
      setLocalNodeMetrics(options.metrics ?? null);
    }
    setLocalNodeLastUpdatedAt(Date.now());
  };

  const refreshLocalNodeStatus = async (
    options?: {
      includeLogs?: boolean;
      includeMetrics?: boolean;
    },
  ) => {
    const includeLogs = options?.includeLogs === true;
    const includeMetrics = options?.includeMetrics !== false;
    const [statusResponse, logs, metrics] = await Promise.all([
      getLocalNodeStatus(),
      includeLogs ? getLocalNodeLogsTail(40) : Promise.resolve(""),
      includeMetrics ? getLocalNodeMetrics() : Promise.resolve(null),
    ]);
    applyLocalNodeSnapshot(statusResponse, {
      logs: includeLogs ? logs : undefined,
      metrics,
    });
    return statusResponse;
  };

  useEffect(() => {
    let active = true;
    setCustomRpcLoading(true);
    setCustomRpcError(null);
    setCustomRpcSaved(false);

    Promise.all([
      getCustomKaspaRpc(network),
      getKaspaRpcProviderPreset(network),
      getKaspaRpcPoolOverride(network, "official"),
      getKaspaRpcPoolOverride(network, "igra"),
      getKaspaRpcPoolOverride(network, "kasplex"),
      getLocalNodeEnabled(),
      getLocalNodeNetworkProfile(),
      getLocalNodeDataDir(),
      refreshLocalNodeStatus({ includeLogs: false, includeMetrics: true }),
    ])
      .then(([
        value,
        preset,
        officialPoolOverride,
        igraPoolOverride,
        kasplexPoolOverride,
        localEnabled,
        localProfile,
        localDataDirValue,
      ]) => {
        if (!active) return;
        setCustomRpcInput(value ?? "");
        setRpcPreset(preset);
        const nextOverrides = {
          official: officialPoolOverride,
          igra: igraPoolOverride,
          kasplex: kasplexPoolOverride,
        } satisfies Partial<Record<KaspaRpcPoolOverridePreset, string[]>>;
        setRpcPoolOverrides(nextOverrides);
        const selectedPool = preset === "official" || preset === "igra" || preset === "kasplex"
          ? (nextOverrides[preset] || [])
          : [];
        setRpcPoolOverrideInput(selectedPool.join("\n"));
        setLocalNodeEnabledState(localEnabled);
        setLocalNodeProfileState(localProfile);
        setLocalNodeDataDirState(localDataDirValue ?? "");
      })
      .catch(() => {
        if (!active) return;
        setCustomRpcError("Failed to load RPC settings.");
      })
      .finally(() => {
        if (active) setCustomRpcLoading(false);
      });

    return () => {
      active = false;
    };
  }, [network]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let tick = 0;
    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const includeMetrics = !localNodeStreamConnected || tick % 3 === 0;
        await refreshLocalNodeStatus({
          includeLogs: false,
          includeMetrics,
        });
      } catch {
        // noop
      } finally {
        tick += 1;
        inFlight = false;
      }
    };

    void poll();
    const intervalMs = localNodeStreamConnected ? 15_000 : 6_000;
    const timer = setInterval(() => {
      void poll();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [localNodeStreamConnected]);

  useEffect(() => {
    const unsubscribe = subscribeLocalNodeEvents((event) => {
      if (event.type === "connected" || event.type === "heartbeat") {
        setLocalNodeStreamConnected(true);
        setLocalNodeLastUpdatedAt(Date.now());
      }
      if (event.type === "stream_error" || event.type === "error") {
        setLocalNodeStreamConnected(false);
      }
      if (event.type === "status") {
        const payload = event.payload as LocalNodeStatusResponse | undefined;
        if (payload?.status) {
          applyLocalNodeSnapshot(payload, { metrics: null });
        }
      }
      if (event.type === "lifecycle") {
        void refreshLocalNodeStatus({
          includeLogs: localNodeShowLogs,
          includeMetrics: true,
        });
      }
    });
    return () => {
      unsubscribe();
      setLocalNodeStreamConnected(false);
    };
  }, [localNodeShowLogs]);

  useEffect(() => {
    setProviderProbeRows([]);
    setProviderProbeError(null);
    setProviderProbeAt(null);
  }, [network, rpcPreset]);

  useEffect(() => {
    if (!editablePoolPreset) {
      setRpcPoolOverrideInput("");
      return;
    }
    setRpcPoolOverrideInput((rpcPoolOverrides[editablePoolPreset] || []).join("\n"));
  }, [editablePoolPreset, rpcPoolOverrides]);

  useEffect(() => {
    if (!localNodeShowLogs) return;
    let cancelled = false;
    getLocalNodeLogsTail(120)
      .then((logs) => {
        if (!cancelled) setLocalNodeLogs(logs);
      })
      .catch(() => {
        if (!cancelled) setLocalNodeLogs("");
      });
    return () => {
      cancelled = true;
    };
  }, [localNodeShowLogs]);

  // ── Reveal seed phrase ───────────────────────────────────────────────────────
  const handleReveal = async (e: React.FormEvent) => {
    e.preventDefault();
    setRevealErr(null);
    setRevealLoading(true);
    try {
      // Re-authenticate with password to get fresh session + mnemonic
      const session = await unlockVault(revealPw, autoLockMinutes, {
        persistSession: persistUnlockSessionEnabled,
      });
      setRevealWords(session.mnemonic.split(" "));
      setRevealPw("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRevealErr(msg === "INVALID_PASSWORD" ? "Incorrect password." : "Authentication failed.");
      setRevealPw("");
    } finally {
      setRevealLoading(false);
    }
  };

  const handleHidePhrase = () => {
    setRevealWords([]);
    setRevealPw("");
    setRevealErr(null);
    setPanel("none");
  };

  // ── Change password ──────────────────────────────────────────────────────────
  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setChangePwErr(null);
    if (newPw.length < 8) { setChangePwErr("New password must be at least 8 characters."); return; }
    if (newPw !== confirmPw) { setChangePwErr("New passwords do not match."); return; }
    if (newPw === oldPw) { setChangePwErr("New password must differ from current password."); return; }
    setChangePwLoading(true);
    try {
      await changePassword(oldPw, newPw);
      setChangePwOk(true);
      setOldPw(""); setNewPw(""); setConfirmPw("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "INVALID_PASSWORD") setChangePwErr("Current password is incorrect.");
      else if (msg === "WEAK_PASSWORD") setChangePwErr("New password is too short (min 8 chars).");
      else setChangePwErr("Failed to change password. Try again.");
    } finally {
      setChangePwLoading(false);
    }
  };

  // ── Reset wallet ─────────────────────────────────────────────────────────────
  const handleReset = async () => {
    if (!resetConfirm) { setResetConfirm(true); return; }
    await resetWallet();
    onLock(); // parent will navigate to first-run on next render
  };

  // ── Input style helper ───────────────────────────────────────────────────────
  const inputStyle = (hasError = false) => ({
    ...monoInput(hasError),
  });

  const closePanel = () => {
    setPanel("none");
    setRevealWords([]);
    setRevealPw(""); setRevealErr(null);
    setOldPw(""); setNewPw(""); setConfirmPw("");
    setChangePwErr(null); setChangePwOk(false);
    setResetConfirm(false);
  };

  const openLocalNodePath = (pathname: string) => {
    const target = `${localControlBaseUrl}${pathname}`;
    if (typeof chrome !== "undefined" && chrome.tabs?.create) {
      chrome.tabs.create({ url: target });
      return;
    }
    if (typeof window !== "undefined") {
      window.open(target, "_blank", "noopener,noreferrer");
    }
  };

  const runProviderProbe = async () => {
    setProviderProbeBusy(true);
    setProviderProbeError(null);
    setProviderProbeRows([]);
    try {
      invalidateRpcPoolRuntime();
      const rows = await probeKaspaEndpointPool(network);
      const sorted = [...rows].sort((a, b) => {
        const aOk = a.lastOkAt || 0;
        const bOk = b.lastOkAt || 0;
        if (aOk !== bOk) return bOk - aOk;
        const aFail = a.consecutiveFails || 0;
        const bFail = b.consecutiveFails || 0;
        return aFail - bFail;
      });
      setProviderProbeRows(sorted);
      setProviderProbeAt(Date.now());
    } catch {
      setProviderProbeError("Failed to probe provider feed.");
    } finally {
      setProviderProbeBusy(false);
    }
  };

  const parsePoolInput = (raw: string): string[] => {
    const list = raw
      .split(/[\n,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const deduped: string[] = [];
    for (const entry of list) {
      try {
        const u = new URL(entry);
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
        const normalized = entry.replace(/\/+$/, "");
        if (!deduped.includes(normalized)) deduped.push(normalized);
      } catch {
        // skip invalid
      }
    }
    return deduped;
  };

  const saveRpcPoolOverride = async () => {
    if (!editablePoolPreset) return;
    setRpcPoolOverrideLoading(true);
    setRpcPoolOverrideError(null);
    setRpcPoolOverrideSaved(false);
    try {
      const parsed = parsePoolInput(rpcPoolOverrideInput);
      if (rpcPoolOverrideInput.trim() && parsed.length === 0) {
        setRpcPoolOverrideError("No valid http(s) endpoints found in override list.");
        return;
      }
      if (parsed.length > 0) {
        await ensureHostPermissionsForEndpoints(parsed);
      }
      await setKaspaRpcPoolOverride(network, editablePoolPreset, parsed.length > 0 ? parsed : null);
      setRpcPoolOverrides((prev) => ({ ...prev, [editablePoolPreset]: parsed }));
      setRpcPoolOverrideSaved(true);
      invalidateRpcPoolRuntime();
      // Force pool recomputation quickly after override change.
      await runProviderProbe();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("HOST_PERMISSION_DENIED:")) {
        setRpcPoolOverrideError("Browser denied host permission for selected endpoint. Allow permission to use this endpoint.");
      } else {
        setRpcPoolOverrideError("Failed to save endpoint pool override.");
      }
    } finally {
      setRpcPoolOverrideLoading(false);
    }
  };

  const clearRpcPoolOverride = async () => {
    if (!editablePoolPreset) return;
    setRpcPoolOverrideLoading(true);
    setRpcPoolOverrideError(null);
    setRpcPoolOverrideSaved(false);
    try {
      await setKaspaRpcPoolOverride(network, editablePoolPreset, null);
      setRpcPoolOverrides((prev) => ({ ...prev, [editablePoolPreset]: [] }));
      setRpcPoolOverrideInput("");
      setRpcPoolOverrideSaved(true);
      invalidateRpcPoolRuntime();
      await runProviderProbe();
    } catch (err) {
      setRpcPoolOverrideError(err instanceof Error ? err.message : "Failed to clear endpoint pool override.");
    } finally {
      setRpcPoolOverrideLoading(false);
    }
  };

  const applyAutoLockMinutes = async (minutes: number) => {
    setSessionPrefsLoading(true);
    try {
      await onAutoLockMinutesChange(minutes);
    } finally {
      setSessionPrefsLoading(false);
    }
  };

  const togglePersistUnlockSession = async () => {
    setSessionPrefsLoading(true);
    try {
      await onPersistUnlockSessionChange(!persistUnlockSessionEnabled);
    } finally {
      setSessionPrefsLoading(false);
    }
  };

  const applyNodePreset = async (preset: "managed_local" | "remote_official") => {
    setLocalNodeBusy(true);
    setLocalNodeError(null);
    try {
      if (preset === "managed_local") {
        await setLocalNodeNetworkProfile(activeNetworkProfile);
        setLocalNodeProfileState(activeNetworkProfile);
        await setLocalNodeDataDir(null);
        setLocalNodeDataDirState("");
        await setLocalNodeEnabled(true);
        setLocalNodeEnabledState(true);
        await setKaspaRpcProviderPreset(network, "local");
        setRpcPreset("local");
        if (!localNodeStatus?.running) {
          const response = await startLocalNode({
            networkProfile: activeNetworkProfile,
            dataDir: null,
          });
          applyLocalNodeSnapshot(response, {});
        }
      } else {
        await setLocalNodeEnabled(false);
        setLocalNodeEnabledState(false);
        await setKaspaRpcProviderPreset(network, "official");
        setRpcPreset("official");
      }
      invalidateRpcPoolRuntime();
      await refreshLocalNodeStatus({ includeLogs: localNodeShowLogs, includeMetrics: true });
    } catch (err) {
      setLocalNodeError(err instanceof Error ? err.message : "Failed to apply node preset.");
    } finally {
      setLocalNodeBusy(false);
    }
  };

  const applyRpcPreset = async (preset: KaspaRpcProviderPreset) => {
    setCustomRpcLoading(true);
    setCustomRpcError(null);
    setCustomRpcSaved(false);
    try {
      await setKaspaRpcProviderPreset(network, preset);
      if (preset === "local") {
        await setLocalNodeEnabled(true);
        setLocalNodeEnabledState(true);
      }
      setRpcPreset(preset);
      setCustomRpcSaved(true);
      invalidateRpcPoolRuntime();
    } catch {
      setCustomRpcError("Failed to save RPC provider preset.");
    } finally {
      setCustomRpcLoading(false);
    }
  };

  const saveCustomRpc = async () => {
    const candidate = customRpcInput.trim();
    if (!candidate) {
      setCustomRpcError("Enter a custom RPC endpoint first.");
      return;
    }
    setCustomRpcLoading(true);
    setCustomRpcError(null);
    setCustomRpcSaved(false);
    try {
      await ensureHostPermissionsForEndpoints([candidate]);
      await setCustomKaspaRpc(network, candidate);
      await setKaspaRpcProviderPreset(network, "custom");
      setRpcPreset("custom");
      setCustomRpcSaved(true);
      invalidateRpcPoolRuntime();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "INVALID_RPC_ENDPOINT") {
        setCustomRpcError("Invalid endpoint URL. Use http(s)://...");
      } else if (msg.startsWith("HOST_PERMISSION_DENIED:")) {
        setCustomRpcError("Browser denied host permission for selected endpoint. Allow permission to use this endpoint.");
      } else {
        setCustomRpcError("Failed to save custom RPC endpoint.");
      }
    } finally {
      setCustomRpcLoading(false);
    }
  };

  const clearCustomRpc = async () => {
    setCustomRpcLoading(true);
    setCustomRpcError(null);
    setCustomRpcSaved(false);
    try {
      await setCustomKaspaRpc(network, null);
      await setKaspaRpcProviderPreset(network, "official");
      setRpcPreset("official");
      setCustomRpcInput("");
      setCustomRpcSaved(true);
      invalidateRpcPoolRuntime();
    } catch {
      setCustomRpcError("Failed to clear custom RPC endpoint.");
    } finally {
      setCustomRpcLoading(false);
    }
  };

  const applyLocalNodeEnabled = async (enabled: boolean) => {
    setLocalNodeBusy(true);
    setLocalNodeError(null);
    try {
      let targetProfile = localNodeProfile;
      if (enabled && !localProfileMatchesActive) {
        targetProfile = activeNetworkProfile;
        await setLocalNodeNetworkProfile(targetProfile);
        setLocalNodeProfileState(targetProfile);
      }
      await setLocalNodeEnabled(enabled);
      setLocalNodeEnabledState(enabled);
      if (enabled) {
        await setKaspaRpcProviderPreset(network, "local");
        setRpcPreset("local");
        if (!localNodeStatus?.running) {
          const response = await startLocalNode({
            networkProfile: targetProfile,
            dataDir: localDataDirNormalized || null,
          });
          applyLocalNodeSnapshot(response, {});
        }
      } else if (rpcPreset === "local") {
        await setKaspaRpcProviderPreset(network, "official");
        setRpcPreset("official");
      }
      invalidateRpcPoolRuntime();
      await refreshLocalNodeStatus({ includeLogs: localNodeShowLogs, includeMetrics: true });
    } catch (err) {
      setLocalNodeError(err instanceof Error ? err.message : "Failed to update local node mode.");
    } finally {
      setLocalNodeBusy(false);
    }
  };

  const applyLocalNodeProfile = async (profile: LocalNodeNetworkProfile) => {
    setLocalNodeBusy(true);
    setLocalNodeError(null);
    try {
      await setLocalNodeNetworkProfile(profile);
      setLocalNodeProfileState(profile);
      invalidateRpcPoolRuntime();
      await refreshLocalNodeStatus({ includeLogs: false, includeMetrics: true });
    } catch (err) {
      setLocalNodeError(err instanceof Error ? err.message : "Failed to save local node profile.");
    } finally {
      setLocalNodeBusy(false);
    }
  };

  const saveLocalNodeDataDir = async (pathValue?: string | null) => {
    setLocalNodeBusy(true);
    setLocalNodeError(null);
    try {
      const normalized = pathValue !== undefined
        ? (typeof pathValue === "string" ? pathValue.trim() : null)
        : (localNodeDataDir.trim() || null);
      await setLocalNodeDataDir(normalized);
      if (!normalized) {
        setLocalNodeDataDirState("");
      }
      await refreshLocalNodeStatus({ includeLogs: false, includeMetrics: true });
    } catch (err) {
      setLocalNodeError(err instanceof Error ? err.message : "Failed to save local node data dir.");
    } finally {
      setLocalNodeBusy(false);
    }
  };

  const startManagedLocalNode = async () => {
    setLocalNodeBusy(true);
    setLocalNodeError(null);
    try {
      const response = await startLocalNode({
        networkProfile: localNodeProfile,
        dataDir: localNodeDataDir.trim() || null,
      });
      applyLocalNodeSnapshot(response, {});
      await setLocalNodeEnabled(true);
      await setKaspaRpcProviderPreset(network, "local");
      setLocalNodeEnabledState(true);
      setRpcPreset("local");
      invalidateRpcPoolRuntime();
      await refreshLocalNodeStatus({ includeLogs: localNodeShowLogs, includeMetrics: true });
    } catch (err) {
      setLocalNodeError(err instanceof Error ? err.message : "Failed to start local node.");
    } finally {
      setLocalNodeBusy(false);
    }
  };

  const stopManagedLocalNode = async () => {
    setLocalNodeBusy(true);
    setLocalNodeError(null);
    try {
      const response = await stopLocalNode();
      applyLocalNodeSnapshot(response, {});
      invalidateRpcPoolRuntime();
      await refreshLocalNodeStatus({ includeLogs: localNodeShowLogs, includeMetrics: true });
    } catch (err) {
      setLocalNodeError(err instanceof Error ? err.message : "Failed to stop local node.");
    } finally {
      setLocalNodeBusy(false);
    }
  };

  const restartManagedLocalNode = async () => {
    setLocalNodeBusy(true);
    setLocalNodeError(null);
    try {
      const response = await restartLocalNode({
        networkProfile: localNodeProfile,
        dataDir: localNodeDataDir.trim() || null,
      });
      applyLocalNodeSnapshot(response, {});
      invalidateRpcPoolRuntime();
      await refreshLocalNodeStatus({ includeLogs: localNodeShowLogs, includeMetrics: true });
    } catch (err) {
      setLocalNodeError(err instanceof Error ? err.message : "Failed to restart local node.");
    } finally {
      setLocalNodeBusy(false);
    }
  };

  const startOrApplyLocalNode = async () => {
    if (localNodeStatus?.running) {
      if (hasPendingRuntimeChanges) {
        await restartManagedLocalNode();
        return;
      }
      await refreshLocalNodeStatus({ includeLogs: localNodeShowLogs, includeMetrics: true });
      return;
    }
    await startManagedLocalNode();
  };

  return (
    <div style={popupTabStack}>

      {/* Connection status */}
      <div style={sectionCard("default")}>
        <div style={{ ...sectionKicker, marginBottom: 8 }}>CONNECTION STATUS</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <div style={{ fontSize: 8, color: C.dim, marginBottom: 3 }}>PROVIDER</div>
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: address ? C.ok : C.warn }} />
              <span style={{ fontSize: 9, color: C.text, fontWeight: 700 }}>{provider.toUpperCase()}</span>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 8, color: C.dim, marginBottom: 3 }}>NETWORK</div>
            <span style={{
              fontSize: 8, color: network === "mainnet" ? C.warn : C.ok, fontWeight: 700,
              background: network === "mainnet" ? `${C.warn}15` : `${C.ok}15`,
              border: `1px solid ${network === "mainnet" ? C.warn : C.ok}30`,
              borderRadius: 3, padding: "2px 6px",
            }}>{network.toUpperCase()}</span>
          </div>
          {address && (
            <div style={{ gridColumn: "1 / -1" }}>
              <div style={{ fontSize: 8, color: C.dim, marginBottom: 3 }}>ADDRESS</div>
              <div style={{ ...insetCard(), fontSize: 8, color: C.text, padding: "7px 9px" }}>{shortAddr(address)}</div>
            </div>
          )}
        </div>
      </div>

      <div style={sectionCard("default")}>
        <div style={{ ...sectionKicker, marginBottom: 8 }}>KASPA RPC ENDPOINT</div>
        <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.5, marginBottom: 6 }}>
          Active network: <span style={{ color: C.text, fontWeight: 700 }}>{providerDescriptor.network.toUpperCase()}</span>
        </div>
        <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.5, marginBottom: 7 }}>
          Provider preset: <span style={{ color: C.text, fontWeight: 700 }}>{rpcPresetLabels[rpcPreset]}</span> · Pool size:{" "}
          <span style={{ color: C.text, fontWeight: 700 }}>{providerDescriptor.effectivePool.length}</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {(Object.keys(rpcPresetLabels) as KaspaRpcProviderPreset[]).map((preset) => {
            const active = rpcPreset === preset;
            return (
              <button
                key={preset}
                onClick={() => { void applyRpcPreset(preset); }}
                disabled={customRpcLoading}
                style={{
                  ...outlineButton(active ? C.accent : C.dim, true),
                  padding: "6px 8px",
                  fontSize: 8,
                  color: active ? C.accent : C.dim,
                  opacity: customRpcLoading ? 0.7 : 1,
                }}
              >
                {rpcPresetLabels[preset]}
              </button>
            );
          })}
        </div>
        <div style={{ ...insetCard(), marginBottom: 8, display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.45 }}>
            RPC pool runs in background. Endpoint links are hidden in UI.
          </div>
          <div style={{ fontSize: 8, color: C.text, lineHeight: 1.4 }}>
            Active pool size: <span style={{ fontWeight: 700 }}>{providerDescriptor.effectivePool.length}</span>
          </div>
          {providerDescriptor.usesOfficialFallback && (
            <div style={{ fontSize: 8, color: C.warn, lineHeight: 1.45 }}>
              {rpcPreset === "custom"
                ? "Custom endpoint not set; currently falling back to official pool."
                : `${rpcPresetLabels[rpcPreset]} preset pool is empty; currently falling back to official pool.`}
            </div>
          )}
          {providerDescriptor.requiredEnvKeys.length > 0 && (
            <div style={{ fontSize: 7, color: C.dim, lineHeight: 1.45 }}>
              Env override keys: {providerDescriptor.requiredEnvKeys.join(", ")}
            </div>
          )}
        </div>
        <input
          value={customRpcInput}
          onChange={(e) => {
            setCustomRpcInput(e.target.value);
            setCustomRpcSaved(false);
            setCustomRpcError(null);
          }}
          placeholder="Enter custom RPC endpoint"
          disabled={customRpcLoading}
          style={{ ...inputStyle(Boolean(customRpcError)), marginBottom: 7 }}
        />
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() => { void saveCustomRpc(); }}
            disabled={customRpcLoading || !customRpcInput.trim()}
            style={{
              ...outlineButton(C.accent, true),
              flex: 1,
              padding: "7px 8px",
              color: C.accent,
              opacity: customRpcLoading ? 0.7 : 1,
            }}
          >
            {customRpcLoading ? "SAVING…" : "SAVE & USE CUSTOM"}
          </button>
          <button
            onClick={() => { void clearCustomRpc(); }}
            disabled={customRpcLoading}
            style={{
              ...outlineButton(C.dim, true),
              flex: 1,
              padding: "7px 8px",
              color: C.dim,
              opacity: customRpcLoading ? 0.7 : 1,
            }}
          >
            CLEAR
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <button
            onClick={() => { void runProviderProbe(); }}
            disabled={providerProbeBusy}
            style={{
              ...outlineButton(C.ok, true),
              flex: 1,
              padding: "7px 8px",
              color: C.ok,
              opacity: providerProbeBusy ? 0.7 : 1,
            }}
          >
            {providerProbeBusy ? "PROBING…" : "TEST LIVE FEED"}
          </button>
        </div>
        {editablePoolPreset && (
          <div style={{ ...insetCard(), marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.45 }}>
              Editable preset pool override ({rpcPresetLabels[editablePoolPreset]}) · one endpoint per line.
            </div>
            <textarea
              value={rpcPoolOverrideInput}
              onChange={(event) => {
                setRpcPoolOverrideInput(event.target.value);
                setRpcPoolOverrideSaved(false);
                setRpcPoolOverrideError(null);
              }}
              rows={3}
              placeholder="rpc-endpoint-a\nrpc-endpoint-b"
              disabled={rpcPoolOverrideLoading}
              style={{
                ...inputStyle(Boolean(rpcPoolOverrideError)),
                minHeight: 68,
                resize: "vertical",
                marginBottom: 0,
              }}
            />
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => { void saveRpcPoolOverride(); }}
                disabled={rpcPoolOverrideLoading}
                style={{
                  ...outlineButton(C.accent, true),
                  flex: 1,
                  padding: "7px 8px",
                  color: C.accent,
                  opacity: rpcPoolOverrideLoading ? 0.7 : 1,
                }}
              >
                {rpcPoolOverrideLoading ? "SAVING…" : "SAVE POOL OVERRIDE"}
              </button>
              <button
                onClick={() => { void clearRpcPoolOverride(); }}
                disabled={rpcPoolOverrideLoading}
                style={{
                  ...outlineButton(C.dim, true),
                  flex: 1,
                  padding: "7px 8px",
                  color: C.dim,
                  opacity: rpcPoolOverrideLoading ? 0.7 : 1,
                }}
              >
                CLEAR OVERRIDE
              </button>
            </div>
            {rpcPoolOverrideError && (
              <div style={{ fontSize: 8, color: C.danger, lineHeight: 1.45 }}>{rpcPoolOverrideError}</div>
            )}
            {!rpcPoolOverrideError && rpcPoolOverrideSaved && (
              <div style={{ fontSize: 8, color: C.ok, lineHeight: 1.45 }}>Preset pool override saved.</div>
            )}
          </div>
        )}
        {customRpcError && (
          <div style={{ fontSize: 8, color: C.danger, marginTop: 6 }}>{customRpcError}</div>
        )}
        {!customRpcError && customRpcSaved && (
          <div style={{ fontSize: 8, color: C.ok, marginTop: 6 }}>Saved RPC settings for this network.</div>
        )}
        {providerProbeError && (
          <div style={{ fontSize: 8, color: C.danger, marginTop: 6 }}>{providerProbeError}</div>
        )}
        {providerProbeAt && !providerProbeError && (
          <div style={{ fontSize: 8, color: C.dim, marginTop: 6 }}>
            Last provider probe: {relativeSeconds(providerProbeAt)}
          </div>
        )}
        {providerProbeRows.length > 0 && (
          <div style={{ ...insetCard(), marginTop: 6, display: "flex", flexDirection: "column", gap: 5 }}>
            {providerProbeRows.slice(0, 4).map((row, index) => (
              <div key={row.base} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center" }}>
                <div style={{ fontSize: 8, color: C.text, lineHeight: 1.35 }}>Endpoint #{index + 1}</div>
                <div style={{ fontSize: 7, color: row.circuit === "open" ? C.danger : C.ok }}>
                  {row.circuit.toUpperCase()} · {row.lastLatencyMs ? `${Math.round(row.lastLatencyMs)}ms` : "n/a"}
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ ...insetCard(), marginTop: 8, display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontSize: 8, color: C.dim, letterSpacing: "0.08em" }}>LOCAL NODE MODE (DEFI)</div>
            <div style={{
              fontSize: 7,
              color: localNodeStreamConnected ? C.ok : C.warn,
              border: `1px solid ${localNodeStreamConnected ? `${C.ok}45` : `${C.warn}45`}`,
              borderRadius: 4,
              padding: "2px 5px",
              letterSpacing: "0.06em",
            }}>
              {localNodeStreamConnected ? "LIVE FEED" : "BACKUP POLL"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <div style={{
              fontSize: 7,
              color: localNodeStatus?.running ? C.ok : C.dim,
              border: `1px solid ${localNodeStatus?.running ? `${C.ok}45` : C.border}`,
              borderRadius: 4,
              padding: "2px 5px",
              letterSpacing: "0.06em",
            }}>
              LOCAL NODE {localNodeStatus?.running ? "ON" : "OFF"}
            </div>
            <div style={{
              fontSize: 7,
              color: localNodeStatus?.rpcHealthy ? C.ok : C.warn,
              border: `1px solid ${localNodeStatus?.rpcHealthy ? `${C.ok}45` : `${C.warn}45`}`,
              borderRadius: 4,
              padding: "2px 5px",
              letterSpacing: "0.06em",
            }}>
              TRADE RPC {localNodeStatus?.rpcHealthy ? "LIVE" : "CHECKING"}
            </div>
            <div style={{
              fontSize: 7,
              color: localConnectionState === "healthy" ? C.ok : (localConnectionState === "degraded" ? C.danger : C.dim),
              border: `1px solid ${localConnectionState === "healthy" ? `${C.ok}45` : (localConnectionState === "degraded" ? `${C.danger}55` : C.border)}`,
              borderRadius: 4,
              padding: "2px 5px",
              letterSpacing: "0.06em",
            }}>
              STATE {localConnectionState.toUpperCase()}
            </div>
            <button
              onClick={() => openLocalNodePath("/node/status")}
              style={{
                ...outlineButton(C.dim, true),
                padding: "2px 6px",
                fontSize: 7,
                color: C.dim,
                letterSpacing: "0.06em",
              }}
            >
              OPEN STATUS
            </button>
            <button
              onClick={() => openLocalNodePath("/metrics")}
              style={{
                ...outlineButton(C.dim, true),
                padding: "2px 6px",
                fontSize: 7,
                color: C.dim,
                letterSpacing: "0.06em",
              }}
            >
              OPEN METRICS
            </button>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              onClick={() => { void applyNodePreset("managed_local"); }}
              disabled={localNodeBusy}
              style={{
                ...outlineButton(C.accent, true),
                padding: "6px 8px",
                fontSize: 8,
                color: C.accent,
                opacity: localNodeBusy ? 0.7 : 1,
              }}
            >
              DEFI PRESET: LOCAL-FIRST
            </button>
            <button
              onClick={() => { void applyNodePreset("remote_official"); }}
              disabled={localNodeBusy}
              style={{
                ...outlineButton(C.dim, true),
                padding: "6px 8px",
                fontSize: 8,
                color: C.dim,
                opacity: localNodeBusy ? 0.7 : 1,
              }}
            >
              DEFI PRESET: REMOTE-FIRST
            </button>
          </div>
          {!localNodeStatus && (
            <div style={{ fontSize: 8, color: C.warn, lineHeight: 1.45 }}>
              Local node helper is offline. Run <span style={{ ...mono, color: C.text }}>npm run local-node:start</span> for self-hosted DeFi execution.
            </div>
          )}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              onClick={() => { void applyLocalNodeEnabled(!localNodeEnabled); }}
              disabled={localNodeBusy}
              style={{
                ...outlineButton(localNodeEnabled ? C.ok : C.dim, true),
                padding: "6px 8px",
                fontSize: 8,
                color: localNodeEnabled ? C.ok : C.dim,
                opacity: localNodeBusy ? 0.7 : 1,
              }}
            >
              {localNodeEnabled ? "LOCAL-FIRST ON" : "LOCAL-FIRST OFF"}
            </button>
            <button
              onClick={() => { void applyLocalNodeProfile(activeNetworkProfile); }}
              disabled={localNodeBusy || localNodeProfile === activeNetworkProfile}
              style={{
                ...outlineButton(localNodeProfile === activeNetworkProfile ? C.ok : C.accent, true),
                padding: "6px 8px",
                fontSize: 8,
                color: localNodeProfile === activeNetworkProfile ? C.ok : C.accent,
                opacity: localNodeBusy ? 0.7 : 1,
              }}
            >
              MATCH ACTIVE ({profileLabel(activeNetworkProfile)})
            </button>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {LOCAL_NODE_PROFILES.map((profile) => (
              <button
                key={profile}
                onClick={() => { void applyLocalNodeProfile(profile); }}
                disabled={localNodeBusy}
                style={{
                  ...outlineButton(localNodeProfile === profile ? C.accent : C.dim, true),
                  padding: "6px 8px",
                  fontSize: 8,
                  color: localNodeProfile === profile ? C.accent : C.dim,
                  opacity: localNodeBusy ? 0.7 : 1,
                }}
              >
                {profileLabel(profile)}
              </button>
            ))}
          </div>
          {!localProfileMatchesActive && (
            <div style={{ fontSize: 8, color: C.warn, lineHeight: 1.45 }}>
              Profile mismatch: local {profileLabel(localNodeProfile)} vs active {profileLabel(activeNetworkProfile)}. Remote RPC fallback stays active until they match.
            </div>
          )}
          <input
            value={localNodeDataDir}
            onChange={(event) => setLocalNodeDataDirState(event.target.value)}
            placeholder="Optional custom data root (leave empty for managed default)"
            disabled={localNodeBusy}
            style={{ ...inputStyle(Boolean(localNodeError)), marginBottom: 0 }}
          />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              onClick={() => { void saveLocalNodeDataDir(); }}
              disabled={localNodeBusy}
              style={{
                ...outlineButton(C.accent, true),
                flex: 1,
                minWidth: 86,
                padding: "7px 8px",
                color: C.accent,
                opacity: localNodeBusy ? 0.7 : 1,
              }}
            >
              SAVE DIR
            </button>
            <button
              onClick={() => { void saveLocalNodeDataDir(null); }}
              disabled={localNodeBusy}
              style={{
                ...outlineButton(C.dim, true),
                minWidth: 120,
                padding: "7px 8px",
                color: C.dim,
                opacity: localNodeBusy ? 0.7 : 1,
              }}
            >
              USE MANAGED DIR
            </button>
            <button
              onClick={() => { void startOrApplyLocalNode(); }}
              disabled={localNodeBusy}
              style={{
                ...outlineButton(
                  localNodeStatus?.running
                    ? (hasPendingRuntimeChanges ? C.warn : C.ok)
                    : C.ok,
                  true,
                ),
                flex: 1,
                minWidth: 120,
                padding: "7px 8px",
                color: localNodeStatus?.running
                  ? (hasPendingRuntimeChanges ? C.warn : C.ok)
                  : C.ok,
                opacity: localNodeBusy ? 0.7 : 1,
              }}
            >
              {!localNodeStatus?.running
                ? "START"
                : hasPendingRuntimeChanges
                  ? "APPLY & RESTART"
                  : "RUNNING"}
            </button>
            <button
              onClick={() => { void restartManagedLocalNode(); }}
              disabled={localNodeBusy || !localNodeStatus?.running}
              style={{
                ...outlineButton(C.warn, true),
                flex: 1,
                minWidth: 86,
                padding: "7px 8px",
                color: C.warn,
                opacity: localNodeBusy || !localNodeStatus?.running ? 0.7 : 1,
              }}
            >
              RESTART
            </button>
            <button
              onClick={() => { void stopManagedLocalNode(); }}
              disabled={localNodeBusy || !localNodeStatus?.running}
              style={{
                ...outlineButton(C.danger, true),
                flex: 1,
                minWidth: 72,
                padding: "7px 8px",
                color: C.danger,
                opacity: localNodeBusy || !localNodeStatus?.running ? 0.7 : 1,
              }}
            >
              STOP
            </button>
            <button
              onClick={() => { void refreshLocalNodeStatus({ includeLogs: localNodeShowLogs, includeMetrics: true }); }}
              disabled={localNodeBusy}
              style={{
                ...outlineButton(C.dim, true),
                minWidth: 82,
                padding: "7px 8px",
                color: C.dim,
                opacity: localNodeBusy ? 0.7 : 1,
              }}
            >
              REFRESH
            </button>
            <button
              onClick={() => setLocalNodeShowLogs((prev) => !prev)}
              disabled={localNodeBusy}
              style={{
                ...outlineButton(localNodeShowLogs ? C.accent : C.dim, true),
                minWidth: 92,
                padding: "7px 8px",
                color: localNodeShowLogs ? C.accent : C.dim,
                opacity: localNodeBusy ? 0.7 : 1,
              }}
            >
              {localNodeShowLogs ? "HIDE LOGS" : "SHOW LOGS"}
            </button>
          </div>
          <div style={{ fontSize: 8, color: localNodeStatus?.rpcHealthy ? C.ok : C.dim, lineHeight: 1.45 }}>
            Engine: {localNodeStatus?.running ? "running" : "stopped"} · RPC: {localNodeStatus?.rpcHealthy ? "live" : "fallback"} · Sync:{" "}
            {localSyncProgressPct != null ? `${fmt(localSyncProgressPct, 2)}%` : "—"} · Updated {relativeSeconds(localNodeLastUpdatedAt)}
          </div>
          <div style={{ ...insetCard(), height: 8, padding: 0, overflow: "hidden" }}>
            <div
              style={{
                width: `${Math.max(0, Math.min(100, localSyncProgressPct ?? 0))}%`,
                height: "100%",
                background: localNodeStatus?.sync?.synced
                  ? `linear-gradient(90deg, ${C.ok}, #6DD6A7)`
                  : `linear-gradient(90deg, ${C.accent}, #7BE9CF)`,
                transition: "width 200ms ease",
              }}
            />
          </div>
          <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.45, wordBreak: "break-all" }}>
            Storage: {localNodeStatus?.dataDirOverride ? "CUSTOM PATH" : "MANAGED DEFAULT"} · Root: {localNodeStatus?.dataDirBase || "—"}
          </div>
          <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.45, wordBreak: "break-all" }}>
            Profile dir: {localNodeStatus?.dataDir || "—"}
          </div>
          <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.45 }}>
            Active route: {(localNodeBackend?.source || "remote").toUpperCase()} · {LOCAL_NODE_REASON_LABELS[localNodeBackend?.reason || ""] || (localNodeBackend?.reason || "No status reason")}
          </div>
          {localNodeMetrics && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6 }}>
              <div style={{ ...insetCard(), padding: "6px 7px" }}>
                <div style={{ fontSize: 7, color: C.dim }}>REQ</div>
                <div style={{ fontSize: 9, color: C.text, fontWeight: 700 }}>{localNodeMetrics.control.requestsTotal}</div>
              </div>
              <div style={{ ...insetCard(), padding: "6px 7px" }}>
                <div style={{ fontSize: 7, color: C.dim }}>EVENTS</div>
                <div style={{ fontSize: 9, color: C.text, fontWeight: 700 }}>{localNodeMetrics.control.eventsEmittedTotal}</div>
              </div>
              <div style={{ ...insetCard(), padding: "6px 7px" }}>
                <div style={{ fontSize: 7, color: C.dim }}>UPTIME</div>
                <div style={{ fontSize: 9, color: C.text, fontWeight: 700 }}>{localNodeMetrics.uptimeSec}s</div>
              </div>
              <div style={{ ...insetCard(), padding: "6px 7px" }}>
                <div style={{ fontSize: 7, color: C.dim }}>RESTARTS</div>
                <div style={{ fontSize: 9, color: C.warn, fontWeight: 700 }}>{localNodeMetrics.node.restartsTotal}</div>
              </div>
            </div>
          )}
          {localNodeStatus?.rpcBaseUrl && (
            <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.45, wordBreak: "break-all" }}>
              RPC Endpoint: {localNodeStatus.rpcBaseUrl}
            </div>
          )}
          {localNodeStatus?.error && (
            <div style={{ fontSize: 8, color: C.danger, lineHeight: 1.45 }}>{localNodeStatus.error}</div>
          )}
          {localNodeError && (
            <div style={{ fontSize: 8, color: C.danger, lineHeight: 1.45 }}>{localNodeError}</div>
          )}
          {localNodeShowLogs && (
            <div style={{ ...insetCard(), fontSize: 7, color: C.muted, whiteSpace: "pre-wrap", lineHeight: 1.4, maxHeight: 96, overflowY: "auto" }}>
              {localNodeLogs || "No recent logs available yet."}
            </div>
          )}
        </div>
        <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.5, marginTop: 6 }}>
          Presets are saved per network. Local-first mode uses your control service (`VITE_LOCAL_NODE_CONTROL_URL`) and auto-falls back to remote RPC when local health is degraded.
        </div>
      </div>

      {isManagedWallet && (
        <div style={sectionCard("default")}>
          <div style={{ ...sectionKicker, marginBottom: 8 }}>SESSION SETTINGS</div>

          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 8, color: C.dim, marginBottom: 5, letterSpacing: "0.08em" }}>AUTO-LOCK</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {autoLockOptions.map((opt) => (
                <button
                  key={opt.value}
                  disabled={sessionPrefsLoading}
                  onClick={() => { void applyAutoLockMinutes(opt.value); }}
                  style={{
                    ...outlineButton(autoLockMinutes === opt.value ? C.accent : C.dim, true),
                    padding: "6px 8px",
                    fontSize: 8,
                    color: autoLockMinutes === opt.value ? C.accent : C.dim,
                    opacity: sessionPrefsLoading ? 0.7 : 1,
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={() => { void togglePersistUnlockSession(); }}
            disabled={sessionPrefsLoading}
            style={{
              ...outlineButton(persistUnlockSessionEnabled ? C.ok : C.dim, true),
              width: "100%",
              padding: "8px 10px",
              color: persistUnlockSessionEnabled ? C.ok : C.dim,
              textAlign: "left",
              opacity: sessionPrefsLoading ? 0.7 : 1,
            }}
          >
            {persistUnlockSessionEnabled
              ? "✓ KEEP UNLOCKED WHEN POPUP CLOSES"
              : "KEEP UNLOCKED WHEN POPUP CLOSES"}
          </button>

          <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.5, marginTop: 6 }}>
            Stores unlocked session in browser session memory only; lock manually on shared devices.
          </div>

        </div>
      )}

      {/* Managed wallet actions */}
      {isManagedWallet && (
        <>
          {/* Action button row */}
          {panel === "none" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <button onClick={() => setPanel("reveal")} style={actionBtn(C.accent)}>
                🔑 REVEAL SEED PHRASE
              </button>
              <button onClick={() => setPanel("change_pw")} style={actionBtn(C.dim)}>
                🔐 CHANGE PASSWORD
              </button>
              <button onClick={() => setPanel("reset")} style={actionBtn(C.danger)}>
                ⚠ RESET WALLET
              </button>
            </div>
          )}

          {/* ── REVEAL PHRASE PANEL ───────────────────────────────────────── */}
          {panel === "reveal" && (
            <div style={{ ...sectionCard("warn") }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ ...sectionTitle, color: C.warn }}>SEED PHRASE</span>
                <button onClick={handleHidePhrase} style={{ background: "none", border: "none", color: C.dim, fontSize: 8, cursor: "pointer", ...mono }}>✕ close</button>
              </div>

              {revealWords.length === 0 ? (
                <form onSubmit={handleReveal}>
                  <div style={{ fontSize: 8, color: C.dim, marginBottom: 6, lineHeight: 1.5 }}>
                    Enter your password to view your seed phrase.
                    Never share it — anyone with this phrase controls your wallet.
                  </div>
                  <input
                    type="password"
                    value={revealPw}
                    onChange={e => setRevealPw(e.target.value)}
                    placeholder="Your password"
                    disabled={revealLoading}
                    style={{ ...inputStyle(Boolean(revealErr)), marginBottom: 6 }}
                  />
                  {revealErr && <div style={{ fontSize: 8, color: C.danger, marginBottom: 6 }}>{revealErr}</div>}
                  <button
                    type="submit"
                    disabled={!revealPw || revealLoading}
                    style={{
                      ...outlineButton(revealPw && !revealLoading ? C.warn : C.dim, true),
                      width: "100%",
                      padding: "7px 0",
                      color: revealPw && !revealLoading ? C.warn : C.dim,
                      cursor: revealPw && !revealLoading ? "pointer" : "not-allowed",
                    }}
                  >{revealLoading ? "AUTHENTICATING…" : "SHOW SEED PHRASE"}</button>
                </form>
              ) : (
                <>
                  <div style={{ ...insetCard(), display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, marginBottom: 8 }}>
                    {revealWords.map((word, i) => (
                      <div key={i} style={{
                        background: "rgba(5,7,10,0.9)", border: `1px solid ${C.border}`,
                        borderRadius: 4, padding: "5px 4px",
                        display: "flex", alignItems: "center", gap: 3,
                      }}>
                        <span style={{ fontSize: 8, color: C.dim, flexShrink: 0 }}>{i + 1}.</span>
                        <span style={{ fontSize: 8, color: C.text, fontWeight: 600 }}>{word}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 8, color: C.warn, lineHeight: 1.4 }}>
                    ⚠ Store offline. Never photograph or share digitally.
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── CHANGE PASSWORD PANEL ─────────────────────────────────────── */}
          {panel === "change_pw" && (
            <div style={sectionCard("default")}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={sectionTitle}>CHANGE PASSWORD</span>
                <button onClick={closePanel} style={{ background: "none", border: "none", color: C.dim, fontSize: 8, cursor: "pointer", ...mono }}>✕ close</button>
              </div>

              {changePwOk ? (
                <div style={{ fontSize: 8, color: C.ok, textAlign: "center", padding: "8px 0" }}>
                  ✓ Password updated successfully.
                </div>
              ) : (
                <form onSubmit={handleChangePassword} style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  <input type="password" value={oldPw} onChange={e => setOldPw(e.target.value)}
                    placeholder="Current password" disabled={changePwLoading} style={inputStyle()} />
                  <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)}
                    placeholder="New password (min 8 chars)" disabled={changePwLoading} style={inputStyle()} />
                  <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
                    placeholder="Confirm new password" disabled={changePwLoading} style={inputStyle()} />
                  {changePwErr && <div style={{ fontSize: 8, color: C.danger }}>{changePwErr}</div>}
                  <button
                    type="submit"
                    disabled={!oldPw || !newPw || !confirmPw || changePwLoading}
                    style={{
                      ...primaryButton(oldPw && newPw && confirmPw && !changePwLoading),
                      padding: "8px 0",
                      cursor: oldPw && newPw && confirmPw && !changePwLoading ? "pointer" : "not-allowed",
                    }}
                  >{changePwLoading ? "RE-ENCRYPTING…" : "UPDATE PASSWORD"}</button>
                </form>
              )}
            </div>
          )}

          {/* ── RESET WALLET PANEL ────────────────────────────────────────── */}
          {panel === "reset" && (
            <div style={{ ...sectionCard("danger"), backgroundColor: C.dLow }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ ...sectionTitle, color: C.danger }}>⚠ RESET WALLET</span>
                <button onClick={closePanel} style={{ background: "none", border: "none", color: C.dim, fontSize: 8, cursor: "pointer", ...mono }}>✕ cancel</button>
              </div>
              <div style={{ fontSize: 8, color: C.dim, lineHeight: 1.5, marginBottom: 10 }}>
                This will permanently delete your encrypted vault from this extension.
                Your on-chain funds are NOT affected. You can re-import using your seed phrase.
                <strong style={{ color: C.warn }}> Make sure your seed phrase is backed up before proceeding.</strong>
              </div>
              <button
                onClick={handleReset}
                style={{
                  ...outlineButton(C.danger, true),
                  width: "100%", padding: "8px 0",
                  background: resetConfirm ? C.danger : "rgba(49,21,32,0.65)",
                  border: `1px solid ${C.danger}${resetConfirm ? "90" : "50"}`,
                  color: resetConfirm ? "#fff" : C.danger,
                }}
              >{resetConfirm ? "⚠ CONFIRM — PERMANENTLY DELETE VAULT" : "RESET WALLET"}</button>
              {resetConfirm && (
                <div style={{ fontSize: 8, color: C.danger, marginTop: 5, textAlign: "center" }}>
                  This cannot be undone. Your seed phrase is your only recovery option.
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Security notes */}
      <div style={{ ...insetCard(), padding: "10px 12px" }}>
        <div style={{ ...sectionKicker, marginBottom: 6 }}>SECURITY NOTES</div>
        {[
          "Seed phrase encrypted with AES-256-GCM before storage.",
          "Password derived with Argon2id (legacy PBKDF2 vaults migrate on unlock).",
          "Plaintext secrets never touch chrome.storage.",
          "All signing happens locally — nothing is transmitted to servers.",
        ].map((note, i, arr) => (
          <div key={i} style={{ display: "flex", gap: 6, marginBottom: i < arr.length - 1 ? 4 : 0 }}>
            <span style={{ color: C.ok, fontSize: 8, flexShrink: 0 }}>✓</span>
            <span style={{ fontSize: 8, color: C.dim, lineHeight: 1.5 }}>{note}</span>
          </div>
        ))}
      </div>

      {/* Lock wallet — shortcut (also in header) */}
      {isManagedWallet && panel === "none" && (
        <button
          onClick={onLock}
          style={{
            ...outlineButton(C.dim, true),
            padding: "8px 0",
          }}
        >🔒 LOCK WALLET</button>
      )}
    </div>
  );
}

// ── Style helpers ─────────────────────────────────────────────────────────────
function actionBtn(color: string): React.CSSProperties {
  return {
    ...outlineButton(color, true),
    padding: "10px 12px",
    color,
    textAlign: "left" as const, letterSpacing: "0.08em",
  };
}
