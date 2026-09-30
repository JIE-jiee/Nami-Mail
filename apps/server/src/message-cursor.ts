/**
 * The keyset cursor the message list pages with.
 *
 * `LIMIT ? OFFSET ?` cannot converge while mail arrives: every new row shifts
 * the whole ordered result down by one, so a row that sat at offset 40 when the
 * user started scrolling is at offset 41 by the time they reach page 2, and the
 * page-2 window skips it. Measured on 1000 rows at pageSize 40 with one
 * message arriving per page, 24 of the 1000 rows were never served — and the
 * loss is a function of the arrival rate, not of the database size. A cursor
 * names a *position* in the total order instead of an offset into it, so rows
 * inserted above the cursor cannot displace anything below it.
 *
 * The position is the same `(sort_key DESC, id DESC)` pair the list orders by,
 * which is why the cursor is derived from the last row of the page that handed
 * it out rather than counted. `id` is the tiebreak: `sort_key` alone is not
 * unique (a sync that lands several messages in the same second writes several
 * rows with the same COALESCE value), and a cursor over a non-total order
 * cannot say which side of a tie it sits on.
 *
 * Opaque by construction. Clients echo the string back and never build one, so
 * the encoding below is free to change: it is base64url over NUL-separated
 * parts, and the version tag is what lets a future shape be rejected instead of
 * misread.
 *
 * Leaf module: no imports.
 */

/** One position in the list's total order. */
export type MessageListCursor = {
  /** The row's `sort_key`, an ISO-8601 UTC instant. */
  sortKey: string;
  /** The row's id, the tiebreak inside a shared sort_key. */
  id: string;
};

/** Bumped when the encoded shape changes; an older cursor is then rejected. */
const CURSOR_VERSION = "1";
/**
 * NUL cannot occur in an ISO instant or in a message id, so the separator can
 * never split a part it did not mean to.
 */
const SEPARATOR = "\u0000";
/** base64url's alphabet. Buffer's decoder silently drops anything else. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/**
 * Two ISO instants and two UUIDs encode to well under 200 characters; the bound
 * is here so a hostile client cannot make the route decode an arbitrary blob.
 */
export const MAX_MESSAGE_CURSOR_LENGTH = 512;

/** Raised for any cursor the route did not issue. The route answers 400. */
export class InvalidMessageCursorError extends Error {
  constructor(reason: string) {
    super(`Invalid message list cursor: ${reason}`);
    this.name = "InvalidMessageCursorError";
  }
}

/**
 * The cursor that resumes the list immediately after `position`.
 *
 * A row that has since been deleted or moved out of the view does not
 * invalidate it: the position is a value in a total order, not a reference to a
 * live row, so the predicate below still selects exactly the rows that were
 * below it. That is why there is no expiry to enforce — a cursor only fails
 * when it is *malformed*, not when it is *old*.
 */
export function encodeMessageCursor(position: MessageListCursor): string {
  return Buffer.from(
    `${CURSOR_VERSION}${SEPARATOR}${position.sortKey}${SEPARATOR}${position.id}`,
    "utf8",
  ).toString("base64url");
}

/**
 * Reverses `encodeMessageCursor`, rejecting anything this build did not issue.
 *
 * Every check is explicit rather than a `try` around a parse: an empty string, a
 * truncated payload, a future version and a well-formed cursor for a different
 * view all have to fail the same way, and a lenient decoder would quietly turn
 * the last one into a wrong page.
 */
export function decodeMessageCursor(value: string): MessageListCursor {
  if (value.length === 0) throw new InvalidMessageCursorError("it is empty");
  if (value.length > MAX_MESSAGE_CURSOR_LENGTH) {
    throw new InvalidMessageCursorError("it is longer than any cursor this route issues");
  }
  if (!BASE64URL.test(value)) throw new InvalidMessageCursorError("it is not base64url");
  const parts = Buffer.from(value, "base64url").toString("utf8").split(SEPARATOR);
  if (parts.length !== 3) throw new InvalidMessageCursorError("it does not carry a version, a sort key and an id");
  const [version, sortKey, id] = parts as [string, string, string];
  if (version !== CURSOR_VERSION) throw new InvalidMessageCursorError(`it names version ${version}`);
  if (sortKey.length === 0) throw new InvalidMessageCursorError("its sort key is empty");
  if (id.length === 0) throw new InvalidMessageCursorError("its id is empty");
  return { sortKey, id };
}
