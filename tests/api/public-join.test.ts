// Snapshot join, session restore, and history availability through the public entry point only.
import { expect, test } from "bun:test";
import {
  Authority,
  BOOTSTRAP_FORMAT,
  beginJoin,
  bootstrapFromCheckpoint,
  captureBootstrap,
  createAllocator,
  defineDocumentSchema,
  exportCheckpoint,
  joinClient,
  parseDocument,
  readBootstrap,
  SequenceAllocator,
  SnapshotError,
  toTable,
} from "../../src/index.ts";
import type {
  Bootstrap,
  ClientSession,
  HistoryStatus,
  JoinOptions,
  SchemaRef,
  SessionStore,
  TransitionEvent,
} from "../../src/index.ts";

const schema = defineDocumentSchema({
  id: "api.join",
  version: "1",
  rootTag: "doc",
  components: {
    doc: {
      identity: "none",
      content: { mode: "element", allowedTags: ["p"] },
      props: { type: "object" },
    },
    p: { identity: "stable", content: { mode: "mixed" }, props: { type: "object" } },
  },
});

test("public API: bootstrap join, catch-up, and restored own history", async () => {
  const parsed = parseDocument(`<doc><p id="p1">hello</p></doc>`, schema);
  if (!parsed.ok) throw new Error("setup");
  const authority = Authority.create("doc", "epoch", toTable(parsed.value, createAllocator()), {
    schema,
  });
  const ref: SchemaRef = { id: schema.id, version: schema.version };
  const run = authority.getTable().get("p1")?.children[0] ?? "";
  const live: TransitionEvent[] = [];
  const handoff = beginJoin(authority, ref, (t) => live.push(t));
  const bootstrap: Bootstrap = handoff.bootstrap;
  expect(bootstrap.format).toBe(BOOTSTRAP_FORMAT);
  const options: JoinOptions = {
    bootstrap,
    schema,
    allocator: SequenceAllocator.ephemeral("replica-a"),
    actor: "alice",
  };
  const alice = joinClient(options);
  const empty: HistoryStatus = alice.getStatus().history;
  expect(empty).toEqual({ status: "empty" });
  alice.transact((b) => b.textInsert(run, 5, "!"));
  const request = alice.nextRequest();
  authority.submit(request, { actor: "alice" });
  alice.receive(live);
  handoff.stop();
  expect(alice.getStatus().confirmedRevision).toBe(1);

  // The actor's session goes through a host-provided store and is restored on another device.
  const saved = new Map<string, ClientSession>();
  const sessions: SessionStore = {
    load: (documentId, actor) => Promise.resolve(saved.get(`${documentId}/${actor}`)),
    save: (session) => {
      saved.set(`${session.documentId}/${session.actor}`, session);
      return Promise.resolve();
    },
  };
  await sessions.save(alice.exportSession());
  const stored = bootstrapFromCheckpoint(exportCheckpoint(authority, ref));
  const restored = await sessions.load("doc", "alice");
  const phone = joinClient({
    ...options,
    bootstrap: stored,
    allocator: SequenceAllocator.ephemeral("replica-p"),
    ...(restored === undefined ? {} : { restore: restored }),
  });
  expect(phone.getStatus().history).toEqual({ status: "restored", revision: 1 });
  expect(phone.undo()).toMatchObject({ status: "requested" });
  authority.submit(phone.nextRequest(), { actor: "alice" });
  expect(authority.getTable().get(run)?.props["value"]).toBe("hello");
  expect(readBootstrap(captureBootstrap(authority, ref), schema).revision).toBe(2);
  expect(() => readBootstrap({ ...bootstrap, format: "x" }, schema)).toThrow(SnapshotError);
});
