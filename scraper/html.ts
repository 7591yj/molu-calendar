import { isTag } from "domhandler";
import type { ChildNode as DomNode, Element } from "domhandler";
import { DomUtils, parseDocument } from "htmlparser2";

export type Block =
  | { type: "line"; text: string }
  | { type: "image"; src: string; name: string }
  | { type: "table"; rows: string[][] };

const BREAKING =
  /^(p|div|br|li|ul|ol|h[1-6]|tr|section|article|blockquote|hr)$/;
const REMOVED = new Set(["script", "style", "s", "strike", "del"]);

export function cleanText(text: string): string {
  return text
    .replace(/[\u00a0\u200b\ufeff]/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .trim();
}

export function decodeEntities(text: string): string {
  return cleanText(DomUtils.textContent(parseDocument(text)));
}

function isElement(node: DomNode): node is Element {
  return isTag(node);
}

function nodeText(node: DomNode): string {
  if (node.type === "text") return (node as { data: string }).data;
  if (!isElement(node)) return "";
  if (node.name === "br") return "\n";
  const inner = node.children.map(nodeText).join("");
  return BREAKING.test(node.name) ? `\n${inner}\n` : inner;
}

function cellLines(cell: Element): string {
  return nodeText(cell).split("\n").map(cleanText).filter(Boolean).join("\n");
}

function tableRows(table: Element): string[][] {
  const rows = DomUtils.getElementsByTagName("tr", table.children);
  const grid: string[][] = [];
  const carry: { text: string; left: number }[] = [];
  rows.forEach((row, rowIndex) => {
    const out: string[] = [];
    const cells = row.children.filter(
      (c): c is Element => isElement(c) && (c.name === "td" || c.name === "th"),
    );
    let column = 0;
    const fillCarried = () => {
      while (carry[column] && carry[column]!.left > 0) {
        out[column] = carry[column]!.text;
        carry[column]!.left -= 1;
        column += 1;
      }
    };
    for (const cell of cells) {
      fillCarried();
      const text = cellLines(cell);
      const rowspan = Math.max(
        1,
        Math.min(50, Number(cell.attribs.rowspan) || 1),
      );
      const colspan = Math.max(
        1,
        Math.min(20, Number(cell.attribs.colspan) || 1),
      );
      for (let span = 0; span < colspan; span++) {
        out[column] = text;
        carry[column] = { text, left: rowspan - 1 };
        column += 1;
      }
    }
    fillCarried();
    grid[rowIndex] = Array.from(out, (value) => value ?? "");
  });
  return grid.filter((row) => row.some(Boolean));
}

function imageUrl(src: string | undefined): string | null {
  if (!src) return null;
  try {
    const url = new URL(src, "https://forum.nexon.com/");
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function imageName(src: string): string {
  try {
    return decodeURIComponent(new URL(src).pathname.split("/").pop() ?? "");
  } catch {
    return src.split("/").pop() ?? "";
  }
}

export function noticeBlocks(html: string): Block[] {
  const dom = parseDocument(html);
  for (const name of REMOVED) {
    for (const element of DomUtils.getElementsByTagName(name, dom.children))
      DomUtils.removeElement(element);
  }
  const blocks: Block[] = [];
  let buffer = "";
  const flush = () => {
    for (const line of buffer.split("\n").map(cleanText))
      if (line) blocks.push({ type: "line", text: line });
    buffer = "";
  };
  const walk = (node: DomNode) => {
    if (node.type === "text") {
      buffer += (node as { data: string }).data;
      return;
    }
    if (!isElement(node)) return;
    if (node.name === "table") {
      flush();
      const rows = tableRows(node);
      if (rows.length) blocks.push({ type: "table", rows });
      return;
    }
    if (node.name === "img") {
      const src = imageUrl(node.attribs.src);
      if (src) {
        flush();
        blocks.push({ type: "image", src, name: imageName(src) });
      }
      return;
    }
    if (node.name === "br") {
      buffer += "\n";
      return;
    }
    const breaking = BREAKING.test(node.name);
    if (breaking) buffer += "\n";
    node.children.forEach(walk);
    if (breaking) buffer += "\n";
  };
  dom.children.forEach(walk);
  flush();
  return blocks;
}
