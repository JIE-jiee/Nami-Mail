/**
 * Account sync/move concurrency state plus the per-account FIFO write lock.
 *
 * This module is a leaf: apart from two type-only imports it has no
 * dependencies, so every sync-family module (sync.ts, sync-moves.ts,
 * sync-flags.ts, sync-sent-verify.ts, flags-outbox.ts, operation-queue.ts)
 * can depend on it without any of them depending on each other. These
 * primitives used to live in sync.ts, which made sync.ts the parent of its own
 * children and produced an import cycle.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseHandle } from "./db.js";
import type { AccountRecord } from "./types.js";


const running = new Set<string>();
const movingAccounts = new Set<string>();

/** True when the account is mid-sync. Used by move operations to block concurrent intents. */
export function isAccountSyncing(accountId: string): boolean {
  return running.has(accountId);
}

/** True when a move operation is in flight for the account. */
export function isAccountMoving(accountId: string): boolean {
  return movingAccounts.has(accountId);
}

/** Mark an account as mid-move. Call from sync-moves.ts only. */
export function markAccountMoving(accountId: string): void {
  movingAccounts.add(accountId);
}

/** Clear the mid-move flag for an account. Call from sync-moves.ts only. */
export function unmarkAccountMoving(accountId: string): void {
  movingAccounts.delete(accountId);
}

/** Clears in-flight sync and move tracking when an account is deleted. */
export function clearAccountSyncState(accountId: string): void {
  running.delete(accountId);
  movingAccounts.delete(accountId);
}

/** Marks an account as mid-sync. Call from sync.ts only. */
export function markAccountSyncing(accountId: string): void {
  running.add(accountId);
}

/** Clears the mid-sync flag. Call from sync.ts only. */
export function unmarkAccountSyncing(accountId: string): void {
  running.delete(accountId);
}

// Per-account FIFO write lock chains. A second write operation on the same
// account (another move, a flag update) waits in line instead of failing with
// a busy error, so a burst of deletes or moves is processed in order rather
// than rejected. A full sync pass (`running`) intentionally stays an
// immediate failure: queued writes must never block a sync cycle.
const accountWriteChains = new Map<string, Promise<void>>();

// Tracks which accounts the current async execution context already holds a
// write slot for. Nested acquisitions — the operation queue takes the slot
// before invoking an executor that also takes it, and batch moves fall back to
// single-message moves that take it again — must be no-ops instead of waiting
// on their own gate forever (a self-deadlock).
const heldWriteSlots = new AsyncLocalStorage<Set<string>>();

/** Longest an operation may wait for the account write slot it is queued
 * behind. A predecessor whose provider command hangs (and whose executor is
 * later abandoned) must not block this operation forever; on timeout the
 * operation fails and its place in the chain is released so operations behind
 * it still proceed. Generous relative to a normal operation (seconds) but far
 * shorter than the queue's executor run timeout. */
const ACCOUNT_WRITE_SLOT_TIMEOUT_MS = 30_000;

/** Rejects with `message` after `milliseconds`, without keeping the process
 * alive for a run that may never settle on its own during shutdown. */
export function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Longest a write lets an in-flight sync pass finish before giving up. Kept
 * well below the renderer's 30s request budget so the caller still gets the
 * real outcome instead of a client-side timeout. */
export const ACCOUNT_SYNC_WAIT_MS = 15_000;

/** Polls `predicate` until it holds or `timeoutMs` elapses. */
export async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 150): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}

/**
 * Resolves true once no sync pass is in flight for the account, false when the
 * budget ran out.
 *
 * A write must never *block* a sync cycle (see the write-chain note above), but
 * it must also not be rejected just because a pass happens to be running. The
 * caller claims the account for moving first, which makes `syncAccount` skip
 * it, so no new pass can start here — only the pass already underway has to
 * finish.
 */
export function waitForAccountSyncIdle(accountId: string, timeoutMs = ACCOUNT_SYNC_WAIT_MS): Promise<boolean> {
  return waitUntil(() => !running.has(accountId), timeoutMs);
}

/**
 * Acquires write slots for every account in a deterministic order (sorted, so
 * concurrent multi-account batches can never deadlock). The returned release
 * functions must be called in reverse order.
 */
export async function acquireAccountWriteSlots(accountIds: readonly string[]): Promise<Array<() => void>> {
  const sorted = [...new Set(accountIds)].sort();
  const releases: Array<() => void> = [];
  const held = heldWriteSlots.getStore();
  try {
    for (const accountId of sorted) {
      // A nested acquisition within the same execution context already holds
      // this account's slot: do not wait on our own gate (self-deadlock).
      if (held?.has(accountId)) continue;
      const prev = accountWriteChains.get(accountId) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      accountWriteChains.set(accountId, prev.then(() => gate));
      try {
        await withTimeout(prev, ACCOUNT_WRITE_SLOT_TIMEOUT_MS, `Timed out waiting for the account ${accountId} write slot.`);
      } catch (error) {
        // Give up our place instead of leaving an unresolved gate that would
        // block every operation queued behind us.
        release();
        throw error;
      }
      held?.add(accountId);
      releases.push(() => {
        release();
        held?.delete(accountId);
      });
    }
    return releases;
  } catch (error) {
    for (const release of releases.reverse()) release();
    throw error;
  }
}

/** Runs `fn` while holding write slots for every named account. */
export async function withAccountWriteLocks<T>(accountIds: readonly string[], fn: () => Promise<T>): Promise<T> {
  return heldWriteSlots.run(heldWriteSlots.getStore() ?? new Set<string>(), async () => {
    const releases = await acquireAccountWriteSlots(accountIds);
    try {
      return await fn();
    } finally {
      for (const release of releases.reverse()) release();
    }
  });
}

/**
 * Runs `fn` in a context that considers every named account's write slot as
 * already held, so the executor's own nested `withAccountWriteLocks` calls are
 * reentrant no-ops. Used by the operation queue, which acquires the slot
 * itself (to release it on timeout) before invoking an executor that would
 * otherwise acquire it again and deadlock.
 */
export function withHeldWriteSlots<T>(accountIds: readonly string[], fn: () => Promise<T>): Promise<T> {
  const parent = heldWriteSlots.getStore();
  const held = new Set(accountIds);
  if (parent) for (const accountId of parent) held.add(accountId);
  return heldWriteSlots.run(held, fn);
}

export function accountById(db: DatabaseHandle, id: string): AccountRecord | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRecord | undefined;
}
