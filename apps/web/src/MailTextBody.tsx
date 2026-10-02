import { Fragment, type ReactNode } from "react";
import { splitBodyLinks } from "./app/app-utils";

/**
 * Renders a plain-text mail body, turning bare http(s) URLs into real links.
 *
 * The plain-text path is prose the reader typesets, not markup it renders, so
 * every run of plain text is emitted as a bare string child and React escapes
 * it — there is no HTML path here at all and none may be added. A link's `href`
 * is exactly the URL the splitter matched, and the splitter only ever matches
 * http/https, so no executable scheme (`javascript:`, `data:`, `file:`) can
 * reach the attribute.
 *
 * `target="_blank"` is what routes a click to the system browser: the desktop
 * shell's `setWindowOpenHandler` is already the one place that decides what an
 * external link does, and the HTML body already goes through it.
 */
export function MailTextBody({ body, suffix }: { body: string; suffix?: ReactNode }) {
  return (
    <>
      {splitBodyLinks(body).map((part, index) => part.kind === "link"
        ? <a key={`link:${index}:${part.href}`} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
        : <Fragment key={`text:${index}`}>{part.text}</Fragment>)}
      {suffix}
    </>
  );
}
