// @vitest-environment jsdom
// The shell's global keydown routing used to live inline in App's effect and
// had zero coverage. The decision logic now lives in dialogKeydownDecision so
// every escape-cascade branch, gate, and shortcut is pinned here — the App
// effect is just a thin executor over these decisions.
import { beforeEach, describe, expect, it } from "vitest";
import { dialogKeydownDecision, isTypingTarget, MODAL_KEYS, type DialogKeydownAction, type DialogKeydownSnapshot, type ModalKey } from "./dialogRouting";
import type { Message } from "./types";

function baseSnapshot(overrides: Partial<DialogKeydownSnapshot> = {}): DialogKeydownSnapshot {
  return {
    updatePromptOpen: false,
    settingsOpen: false,
    calendarOpen: false,
    contactsOpen: false,
    templatesOpen: false,
    accountsOpen: false,
    composeOpen: false,
    addOpen: false,
    mobileSidebar: false,
    sendingStatusOpen: false,
    translationTermsOpen: false,
    attachmentPreviewOpen: false,
    batchDeleteOpen: false,
    agentOpen: false,
    selectedId: null,
    selected: false,
    keyboardSelectionAnchorId: null,
    accountsLength: 0,
    filteredMessages: [],
    ...overrides,
  };
}

function message(id: string): Message {
  return { id } as Message;
}

function dispatchKeyOn(target: Element | null, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init, key });
  if (target) target.dispatchEvent(event);
  return event;
}

// jsdom does not implement contenteditable semantics (isContentEditable is
// undefined and the contentEditable setter writes no attribute), so simulate
// the browser property the routing code actually reads.
function contentEditableElement(): HTMLDivElement {
  const editable = document.createElement("div");
  Object.defineProperty(editable, "isContentEditable", { value: true });
  return editable;
}

function key(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return dispatchKeyOn(null, key, init);
}

describe("isTypingTarget", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("treats an input as typing", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const event = dispatchKeyOn(input, "n");
    expect(isTypingTarget(event.target)).toBe(true);
  });

  it("treats a textarea as typing", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    const event = dispatchKeyOn(textarea, "n");
    expect(isTypingTarget(event.target)).toBe(true);
  });

  it("treats a select as typing", () => {
    const select = document.createElement("select");
    document.body.appendChild(select);
    const event = dispatchKeyOn(select, "n");
    expect(isTypingTarget(event.target)).toBe(true);
  });

  it("treats a themed select-control descendant as typing", () => {
    const selectControl = document.createElement("div");
    selectControl.className = "select-control";
    const button = document.createElement("button");
    selectControl.appendChild(button);
    document.body.appendChild(selectControl);
    const event = dispatchKeyOn(button, "n");
    expect(isTypingTarget(event.target)).toBe(true);
  });

  it("treats a contentEditable element as typing", () => {
    const editable = contentEditableElement();
    document.body.appendChild(editable);
    const event = dispatchKeyOn(editable, "n");
    expect(isTypingTarget(event.target)).toBe(true);
  });

  it("treats plain body/document targets as not typing", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
  });
});

describe("dialogKeydownDecision · Escape cascade", () => {
  it("closes settings first in the cascade", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ settingsOpen: true, calendarOpen: true }));
    expect(decision?.action).toEqual({ kind: "close_settings" });
    expect(decision?.preventDefault).toBe(false);
  });

  it("closes the calendar", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ calendarOpen: true }));
    expect(decision?.action).toEqual({ kind: "close_calendar" });
  });

  it("closes contacts", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ contactsOpen: true }));
    expect(decision?.action).toEqual({ kind: "close_contacts" });
  });

  it("closes templates", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ templatesOpen: true }));
    expect(decision?.action).toEqual({ kind: "close_templates" });
  });

  it("closes the accounts dialog", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ accountsOpen: true }));
    expect(decision?.action).toEqual({ kind: "close_accounts" });
  });

  it("leaves Escape to the compose modal (dirty-draft confirmation owns it)", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ composeOpen: true }));
    expect(decision).toBeNull();
  });

  it("closes the add-account dialog", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ addOpen: true }));
    expect(decision?.action).toEqual({ kind: "close_add_account" });
  });

  it("closes the mobile sidebar", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ mobileSidebar: true }));
    expect(decision?.action).toEqual({ kind: "close_mobile_sidebar" });
  });

  it("closes the attachment preview before the reader (WEB-1: one Escape, one layer)", () => {
    // The preview drawer stacks above the open message, so with both open the
    // first Escape must close only the preview — never close_reader as well.
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ attachmentPreviewOpen: true, selectedId: "m1" }));
    expect(decision?.action).toEqual({ kind: "close_attachment_preview" });
    expect(decision?.preventDefault).toBe(false);
  });

  it("closes the reader when a message is selected", () => {
    const decision = dialogKeydownDecision(key("Escape"), baseSnapshot({ selectedId: "m1" }));
    expect(decision?.action).toEqual({ kind: "close_reader" });
  });

  it("ignores Escape when nothing is open", () => {
    expect(dialogKeydownDecision(key("Escape"), baseSnapshot())).toBeNull();
  });

  it("absorbs every key while the update prompt is up, preventing default only on Escape", () => {
    const escape = dialogKeydownDecision(key("Escape"), baseSnapshot({ updatePromptOpen: true }));
    expect(escape).toEqual({ action: { kind: "absorb" }, preventDefault: true });
    const composeKey = dialogKeydownDecision(key("n"), baseSnapshot({ updatePromptOpen: true, accountsLength: 1 }));
    expect(composeKey).toEqual({ action: { kind: "absorb" }, preventDefault: false });
  });
});

describe("dialogKeydownDecision · Escape cascade exhaustiveness over MODAL_KEYS", () => {
  // WEB-5 guard: the Escape cascade used to be enumerated by hand and one
  // modal (attachmentPreviewOpen) shipped without a branch, so one Escape
  // closed two layers. This table is typed Record<ModalKey, …>, so a modal
  // added to the snapshot without pinning its Escape outcome here fails to
  // compile — and every entry below asserts the exact decision the shell must
  // return. updatePromptOpen is not in MODAL_KEYS on purpose (App-local
  // state, absorbed before the cascade — see MODAL_KEYS's doc); its Escape
  // outcome is pinned by the update-prompt test in the cascade describe.
  type ExpectedEscape = { action: DialogKeydownAction; preventDefault: boolean } | null;
  const expectedEscape: Record<ModalKey, ExpectedEscape> = {
    settingsOpen: { action: { kind: "close_settings" }, preventDefault: false },
    calendarOpen: { action: { kind: "close_calendar" }, preventDefault: false },
    contactsOpen: { action: { kind: "close_contacts" }, preventDefault: false },
    templatesOpen: { action: { kind: "close_templates" }, preventDefault: false },
    accountsOpen: { action: { kind: "close_accounts" }, preventDefault: false },
    // Compose owns Escape itself: the dirty-draft confirmation must decide
    // before the shell, so the decision layer returns null (leave it to the
    // component layer).
    composeOpen: null,
    addOpen: { action: { kind: "close_add_account" }, preventDefault: false },
    mobileSidebar: { action: { kind: "close_mobile_sidebar" }, preventDefault: false },
    // No shell branch: SendingStatusModal handles Escape in its own capture
    // listener (details → confirm → close), so the shell must stay out.
    sendingStatusOpen: null,
    // No shell branch: TranslationTermsDialog handles Escape in its own
    // capture listener (decline + close), so the shell must stay out.
    translationTermsOpen: null,
    // Preview drawer is the top layer over the reader: closes before
    // close_reader (WEB-1 fix).
    attachmentPreviewOpen: { action: { kind: "close_attachment_preview" }, preventDefault: false },
    // No shell branch: App's batch-delete alertdialog consumes Escape in its
    // own capture listener, so a fallback branch here could only ever fire as
    // the second half of a WEB-1 double-close.
    batchDeleteOpen: null,
    // No shell branch, same reason: the agent workspace closes itself from its
    // own capture listener.
    agentOpen: null,
  };

  it.each(Object.entries(expectedEscape) as Array<[ModalKey, ExpectedEscape]>)(
    "pins Escape with only %s open",
    (modalKey, expected) => {
      const overrides: Partial<DialogKeydownSnapshot> = {};
      overrides[modalKey] = true;
      expect(dialogKeydownDecision(key("Escape"), baseSnapshot(overrides))).toEqual(expected);
    },
  );

  it("covers exactly the snapshot's modal booleans, so nothing bypasses the cascade", () => {
    // The other direction of the guard: every boolean field in
    // DialogKeydownSnapshot must be a MODAL_KEYS entry, except the two
    // deliberate non-modals — updatePromptOpen (App-local state, absorbed
    // before the cascade) and selected ("a message is selected", not an
    // overlay). A new modal boolean added to the snapshot without joining
    // MODAL_KEYS fails here instead of shipping without Escape routing.
    const snapshot = baseSnapshot();
    const booleanKeys = (Object.keys(snapshot) as Array<keyof DialogKeydownSnapshot>).filter((key) => typeof snapshot[key] === "boolean");
    const nonModalBooleans = ["updatePromptOpen", "selected"];
    const modalKeys = booleanKeys.filter((key) => !nonModalBooleans.includes(key));
    expect(new Set(modalKeys)).toEqual(new Set(MODAL_KEYS));
    expect(modalKeys).toHaveLength(MODAL_KEYS.length);
  });
});

describe("dialogKeydownDecision · shortcut gate", () => {
  it.each([
    ["settings", { settingsOpen: true }],
    ["calendar", { calendarOpen: true }],
    ["contacts", { contactsOpen: true }],
    ["templates", { templatesOpen: true }],
    ["accounts", { accountsOpen: true }],
    ["sending status", { sendingStatusOpen: true }],
    ["compose", { composeOpen: true }],
    ["add account", { addOpen: true }],
    ["mobile sidebar", { mobileSidebar: true }],
    ["translation terms", { translationTermsOpen: true }],
    ["attachment preview", { attachmentPreviewOpen: true }],
  ] as const)("freezes shortcuts while %s is open", (_name, open) => {
    expect(dialogKeydownDecision(key("n"), baseSnapshot({ ...open, accountsLength: 1 }))).toBeNull();
    expect(dialogKeydownDecision(key("k", { metaKey: true }), baseSnapshot(open))).toBeNull();
  });

  it("blocks reply/forward/navigation behind the terms dialog and attachment preview", () => {
    const terms = { translationTermsOpen: true };
    const preview = { attachmentPreviewOpen: true, selected: true, filteredMessages: [message("m1"), message("m2")] };
    for (const open of [terms, preview]) {
      expect(dialogKeydownDecision(key("n"), baseSnapshot({ ...open, accountsLength: 1 }))).toBeNull();
      expect(dialogKeydownDecision(key("r"), baseSnapshot(open))).toBeNull();
      expect(dialogKeydownDecision(key("f"), baseSnapshot(open))).toBeNull();
      expect(dialogKeydownDecision(key("j"), baseSnapshot(open))).toBeNull();
      expect(dialogKeydownDecision(key("k"), baseSnapshot(open))).toBeNull();
    }
  });

  it("lets plain letters through when nothing is open", () => {
    const decision = dialogKeydownDecision(key("n"), baseSnapshot({ accountsLength: 1 }));
    expect(decision?.action).toEqual({ kind: "compose" });
  });
});

describe("dialogKeydownDecision · typing targets", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("never triggers shortcuts from an input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(dialogKeydownDecision(dispatchKeyOn(input, "n"), baseSnapshot({ accountsLength: 1 }))).toBeNull();
  });

  it("never triggers shortcuts from a contentEditable", () => {
    const editable = contentEditableElement();
    document.body.appendChild(editable);
    expect(dialogKeydownDecision(dispatchKeyOn(editable, "j"), baseSnapshot({ filteredMessages: [message("m1"), message("m2")] }))).toBeNull();
  });
});

describe("dialogKeydownDecision · Cmd/Ctrl+K", () => {
  it("focuses the search box via metaKey", () => {
    const decision = dialogKeydownDecision(key("k", { metaKey: true }), baseSnapshot());
    expect(decision).toEqual({ action: { kind: "focus_search" }, preventDefault: true });
  });

  it("focuses the search box via ctrlKey", () => {
    const decision = dialogKeydownDecision(key("k", { ctrlKey: true }), baseSnapshot());
    expect(decision?.action).toEqual({ kind: "focus_search" });
  });

  it("is gated behind the modal list like every other shortcut", () => {
    expect(dialogKeydownDecision(key("k", { metaKey: true }), baseSnapshot({ settingsOpen: true }))).toBeNull();
  });
});

describe("dialogKeydownDecision · composition shortcuts", () => {
  it("opens compose on n with accounts", () => {
    const decision = dialogKeydownDecision(key("n"), baseSnapshot({ accountsLength: 2 }));
    expect(decision).toEqual({ action: { kind: "compose" }, preventDefault: true });
  });

  it("opens add-account on n without accounts", () => {
    const decision = dialogKeydownDecision(key("n"), baseSnapshot({ accountsLength: 0 }));
    expect(decision).toEqual({ action: { kind: "add_account" }, preventDefault: true });
  });

  it("replies on r with a selected message", () => {
    const decision = dialogKeydownDecision(key("r"), baseSnapshot({ selected: true }));
    expect(decision).toEqual({ action: { kind: "reply" }, preventDefault: true });
  });

  it("replies to all on shift+r", () => {
    const decision = dialogKeydownDecision(key("r", { shiftKey: true }), baseSnapshot({ selected: true }));
    expect(decision?.action).toEqual({ kind: "reply_all" });
  });

  it("does nothing on r without a selected message", () => {
    expect(dialogKeydownDecision(key("r"), baseSnapshot({ selected: false }))).toBeNull();
  });

  it("forwards on f with a selected message", () => {
    const decision = dialogKeydownDecision(key("f"), baseSnapshot({ selected: true }));
    expect(decision).toEqual({ action: { kind: "forward" }, preventDefault: true });
  });

  it("does nothing on f without a selected message", () => {
    expect(dialogKeydownDecision(key("f"), baseSnapshot({ selected: false }))).toBeNull();
  });

  it("releases modifier-only keys (alt, ctrl, meta)", () => {
    expect(dialogKeydownDecision(key("n", { altKey: true }), baseSnapshot({ accountsLength: 1 }))).toBeNull();
    expect(dialogKeydownDecision(key("r", { ctrlKey: true }), baseSnapshot({ selected: true }))).toBeNull();
    expect(dialogKeydownDecision(key("f", { metaKey: true }), baseSnapshot({ selected: true }))).toBeNull();
  });
});

describe("dialogKeydownDecision · j/k navigation", () => {
  const three = [message("m1"), message("m2"), message("m3")];

  it("opens the first message on j with no selection", () => {
    const decision = dialogKeydownDecision(key("j"), baseSnapshot({ selectedId: null, filteredMessages: three }));
    expect(decision?.action).toEqual({ kind: "open_message", message: three[0] });
    expect(decision?.preventDefault).toBe(true);
  });

  it("opens the last message on k with no selection", () => {
    const decision = dialogKeydownDecision(key("k"), baseSnapshot({ selectedId: null, filteredMessages: three }));
    expect(decision?.action).toEqual({ kind: "open_message", message: three[2] });
  });

  it("steps forward on j from a middle selection", () => {
    const decision = dialogKeydownDecision(key("j"), baseSnapshot({ selectedId: "m2", filteredMessages: three }));
    expect(decision?.action).toEqual({ kind: "open_message", message: three[2] });
  });

  it("steps backward on k from a middle selection", () => {
    const decision = dialogKeydownDecision(key("k"), baseSnapshot({ selectedId: "m2", filteredMessages: three }));
    expect(decision?.action).toEqual({ kind: "open_message", message: three[0] });
  });

  it("does nothing when j overruns the end", () => {
    expect(dialogKeydownDecision(key("j"), baseSnapshot({ selectedId: "m3", filteredMessages: three }))).toBeNull();
  });

  it("does nothing when k underruns the start", () => {
    expect(dialogKeydownDecision(key("k"), baseSnapshot({ selectedId: "m1", filteredMessages: three }))).toBeNull();
  });

  it("does nothing on unbound keys", () => {
    expect(dialogKeydownDecision(key("g"), baseSnapshot({ filteredMessages: three }))).toBeNull();
  });

  it("selects from the first row on shift+j with no selection or anchor", () => {
    const decision = dialogKeydownDecision(key("j", { shiftKey: true }), baseSnapshot({ filteredMessages: three }));
    expect(decision?.action).toEqual({ kind: "select_range", ids: ["m1"] });
    expect(decision?.preventDefault).toBe(true);
  });

  it("selects from the last row on shift+k with no selection or anchor", () => {
    const decision = dialogKeydownDecision(key("k", { shiftKey: true }), baseSnapshot({ filteredMessages: three }));
    expect(decision?.action).toEqual({ kind: "select_range", ids: ["m3"] });
  });

  it("expands from the selected message without an anchor", () => {
    const down = dialogKeydownDecision(key("j", { shiftKey: true }), baseSnapshot({ selectedId: "m2", filteredMessages: three }));
    expect(down?.action).toEqual({ kind: "select_range", ids: ["m2", "m3"] });
    const up = dialogKeydownDecision(key("k", { shiftKey: true }), baseSnapshot({ selectedId: "m2", filteredMessages: three }));
    expect(up?.action).toEqual({ kind: "select_range", ids: ["m1", "m2"] });
  });

  it("walks the span from the anchor on repeated shift+j", () => {
    // The decision layer returns the closed span from the anchor to the next
    // row; App merges it into the selection, so repeated presses read as a
    // growing selection even though each decision is a fresh span.
    const first = dialogKeydownDecision(key("j", { shiftKey: true }), baseSnapshot({ filteredMessages: three }));
    expect(first?.action).toEqual({ kind: "select_range", ids: ["m1"] });
    const second = dialogKeydownDecision(key("j", { shiftKey: true }), baseSnapshot({ keyboardSelectionAnchorId: "m1", filteredMessages: three }));
    expect(second?.action).toEqual({ kind: "select_range", ids: ["m1", "m2"] });
    const third = dialogKeydownDecision(key("j", { shiftKey: true }), baseSnapshot({ keyboardSelectionAnchorId: "m2", filteredMessages: three }));
    expect(third?.action).toEqual({ kind: "select_range", ids: ["m2", "m3"] });
  });

  it("expands upward from the anchor with shift+k", () => {
    const decision = dialogKeydownDecision(key("k", { shiftKey: true }), baseSnapshot({ keyboardSelectionAnchorId: "m3", filteredMessages: three }));
    expect(decision?.action).toEqual({ kind: "select_range", ids: ["m2", "m3"] });
  });

  it("falls back to the selected message when the anchor is stale", () => {
    const decision = dialogKeydownDecision(
      key("j", { shiftKey: true }),
      baseSnapshot({ keyboardSelectionAnchorId: "m-ghost", selectedId: "m2", filteredMessages: three }),
    );
    expect(decision?.action).toEqual({ kind: "select_range", ids: ["m2", "m3"] });
  });

  it("does nothing when a shift expansion overruns the list", () => {
    expect(dialogKeydownDecision(key("j", { shiftKey: true }), baseSnapshot({ keyboardSelectionAnchorId: "m3", filteredMessages: three }))).toBeNull();
    expect(dialogKeydownDecision(key("k", { shiftKey: true }), baseSnapshot({ keyboardSelectionAnchorId: "m1", filteredMessages: three }))).toBeNull();
  });
});