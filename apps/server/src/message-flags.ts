/**
 * Shared vocabulary for message flag updates.
 *
 * Two paths apply flag changes — `sync-flags.ts` (user-initiated, IMAP STORE
 * first, then the local cache) and `flags-outbox.ts` (durable queue pushing a
 * locally committed change). Both translate the same patch shape into the same
 * IMAP flag names, so the shape and the names have one definition here.
 *
 * The two paths deliberately keep their own write ordering; only the vocabulary
 * is shared.
 */

export type MessageFlagsPatch = {
  seen?: boolean;
  flagged?: boolean;
};

export const messageFlagNames = {
  seen: "\\Seen",
  flagged: "\\Flagged",
} as const;
