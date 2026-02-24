import { normalizeKaspaAddress } from "../helpers";
import { ALLOWED_ADDRESS_PREFIXES, DEFAULT_NETWORK } from "../constants";
import { kasBalance } from "../api/kaspaApi";

/**
 * Agent Deposit Address Management
 * 
 * Manages the mapping between connected wallet addresses and agent deposit addresses.
 * The agent deposit address is where user deposits (principal) should be sent.
 */

// Storage key for agent deposit mappings
const AGENT_DEPOSIT_KEY = "forgeos.agent_deposits";

type AgentDepositEntry = {
  walletAddress: string;
  agentDepositAddress: string;
  createdAt: number;
  network: string;
};

function getStoredMappings(): Record<string, AgentDepositEntry> {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(AGENT_DEPOSIT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, AgentDepositEntry>;
  } catch {
    return {};
  }
}

function saveMapping(entry: AgentDepositEntry): void {
  try {
    if (typeof window === "undefined") return;
    const mappings = getStoredMappings();
    mappings[entry.walletAddress.toLowerCase()] = entry;
    window.localStorage.setItem(AGENT_DEPOSIT_KEY, JSON.stringify(mappings));
  } catch {
    // Ignore storage failures
  }
}

/**
 * Derives a deterministic agent deposit address from a wallet address.
 * This creates a unique but deterministic address for each wallet.
 * 
 * For production, this should call a backend API:
 * GET /api/agent/deposit-address?wallet=<connectedAddress>
 * 
 * For now, we derive a deterministic address using a simple transformation.
 * The derived address format: kaspa:qz<wallet.slice(6, 36)...> for deterministic mapping
 */
function deriveAgentDepositAddress(walletAddress: string): string {
  // Normalize the input address
  const normalized = normalizeKaspaAddress(walletAddress, ALLOWED_ADDRESS_PREFIXES);
  
  // For now, use a simple derivation - in production this should come from backend
  // This creates a deterministic mapping based on the wallet address
  const cleanAddr = normalized.replace(/^kaspa:/, "").replace(/^kaspatest:/, "");
  
  // Create a deterministic but different address (use first 20 chars of hash-like transformation)
  // In production, this should be replaced with actual API call
  const prefix = DEFAULT_NETWORK.startsWith("testnet") ? "kaspatest:" : "kaspa:";
  
  // For deterministic derivation, we'll use a simple transformation
  // In a real implementation, this would be fetched from backend
  // Using a placeholder that represents "agent's deposit address"
  // The key insight: this should be an address the agent controls
  const derived = `${prefix}qz${cleanAddr.slice(1, 32)}${cleanAddr.slice(0, 1)}`;
  
  try {
    return normalizeKaspaAddress(derived, ALLOWED_ADDRESS_PREFIXES);
  } catch {
    // Fallback: return treasury as last resort (but log warning)
    console.warn("[AgentDeposit] Could not derive agent address, using fallback");
    return normalized;
  }
}

/**
 * Gets the agent deposit address for a given wallet.
 * Returns the address from backend API if available, otherwise returns empty string
 * so the caller falls back to ACCUMULATION_VAULT.
 *
 * NOTE: The local derivation logic was removed because it produced invalid Kaspa
 * bech32 addresses, causing self-sends. A real agent deposit address requires the
 * backend API (VITE_API_URL + /api/agent/deposit-address). Until that is configured,
 * all accumulate transactions correctly go to ACCUMULATION_VAULT.
 */
export function getAgentDepositAddress(_walletAddress: string): string {
  // Returns empty string — caller uses `agentDepositAddr || ACCUMULATION_VAULT`
  return "";
}

/**
 * Clears the agent deposit mapping for a wallet (on disconnect)
 */
export function clearAgentDepositMapping(walletAddress: string): void {
  try {
    if (typeof window === "undefined") return;
    const mappings = getStoredMappings();
    delete mappings[walletAddress.toLowerCase()];
    window.localStorage.setItem(AGENT_DEPOSIT_KEY, JSON.stringify(mappings));
  } catch {
    // Ignore storage failures
  }
}

/**
 * Gets all stored agent deposit mappings (for debugging/display)
 */
export function getAllAgentDepositMappings(): AgentDepositEntry[] {
  return Object.values(getStoredMappings());
}

/**
 * Fetches agent deposit address from backend API (production version)
 * This should be used when backend API is available
 */
export async function fetchAgentDepositAddressFromApi(walletAddress: string): Promise<string | null> {
  try {
    const baseUrl = import.meta.env.VITE_API_URL || "";
    if (!baseUrl) return null;
    
    const response = await fetch(`${baseUrl}/api/agent/deposit-address?wallet=${encodeURIComponent(walletAddress)}`);
    if (!response.ok) return null;
    
    const data = await response.json();
    if (data?.address) {
      return normalizeKaspaAddress(data.address, ALLOWED_ADDRESS_PREFIXES);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetches the balance at the agent deposit address
 * @returns The balance in KAS, or 0 if fetch fails
 */
export async function fetchAgentDepositBalance(agentDepositAddress: string): Promise<number> {
  if (!agentDepositAddress) return 0;
  
  try {
    const balance = await kasBalance(agentDepositAddress);
    return Number(balance.kas) || 0;
  } catch (error) {
    console.warn("[AgentDeposit] Failed to fetch agent deposit balance:", error);
    return 0;
  }
}

