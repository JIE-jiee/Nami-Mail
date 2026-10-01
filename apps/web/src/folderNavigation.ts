import type { MessageListView } from "./mailListState";

/**
 * The three pieces of state that decide which list the shell is showing. They
 * are exactly the inputs App's `load` callback is keyed on, which is what makes
 * them the right granularity for "is this navigation a switch?".
 */
export type MailboxSelection = {
  accountId: string;
  /** IMAP folder path; "" is the unified inbox. */
  folder: string;
  view: MessageListView;
};

/**
 * True when two selections address the same list.
 *
 * The shell reloads through a single effect keyed on the `load` callback, and
 * `load` is a `useCallback` over the selection — so a navigation that does not
 * move the selection re-runs no effect, and therefore issues no request. Any
 * caller that raises the loading flag for such a click is raising a flag that
 * nothing is left to lower: the sidebar spinner comes up after its grace
 * period and the list stays in its switching state until the user happens to
 * click something else. Clicking the folder you are already in must therefore
 * be a no-op, not a reload.
 *
 * Comparing all three fields (not just the folder) matters because a folder
 * name is only unique within its account, and a folder click always lands on
 * the inbox view — so the same path reached from a different account, or from
 * a non-inbox view, is a genuine switch.
 */
export function isSameMailboxSelection(current: MailboxSelection, next: MailboxSelection): boolean {
  return current.accountId === next.accountId
    && current.folder === next.folder
    && current.view === next.view;
}

/**
 * Whether a sidebar navigation should raise the shell's loading flag.
 *
 * This is the call-site form of `isSameMailboxSelection`, so the rule that a
 * re-click on what is already open must not enter the loading phase is stated
 * once and cannot drift per handler.
 */
export function shouldShowLoading(current: MailboxSelection, next: MailboxSelection): boolean {
  return !isSameMailboxSelection(current, next);
}
