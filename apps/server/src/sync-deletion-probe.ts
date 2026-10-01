/**
 * Cursor state for the remote-deletion verification probe.
 *
 * Each folder pass re-verifies a bounded batch of cached UIDs against the
 * provider (`reconcileRemoteDeletionBatch` in sync.ts) and remembers the
 * highest UID it verified, so successive passes sweep a folder from oldest to
 * newest and only wrap back to the oldest once the sweep has run off the end.
 *
 * That rotation is only correct while the cursor outlives a single sync pass.
 * A folder holding more cached rows than one batch can verify would otherwise
 * be re-probed at the very same oldest UIDs on every pass and never reach
 * recently cached mail -- which is exactly the mail a user deletes on their
 * phone, the case the probe exists to catch. The cursor therefore lives per
 * process, exactly as the module-level Map it replaces did.
 *
 * What changed is ownership, not lifetime. The state is an instance behind
 * {@link RemoteDeletionProbeState} that sync.ts receives as an argument instead
 * of reaching for a module singleton, so a caller that wants an isolated probe
 * (a test, a second database inside one process) owns its own instance and gets
 * exactly that. Callers that pass nothing keep sharing {@link
 * defaultRemoteDeletionProbeState}, which preserves the previous behaviour
 * without them having to know this module exists.
 */

/**
 * Cached UIDs verified per folder per pass. Bounded so one folder's probe is a
 * single small FETCH; the cursor below spreads the remaining coverage across
 * later passes.
 */
export const REMOTE_DELETION_PROBE_BATCH_SIZE = 64;

/**
 * Cursor entries kept at once. A key is one (account, folder, UIDVALIDITY
 * epoch) triple, so this bounds the memory of accounts that churn through many
 * folders or UID epochs; the oldest entry is dropped once the map is full.
 */
export const REMOTE_DELETION_PROBE_CURSOR_LIMIT = 1_024;

/** A probe cursor store. Owning one is how a caller scopes the rotation. */
export type RemoteDeletionProbeState = {
  /** Last verified UID for `key`, or undefined when the probe has not run. */
  get(key: string): number | undefined;
  /** Records `uid` as the verified high-water mark, evicting oldest-first. */
  advance(key: string, uid: number): void;
  /** Forgets `key`; the next probe for it restarts from the oldest UID. */
  delete(key: string): void;
};

/**
 * Identity of one probe cursor. The UIDVALIDITY epoch is part of the key
 * because cached UIDs only mean anything inside the epoch they were observed
 * in, and it is pinned here (rather than left to the caller) so two callers can
 * never disagree about which sweep they are continuing.
 */
export function remoteDeletionProbeCursorKey(
  accountId: string,
  mailbox: string,
  uidValidity: string,
): string {
  return `${accountId}\0${mailbox}\0${uidValidity}`;
}

/**
 * Creates an isolated cursor store. `limit` bounds the LRU so a caller that
 * drives the probe in a loop (a test asserting eviction) does not have to fill
 * 1024 keys first.
 */
export function createRemoteDeletionProbeState(
  limit: number = REMOTE_DELETION_PROBE_CURSOR_LIMIT,
): RemoteDeletionProbeState {
  const cursors = new Map<string, number>();
  return {
    // Closure methods rather than `this`-bound ones so a caller that destructures
    // the state keeps working.
    get: (key) => cursors.get(key),
    advance(key, uid) {
      // Re-insert so the map's iteration order is least-recently-advanced first.
      cursors.delete(key);
      cursors.set(key, uid);
      while (cursors.size > limit) {
        const oldestKey = cursors.keys().next().value;
        if (typeof oldestKey !== "string") return;
        cursors.delete(oldestKey);
      }
    },
    delete: (key) => {
      cursors.delete(key);
    },
  };
}

/** Process-wide cursor store shared by every sync pass that injects nothing. */
const processProbeState = createRemoteDeletionProbeState();

/**
 * The shared store sync.ts falls back to, so the verification rotation keeps
 * working across passes exactly as it did when the Map was module-private.
 */
export function defaultRemoteDeletionProbeState(): RemoteDeletionProbeState {
  return processProbeState;
}
