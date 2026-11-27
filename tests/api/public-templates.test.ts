import { expect, test } from "bun:test";
import {
  Authority,
  Client,
  CompositionError,
  CompositionIndex,
  ROOT_ID,
  SequenceAllocator,
  captureActionGuards,
  compositionComponents,
  compositionReviewKey,
  compositionValidator,
  copyCompositionFragment,
  createAllocator,
  defineDocumentSchema,
  inferComposition,
  parseDocument,
  planCompositionRename,
  planSemanticAction,
  projectComposition,
  resolveCompositionPath,
  submitSemanticPlan,
  toTable,
} from "../../src/index.ts";
import type {
  ActionChecks,
  ActionGuard,
  ActionRead,
  ActionStep,
  CompositionDiagnostic,
  CompositionField,
  CompositionInterface,
  CompositionOptions,
  CompositionPath,
  CompositionResult,
  GuardedAction,
  ProjectedBinding,
  SemanticPlan,
} from "../../src/index.ts";

test("Public composition types carry explicit paths, owners and guarded effects", () => {
  const profile = defineDocumentSchema({
    id: "test",
    version: "1",
    rootTag: "doc",
    components: {
      ...compositionComponents,
      doc: {
        identity: "none",
        props: { type: "object" },
        content: {
          mode: "element",
          allowedTags: ["compositionDefinition", "compositionOccurrence"],
        },
      },
    },
  });
  const parsed = parseDocument(
    '<doc><compositionDefinition id="d" version="1"><compositionField id="f" scope="form" path="item"><script type="application/json">{"contract":{"type":"string"}}</script></compositionField></compositionDefinition><compositionOccurrence id="o" definition="d" version="1" scope="form" /></doc>',
    profile,
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const table = toTable(parsed.value, createAllocator());
  const model: CompositionInterface = inferComposition(table, "d");
  const match: CompositionPath | undefined = resolveCompositionPath(model, "form", "item");
  expect(match?.contract.type).toBe("string");
  const field: CompositionField | undefined = model.fields[0];
  expect(field?.id).toBe("f");
  const options: CompositionOptions = {};
  const result: CompositionResult | undefined = projectComposition(table, "o", options)[0];
  const binding: ProjectedBinding | undefined = result?.bindings[0];
  expect(binding?.owner).toBe("o");
  expect(new CompositionIndex(options).project(table, "o")[0]).toEqual(result);
  expect(copyCompositionFragment(["unchanged"], profile, createAllocator())).toEqual(["unchanged"]);
  expect(compositionReviewKey(table, "d")).toContain("item");
  try {
    resolveCompositionPath(model, "form", "item", "create");
    throw new Error("expected duplicate resolution to fail");
  } catch (error) {
    if (!(error instanceof CompositionError)) throw error;
    const diagnostics: readonly CompositionDiagnostic[] = error.diagnostics;
    expect(diagnostics[0]?.at).toBe("item");
  }
  const validators = [compositionValidator(options)];
  const authority = Authority.create("doc", "epoch", table, {
    schema: profile,
    validators,
    authorizeActionReads: (_actor, reads) => reads.every(({ node }) => node !== ROOT_ID),
  });
  const client = new Client({
    ...authority.scope(),
    actor: "alice",
    allocator: SequenceAllocator.ephemeral("alice"),
    table,
    revision: 0,
  });
  const checks: ActionChecks = { validators };
  const reads: readonly ActionRead[] = [{ node: ROOT_ID }];
  const guards: readonly ActionGuard[] = captureActionGuards(table, reads);
  const context: GuardedAction = { policy: "example/1", guards };
  const edit: ActionStep = {
    rule: "fill",
    apply: (draft) => draft.set("o", "values", { item: "" }),
  };
  const plan: SemanticPlan = planSemanticAction(table, context.policy, reads, edit, [], checks);
  expect(submitSemanticPlan(client, plan).status).toBe("applied");
  const request = client.nextRequest();
  if (request === undefined) throw new Error("expected request");
  const decision = authority.submit(request, { actor: "alice" });
  expect(decision).toMatchObject({ receipt: { outcome: "rejected", reason: "not authorized" } });
  expect(planCompositionRename(table, "d", "form", "item", "name", checks).effects).toHaveLength(1);
});
