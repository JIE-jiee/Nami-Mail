import { describe, expect, it } from "vitest";
import {
  MAX_STORED_HTML_BODY_BYTES,
  MAX_STORED_TEXT_BODY_BYTES,
  TRUNCATED_BODY_NOTICE,
  limitStoredHtmlBody,
  limitStoredTextBody,
} from "../src/message-body-limits.js";

const textCap = MAX_STORED_TEXT_BODY_BYTES;
const htmlCap = MAX_STORED_HTML_BODY_BYTES;

describe("stored body limits", () => {
  it("leaves a body under the ceiling byte-for-byte identical", () => {
    const text = "a normal body\nwith a couple of lines";
    const html = "<p>a normal body</p>";
    expect(limitStoredTextBody(text)).toBe(text);
    expect(limitStoredHtmlBody(html)).toBe(html);
  });

  it("keeps an exactly-at-the-ceiling body intact", () => {
    const text = "a".repeat(textCap);
    const html = `<p>${"a".repeat(htmlCap - 7)}</p>`;
    expect(Buffer.byteLength(limitStoredTextBody(text), "utf8")).toBe(textCap);
    expect(limitStoredHtmlBody(html)).toBe(html);
  });

  it("truncates an oversized text body, keeps its head and appends the notice", () => {
    const body = "b".repeat(textCap + 4096);
    const stored = limitStoredTextBody(body);

    expect(stored.startsWith("b".repeat(1024))).toBe(true);
    expect(stored.endsWith(`\n\n${TRUNCATED_BODY_NOTICE}`)).toBe(true);
    // The notice is the only thing added on top of the capped prefix.
    const prefix = stored.slice(0, stored.length - TRUNCATED_BODY_NOTICE.length - 2);
    expect(Buffer.byteLength(prefix, "utf8")).toBeLessThanOrEqual(textCap);
    expect(prefix.length).toBeGreaterThan(textCap - 64);
  });

  it("measures the text ceiling in UTF-8 bytes, so a CJK body is cut below the character count", () => {
    // Three UTF-8 bytes per character: a body well under one million
    // characters still crosses a one-megabyte byte ceiling.
    const body = "邮".repeat(400_000);
    expect(body.length).toBeLessThan(textCap);
    const stored = limitStoredTextBody(body);
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(textCap + 2 + Buffer.byteLength(TRUNCATED_BODY_NOTICE, "utf8"));
    expect(stored.endsWith(TRUNCATED_BODY_NOTICE)).toBe(true);
  });

  it("never leaves a split surrogate pair in a truncated body", () => {
    const stored = limitStoredTextBody("😀".repeat(400_000));
    expect(/[\uD800-\uDBFF]$/.test(stored.slice(0, stored.length - TRUNCATED_BODY_NOTICE.length - 2))).toBe(false);
  });

  it("truncates an oversized html body outside of any partial tag and appends a paragraph", () => {
    const stored = limitStoredHtmlBody(`<p>${"a".repeat(htmlCap + 4096)}<img src="data:image/png;base64,AAAA`);

    expect(stored.endsWith(`<p>${TRUNCATED_BODY_NOTICE}</p>`)).toBe(true);
    const prefix = stored.slice(0, stored.length - `<p>${TRUNCATED_BODY_NOTICE}</p>`.length);
    // The dropped tail starts mid-attribute, so the retained prefix must not
    // end inside a tag — otherwise the notice would be swallowed by it.
    expect(prefix.lastIndexOf("<")).toBeLessThanOrEqual(prefix.lastIndexOf(">"));
    expect(prefix).toContain("<p>aaaa");
  });
});
