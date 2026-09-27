# Installation

The package is not published to a registry. Consume a pinned commit of the public
repository <https://github.com/AnimaticML/ml-collab-codec> and build it once.

## Pinned checkout (recommended)

```sh
git clone https://github.com/AnimaticML/ml-collab-codec.git vendor/ml-collab-codec
git -C vendor/ml-collab-codec checkout <commit>
cd vendor/ml-collab-codec && bun install --frozen-lockfile && bun run build
```

Then depend on the checkout by path from your application:

```json
{ "dependencies": { "ml-collab-codec": "file:vendor/ml-collab-codec" } }
```

A Git submodule or a workspace member works the same way: build it once with
`bun install --frozen-lockfile && bun run build`, then depend on it by path. The package
exports one ESM entry (`dist/index.js`) with declarations (`dist/types/index.d.ts`); a
checkout without `dist/` has not been built yet. `tests/acceptance/mr-distribution.test.ts`
exercises exactly this recipe from a clean clone of the current commit, with a separate
consumer on Node and Bun and a TypeScript consumer that uses only the declarations.

## Runtimes

| Runtime    | Status                                                                      |
| ---------- | --------------------------------------------------------------------------- |
| Bun        | ≥ 1.2.5 (development and test runner)                                       |
| Node       | ≥ 20.11 (the built package is executed on 20.11 in tests)                   |
| Browsers   | the core has no DOM dependency; a manual Chromium check exists, not CI      |
| TypeScript | declarations checked with 5.9 under `strict` + `exactOptionalPropertyTypes` |

The core uses only ECMAScript built-ins. File access (`src/adapters/file.ts`) and the
HTML bootstrap (`src/adapters/browser.ts`) are separate adapters.
