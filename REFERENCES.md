# Sources, provenance, and reference-reading instructions

## Source basis and precedence

This packet is a consolidated English rewrite of the supplied source handoffs and
owner discussion, not a claim that new implementation work has already happened.
The two source files were read in full during preparation:

- `STRUCTURED_DOCUMENT_LIBRARY_HANDOFF_RU(1).md` — SHA-256 `9cab4cde70197024873b68065f8a2469a360c63ef2a7c4318e2d6c5822660418`
- `STRUCTURED_DOCUMENT_SPEC_ADDENDUM_RU.md` — SHA-256 `7dbf4191d5053389d89576d71639c0760742eb826da01cb40d58f78bb52b5587`

They are not copied into this package as parallel specifications. The owner then
accepted the proposal except for preserving absence/null/default spelling distinctions
in structured agent output, and requested a complete TypeScript/Bun implementation
handoff with tests, lint, cleanup, and no giant code files.

Superseded passages: the original handoff's generic absent/null distinction and the
addendum's section 2 table, section 3.3 presence-wrapper proposal, C03, and S03 must
be read through SPEC section 3. The new packet deliberately changes those requirements;
it does not mistranslate them accidentally. False/zero/empty-string preservation,
invalid-value diagnostics, and hidden-data protection remain required.

The original source left several architecture choices open. The owner's subsequent
acceptance promotes the stated v1 policies to the baseline: value/structure/text/move/
delta capabilities, explicit invariant rejection, effective outcomes, authoritative
arbitration, typed provider projections, and homogeneous visibility regions. Exact
wire/API shapes, numeric profile, and text/ID decisions remain delegated in SPEC 17.

New engineering scaffolding choices made for this package (not claims from the source):
ESLint plus Knip plus Prettier, 300/450 file-line limits, an 80-line production-function
limit, a literal-ID acceptance-completion guard, isolated `src/core` ambient types,
and the starting development dependency ranges. These are practical starting defaults.

## Legacy repository: verified read-only reference

Repository: <https://github.com/alexandr-panchenko/WebComponentJSONCodec>

Pinned commit: `1ae5ffc55cd92eaced303a9592025e7410864e35`.
A read-only GitHub connector query during preparation confirmed this default-branch
revision and retrieved its package configuration. The earlier source discussion
inspected its parser, normalization, mapping, serializer, and 12 deserialization plus
4 serialization tests. This packet does not claim those tests were executed here.

Read these paths at the pinned commit before implementation:

- `test/spec/deserialize.spec.ts` and `test/spec/serialize.spec.ts`.
- `src/syntax/parser.ts`, `src/document/normalize.ts`, `src/mapping/deserialize.ts`.
- `src/serialization/serialize.ts`, `src/utils/object.ts`, `src/types.ts`.
- `README.md`, `package.json`, and the actual `LICENSE` before borrowing code.

Pinned test link:
<https://github.com/alexandr-panchenko/WebComponentJSONCodec/blob/1ae5ffc55cd92eaced303a9592025e7410864e35/test/spec/deserialize.spec.ts>

Keep reference checkouts outside production `src` and ordinary test discovery. Do
not copy old tests verbatim and preserve their silent-loss expectations. Derive new
behavioral fixtures and document each retained rule and deliberately changed behavior.
Do not push to this reference repository merely because it is the only URL provided.

The AnimaticML fork and existing Docong operation code were not supplied as accessible
repository paths for this packet. Their internals were not verified. Inspect them if
made available, but do not substitute guessed code or block core implementation.

## External technical references

These are primary-source reading targets, not selected runtime dependencies. Provider
links and their limitations came from the supplied addendum. Provider behavior and
numeric provider limits were not reverified by live API calls for this consolidation.
Build a dated, model/API-scoped matrix during implementation rather than copying old
limits as timeless facts. No provider SDK must be allowed to silently weaken guarantees.

- [O1] OpenAI structured outputs:
  <https://developers.openai.com/api/docs/guides/structured-outputs>
- [G1] Gemini structured output:
  <https://ai.google.dev/gemini-api/docs/structured-output>
- [A1] Anthropic structured outputs:
  <https://platform.claude.com/docs/en/build-with-claude/structured-outputs>
- [J1] JSON Schema annotations/default:
  <https://json-schema.org/understanding-json-schema/reference/annotations>
- [J2] JSON Schema validation vocabulary:
  <https://json-schema.org/draft/2020-12/json-schema-validation>
- [Z1] Zod to JSON Schema:
  <https://zod.dev/json-schema>
- [N1] ECMAScript Number addition:
  <https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-numeric-types-number-add>
- [OT1] JSON1 implementation, limitations, and specification:
  <https://github.com/ottypes/json1>
  <https://github.com/ottypes/json1/blob/master/spec.md>
- [T1] text-unicode and its notes on composition versus transformation:
  <https://github.com/ottypes/text-unicode>
  <https://github.com/ottypes/text-unicode/blob/master/NOTES.md>
- [P1] JSON Patch (application protocol, not an OT specification):
  <https://datatracker.ietf.org/doc/html/rfc6902>
- [P2] ShareDB coordination/type separation:
  <https://share.github.io/sharedb/>
  <https://share.github.io/sharedb/types/>
- [H1] HTML syntax/container constraints:
  <https://html.spec.whatwg.org/multipage/syntax.html>

## Tooling documentation consulted for the scaffold

Opened during preparation on 2026-09-22. This verifies documented configuration
concepts, not an executed dependency install. See README for environment limitations.

- Bun test runner: <https://bun.sh/docs/test>
- Bun lockfile: <https://bun.sh/docs/pm/lockfile>
- TypeScript ESLint setup: <https://typescript-eslint.io/getting-started/>
- Knip configuration: <https://knip.dev/reference/configuration>
- ESLint file-length rule: <https://eslint.org/docs/latest/rules/max-lines>
- ESLint function-length rule: <https://eslint.org/docs/latest/rules/max-lines-per-function>
