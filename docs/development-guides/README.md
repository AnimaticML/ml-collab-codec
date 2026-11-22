# Development recommendations for consuming applications

These permanent guides recommend a reproducible quality baseline for applications
built with the library. They are optional until the consuming project explicitly
adopts its scope and exceptions; adoption makes those selected checks that project's
contract. They do not impose this baseline on the library's existing contributor rules.

- [Quality adoption](code-quality-adoption-handoff.md): checks, module selection,
  proportional testing, browser cadence, CI budgets and honest acceptance evidence.
- [Configuration recipes](code-quality-configuration.md): a Bun/TypeScript profile
  and conditional UI, browser, service and publication modules.

Copy the pair independently, recording source revision and local adaptations. Bun,
React, CSS and browsers are applicable modules, not prerequisites to use codec.
The filenames retain “handoff” for compatibility; these documents are maintained
recommendations, not files to discard after setup. See [application methodology](../methodology/README.md)
for product design and [API guides](../README.md) for actual library contracts.
