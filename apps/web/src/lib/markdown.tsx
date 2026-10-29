import { createElement, type ReactNode } from "react";

// A small, dependency-free Markdown renderer that builds React elements (never raw HTML), so document
// content cannot inject markup or scripts. Supports headings, paragraphs, lists, quotes, fenced code,
// rules, **bold**, *italic*, `code` and http(s)/mailto links.

const SAFE_URL = /^(https?:\/\/|mailto:|#|\/)/i;

function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0; let index = 0; let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0]; const key = keyPrefix + "-" + index++;
    if (match[1]) out.push(createElement("code", { key }, token.slice(1, -1)));
    else if (match[2]) out.push(createElement("strong", { key }, token.slice(2, -2)));
    else if (match[3]) out.push(createElement("em", { key }, token.slice(1, -1)));
    else {
      const parts = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (parts && SAFE_URL.test(parts[2])) out.push(createElement("a", { key, href: parts[2], target: "_blank", rel: "noopener noreferrer" }, parts[1]));
      else out.push(token); // unsafe scheme such as javascript: stays as inert text
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0; let key = 0;
  const next = () => "b" + key++;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push(createElement("pre", { key: next() }, createElement("code", null, code.join("\n"))));
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { const level = heading[1].length; const k = next(); blocks.push(createElement("h" + (level + 1), { key: k }, ...inline(heading[2], k))); i++; continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { blocks.push(createElement("hr", { key: next() })); i++; continue; }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      const k = next(); blocks.push(createElement("blockquote", { key: k }, ...inline(quote.join(" "), k))); continue;
    }
    const bullet = /^\s*[-*]\s+/; const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line); const marker = ordered ? numbered : bullet; const items: ReactNode[] = [];
      while (i < lines.length && marker.test(lines[i])) { const k = next(); items.push(createElement("li", { key: k }, ...inline(lines[i].replace(marker, ""), k))); i++; }
      blocks.push(createElement(ordered ? "ol" : "ul", { key: next() }, ...items)); continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>\s?|\s*[-*]\s+|\s*\d+[.)]\s+|-{3,}\s*$)/.test(lines[i])) paragraph.push(lines[i++]);
    if (!paragraph.length) { paragraph.push(lines[i++]); }
    const k = next(); blocks.push(createElement("p", { key: k }, ...inline(paragraph.join(" "), k)));
  }
  return blocks;
}
