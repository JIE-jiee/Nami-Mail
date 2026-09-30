/**
 * Desktop-confirmation lifecycle for the Agent: pending-confirmation
 * bookkeeping (creation, expiry, settle, cancel), the decision entry point
 * Electron main invokes, and the ToolCall→payload-scope WeakMap that binds a
 * confirmation's immutable payload hash to the exact tool-call object that
 * triggered it.
 *
 * Extracted verbatim from AgentService (the #108 pattern): the lifecycle owns
 * its two maps, AgentService keeps the public `resolveDesktopConfirmation` as
 * a one-line delegate and routes its other call sites straight here, so the
 * public surface — and the agent-service test suites — stay untouched.
 *
 * Keying contract: `prepareConfirmationPayload` and `confirmationPayloadHash`
 * must see the SAME ToolCall object references that streamMessage and
 * invokeExternalTool pass in — the WeakMap identifies a call by object
 * identity, and a snapshot copy would silently lose the scope.
 */
import { createHash } from "node:crypto";
import type { CallerContext, ConfirmationDecision, ConfirmationRequest, ToolCall } from "@nami/agent-contracts";
import type { ToolRegistry } from "@nami/agent-core";
import { now } from "./agent-shared.js";
import type { ImmutableGuiConfirmationStore } from "./confirmations.js";
import { canonicalAgentJson } from "./store-crypto.js";

export type AgentConfirmationResolution = Readonly<{ ok: true }> | Readonly<{ ok: false }>;

type PendingConfirmationOutcome = "approved" | "rejected" | "expired" | "cancelled";

type PendingAgentConfirmation = {
  confirmation: ConfirmationRequest;
  conversationId: string;
  requestId: string;
  caller: CallerContext;
  call: ToolCall;
  executionAccountIds: string[];
  controller: AbortController;
  settled: boolean;
  outcome: Promise<PendingConfirmationOutcome>;
  timeout?: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
  resolve: (outcome: PendingConfirmationOutcome) => void;
};

type ConfirmationPayloadScope = {
  requestId: string;
  accountIds: string[];
};

export class AgentConfirmationLifecycle {
  private readonly pendingConfirmations = new Map<string, PendingAgentConfirmation>();
  private readonly confirmationPayloadScopes = new WeakMap<ToolCall, ConfirmationPayloadScope>();

  constructor(private readonly deps: {
    /** Immutable receipt store; undefined when no desktop confirmation is wired. */
    readonly confirmationStore: ImmutableGuiConfirmationStore | undefined;
    /** Desktop confirmation handle; undefined disables the decision entry point.
     * `capability` is opaque here — the store validates it on record. */
    readonly desktopConfirmation: { readonly capability: unknown } | undefined;
    /** Resolves a tool call to descriptor/accounts for scope capture. */
    readonly tools: ToolRegistry;
    /** True when `controller` is still the live run for the conversation. */
    readonly isRunControllerActive: (conversationId: string, controller: AbortController) => boolean;
  }) {}

  /** Only Electron main can invoke this through the runtime-owned closure. */
  async resolveDesktopConfirmation(
    confirmationId: string,
    decision: "approve" | "reject",
  ): Promise<AgentConfirmationResolution> {
    const pending = this.pendingConfirmations.get(confirmationId);
    const desktopConfirmation = this.deps.desktopConfirmation;
    if (
      !pending
      || pending.settled
      || pending.controller.signal.aborted
      || !this.deps.isRunControllerActive(pending.conversationId, pending.controller)
      || !desktopConfirmation
      || !this.deps.confirmationStore
    ) return { ok: false };

    const expiresAt = Date.parse(pending.confirmation.expiresAt);
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
      this.expirePendingConfirmation(pending);
      return { ok: false };
    }

    const receipt: ConfirmationDecision = decision === "approve"
      ? {
        confirmationId: pending.confirmation.id,
        requestId: pending.requestId,
        decision: "approved",
        decidedAt: now(),
        immutablePayloadHash: pending.confirmation.immutablePayloadHash,
      }
      : {
        confirmationId: pending.confirmation.id,
        requestId: pending.requestId,
        decision: "rejected",
        decidedAt: now(),
      };
    try {
      this.deps.confirmationStore.recordDecision(receipt, pending.caller, desktopConfirmation.capability);
    } catch {
      return { ok: false };
    }
    this.settlePendingConfirmation(pending, decision === "approve" ? "approved" : "rejected");
    return { ok: true };
  }

  /** Called from AgentService's runtime wiring for confirmation payloads. */
  confirmationPayloadHash(call: ToolCall): string {
    const scope = this.confirmationPayloadScopes.get(call);
    if (!scope) throw new Error("Confirmation payload scope is unavailable.");
    return createHash("sha256").update(canonicalAgentJson({
      toolCallId: call.id,
      toolName: call.toolName,
      input: call.input,
      requestId: scope.requestId,
      accountIds: scope.accountIds,
    })).digest("hex");
  }

  /** Called from AgentService's tool paths before an invocation that may need a confirmation. */
  prepareConfirmationPayload(
    call: ToolCall,
    requestId: string,
    executionAccountIds: readonly string[],
  ): void {
    if (!this.deps.confirmationStore) return;
    const resolution = this.deps.tools.resolve(call, executionAccountIds);
    if (!resolution.ok) return;
    const descriptor = resolution.tool.descriptor;
    if (descriptor.confirmationPolicy !== "required" && descriptor.executionMode !== "high-risk") return;
    this.confirmationPayloadScopes.set(call, {
      requestId,
      accountIds: [...resolution.accountIds],
    });
  }

  /** Called from AgentService's streamMessage when a tool requires confirmation. */
  createPendingConfirmation(input: Omit<PendingAgentConfirmation, "settled" | "outcome" | "timeout" | "removeAbortListener" | "resolve">): PendingAgentConfirmation | undefined {
    if (input.controller.signal.aborted) return undefined;
    let resolve!: (outcome: PendingConfirmationOutcome) => void;
    const outcome = new Promise<PendingConfirmationOutcome>((resolveOutcome) => {
      resolve = resolveOutcome;
    });
    const pending: PendingAgentConfirmation = {
      ...input,
      settled: false,
      outcome,
      resolve,
    };
    const abort = () => this.settlePendingConfirmation(pending, "cancelled");
    pending.controller.signal.addEventListener("abort", abort, { once: true });
    pending.removeAbortListener = () => pending.controller.signal.removeEventListener("abort", abort);
    if (pending.controller.signal.aborted) {
      this.settlePendingConfirmation(pending, "cancelled");
      return undefined;
    }
    this.pendingConfirmations.set(pending.confirmation.id, pending);
    this.schedulePendingConfirmationExpiry(pending);
    return pending;
  }

  private schedulePendingConfirmationExpiry(pending: PendingAgentConfirmation): void {
    const expiresAt = Date.parse(pending.confirmation.expiresAt);
    const remaining = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - Date.now()) : 0;
    pending.timeout = setTimeout(() => this.expirePendingConfirmation(pending), remaining);
  }

  private expirePendingConfirmation(pending: PendingAgentConfirmation): void {
    if (pending.settled) return;
    const expiresAt = Date.parse(pending.confirmation.expiresAt);
    if (Number.isFinite(expiresAt) && Date.now() < expiresAt) {
      this.schedulePendingConfirmationExpiry(pending);
      return;
    }
    const desktopConfirmation = this.deps.desktopConfirmation;
    if (desktopConfirmation && this.deps.confirmationStore && !pending.controller.signal.aborted) {
      try {
        this.deps.confirmationStore.recordDecision({
          confirmationId: pending.confirmation.id,
          requestId: pending.requestId,
          decision: "expired",
          decidedAt: now(),
        }, pending.caller, desktopConfirmation.capability);
      } catch {
        // The immutable store records an expired receipt and then rejects the stale decision.
      }
    }
    this.settlePendingConfirmation(pending, "expired");
  }

  private settlePendingConfirmation(pending: PendingAgentConfirmation, outcome: PendingConfirmationOutcome): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.removeAbortListener?.();
    if (this.pendingConfirmations.get(pending.confirmation.id) === pending) {
      this.pendingConfirmations.delete(pending.confirmation.id);
    }
    pending.resolve(outcome);
  }

  /** Settles every pending confirmation for the given run (user-initiated cancel). */
  cancelPendingConfirmations(controller: AbortController): void {
    for (const pending of [...this.pendingConfirmations.values()]) {
      if (pending.controller === controller) this.settlePendingConfirmation(pending, "cancelled");
    }
  }

  /** Settles every pending confirmation regardless of run — service shutdown path. */
  cancelAll(): void {
    for (const pending of [...this.pendingConfirmations.values()]) this.settlePendingConfirmation(pending, "cancelled");
  }
}
