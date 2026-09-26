# How to use the historical review probes

`ml-collab-codec-review-probes.mjs` is the **unchanged** 11-probe file from the prior source review of commit `73a782d17961b086d6e05a2fb65a3e0bf288f231`. Its bytes are preserved to make the original observations reproducible. It is not a comprehensive test suite or implementation handoff. The two `ML_COLLAB_REMEDIATION*.md` files are the current assignment.

After building an applicable checkout:

```sh
node /path/to/review-evidence/ml-collab-codec-review-probes.mjs \
  /path/to/ml-collab-codec/dist/index.js
```

The reviewer syntax-checked this script with Node but did not run it against a built library. Reproduce on the actual checkout and retain each real diagnostic. A changed API/fixture is not the same as a reproduced semantic defect.

## Coverage and qualifications

| Original probes | What they investigate | Current acceptance |
|---|---|---|
| V1–V4 | Array item validation, nested unknown-data loss, standalone validation, authority candidate validation | MR02–MR06 |
| I1–I3 | Mutation through published child arrays/props and aliasing retained input | MR19–MR21, subject to the explicit ownership policy below |
| C1 | Permitted opaque property lost on serialization | MR05, MR08 |
| D1 | Same-ID type change omitted by diff | MR11–MR13 |
| P1 | Emitted projected schema excludes its own text-row representation | MR14–MR18; a different coherent wire grammar is valid |
| R1 | Async layout completion does not invalidate a dependent cache | MR22–MR24 |

**Ownership clarification:** I1/I2/I3 describe a fully defensive runtime, stronger than the owner's latest requirement. Runtime deep freezing or prevention of deliberate mutation of a borrowed read-only view is NOT mandatory. A documented trusted-caller/deep-readonly contract is allowed, provided valid library use preserves versions, input acquisition/transfer is explicit, and supported independent edit copies do not alias the base. Port these probes to that contract; keep optional guard observations separate. Do not cite their blanket "all probes pass" header as a reason to impose deep freezing.

**Provider/API clarification:** P1 inspects the old export's particular object path and `#text` convention. A redesigned typed grammar may represent mixed text differently. Test actual expressiveness, round-trip and independent validation, not the historical shape.

The script does not cover JSON Schema migration, full recursive provider export, root ID, all opaque values, full diff behavior, checkpoint+tail joining, historical undo restoration, pair coverage, async durability, Git installation, documentation, or benchmarks. Passing it cannot complete this assignment.
