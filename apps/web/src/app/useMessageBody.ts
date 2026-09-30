import { useEffect } from "react";
import { api } from "../api";
import type { ThreadSnapshot } from "../threads";
import type { Message } from "../types";

type MessagesSetter = (update: (items: Message[]) => Message[]) => void;
type ThreadExtrasSetter = (update: (current: ThreadSnapshot | null) => ThreadSnapshot | null) => void;

/**
 * Loads the body of the message the reader has open.
 *
 * A list row carries no body: `GET /api/messages` answers with a bounded text
 * preview and no HTML part, because a page that serialized every stored body
 * is what turns a few oversized messages into a frozen inbox refresh. Anything
 * that reads a body — the reader, quoting a reply, translating, editing a
 * draft — therefore needs the per-message endpoint, and the open message is the
 * only one it ever needs.
 *
 * The loaded message is merged back into the list state (and into the thread
 * snapshot, which the reader also resolves from) so every existing consumer
 * keeps reading one row: a background refresh that swaps the row for a
 * body-less one re-triggers this effect, and a message whose real body is
 * empty never loops, because a detail response always carries both body keys.
 */
export function useMessageBody(
  isDemo: boolean,
  openMessage: Message | null,
  setMessages: MessagesSetter,
  setThreadExtras: ThreadExtrasSetter,
): void {
  useEffect(() => {
    if (isDemo || !openMessage || openMessage.htmlBody !== undefined) return;
    let cancelled = false;
    void api.message(openMessage.id).then((detail) => {
      if (cancelled) return;
      setMessages((items) => items.map((item) => (item.id === detail.id ? detail : item)));
      setThreadExtras((current) => (current
        ? { ...current, members: current.members.map((member) => (member.id === detail.id ? detail : member)) }
        : current));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [isDemo, openMessage, setMessages, setThreadExtras]);
}
