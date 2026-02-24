import { makeForgeError } from "./errorTaxonomy";

export type AgentLifecycleState = "OFF" | "RUNNING" | "PAUSED" | "SUSPENDED" | "ERROR";
export type AgentLifecycleEvent =
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "START" }
  | { type: "KILL" }
  | { type: "FAIL"; reason?: string }
  | { type: "RESET_ERROR" };

export type QueueTxLifecycleState = "pending" | "signing" | "signed" | "rejected" | "failed";
export type QueueTxLifecycleEvent =
  | { type: "BEGIN_SIGN" }
  | { type: "SIGN_SUCCESS"; txid?: string }
  | { type: "SIGN_REJECT" }
  | { type: "FAIL"; reason?: string }
  | { type: "REQUEUE" };

export type QueueTxReceiptLifecycleState =
  | "submitted"
  | "broadcasted"
  | "pending_confirm"
  | "confirmed"
  | "failed"
  | "timeout";

export type QueueTxReceiptLifecycleEvent =
  | { type: "BROADCASTED" }
  | { type: "POLL_PENDING" }
  | { type: "CONFIRMED" }
  | { type: "FAILED" }
  | { type: "TIMEOUT" }
  | { type: "RESET" };

export function transitionAgentLifecycle(state: AgentLifecycleState, event: AgentLifecycleEvent): AgentLifecycleState {
  switch (state) {
    case "OFF":
      if (event.type === "START") return "RUNNING";
      return state;
    case "RUNNING":
      if (event.type === "PAUSE") return "PAUSED";
      if (event.type === "KILL") return "SUSPENDED";
      if (event.type === "FAIL") return "ERROR";
      return state;
    case "PAUSED":
      if (event.type === "RESUME") return "RUNNING";
      if (event.type === "KILL") return "SUSPENDED";
      if (event.type === "FAIL") return "ERROR";
      return state;
    case "SUSPENDED":
      if (event.type === "RESUME") return "RUNNING";
      return state;
    case "ERROR":
      if (event.type === "RESET_ERROR" || event.type === "RESUME") return "RUNNING";
      if (event.type === "KILL") return "SUSPENDED";
      return state;
    default:
      throw makeForgeError({
        domain: "lifecycle",
        code: "LIFECYCLE_INVALID_TRANSITION",
        message: `Unknown agent state: ${String(state)}`,
      });
  }
}

export function transitionQueueTxLifecycle(
  state: QueueTxLifecycleState,
  event: QueueTxLifecycleEvent
): QueueTxLifecycleState {
  switch (state) {
    case "pending":
      if (event.type === "BEGIN_SIGN") return "signing";
      if (event.type === "SIGN_SUCCESS") return "signed";
      if (event.type === "SIGN_REJECT") return "rejected";
      if (event.type === "FAIL") return "failed";
      return state;
    case "signing":
      if (event.type === "SIGN_SUCCESS") return "signed";
      if (event.type === "SIGN_REJECT") return "rejected";
      if (event.type === "FAIL") return "failed";
      return state;
    case "failed":
      if (event.type === "REQUEUE") return "pending";
      if (event.type === "BEGIN_SIGN") return "signing";
      return state;
    case "rejected":
      if (event.type === "REQUEUE") return "pending";
      return state;
    case "signed":
      return state;
    default:
      throw makeForgeError({
        domain: "lifecycle",
        code: "LIFECYCLE_INVALID_TRANSITION",
        message: `Unknown tx lifecycle state: ${String(state)}`,
      });
  }
}

export function transitionQueueTxReceiptLifecycle(
  state: QueueTxReceiptLifecycleState,
  event: QueueTxReceiptLifecycleEvent
): QueueTxReceiptLifecycleState {
  switch (state) {
    case "submitted":
      if (event.type === "BROADCASTED") return "broadcasted";
      if (event.type === "POLL_PENDING") return "pending_confirm";
      if (event.type === "CONFIRMED") return "confirmed";
      if (event.type === "FAILED") return "failed";
      if (event.type === "TIMEOUT") return "timeout";
      return state;
    case "broadcasted":
      if (event.type === "POLL_PENDING") return "pending_confirm";
      if (event.type === "CONFIRMED") return "confirmed";
      if (event.type === "FAILED") return "failed";
      if (event.type === "TIMEOUT") return "timeout";
      return state;
    case "pending_confirm":
      if (event.type === "CONFIRMED") return "confirmed";
      if (event.type === "FAILED") return "failed";
      if (event.type === "TIMEOUT") return "timeout";
      return state;
    case "failed":
    case "timeout":
    case "confirmed":
      if (event.type === "RESET") return "submitted";
      return state;
    default:
      throw makeForgeError({
        domain: "lifecycle",
        code: "LIFECYCLE_INVALID_TRANSITION",
        message: `Unknown tx receipt lifecycle state: ${String(state)}`,
      });
  }
}
