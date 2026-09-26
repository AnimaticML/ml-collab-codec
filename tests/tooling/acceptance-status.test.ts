import { expect, test } from "bun:test";
import { inspectAcceptance } from "../../scripts/lib/acceptance-status.ts";

const ids = ["C01", "S03"];
const complete = [
  {
    path: "sample.test.ts",
    source: 'test("C01 round-trip", () => { check(); }); test("S03 defaults", () => { check(); });',
  },
];

test("completion guard accepts named active tests with an implementation entry", () => {
  expect(inspectAcceptance(ids, complete, true)).toEqual([]);
});

test("completion guard rejects an absent implementation", () => {
  expect(inspectAcceptance(ids, complete, false)).toContain(
    "Missing implementation entry: src/index.ts.",
  );
});

test("completion guard rejects TODO, skip, and focus", () => {
  for (const modifier of ["todo", "skip", "only"]) {
    const sources = [
      { path: "sample.test.ts", source: `test.${modifier}("C01 example", () => {});` },
    ];
    expect(inspectAcceptance(["C01"], sources, true).length).toBeGreaterThan(0);
  }
});

test("completion guard rejects missing baseline coverage", () => {
  expect(inspectAcceptance([...ids, "C02"], complete, true)).toContain(
    "C02: no active literal baseline test.",
  );
});

test("completion guard rejects unknown and duplicate IDs", () => {
  expect(
    inspectAcceptance(["C01"], complete, true).some((p) => p.includes("unknown scenario S03")),
  ).toBe(true);
  expect(inspectAcceptance(["C01", "C01"], complete, true)).toContain(
    "Duplicate baseline scenario IDs.",
  );
});

test("completion guard rejects a callback-less test declaration", () => {
  const sources = [{ path: "sample.test.ts", source: 'test("C01 unfinished");' }];
  expect(inspectAcceptance(["C01"], sources, true)).toContain(
    "C01: no active literal baseline test.",
  );
});

test("completion guard rejects an empty baseline", () => {
  expect(inspectAcceptance([], [], true)).toContain("No baseline scenario IDs were found.");
});

test("completion guard supports apostrophes inside a double-quoted title", () => {
  const sources = [{ path: "sample.test.ts", source: 'test("C01 owner\'s value", () => {});' }];
  expect(inspectAcceptance(["C01"], sources, true)).toEqual([]);
});

test("completion guard counts revision scenario IDs like baseline IDs", () => {
  const sources = [
    { path: "r.test.ts", source: 'test("R54 presence stays ephemeral", () => { check(); });' },
  ];
  expect(inspectAcceptance(["R54"], sources, true)).toEqual([]);
  expect(inspectAcceptance(["R53", "R54"], sources, true)).toContain(
    "R53: no active literal baseline test.",
  );
});
