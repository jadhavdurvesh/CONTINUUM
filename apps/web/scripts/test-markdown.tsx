import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "../src/lib/markdown";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error("Markdown test failed: " + message);
}
const html = (md: string) => renderToStaticMarkup(createElement("div", null, ...renderMarkdown(md)));

assert(html("# Title").includes("<h2>Title</h2>"), "heading");
assert(html("**bold** and *it* and `code`").includes("<strong>bold</strong>") && html("*it*").includes("<em>it</em>"), "inline styles");
assert(html("- a\n- b").includes("<ul><li>a</li><li>b</li></ul>"), "bullet list");
assert(html("1. a\n2. b").includes("<ol><li>a</li><li>b</li></ol>"), "ordered list");
assert(html("```js\nlet a = 1 < 2;\n```").includes("let a = 1 &lt; 2;"), "code block is escaped");
assert(!html("<script>alert(1)</script>").includes("<script>"), "raw HTML is escaped");
assert(html("<img src=x onerror=alert(1)>").includes("&lt;img"), "img tag is escaped");
assert(!html("[x](javascript:alert(1))").includes("href"), "javascript: links are inert");
assert(html("[docs](https://example.com)").includes('href="https://example.com"') && html("[docs](https://example.com)").includes("noopener"), "safe links open safely");
assert(html("> quote").includes("<blockquote>quote</blockquote>"), "blockquote");
assert(html("line one\nline two").includes("<p>line one line two</p>"), "paragraph joins lines");
console.log("Markdown tests passed.");
