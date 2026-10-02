import { expect } from "bun:test";
import {
  createAllocator,
  diffToChanges,
  fromTable,
  toTable,
  typingHistoryPolicy,
  type ChangeBuilder,
  type Client,
  type ContentItem,
  type DocumentModel,
  type JsonValue,
  type UndoResult,
} from "../../src/index.ts";
import { Room } from "./room.ts";

const SCHEMA = "causal-history";

/**
 * One own writer (typing policy, controlled clock) plus an optional remote
 * collaborator over a real authority. Every own edit is settled before the
 * next one, so own groups are causally ordered, never concurrent.
 */
export class CausalProbe {
  readonly room: Room;
  readonly writer: Client;
  readonly other: Client;
  private time = 0;

  constructor(paragraphs: readonly (readonly ContentItem[])[] = [["Начало "]], props = {}) {
    const model: DocumentModel = {
      schemaId: SCHEMA,
      schemaVersion: "1",
      root: {
        id: "document",
        tag: "document",
        props: {},
        content: paragraphs.map((content, index) => ({
          id: index === 0 ? "paragraph" : `paragraph-${index}`,
          tag: "paragraph",
          props: index === 0 ? props : {},
          content: [...content],
        })),
      },
    };
    this.room = new Room(toTable(model, createAllocator()));
    this.writer = this.room.join("writer", "replica-w", "writer", {
      historyPolicy: typingHistoryPolicy(1000),
      now: () => this.time,
    });
    this.other = this.room.join("other", "replica-o");
  }

  advance(milliseconds = 100): void {
    this.time += milliseconds;
  }

  transact(write: (builder: ChangeBuilder) => void): void {
    this.advance();
    expect(this.writer.transact(write).status).toBe("applied");
    this.room.settle();
  }

  remote(write: (builder: ChangeBuilder) => void): void {
    expect(this.other.transact(write).status).toBe("applied");
    this.room.settle();
  }

  /** Author the difference to `content` for the first paragraph through the library's own diff. */
  replace(content: readonly ContentItem[]): void {
    const root = this.model().root;
    const [, ...others] = root.content ?? [];
    const target = {
      ...root,
      content: [{ id: "paragraph", tag: "paragraph", props: this.props(), content }, ...others],
    };
    this.transact((builder) => {
      const seq = this.writer.options.allocator.last;
      const changes = diffToChanges(builder.current(), target, {
        replica: this.writer.replica,
        seq,
      });
      for (const change of changes) builder.record(change);
    });
  }

  restore(direction: "undo" | "redo"): UndoResult {
    const result = this.writer[direction]();
    this.room.settle();
    return result;
  }

  /** Undo (or redo) until nothing is left, requiring every step to be accepted; returns the states seen. */
  exhaust(direction: "undo" | "redo", read: () => unknown = () => this.content()): unknown[] {
    const seen: unknown[] = [];
    for (let step = 0; step < 200; step += 1) {
      const result = this.restore(direction);
      if (result.status === "unavailable") return seen;
      expect(result).toMatchObject({ status: "requested" });
      expect(this.writer.getStatus().unsent).toEqual([]);
      seen.push(read());
    }
    throw new Error(`${direction} did not terminate`);
  }

  model(): DocumentModel {
    return fromTable(this.room.authority.getTable(), SCHEMA, "1");
  }

  paragraph(index = 0): ContentItem[] {
    const paragraph = this.model().root.content?.[index];
    if (paragraph === undefined || typeof paragraph === "string") throw new Error("no paragraph");
    return [...(paragraph.content ?? [])];
  }

  content(): ContentItem[] {
    return this.paragraph(0);
  }

  props(): Record<string, JsonValue> {
    return { ...this.room.authority.getTable().get("paragraph")?.props };
  }

  /** Every replica agrees with the authority. */
  converged(): void {
    const expected = JSON.stringify(this.model());
    for (const client of [this.writer, this.other])
      expect(JSON.stringify(fromTable(client.getSnapshot().table, SCHEMA, "1"))).toBe(expected);
  }
}

export function rich(plain: string, bold: string, tail = ""): ContentItem[] {
  return [plain, { tag: "span", props: { bold: true }, content: [bold] }, ...(tail ? [tail] : [])];
}

/** Type plain text, then bold text, then plain text again, one character per accepted transaction. */
export function typePlainBoldPlain(probe: CausalProbe, explicit = false): void {
  const segment = (label: string, type: () => void): void => {
    if (explicit) probe.writer.beginGroup(label);
    type();
    if (explicit) probe.writer.endGroup();
  };
  let plain = "Начало ";
  let bold = "";
  let tail = "";
  segment("plain", () => {
    for (const character of "обычный ") probe.replace([(plain += character)]);
  });
  segment("bold", () => {
    for (const character of "жирный ") probe.replace(rich(plain, (bold += character)));
  });
  segment("tail", () => {
    for (const character of "хвост") probe.replace(rich(plain, bold, (tail += character)));
  });
}
