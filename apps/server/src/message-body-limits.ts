/**
 * Hard ceiling on the body parts a synced message may store.
 *
 * The stored payload is what every later read pays for: one AES decrypt plus
 * one JSON.parse per row on the folder view, and the full string handed to
 * DOMPurify when the message is opened. A message whose body is a 50-200MB
 * `data:` URL image (inline base64 needs no attachment part, so the
 * attachment-metadata path never sees it) therefore costs the whole process
 * — not just its own row — on a single inbox refresh. `messages.size` cannot
 * gate this: the provider reports the RFC822 size, which includes attachment
 * bytes the design deliberately never stores, and the body size is only known
 * after parsing.
 *
 * The chosen ceilings follow the product's own limits: outbound attachments
 * are 10MB per file / 25MB per message (apps/server/src/outbound-attachments.ts)
 * and the inline image proxy stores 10MB files, so a legitimate bulk mail
 * carries its weight in attachments — which are metadata-only here and fetched
 * on demand — and its HTML stays far below 1MB. 1 MiB of text and 5 MiB of
 * HTML are one to two orders of magnitude above real newsletters while
 * bounding one stored payload to 6 MiB.
 */
export const MAX_STORED_TEXT_BODY_BYTES = 1024 * 1024;
export const MAX_STORED_HTML_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Appended in place of the discarded tail. Truncation is deliberately not a
 * drop: the sender, avatar, subject and attachment list still describe the
 * message, and the user can still export the untouched original
 * (GET /api/messages/:id/eml downloads the provider source on demand).
 */
export const TRUNCATED_BODY_NOTICE = "（正文过大，已截断显示。完整内容请在邮件客户端中打开原始邮件。）";

const TRUNCATED_HTML_NOTICE = `<p>${TRUNCATED_BODY_NOTICE}</p>`;

/**
 * Longest UTF-16 prefix of `value` whose UTF-8 encoding fits `maxBytes`.
 * Binary search over the code-unit index keeps the number of native
 * `Buffer.byteLength` scans logarithmic, so an oversized 200MB body is
 * measured in tens of passes rather than one per character.
 */
function utf8Prefix(value: string, maxBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let cut = value.slice(0, low);
  // A split surrogate pair would leave a lone surrogate in the stored string.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

/** Drops a trailing partial tag so the notice cannot be swallowed by it. */
function cutHtmlPrefix(value: string): string {
  const lastOpen = value.lastIndexOf("<");
  return lastOpen > value.lastIndexOf(">") ? value.slice(0, lastOpen) : value;
}

function limitBody(value: string, maxBytes: number, notice: string, html: boolean): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const cut = utf8Prefix(value, maxBytes);
  return html ? `${cutHtmlPrefix(cut)}${notice}` : `${cut}\n\n${notice}`;
}

export function limitStoredTextBody(value: string): string {
  return limitBody(value, MAX_STORED_TEXT_BODY_BYTES, TRUNCATED_BODY_NOTICE, false);
}

export function limitStoredHtmlBody(value: string): string {
  return limitBody(value, MAX_STORED_HTML_BODY_BYTES, TRUNCATED_HTML_NOTICE, true);
}
