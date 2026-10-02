// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collapseQuotedMailHtml, splitBodyLinks, splitQuotedMailText } from "./app-utils";

describe("collapseQuotedMailHtml", () => {
  it("folds a top-level blockquote into a details toggle", () => {
    const html = "<p>Reply text</p><blockquote><p>quoted history</p></blockquote>";
    const folded = collapseQuotedMailHtml(html, "显示引用的原文");
    expect(folded).toContain('<details class="mail-quote"><summary>显示引用的原文</summary>');
    expect(folded).toContain("<blockquote><p>quoted history</p></blockquote>");
    expect(folded).toContain("<p>Reply text</p>");
  });

  it("folds a gmail_quote wrapper as one block without double-wrapping its inner blockquote", () => {
    const html = '<p>Reply</p><div class="gmail_quote"><div class="gmail_attr">On … wrote:</div><blockquote><p>quoted</p></blockquote></div>';
    const folded = collapseQuotedMailHtml(html, "Show quoted text");
    expect(folded.match(/<details class="mail-quote">/g)).toHaveLength(1);
    expect(folded).toContain("On … wrote:");
    expect(folded).toContain("<blockquote><p>quoted</p></blockquote>");
  });

  it("folds only the outermost quote when quotes are nested", () => {
    const html = "<p>Reply</p><blockquote><p>first</p><blockquote><p>second</p></blockquote></blockquote>";
    const folded = collapseQuotedMailHtml(html, "Show quoted text");
    expect(folded.match(/<details class="mail-quote">/g)).toHaveLength(1);
  });

  it("folds each sibling quote at its original position", () => {
    const html = "<blockquote><p>q1</p></blockquote><p>middle</p><blockquote><p>q2</p></blockquote>";
    const folded = collapseQuotedMailHtml(html, "Show quoted text");
    expect(folded.match(/<details class="mail-quote">/g)).toHaveLength(2);
    expect(folded.indexOf("middle")).toBeGreaterThan(folded.indexOf("q1"));
    expect(folded.indexOf("q2")).toBeGreaterThan(folded.indexOf("middle"));
  });

  it("returns the input unchanged when there is nothing to fold", () => {
    const html = "<p>Just a message.</p>";
    expect(collapseQuotedMailHtml(html, "Show quoted text")).toBe(html);
    expect(collapseQuotedMailHtml("", "Show quoted text")).toBe("");
  });
});

describe("splitQuotedMailText", () => {
  it('splits a trailing ">" quote block, including blank lines inside it', () => {
    const text = "Hello\n\nReply body.\n\n> quoted answer\n\n> more quoting\n";
    expect(splitQuotedMailText(text)).toEqual({ body: "Hello\n\nReply body.", quote: "> quoted answer\n\n> more quoting" });
  });

  it("splits at a classic separator header even without > prefixes", () => {
    const text = "收到。\n\n-----原始邮件-----\n发件人: Someone\n正文被旧客户端复制下来";
    const parts = splitQuotedMailText(text);
    expect(parts.body).toBe("收到。");
    expect(parts.quote).toContain("-----原始邮件-----");
    expect(parts.quote).toContain("正文被旧客户端复制下来");
  });

  it("supports the English original-message separator", () => {
    const text = "Got it.\n\n----- Original Message -----\nFrom: Someone\nforwarded body";
    const parts = splitQuotedMailText(text);
    expect(parts.body).toBe("Got it.");
    expect(parts.quote).toContain("forwarded body");
  });

  it("leaves interleaved replies inline and only folds the trailing quote", () => {
    const text = "answer one\n\n> old quote\n\nanswer two\n\n> newer quote";
    const parts = splitQuotedMailText(text);
    expect(parts.body).toBe("answer one\n\n> old quote\n\nanswer two");
    expect(parts.quote).toBe("> newer quote");
  });

  it("never folds when the whole message is a quote", () => {
    const text = "> all quoted";
    expect(splitQuotedMailText(text)).toEqual({ body: text, quote: "" });
  });

  it("returns plain text unchanged when there is no quote", () => {
    const text = "Hello\n\nNothing quoted here.";
    expect(splitQuotedMailText(text)).toEqual({ body: text, quote: "" });
  });
});

/** Re-assembles the parts the way the reader concatenates them. */
function joined(parts: ReturnType<typeof splitBodyLinks>): string {
  return parts.map((part) => part.text).join("");
}

function links(parts: ReturnType<typeof splitBodyLinks>): string[] {
  return parts.flatMap((part) => part.kind === "link" && part.href ? [part.href] : []);
}

describe("splitBodyLinks", () => {
  it("linkifies a bare URL and keeps the sentence around it as text", () => {
    const parts = splitBodyLinks("Fix available: https://github.com/o/r/pull/42");
    expect(parts).toEqual([
      { kind: "text", text: "Fix available: " },
      { kind: "link", text: "https://github.com/o/r/pull/42", href: "https://github.com/o/r/pull/42" },
    ]);
  });

  it("leaves sentence punctuation outside the link", () => {
    expect(links(splitBodyLinks("See https://example.com/a."))).toEqual(["https://example.com/a"]);
    expect(joined(splitBodyLinks("See https://example.com/a."))).toBe("See https://example.com/a.");
    for (const tail of [",", ";", ":", ")", "]", "\"", "'", "!", "?"]) {
      expect(links(splitBodyLinks(`ref https://example.com/a${tail}`)), tail).toEqual(["https://example.com/a"]);
    }
  });

  it("keeps a bracket the URL itself opened", () => {
    expect(links(splitBodyLinks("see https://en.example.org/wiki/Foo_(bar) end"))).toEqual(["https://en.example.org/wiki/Foo_(bar)"]);
    expect(links(splitBodyLinks("https://example.com/a)"))).toEqual(["https://example.com/a"]);
    expect(links(splitBodyLinks("https://example.com/a#frag)"))).toEqual(["https://example.com/a#frag"]);
  });

  it("handles the angle-bracket form without losing the brackets", () => {
    const parts = splitBodyLinks("mirror: <https://example.com/m>");
    expect(links(parts)).toEqual(["https://example.com/m"]);
    expect(joined(parts)).toBe("mirror: <https://example.com/m>");
    expect(parts[0].text.endsWith("<")).toBe(true);
    expect(parts[parts.length - 1].text.startsWith(">")).toBe(true);
  });

  it("linkifies several URLs on one line", () => {
    const parts = splitBodyLinks("a https://one.example/x b https://two.example/y?z=1 c");
    expect(links(parts)).toEqual(["https://one.example/x", "https://two.example/y?z=1"]);
    expect(joined(parts)).toBe("a https://one.example/x b https://two.example/y?z=1 c");
  });

  it("stops the link at Chinese text and full-width punctuation", () => {
    const parts = splitBodyLinks("已合并 https://github.com/o/r/pull/12 的依赖升级，请查看。");
    expect(links(parts)).toEqual(["https://github.com/o/r/pull/12"]);
    expect(joined(parts)).toBe("已合并 https://github.com/o/r/pull/12 的依赖升级，请查看。");
    expect(joined(splitBodyLinks("链接（https://example.com/x）"))).toBe("链接（https://example.com/x）");
    expect(links(splitBodyLinks("链接（https://example.com/x）"))).toEqual(["https://example.com/x"]);
  });

  it("does not linkify a URL that is the tail of a longer word", () => {
    expect(links(splitBodyLinks("see xhttps://example.com/a"))).toEqual([]);
  });

  it("refuses every scheme that is not http or https", () => {
    for (const body of [
      "javascript:alert(1)",
      "JavaScript:alert(document.domain)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///etc/passwd",
      "mailto:a@example.com",
      "ftp://example.com/x",
      "vbscript:msgbox(1)",
    ]) {
      expect(links(splitBodyLinks(body)), body).toEqual([]);
      expect(joined(splitBodyLinks(body)), body).toBe(body);
    }
  });

  it("keeps an executable scheme as prose even when a real link follows it", () => {
    const body = "javascript:alert(1) then https://example.com/a";
    expect(links(splitBodyLinks(body))).toEqual(["https://example.com/a"]);
    expect(joined(splitBodyLinks(body))).toBe(body);
  });

  it("returns text without links as a single untouched part", () => {
    expect(splitBodyLinks("没有链接的正文。")).toEqual([{ kind: "text", text: "没有链接的正文。" }]);
    expect(splitBodyLinks("")).toEqual([]);
  });

  it("preserves every character — newlines, blank lines, tabs and runs of spaces", () => {
    const body = "第一段\n\n第二段\t带制表符  和   连续空格\n\n    https://example.com/a\n\n尾部  \n";
    const parts = splitBodyLinks(body);
    expect(parts).toEqual([
      { kind: "text", text: "第一段\n\n第二段\t带制表符  和   连续空格\n\n    " },
      { kind: "link", text: "https://example.com/a", href: "https://example.com/a" },
      { kind: "text", text: "\n\n尾部  \n" },
    ]);
    expect(joined(parts)).toBe(body);
  });

  it("preserves a CRLF body verbatim", () => {
    const body = "line one\r\n\r\nhttps://example.com/a\r\n";
    const parts = splitBodyLinks(body);
    expect(parts.filter((part) => part.kind === "text").map((part) => part.text).join("")).toBe("line one\r\n\r\n\r\n");
    expect(joined(parts)).toBe(body);
  });

  it("is idempotent: the same input yields the same parts, and prose stays prose", () => {
    const body = "已发布 https://example.com/a 详情，文档 https://example.com/docs。\n\n— Sent";
    const first = splitBodyLinks(body);
    expect(splitBodyLinks(joined(first))).toEqual(first);
    for (const part of first.filter((candidate) => candidate.kind === "text")) {
      expect(splitBodyLinks(part.text)).toEqual([{ kind: "text", text: part.text }]);
    }
  });

  it("does not linkify a bare scheme with no authority", () => {
    expect(links(splitBodyLinks("broken https:// and more"))).toEqual([]);
    expect(joined(splitBodyLinks("broken https:// and more"))).toBe("broken https:// and more");
  });
});
