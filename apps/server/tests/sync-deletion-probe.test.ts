import { describe, expect, it } from "vitest";
import {
  REMOTE_DELETION_PROBE_BATCH_SIZE,
  REMOTE_DELETION_PROBE_CURSOR_LIMIT,
  createRemoteDeletionProbeState,
  defaultRemoteDeletionProbeState,
  remoteDeletionProbeCursorKey,
} from "../src/sync-deletion-probe.js";

// The cursor key joins its parts with a NUL byte, which has to be built at
// runtime: writing it as an escape in this file would either be a literal
// backslash-zero or, with a trailing digit, an octal escape.
const nul = String.fromCharCode(0);

describe("remote deletion probe cursor state", () => {
  it("keeps the batch and LRU sizes that bound one folder pass", () => {
    expect(REMOTE_DELETION_PROBE_BATCH_SIZE).toBe(64);
    expect(REMOTE_DELETION_PROBE_CURSOR_LIMIT).toBe(1_024);
  });

  it("keys a cursor by account, folder and UIDVALIDITY epoch", () => {
    expect(remoteDeletionProbeCursorKey("account-1", "INBOX", "10"))
      .toBe(["account-1", "INBOX", "10"].join(nul));
    expect(remoteDeletionProbeCursorKey("account-1", "INBOX", "11"))
      .not.toBe(remoteDeletionProbeCursorKey("account-1", "INBOX", "10"));
  });

  it("starts empty, advances to the verified UID and forgets a cleared key", () => {
    const probe = createRemoteDeletionProbeState();
    expect(probe.get("k")).toBeUndefined();
    probe.advance("k", 42);
    expect(probe.get("k")).toBe(42);
    probe.advance("k", 43);
    expect(probe.get("k")).toBe(43);
    probe.delete("k");
    expect(probe.get("k")).toBeUndefined();
  });

  it("evicts the least recently advanced cursor once the limit is reached", () => {
    const probe = createRemoteDeletionProbeState(3);
    probe.advance("a", 1);
    probe.advance("b", 2);
    probe.advance("c", 3);
    // Re-advancing moves "a" to the newest slot, so "b" becomes the oldest.
    probe.advance("a", 11);
    probe.advance("d", 4);
    expect(probe.get("a")).toBe(11);
    expect(probe.get("b")).toBeUndefined();
    expect(probe.get("c")).toBe(3);
    expect(probe.get("d")).toBe(4);
  });

  it("holds a full default-sized cursor set before evicting anything", () => {
    const probe = createRemoteDeletionProbeState();
    for (let index = 0; index < REMOTE_DELETION_PROBE_CURSOR_LIMIT; index += 1) {
      probe.advance(`k${index}`, index);
    }
    expect(probe.get("k0")).toBe(0);
    expect(probe.get(`k${REMOTE_DELETION_PROBE_CURSOR_LIMIT - 1}`))
      .toBe(REMOTE_DELETION_PROBE_CURSOR_LIMIT - 1);
    probe.advance("overflow", 1);
    expect(probe.get("k0")).toBeUndefined();
  });

  it("hands every caller one shared default while created states stay isolated", () => {
    expect(defaultRemoteDeletionProbeState()).toBe(defaultRemoteDeletionProbeState());
    expect(createRemoteDeletionProbeState()).not.toBe(defaultRemoteDeletionProbeState());
  });

  it("survives destructuring so a caller cannot silently detach the map", () => {
    const { get, advance, delete: forget } = createRemoteDeletionProbeState();
    advance("k", 7);
    expect(get("k")).toBe(7);
    forget("k");
    expect(get("k")).toBeUndefined();
  });
});
