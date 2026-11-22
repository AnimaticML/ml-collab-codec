# Code quality adoption

Establish an enforceable quality contract for a new or existing repository. Inspect its
instructions, architecture, tooling and Git state; preserve accepted behavior and
contributors' work. Extend existing tools before adding custom guards. Deliver working
configuration, commands, documentation and applicable CI—not product features or
demonstration frameworks. Do not add packages or services solely to demonstrate checks.
This handoff grants no permission to push, deploy, provision or make paid calls.

This document owns scope, policy and acceptance. The [configuration
companion](code-quality-configuration.md) provides a Bun/TypeScript profile and optional
module recipes. Adapt them to the receiving project; another language uses equivalent
supported tools.

## Select modules and acceptance scope

Record the deliverable, production runtime, platforms, test scopes, interface languages
and verification milestones. Map existing checks to this contract and record applicable
gaps. Mark each module **adopted**, **inapplicable** or
**deferred**, with a reason. A deferred required module remains an acceptance gap.

| Module                   | Adopt when                                         | Decisions to record                                                       |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------- |
| Core quality             | Every project                                      | Analyzers, ownership, limits, discovery, gate profiles, evidence          |
| Bun/TypeScript           | Toolchain selected                                 | Versions, runtime-specific TSConfigs, lint, formatter, architecture, Knip |
| React                    | React UI exists                                    | Hooks, accessibility, JSX guards                                          |
| Vite                     | Vite build selected                                | Plugin, entries, output target, assets, environment                       |
| CSS/design tokens        | First-party styling exists                         | Token owner, allowed values, extraction, mutation exceptions              |
| Localization             | Product language requirements need it              | Locales, typed catalogs, output boundaries                                |
| Browser verification     | Browser behavior is part of the supported contract | Engines/devices, journeys, budgets, partitions, diagnostics               |
| Real-service integration | Persistence, transport or services exist           | Supported adapters, fixtures, cleanup, restart/retry coverage             |
| Workspaces/publication   | Multiple packages or external consumers exist      | Dependency edges, exports, declarations, compatibility                    |
| Independent CI           | Remote verification required                       | Cadence, immutable candidate, aggregate result, spending limits           |

Select modules by applicability, including their prerequisites. Bun tooling need not be
the production runtime; React and Vite are independent; React alone requires neither
localization nor literal-text bans. Other UI frameworks use their own
lifecycle/accessibility checks.

Separate **tooling acceptance** from **code remediation**. Working enforcement and
passing acceptance fixtures can establish setup completion despite documented existing
debt; this does not establish product acceptance. Execute the complete gate to establish
that baseline; its failures remain blocking for remediation/release until fixed or
narrowly excepted. Record adaptations before implementation; document each exception's
scope, rationale and verification before accepting it. Do not weaken the contract to
obtain a pass.

## Reproducibility and static checks

Pin compatible tools and dependencies, commit the lockfile, and verify a frozen
installation from the documented root. Retain compatible existing versions rather than
copying historical pins. Document runtimes, OS/service prerequisites and required
environment variables without secrets.

Apply type checking and applicable static checks to supported production code, tests,
tools, configuration and runnable experiments. Exclude generated output, dependencies,
vendored implementation and retained evidence narrowly; never hide first-party code.
Avoid private machine paths and modifications to installed dependencies. Use the same
underlying checks locally and in CI.

Require strict type checking, unused-declaration/parameter and switch-fallthrough
checks, safe indexed access, and type-aware unsafe-operation/promise rules where
supported, including floating and misused promises. Warnings and unused
suppression/configuration directives fail. The companion defines TypeScript flags,
import syntax, naming guards and formatting.

Apply these maintainability limits to implementation, tests, tools and configuration:

| Measure, excluding blank lines/comments where applicable | Limit |
| -------------------------------------------------------- | ----: |
| File lines                                               |   300 |
| Function lines                                           |    40 |
| Cyclomatic complexity                                    |     8 |
| Block nesting                                            |     2 |
| Callback nesting                                         |     2 |
| Parameters                                               |     3 |

Treat findings as responsibility reviews. Do not split mechanically, conceal branches in
dense expressions/callbacks, add meaningless wrappers, or invent parameter bags to
satisfy counters. Parameter objects represent cohesive concepts. Provide additive CLI
refactoring advice through the supported diagnostic formatter; preserve original
diagnostics and failure behavior. Keep source formatting separate, with one committed
configuration and explicit write/check commands.

## Design, architecture and unused code

Give modules/functions clear responsibilities, functions one abstraction level and names
that explain intent without tracing execution. Add abstractions for concrete needs;
prefer the smallest sufficient design. Each business policy has one owner shared by
interactive and programmatic entry points. Domain rules stay independent of UI,
transport and adapters; application operations coordinate, adapters interact externally,
and composition connects them. Expected failures use stable typed codes/parameters;
presentation produces messages.

Enforce actual dependency directions, aliases and barrels; reject unresolved imports,
cycles in runtime and combined type/runtime graphs, product imports from tests/tools,
and package-export bypasses. Require declared dependencies/public exports at package
boundaries, including a single published package. Create packages for real contracts.

Detect unused files, exports and dependencies using genuine public, CLI, UI, test,
tooling and dynamic entry points, including entry exports. Do not mark every source file
as an entry or suppress broad areas. Review external consumers before deleting or
migrating apparently unused public APIs.

## UI policy

For adopted UI modules, enforce lifecycle rules and strict accessibility, including
accessible control names. Share components and visual tokens. Check applicable colors,
typography, spacing, dimensions, borders, shadows, layers and motion. Restrict inline
styles and runtime mutation; document and verify narrow structural or measured geometry
exceptions. CSS rejects named colors and `!important`.

Keep identifiers, technical documentation and developer diagnostics in English. Choose
interface languages from product requirements. With localization, use typed catalogs,
matching keys/parameter shapes and concrete output-boundary guards. Preserve
user-authored content. Review indirect text/style APIs manually; syntactic guards cannot
prove arbitrary values' provenance. Record inspection gaps.

## Gate contract

Provide real commands and a documented cheap development selection. Omit inapplicable
suites explicitly; unknown arguments/scopes and explicitly empty selections fail. The
complete `check` command runs sequentially, stopping on the first failure:

1. Required dependency preparation.
2. Type checking.
3. Linting.
4. Architecture/package boundaries and cycles.
5. Applicable style/token checks.
6. Unused-code analysis.
7. Formatting verification.
8. All required native tests, including tooling and adopted integration scopes.
9. Adopted browser engine/part matrix.
10. Production build and applicable packaging/consumer checks.

Preserve diagnostics and the original failing exit code. Initialize a machine-readable
report as incomplete before execution; record start time, profile, expected stages,
commit, dirty-worktree status, stage results and durations. Update after each stage;
mark complete only when every required stage succeeds. Failed, interrupted, cancelled,
spawn-failed, skipped or partial runs cannot claim a full pass.

An optional `core` profile runs every adopted non-browser stage and identifies its
scope. It cannot claim browser/full verification when browsers are required. Without the
browser module, the full gate contains only its applicable stages. Other affected
selections are development checks, not `core`. Type checking may run once in the full
gate; standalone `build` must type-check before bundling.

## Test strategy and cadence

Derive expectations from requirements/configuration, independently of implementation
branches/constants. Use the cheapest layer that proves behavior: units for policies,
allowed variation, rejection and boundaries; real integrations for persistence,
transport, authorization, restart/replay, retries and durable effects; real-application
browser journeys for interactions, focus, navigation, displayed outcomes and lifecycle
behavior. Use semantic locators and real interactions; browser fixtures alone do not
verify an application journey. Fixtures supply setup/data/failures, not
competing product implementations.

Keep matrices readable and parameterized; do not duplicate exhaustive coverage at every
layer, require tests for every helper, or impose numerical coverage quotas. Configurable policies
need multiple configurations/boundaries and documented units, defaults, inclusivity and
ownership.

Run affected tests and applicable static/build checks during development and before
integration. Policy changes need units; service changes need real integrations; public
contracts/dependencies/composition need contract and affected-consumer checks; shared tooling needs
tooling fixtures and consumers. Unchanged dependencies need not rerun internal suites
through every consumer. Documentation needs diff/link/format review.

Browser automation can greatly slow development. Use it sparingly for behavior that
needs a browser: run affected journeys/engines during development, expanding for
concrete cross-engine risks. Run the full supported matrix at declared substantial
acceptance/release milestones and designated CI runs. This handoff does not require a
full matrix after every edit, commit or push; preserve any project-required per-change
verification and budget for it. Execute the complete gate for initialization assessment
and substantial milestones; require a full pass for remediation completion and release
readiness on a synchronized, identified candidate. Setup acceptance follows the separate
debt-baseline rule above.

Set explicit case/suite budgets, workers and retries for the environment. When suites
grow, split coherent parts without losing cases/assertions or increasing existing
limits, worker bounds or retries. Full discovery must cover all parts exactly once,
except intentional repeated observations; empty parts fail. Retry passes must not hide
first-attempt failures. Retain evidence; never conceal failures with forced clicks,
weaker assertions or broad suppressions. Verify authorization, data-loss,
duplicate-sensitive retry and ordinary concurrency risks immediately; fix known
reproducible security/data-loss defects immediately.

## Independent CI and spending policy

When CI is adopted, verify one immutable commit across all jobs. For a full result,
distributed execution must preserve full local coverage and aggregate every required
job; failed, cancelled, skipped or missing jobs cannot yield a full pass. Observe a
remote run before claiming CI works. Inspect/configure required checks and branch
protection separately from workflow files. An inapplicable CI module permits no remote
claim; unavailable required CI remains an acceptance gap.

Before enabling CI, record and enforce a spending contract:

- Selected runner/OS, billing multipliers, case/job/full-run timeouts, workers,
  matrix concurrency, engines, parts/shards and preparation/retry/observation overhead.
- Maximum invocations and job-minutes per full run, expected runs/month, monthly
  allowance, artifact size/retention, and observed usage against these bounds.
- Explicit PR/push/schedule/manual cadence, duplicate-trigger coalescing,
  superseded-run cancellation and unchanged-candidate handling.
- Trigger throttling, run-admission guards or provider quotas that keep launches
  within the allowance. A forecast or concurrency limit alone does not cap spending.

Do not multiply full matrices across triggers without budgeting. Splitting tests must
fit total-run bounds as well as per-invocation limits. At exhaustion, stop discretionary
launches, report missing verification, and arrange required runs within the accepted
allowance. Investigate overruns, coalesce redundant work or repartition; revise budgets
explicitly without weakening coverage. Cancellation is not a pass.

Install pinned tools, matching browsers/system prerequisites and service fixtures from
frozen dependencies. Upload reports/failure artifacts even on failure and preserve
failure history under the documented retention policy. Reused success must match the
immutable commit, quality contract and verification environment, and be labelled reused
evidence—not a new pass. Required status checks must match the scheduling policy;
reduced jobs cannot impersonate full checks.

## Prove enforcement and deliver evidence

Test real configurations with valid/invalid fixtures covering limits, import syntax,
architecture/cycles and applicable UI guards. Verify diagnostic preservation, failing
exits, first-failure short-circuiting, skipped later stages, spawn/interruption
reporting, incomplete reports and unknown/empty-selection rejection. Tooling tests are
separately selectable and included in full discovery. Manual review still checks names,
responsibilities, duplicated policies, errors, ordinary inputs and abstraction quality;
passing counters do not establish correctness, usability or security.

Keep one authoritative home per rule: README for prerequisites/commands, AGENTS.md for
operational permissions, a style guide for design principles, a quality contract for
exact enforcement/gaps, and a testing strategy for selection/cadence. Link rather than
duplicate policies. Commit compact decisions/evidence; keep raw logs, generated
artifacts and secrets out of Git and document retention.

Deliver configured files and a report with:

- Modules, versions, environments, target/runtime decisions, adaptations and verified exceptions.
- Exact install/run/build/check commands and frozen-install/tooling-fixture results.
- Commit, evidence locations, full-gate result and existing remediation baseline.
- Separate implementation, UI/product acceptance, release, local, CI and deployed status.
- Unrelated failures, deferred/unavailable checks, inspection gaps and unresolved decisions.
- The next bounded assignment, without automatically starting product development.

Setup is complete when its declared tooling acceptance passes. Remediation is complete
when the full adopted gate and required compatibility checks pass without weakening the
contract. Keep every acceptance claim within its observed evidence.
