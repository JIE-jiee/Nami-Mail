// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MailTextBody } from "./MailTextBody";

describe("MailTextBody", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  async function render(node: React.ReactNode) {
    await act(async () => root.render(<div className="mail-text">{node}</div>));
  }

  it("renders a bare URL as a link that the shell can hand to the browser", async () => {
    await render(<MailTextBody body="Fix: https://github.com/o/r/pull/42" />);
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://github.com/o/r/pull/42");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchor?.textContent).toBe("https://github.com/o/r/pull/42");
  });

  it("keeps the surrounding prose in the same text node, character for character", async () => {
    const body = "已合并 https://github.com/o/r/pull/12\n\n的依赖升级，请查看。";
    await render(<MailTextBody body={body} />);
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector(".mail-text")?.textContent).toBe(body);
    // Whitespace survives because the runs are plain strings, not markup.
    expect(container.querySelector(".mail-text")?.innerHTML).toContain("\n\n");
  });

  it("renders the suffix after the prose, as the quote fold does", () => {
    const markup = renderToStaticMarkup(
      <MailTextBody
        body={"body https://example.com/a"}
        suffix={<button type="button" className="mail-quote-toggle">显示引用的原文</button>}
      />,
    );
    expect(markup.indexOf("<button")).toBeGreaterThan(markup.indexOf("<a"));
  });

  it("leaves a body without links as the one text node it always was", async () => {
    const body = "没有链接的正文。\n\n第二段。";
    await render(<MailTextBody body={body} />);
    const prose = container.querySelector(".mail-text")!;
    expect(prose.querySelectorAll("a")).toHaveLength(0);
    expect(prose.childNodes).toHaveLength(1);
    expect(prose.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(prose.textContent).toBe(body);
  });

  it("never lets markup in a body reach the DOM, and never links a non-http scheme", async () => {
    const body = '<img src=x onerror="alert(1)"> javascript:alert(2) data:text/html,<script>alert(3)</script>';
    const markup = renderToStaticMarkup(<MailTextBody body={body} />);
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<a ");
    expect(markup).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; javascript:alert(2) data:text/html,&lt;script&gt;alert(3)&lt;/script&gt;');
    await render(<MailTextBody body={body} />);
    const prose = container.querySelector(".mail-text")!;
    expect(prose.querySelectorAll("img, script, a")).toHaveLength(0);
    expect(prose.childNodes).toHaveLength(1);
    expect(prose.textContent).toBe(body);
  });

  it("does not invent a link out of a URL glued to a word", () => {
    const markup = renderToStaticMarkup(<MailTextBody body="xhttps://example.com/a" />);
    expect(markup).not.toContain("<a ");
  });
});
