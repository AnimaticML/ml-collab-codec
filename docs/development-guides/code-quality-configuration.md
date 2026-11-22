# Modular code quality configuration companion

Use with the [adoption handoff](code-quality-adoption-handoff.md), which owns module
selection, acceptance, gate semantics, development cadence and spending policy. This
companion supplies implementation recipes, not a standalone executable setup. “Core”
here means the selected Bun/TypeScript profile; other projects need not adopt it.
Activate optional sections only for their modules and deliver real configuration,
runners and fixtures. Adapt roots, entry points and boundaries instead of copying
another project's paths, dependencies, exclusions or package graph.

## Bun/TypeScript toolchain

Use Bun for installation/scripts/native tests, TypeScript for source checking,
ESLint/typescript-eslint for type-aware lint, Prettier for formatting,
dependency-cruiser for architecture, and Knip for unused code. Bundling follows the
deliverable; React, Vite, CSS and browser tooling remain optional.

Pin compatible direct quality dependencies and runtime types exactly; record exact
Bun/Node versions and verify `bun install --frozen-lockfile` from the workspace root.
Set `packageManager` and `engines.bun` consistently with the tooling pin, separately
from production runtime support. For bundled ESM use `package.json` `type: module`;
retain another required module format and adapt config loading when necessary.

Run Node-specific integrations and Knip under actual pinned Node, avoiding Bun's
forced-runtime replacement mode. Knip supports Bun too; an alternative needs a reason
and configuration-loading/builtin-import fixtures. See [Knip
runtimes](https://knip.dev/reference/cli) and [known loading
issues](https://knip.dev/reference/known-issues).

## TypeScript

Choose `target`/`lib` for supported runtimes; preserve compatible existing settings.
ES2022 below is an example, not a migration requirement. ES2023 adds APIs such as
`findLast`, `toSorted`, `toReversed`, `toSpliced` and `with`; used APIs need runtime
support or tested polyfills. `target` controls emitted syntax/default libraries; `lib`
describes APIs independently. Neither provides polyfills. Align the bundler's separate
output target, including with `noEmit`, and avoid unexamined floating `ESNext`
compatibility promises. See
[target](https://www.typescriptlang.org/tsconfig/target.html) and
[lib](https://www.typescriptlang.org/tsconfig/lib.html).

Bun tooling/bundled ESM starting configuration:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["bun"]
  },
  "include": ["src/**/*.ts", "tools/**/*.ts", "tests/**/*.ts", "*.ts"],
  "exclude": ["node_modules", "dist", "local-artifacts", "**/dist/**"]
}
```

Include every actual root, experiments and colocated tests. Add TSX, framework JSX,
`DOM`/`DOM.Iterable` and JSON resolution only where needed. Separate runtime TSConfigs
when ambient globals could mask invalid dependencies; use runtime-appropriate module
resolution for unbundled Node. Omit `skipLibCheck` by default; document any exception
and remaining declaration-compatibility checks without excluding supported source.

## ESLint and diagnostic formatter

Use `eslint.config.ts`, `defineConfig` from `eslint/config`,
`@eslint/js.configs.recommended` and `typescript-eslint.configs.strictTypeChecked`. Set
`parserOptions.project` to actual TSConfigs and `tsconfigRootDir` to the config
directory; every linted TypeScript file, including tests/tools, must belong to a
project. Set `reportUnusedDisableDirectives` and `reportUnusedInlineConfigs` to `error`.
Integrate this fragment into a complete exported config:

```ts
{
  eqeqeq: ['error', 'always'],
  curly: ['error', 'all'],
  'no-nested-ternary': 'error',
  'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': [
    'error',
    { max: 40, skipBlankLines: true, skipComments: true, IIFEs: true },
  ],
  complexity: ['error', 8],
  'max-depth': ['error', 2],
  'max-nested-callbacks': ['error', 2],
  'max-params': ['error', 3],
  '@typescript-eslint/consistent-type-imports': [
    'error',
    { prefer: 'type-imports', fixStyle: 'separate-type-imports', disallowTypeAnnotations: true },
  ],
  'no-restricted-syntax': [
    'error',
    { selector: 'ImportSpecifier[importKind="type"]', message: 'Use a top-level import type declaration.' },
  ],
  '@stylistic/lines-between-class-members': [
    'error', 'always', { exceptAfterOverload: true },
  ],
}
```

Keep runtime dynamic imports allowed. Require camelCase/PascalCase/UPPER_CASE for
variable-like identifiers and PascalCase for types; use
`^(?:id|[A-Za-z][A-Za-z0-9_]{2,})$` for the baseline length guard. Review established
short names and external schemas through narrow exceptions. For top-level spacing, use a
local rule only where built-ins cannot express it: inspect adjacent `Program.body`
declarations, unwrap exports, require a blank line and preserve matching overload
groups. Test the registered rule with valid/invalid cases.

Save this required diagnostic formatter as `tools/formatter.ts`. Point its guide link to
an existing style-guide section, creating the section if necessary:

```ts
import type { ESLint } from 'eslint'

const advice: Record<string, string> = {
  'max-lines-per-function':
    'Separate responsibilities and name intermediate concepts; never split mechanically by line count.',
  complexity:
    'Separate traversal, domain decisions, and effects; simplify the main path without hiding branches in callbacks.',
  'max-depth':
    'Simplify the main path with explicit concepts and guard clauses; do not hide branching in callbacks.',
  'max-nested-callbacks':
    'Separate traversal from decisions and effects; do not move branching into more callbacks.',
  'max-params':
    'Reconsider responsibilities and cohesive concepts; never create an options bag solely to meet a limit.',
}

const formatter: ESLint.Formatter['format'] = (results) =>
  results
    .flatMap((result) =>
      result.messages.map((message) => {
        const rule = message.ruleId ?? 'fatal'
        const diagnostic = `${result.filePath}:${String(message.line)}:${String(message.column)} ${message.severity === 2 ? 'error' : 'warning'} ${rule} ${message.message}`
        const instruction = advice[rule]
        return instruction
          ? `${diagnostic}\n  Guidance: ${instruction} See docs/code-style.md#function-design`
          : diagnostic
      }),
    )
    .join('\n') + '\n'

export default formatter
```

The `lint` command below wires the official `ESLint.Formatter['format']` API into
CLI/CI. ESLint owns the exit status. Advice supplements the five mapped function rules;
file length and unmapped rules retain normal diagnostics. Do not rewrite terminal
output, suppress unfamiliar/fatal diagnostics, catch errors as success, or treat advice
as automatic refactoring or authorization for suppressions. Native editor diagnostics
need not display it; use the public lint command for guidance.

Test every mapping, warnings, an unknown rule and fatal parse/configuration errors
through both the formatter and real CLI. Assert original file, position, severity,
rule/message, additive advice and failing error/warning exits. Positive fixtures have
zero errors, warnings and fatal diagnostics. Keep bounded isolated fixtures extending
real TS settings; import the formatter in tests and declare its dynamic CLI entry in
Knip where needed.

## Optional React and localization guards

For React TSX, enable Hooks recommended and JSX accessibility strict rules, including
accessible control names; another framework uses its own applicable checks. Use `jsx:
react-jsx` only for React. Keep framework globals out of server/tooling configs.

When localization is adopted, configure typed catalogs with matching keys and exact
interpolation shapes. Select supported locales and the default locale from product
requirements. Reject literal JSX text and literal text expressions, literal
accessibility/title/placeholder/label attributes and literal document-title assignments.
React without localization need not ban literals. Preserve user content.

For React/CSS styling, reject JSX style attributes, direct `element.style` assignments
and CSSOM set/remove calls except specifically approved measured-geometry properties.
Apply exceptions consistently across attributes, CSS and runtime writes; reject priority
arguments permitting `!important`. Test these local rules with the configured linter.
Aliases, helpers, templates, conditionals, portals, third-party output and indirect
mutation need manual review or further boundary rules, not claims of full
dataflow/provenance coverage.

## Optional CSS/design-token module

Extend `stylelint-config-standard`; set `color-named: never` and
`declaration-no-important: true`. Require shared token references through
`declaration-property-value-allowed-list` for colors, typography, spacing, dimensions,
borders, shadows, opacity, layers, durations and transforms, including custom-property
definitions outside the token owner.

A starting allow-list accepts `var()`, zero, percentages, selected structural values
(`auto`, `inherit`, `none`, `currentColor`, `transparent`) and token-based `calc()`.
Keep general raw values in the token owner; elsewhere permit only documented,
fixture-verified structural, geometry or breakpoint exceptions. Review `calc`, `clamp`,
`min` and `max` contents; syntax alone does not prove token ownership.

Implement `tools/styles.ts` using real Stylelint over actual stylesheet roots and
literal embedded styles. Reject unsupported interpolation or use a supported parser;
never silently skip it. Review media conditions explicitly: CSS custom properties cannot
simply replace media-query values. SVG path geometry differs from styling; CSS
fill/stroke still follow token policy. Keep user content/rendering geometry distinct
from interface styling. Runtime-write guards run separately in lint; document
indirect-write gaps and test CSS acceptance/rejection with real tools.

## Source formatting

Commit one Prettier configuration:

```json
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

Use separate write/check commands below. Keep lint spacing compatible, preserve blank
lines between declarations/class members and overload groups, and decide existing
documentation's treatment explicitly. Apply the adoption handoff's narrow exclusion
policy.

## Architecture, unused code and optional publication

Use dependency-cruiser's `cruise` API with `validate=true`, the actual TSConfig and
explicit public-export resolution. Run `tsPreCompilationDeps=false` and `true`, saving
JSON for both graphs. Resolve aliases/export conditions and enforce boundaries through
barrels. Where explicit ownership is required, map every source file to a layer and
reject new unclassified files; check transitive portable-entry dependencies where
browser/server separation matters.

Map actual ownership, not empty scaffolding. A layered project can enforce domain-only
domain dependencies, no application-to-UI/adapter edges, no UI-to-adapter edges and no
production-to-test/tool edges; composition wires layers. For workspaces, validate
declared dependencies, allowed edges and exported subpaths syntax-awarely, including
import/export declarations and literal dynamic imports. Reject relative imports across
workspace roots.

Configure Knip's real public/CLI/UI/test/tooling/browser-fixture/child-process/dynamic
entries and all TS/TSX roots. Reach helpers by imports, not blanket entries. Prove
unused exports fail and used TSX components pass where React applies. A narrow `@public`
annotation with matching Knip tag config is a reviewed contract exception. Review
consumers before deletion, as required by the adoption handoff.

For published libraries, use a declaration build config with `declaration=true`,
`emitDeclarationOnly=true`, `noEmit=false`, `rootDir=src` and a declaration output
directory. Exclude tests from shipping, retaining static/test coverage. Source checking
must precede emission; emit-only `noCheck` is allowed only after it passes. For ESM
NodeNext consumers, normalize emitted relative paths to actual `.js` targets through
syntax-aware processing and verify a strict built consumer and public exports. A browser
bundle alone does not prove package compatibility.

## Optional Vite build

Pin Vite and its selected framework plugin together; use ESM config and register the
React plugin only for React. Set explicit `build.target` for supported browsers;
configure actual entries, outputs, assets and environment handling. Another deliverable
replaces `vite build` with its production compiler/bundler; do not add Vite for the
example scripts.

## Commands and runner implementation

Adapt this all-module interface: omit inapplicable commands, select the real bundler,
add a documented `test:dev` affected selection, and retain `check:core` only when
providing that optional profile. Implement the named runners; these scripts alone are
not a working setup.

```json
{
  "scripts": {
    "typecheck": "bun --bun tsc --noEmit",
    "lint": "bun --bun eslint . --max-warnings 0 --format ./tools/formatter.ts",
    "architecture": "bun tools/architecture.ts",
    "styles": "bun tools/styles.ts",
    "unused": "node node_modules/knip/bin/knip.js --include-entry-exports",
    "format": "bun --bun prettier --write .",
    "format:check": "bun --bun prettier --check .",
    "test:unit": "bun tools/test.ts unit",
    "test:integration": "bun tools/test.ts integration",
    "test:tooling": "bun tools/test.ts tooling",
    "test:all": "bun tools/test.ts all",
    "test:browser": "bun tools/browser-test.ts",
    "build": "bun run typecheck && bun run build:bundle",
    "build:bundle": "bun --bun vite build",
    "check": "bun tools/check.ts",
    "check:core": "bun tools/check.ts --core"
  }
}
```

Implement `tools/check.ts` with sequential awaited `Bun.spawn` calls and inherited
diagnostics, following the [gate
contract](code-quality-adoption-handoff.md#gate-contract). Use `build:bundle` internally
to avoid repeated type checking, extending it for workspace/declaration/consumer checks.
Report `core` explicitly when `--core` is used.

In `tools/test.ts`, map scopes to globs; discover `.test`/`.spec` TS/TSX files across
actual source/package/application/tool/test roots with `Bun.Glob`, deduplicate/sort, and
pass explicit Bun-native files to `Bun.spawn(['bun', 'test', ...])`. Delegate
Node-specific integrations and browsers to their supported runners. `test:all` covers
all adopted native scopes; the full gate adds browser coverage separately. Include
colocated units in affected/full discovery but exclude them from shipped output. Reject
unknown scopes/arguments and explicitly empty selections.

## Optional browser module: Playwright

Follow the [browser
cadence](code-quality-adoption-handoff.md#test-strategy-and-cadence). Derive engines,
devices and viewports from product support; broad web support includes Chromium, Firefox
and WebKit. Narrower coverage needs a support decision, not cost alone. Require explicit
engine/part selection and reject missing/unknown/empty values. Install binaries matching
pinned Playwright and their OS prerequisites.

This isolated-engine profile is a starting point. Adopt realistic environment-specific
budgets, then preserve them during remediation:

| Setting                       | Value           |
| ----------------------------- | --------------- |
| Per-case timeout              | 20 seconds      |
| Per-invocation suite budget   | 180 seconds     |
| Functional workers            | At most 2       |
| Observation workers           | 1               |
| Functional diagnostic retries | 1               |
| failOnFlakyTests              | true            |
| forbidOnly                    | true            |
| Failure screenshot            | only-on-failure |
| Functional trace              | on-first-retry  |
| Test server startup timeout   | 30 seconds      |
| Reuse an existing server      | false           |

If runner-observation tests are adopted, run them before concurrent functional cases in
each engine; do not create empty observation suites. Retain timestamped reports and
failure artifacts. Retry passes remain flaky failures.

Enumerate all engine/part combinations from one manifest. Prove real Playwright
discovery matches the unpartitioned suite exactly once per engine, except deliberate
repeated observations, including when sharding. Reject unclassified new files and empty
parts. The example 180 seconds bounds each invocation, not the whole gate; parts/shards,
repeated setup and observations must also fit total-run/CI spending bounds. Document any
different direct all-engine diagnostic scheduling.

## Independent CI implementation

Apply the [CI coverage and spending
policy](code-quality-adoption-handoff.md#independent-ci-and-spending-policy). Use the
same underlying commands/configs and immutable event SHA in every checkout. A practical
layout is one core job plus a browser matrix only when adopted; size parts/shards from
measured budgets, not a fixed matrix. Share the browser manifest, disable matrix
fail-fast to retain evidence, and aggregate all required jobs without accepting
failed/cancelled/skipped/missing dependencies.

Choose PR/push/schedule/manual triggers deliberately. Changed-candidate schedules plus
forced manual runs can avoid redundant matrices; retain required per-change checks.
Include shared lockfile, workspace, config and dependency changes in trigger coverage.
Use read-only permissions unless an authorized action requires more. Upload reports even
on failure; configure explicit retention/timeouts, admission limits and superseded-run
concurrency groups. Required checks must agree with the chosen full/reduced cadence.
Observe an actual remote run after CI configuration changes and inspect branch
protection separately.

## Optional real-service integrations

Use actual supported adapters: real PostgreSQL when used, pinned Miniflare/workerd with
persistent storage for Cloudflare restart/replay, actual Node for Node-specific
behavior. These examples do not add dependencies to unrelated projects. Keep setup,
cleanup and controlled failures reproducible; cover authorization, idempotent retries,
persistence and durable effects as applicable.

## Configuration acceptance

Apply the [acceptance
scope](code-quality-adoption-handoff.md#select-modules-and-acceptance-scope) and
[delivery
requirements](code-quality-adoption-handoff.md#prove-enforcement-and-deliver-evidence).
Verify the frozen install, all adopted source/entry coverage, real positive/negative
tool fixtures, formatter CLI wiring, gate/report failures, optional core/full
separation, browser partition/shard discovery and flaky rejection. Execute applicable
builds and consumer checks; record existing failures as remediation debt. Require the
full local gate and adopted CI evidence for release readiness. Do not create fixtures or
empty suites for inapplicable modules.
