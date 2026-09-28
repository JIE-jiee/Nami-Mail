/**
 * Read-only message row access for the HTTP layer.
 *
 * Every read endpoint used to inline its own `SELECT` against `messages`, so
 * the "row joined with the account email" shape was written out three times
 * and the "is this a draft?" folder join twice. These queries live here so the
 * joins have a single definition; the route keeps validation, error mapping
 * and payload decryption.
 *
 * Leaf module: only type-only imports plus `db.js`.
 */
import type { DatabaseHandle } from "./db.js";
import type { MessageListSqlSelection } from "./message-filters.js";
import type { MessageStorageRow } from "./message-storage.js";
import type { AccountRecord } from "./types.js";

/**
 * List-view reads. The WHERE/FROM fragments are produced by
 * `buildMessageListSql`, which the batch-job resolver also uses, so
 * "select all matching this view" cannot drift from what the list shows.
 */
export function countMessageRows(db: DatabaseHandle, selection: MessageListSqlSelection): number {
  return Number(
    (db.prepare(`SELECT COUNT(*) AS count ${selection.join} ${selection.where}`).get(...selection.params) as { count: number })
      .count,
  );
}

/** One page of a list view, newest first, joined with the owning account. */
export function listMessageRows(
  db: DatabaseHandle,
  selection: MessageListSqlSelection,
  page: number,
  pageSize: number,
): MessageStorageRow[] {
  return db
    .prepare(
      `
          SELECT m.*, a.email AS account_email, a.provider_name
          ${selection.join}
          JOIN accounts a ON a.id = m.account_id
          ${selection.where}
          ORDER BY COALESCE(m.sent_at, m.created_at) DESC
          LIMIT ? OFFSET ?
        `,
    )
    .all(...selection.params, pageSize, (page - 1) * pageSize) as MessageStorageRow[];
}

/**
 * The columns a flag/move operation needs to talk to IMAP and to record a
 * pending change. Read identically by `sync-moves.ts` (three call sites) and
 * `sync-flags.ts`, which used to spell the same SELECT out four times.
 */
export type PendingPushRow = {
  account_id: string;
  mailbox: string;
  uid: number;
  flags_json: string;
  remote_id_lookup: string | null;
  pending_move_destination: string | null;
  pending_move_state: string | null;
};

export function pendingPushRowById(db: DatabaseHandle, id: string): PendingPushRow | undefined {
  return db
    .prepare("SELECT account_id, mailbox, uid, flags_json, remote_id_lookup, pending_move_destination, pending_move_state FROM messages WHERE id = ?")
    .get(id) as PendingPushRow | undefined;
}

/** A message row joined with its account, as returned by the read endpoints. */
export function messageRowById(db: DatabaseHandle, id: string): MessageStorageRow | undefined {
  return db
    .prepare(
      `
        SELECT m.*, a.email AS account_email, a.provider_name
        FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.id = ?
      `,
    )
    .get(id) as MessageStorageRow | undefined;
}

/**
 * Every non-draft message of one account, oldest first. Thread membership is
 * resolved from encrypted headers, so the caller needs a decrypting pass over
 * the whole account rather than a targeted lookup.
 */
export function threadRowsForAccount(db: DatabaseHandle, accountId: string): MessageStorageRow[] {
  return db
    .prepare(
      `
        SELECT m.*, a.email AS account_email, a.provider_name
        FROM messages m
        JOIN accounts a ON a.id = m.account_id
        LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.mailbox
        WHERE m.account_id = ? AND (f.special_use IS NULL OR f.special_use != '\\Drafts')
        ORDER BY COALESCE(m.sent_at, m.created_at), m.id
      `,
    )
    .all(accountId) as MessageStorageRow[];
}

/** Special-use flag of the folder holding a message; undefined when the row is gone. */
export function messageFolderSpecialUse(db: DatabaseHandle, id: string): { special_use: string | null } | undefined {
  return db
    .prepare(
      `
      SELECT f.special_use
      FROM messages m
      LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.mailbox
      WHERE m.id = ?
    `,
    )
    .get(id) as { special_use: string | null } | undefined;
}

export function messageAccountAndFolder(
  db: DatabaseHandle,
  id: string,
): { account_id: string; special_use: string | null } | undefined {
  return db
    .prepare(
      `
      SELECT m.account_id, f.special_use
      FROM messages m
      LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.mailbox
      WHERE m.id = ?
    `,
    )
    .get(id) as { account_id: string; special_use: string | null } | undefined;
}

/** The account row that owns a message, used by operations that act on the mailbox. */
export function accountRowForMessage(db: DatabaseHandle, messageId: string): AccountRecord | undefined {
  return db
    .prepare(
      `
      SELECT a.*
      FROM messages m JOIN accounts a ON a.id = m.account_id
      WHERE m.id = ?
    `,
    )
    .get(messageId) as AccountRecord | undefined;
}

/** Accounts owning each of the given message ids, so a batch can be grouped per account. */
export function messageAccountIds(
  db: DatabaseHandle,
  ids: readonly string[],
): Array<{ id: string; account_id: string }> {
  return db
    .prepare(`SELECT id, account_id FROM messages WHERE id IN (${ids.map(() => "?").join(", ")})`)
    .all(...ids) as Array<{ id: string; account_id: string }>;
}

export function messageAccountId(db: DatabaseHandle, id: string): string | undefined {
  const row = db.prepare("SELECT account_id FROM messages WHERE id = ?").get(id) as
    | { account_id: string }
    | undefined;
  return row?.account_id;
}

export function messageExists(db: DatabaseHandle, id: string): boolean {
  return db.prepare("SELECT 1 FROM messages WHERE id = ?").get(id) !== undefined;
}
