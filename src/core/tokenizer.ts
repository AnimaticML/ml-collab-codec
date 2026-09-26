import { type Diagnostic, type SourceSpan, diag } from "./diagnostics.ts";

/** Raw, schema-unaware syntax tree for the constrained tagged format. */
export interface RawAttribute {
  readonly rawName: string;
  readonly value: string;
  readonly span: SourceSpan;
}

export interface RawElement {
  readonly kind: "element";
  readonly tag: string;
  readonly attributes: readonly RawAttribute[];
  readonly children: readonly RawNode[];
  readonly span: SourceSpan;
}

export interface RawJsonBlock {
  readonly kind: "json";
  readonly target: string | null;
  readonly raw: string;
  readonly span: SourceSpan;
}

export type RawNode = string | RawElement | RawJsonBlock;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body.startsWith("#x") || body.startsWith("#X");
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      // Out-of-range code points stay literal text instead of throwing on hostile input.
      return Number.isSafeInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body];
    return named ?? match;
  });
}

const NAME_CHAR = /[A-Za-z0-9_.-]/;

class Scanner {
  pos = 0;
  readonly diagnostics: Diagnostic[] = [];
  constructor(readonly source: string) {}

  eof(): boolean {
    return this.pos >= this.source.length;
  }
  peek(offset = 0): string {
    return this.source.charAt(this.pos + offset);
  }
  startsWith(text: string): boolean {
    return this.source.startsWith(text, this.pos);
  }
  skipWhitespace(): void {
    while (!this.eof() && /\s/.test(this.peek())) this.pos += 1;
  }
  error(code: Diagnostic["code"], message: string): void {
    this.diagnostics.push(
      diag(code, `@${this.pos}`, message, { span: { start: this.pos, end: this.pos } }),
    );
  }
}

function readName(scanner: Scanner): string {
  const start = scanner.pos;
  while (!scanner.eof() && NAME_CHAR.test(scanner.peek())) scanner.pos += 1;
  return scanner.source.slice(start, scanner.pos);
}

function readAttribute(scanner: Scanner): RawAttribute | null {
  const start = scanner.pos;
  const rawName = readName(scanner);
  if (rawName.length === 0) return null;
  scanner.skipWhitespace();
  if (scanner.peek() !== "=") {
    scanner.error("malformedMarkup", `attribute "${rawName}" is missing "=value"`);
    return { rawName, value: "", span: { start, end: scanner.pos } };
  }
  scanner.pos += 1;
  scanner.skipWhitespace();
  const quote = scanner.peek();
  if (quote !== '"' && quote !== "'") {
    scanner.error("malformedMarkup", `attribute "${rawName}" value must be quoted`);
    return { rawName, value: "", span: { start, end: scanner.pos } };
  }
  scanner.pos += 1;
  const valueStart = scanner.pos;
  while (!scanner.eof() && scanner.peek() !== quote) scanner.pos += 1;
  const raw = scanner.source.slice(valueStart, scanner.pos);
  if (scanner.eof())
    scanner.error("malformedMarkup", `unterminated attribute value for "${rawName}"`);
  else scanner.pos += 1;
  return { rawName, value: decodeEntities(raw), span: { start, end: scanner.pos } };
}

function readAttributes(scanner: Scanner): RawAttribute[] {
  const attributes: RawAttribute[] = [];
  for (;;) {
    scanner.skipWhitespace();
    if (scanner.eof() || scanner.peek() === ">" || scanner.startsWith("/>")) break;
    const attribute = readAttribute(scanner);
    if (attribute === null) break;
    attributes.push(attribute);
  }
  return attributes;
}

function isJsonBlockTag(tag: string, attributes: readonly RawAttribute[]): boolean {
  return (
    tag === "script" &&
    attributes.some((a) => a.rawName === "type" && a.value === "application/json")
  );
}

function readJsonBlock(
  scanner: Scanner,
  attributes: readonly RawAttribute[],
  start: number,
): RawJsonBlock {
  const closeTag = "</script>";
  const bodyStart = scanner.pos;
  const closeIndex = scanner.source.indexOf(closeTag, scanner.pos);
  const end = closeIndex === -1 ? scanner.source.length : closeIndex;
  const raw = scanner.source.slice(bodyStart, end);
  scanner.pos = closeIndex === -1 ? scanner.source.length : closeIndex + closeTag.length;
  if (closeIndex === -1) scanner.error("malformedMarkup", "unterminated <script> JSON block");
  const target = attributes.find((a) => a.rawName === "data-property")?.value ?? null;
  return { kind: "json", target, raw, span: { start, end: scanner.pos } };
}

function readElement(scanner: Scanner): RawElement | RawJsonBlock | null {
  const start = scanner.pos;
  scanner.pos += 1;
  const tag = readName(scanner);
  if (tag.length === 0) {
    scanner.pos = start + 1;
    return null;
  }
  const attributes = readAttributes(scanner);
  if (scanner.startsWith("/>")) {
    scanner.pos += 2;
    return { kind: "element", tag, attributes, children: [], span: { start, end: scanner.pos } };
  }
  if (scanner.peek() !== ">") {
    scanner.error("malformedMarkup", `expected ">" to close <${tag}>`);
    return { kind: "element", tag, attributes, children: [], span: { start, end: scanner.pos } };
  }
  scanner.pos += 1;
  if (isJsonBlockTag(tag, attributes)) return readJsonBlock(scanner, attributes, start);
  const children = readNodes(scanner, tag);
  const closeTag = `</${tag}>`;
  if (scanner.startsWith(closeTag)) scanner.pos += closeTag.length;
  else scanner.error("malformedMarkup", `expected closing tag ${closeTag}`);
  return { kind: "element", tag, attributes, children, span: { start, end: scanner.pos } };
}

function readNodes(scanner: Scanner, insideTag: string | null): RawNode[] {
  const nodes: RawNode[] = [];
  let textStart = scanner.pos;
  const flushText = (end: number): void => {
    if (end > textStart) nodes.push(decodeEntities(scanner.source.slice(textStart, end)));
  };
  while (!scanner.eof()) {
    if (insideTag !== null && scanner.startsWith(`</${insideTag}>`)) break;
    if (scanner.startsWith("<!--")) {
      flushText(scanner.pos);
      const end = scanner.source.indexOf("-->", scanner.pos + 4);
      scanner.pos = end === -1 ? scanner.source.length : end + 3;
      textStart = scanner.pos;
      continue;
    }
    if (scanner.peek() === "<" && /[A-Za-z]/.test(scanner.peek(1))) {
      flushText(scanner.pos);
      const element = readElement(scanner);
      if (element !== null) nodes.push(element);
      textStart = scanner.pos;
      continue;
    }
    if (scanner.startsWith("</") && insideTag === null) {
      scanner.error("malformedMarkup", "unmatched closing tag");
      scanner.pos = scanner.source.length;
      break;
    }
    scanner.pos += 1;
  }
  flushText(scanner.pos);
  return nodes;
}

export function tokenize(source: string): {
  nodes: readonly RawNode[];
  diagnostics: readonly Diagnostic[];
} {
  const scanner = new Scanner(source);
  const nodes = readNodes(scanner, null);
  return { nodes, diagnostics: scanner.diagnostics };
}
