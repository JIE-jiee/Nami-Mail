// @vitest-environment jsdom
// Regression guard for "click a folder, then click the same folder again":
// the sidebar spinner came up and never went away, and the list froze.
//
// The shell below is a faithful miniature of App's navigation wiring — the
// same three state cells, a `load` callback whose identity is keyed on the
// selection, the single effect that drives it, and the sidebar spinner grace
// period. The load callback is the ONLY thing in this shell that ever clears
// `loading`, exactly as in App where `setLoading(false)` lives solely in
// `load`'s finally block. That is what makes the bug reproducible here: a
// click that sets `loading` without changing the selection raises a flag that
// nothing is left to lower.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { isSameMailboxSelection, shouldShowLoading, type MailboxSelection } from "./folderNavigation";
import type { MessageListView } from "./mailListState";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Mirrors App's SIDEBAR_LOADING_SPINNER_DELAY_MS. */
const SIDEBAR_LOADING_SPINNER_DELAY_MS = 250;

/** Lets a test swap in a load that stays pending, to hold a switch "in flight". */
type Gate = { current: Promise<void> };

type ShellHandle = {
  chooseFolder: (path: string) => void;
  isSpinnerVisible: () => boolean;
  isLoading: () => boolean;
  selection: () => MailboxSelection;
};

// The handle is a STABLE object reading through refs. Capturing a freshly
// built object per render would freeze whatever the closures saw at capture
// time, and the assertions below would pass against stale state.
const handle: ShellHandle = {
  chooseFolder: () => undefined,
  isSpinnerVisible: () => false,
  isLoading: () => false,
  selection: () => ({ accountId: "", folder: "", view: "inbox" }),
};

/**
 * A minimal shell with App's exact navigation state machine: a `load`
 * useCallback keyed on the selection, one effect driving it, and the sidebar
 * spinner grace period.
 */
function MailboxShell({ onLoad, gate }: { onLoad: () => void; gate: Gate }) {
  const [selectedAccount] = useState("acct-1");
  const [selectedFolder, setSelectedFolder] = useState("");
  const [view, setView] = useState<MessageListView>("inbox");
  const [loading, setLoading] = useState(true);
  const [sidebarLoading, setSidebarLoading] = useState(false);

  // Live mirrors so the stable `handle` above reads current state.
  const live = useRef({ selectedAccount, selectedFolder, view, loading, sidebarLoading });
  live.current = { selectedAccount, selectedFolder, view, loading, sidebarLoading };

  // Mirrors App's `load`: a useCallback keyed on the selection, clearing
  // `loading` in its own finally and nowhere else. The deps are deliberately
  // the selection only: `onLoad`/`gate` are the test's injection points, and
  // adding them would re-create `load` (and re-run the effect) on every render,
  // which is exactly the coupling this reproduction depends on.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      onLoad();
      await gate.current;
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccount, selectedFolder, view]);

  useEffect(() => { void load(); }, [load]);

  // Mirrors App's sidebar spinner grace period: faster loads show no spinner.
  useEffect(() => {
    if (!loading) {
      setSidebarLoading(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setSidebarLoading(true), SIDEBAR_LOADING_SPINNER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);

  const chooseFolder = (path: string) => {
    // A click that lands on the list already loaded must be a no-op. The load
    // callback is keyed on the selection, so re-raising `loading` for a
    // selection that did not change would leave the flag set forever: no
    // effect re-runs, so nothing lowers it again.
    //
    // This calls `shouldShowLoading` — the exact seam App's `beginNavigation`
    // uses — rather than the predicate behind it, so a regression in the
    // call-site form fails here too.
    const current = live.current;
    if (!shouldShowLoading(
      { accountId: current.selectedAccount, folder: current.selectedFolder, view: current.view },
      { accountId: current.selectedAccount, folder: path, view: "inbox" },
    )) return;
    setLoading(true);
    setSelectedFolder(path);
    setView("inbox");
  };

  handle.chooseFolder = chooseFolder;
  handle.isSpinnerVisible = () => live.current.sidebarLoading;
  handle.isLoading = () => live.current.loading;
  handle.selection = () => ({ accountId: live.current.selectedAccount, folder: live.current.selectedFolder, view: live.current.view });
  return null;
}

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { root: createRoot(container), container };
}

const resolved = () => Promise.resolve();

/** Let the load callback's queue drain so its finally has run. */
async function settle() {
  await act(async () => { await resolved(); await resolved(); });
}

/** Cross the spinner grace period; a still-loading shell turns the spinner on. */
async function crossSpinnerDelay() {
  await act(async () => {
    await new Promise((resolve) => { window.setTimeout(resolve, SIDEBAR_LOADING_SPINNER_DELAY_MS + 20); });
  });
}

describe("isSameMailboxSelection", () => {
  const base: MailboxSelection = { accountId: "acct-1", folder: "INBOX", view: "inbox" };

  it("is true only when account, folder and view all match", () => {
    expect(isSameMailboxSelection(base, { ...base })).toBe(true);
    expect(isSameMailboxSelection(base, { ...base, folder: "Sent" })).toBe(false);
    expect(isSameMailboxSelection(base, { ...base, accountId: "acct-2" })).toBe(false);
    expect(isSameMailboxSelection(base, { ...base, view: "unread" })).toBe(false);
  });

  it("treats the empty folder (unified inbox) as a real, distinct target", () => {
    expect(isSameMailboxSelection({ accountId: "acct-1", folder: "", view: "inbox" }, { accountId: "acct-1", folder: "", view: "inbox" })).toBe(true);
    expect(isSameMailboxSelection({ accountId: "acct-1", folder: "", view: "inbox" }, base)).toBe(false);
  });
});

describe("shouldShowLoading", () => {
  // This is the function every sidebar handler actually calls, so it carries
  // the rule on its own: the spinner belongs to a navigation that moves the
  // list, never to a click that lands on the list already on screen.
  const base: MailboxSelection = { accountId: "acct-1", folder: "INBOX", view: "inbox" };

  it("refuses to raise the loading flag for the selection already on screen", () => {
    expect(shouldShowLoading(base, { ...base })).toBe(false);
    expect(shouldShowLoading(base, { accountId: "acct-1", folder: "INBOX", view: "inbox" })).toBe(false);
  });

  it("raises it for every genuine switch", () => {
    expect(shouldShowLoading(base, { ...base, folder: "Sent" })).toBe(true);
    expect(shouldShowLoading(base, { ...base, accountId: "acct-2" })).toBe(true);
    expect(shouldShowLoading(base, { ...base, view: "starred" })).toBe(true);
  });
});

describe("folder navigation loading convergence", () => {
  let onLoad: ReturnType<typeof vi.fn<() => void>>;
  let gate: Gate;
  let mounted: ReturnType<typeof mount>;

  beforeEach(async () => {
    onLoad = vi.fn<() => void>();
    gate = { current: resolved() };
    mounted = mount();
    await act(async () => { mounted.root.render(<MailboxShell onLoad={onLoad} gate={gate} />); });
    await settle();
  });

  afterEach(() => {
    act(() => { mounted.root.unmount(); });
    mounted.container.remove();
  });

  it("re-clicking the already-selected folder is a no-op that never raises the spinner", async () => {
    // First click really switches the list: one load, spinner settles.
    await act(async () => { handle.chooseFolder("INBOX"); });
    await settle();
    expect(handle.selection().folder).toBe("INBOX");
    expect(handle.isLoading()).toBe(false);
    const loadsAfterFirstClick = onLoad.mock.calls.length;

    // Second click on the SAME folder must not start a second load...
    await act(async () => { handle.chooseFolder("INBOX"); });
    await settle();
    expect(onLoad.mock.calls.length).toBe(loadsAfterFirstClick);

    // ...and must not leave the shell stuck in the loading state. Before the
    // guard this is where it wedged: `loading` was raised, but the selection
    // never changed, so the load effect never re-ran to lower it again — the
    // spinner came up after its grace period and never went away.
    expect(handle.isLoading()).toBe(false);
    await crossSpinnerDelay();
    expect(handle.isLoading()).toBe(false);
    expect(handle.isSpinnerVisible()).toBe(false);
  });

  it("still switches (and loads) when a different folder is clicked", async () => {
    await act(async () => { handle.chooseFolder("INBOX"); });
    await settle();
    const loadsAfterFirstClick = onLoad.mock.calls.length;

    await act(async () => { handle.chooseFolder("Sent"); });
    await settle();
    expect(handle.selection().folder).toBe("Sent");
    expect(onLoad.mock.calls.length).toBeGreaterThan(loadsAfterFirstClick);
    expect(handle.isLoading()).toBe(false);
  });

  it("shows the spinner while a genuine switch is in flight, and clears it on landing", async () => {
    // Hold the load open so the grace period elapses mid-switch.
    let release: () => void = () => undefined;
    gate.current = new Promise<void>((resolve) => { release = resolve; });

    await act(async () => { handle.chooseFolder("INBOX"); });
    await crossSpinnerDelay();
    expect(handle.isLoading()).toBe(true);
    expect(handle.isSpinnerVisible()).toBe(true);

    gate.current = resolved();
    await act(async () => { release(); });
    await settle();
    expect(handle.isLoading()).toBe(false);
    await crossSpinnerDelay();
    expect(handle.isSpinnerVisible()).toBe(false);
  });
});
