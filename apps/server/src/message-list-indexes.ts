/**
 * The indexes that answer the message list's ordering and its keyset cursor.
 *
 * They live apart from `db.ts` because they are a property of the list's query
 * shape rather than of the schema, and because the two account-scoped ones have
 * to be *rebuilt* rather than merely created — see below. The measurements in
 * the comments are on 200 000 rows with the list query and its cursor
 * predicate; `tests/message-list-cursor.test.ts` pins the resulting plans.
 *
 * Leaf module: SQL text only, no imports.
 */

/**
 * The list orders by `(sort_key DESC, id DESC)` — `sort_key` is the VIRTUAL
 * generated column standing in for COALESCE(sent_at, created_at), and `id` is
 * the tiebreak that makes the order total, which a cursor needs in order to say
 * which side of a tie it sits on.
 *
 * The two account-scoped shapes are the whole-account view and the folder view
 * (`effective_mailbox`, so a pending move is filed by its destination). Both
 * carry `id` as a suffix: an index stopping at sort_key leaves SQLite sorting
 * the last term through a temp B-tree, measured at 2.3ms against 0.7ms for a
 * deep page — with the keyset predicate already in the query.
 *
 * They are dropped and rebuilt rather than created under new names because
 * `CREATE INDEX IF NOT EXISTS` matches on name alone: a database opened by an
 * earlier build would keep the two-column shape forever and silently pay the
 * sorter on every page. The cost is one rebuild of two indexes, once, on the
 * first open that needs it.
 */
export const MESSAGE_LIST_ACCOUNT_INDEX_SQL = `
  DROP INDEX IF EXISTS idx_messages_account_sort_key;
  DROP INDEX IF EXISTS idx_messages_account_effective_mailbox;
  CREATE INDEX idx_messages_account_sort_key ON messages(account_id, sort_key DESC, id DESC);
  CREATE INDEX idx_messages_account_effective_mailbox ON messages(account_id, effective_mailbox, sort_key DESC, id DESC);
`;

/**
 * The unified inbox of the "all accounts" entry carries no account filter, and
 * no `(account_id, ...)` index can order it — there is no account to seek into.
 * Measured on 200 000 rows, that page planned as a full table scan through a
 * sorter: 228ms for the first page, and the same again for every page after it.
 * The keyset predicate alone does not fix it (136ms with the two account
 * indexes present), because with no global ordering there is nothing to seek
 * in. With this index the same page is an ordered index scan: 0.6ms for the
 * first page, 1.4ms at the 101st.
 *
 * Unlike the two above it needs no rebuild: it is new, so `IF NOT EXISTS` is
 * correct and an already-open database simply gains it.
 */
export const MESSAGE_LIST_GLOBAL_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS idx_messages_sort_key_id ON messages(sort_key DESC, id DESC)";
