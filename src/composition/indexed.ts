import { children } from "../core/table.ts";
import type { JsonObject } from "../core/types.ts";
import type { Table, TableNode } from "../core/table.ts";
import { inferComposition } from "./inference.ts";
import type { CompositionInterface } from "./inference.ts";
import { compositionInputs, prepareOccurrence } from "./project.ts";
import type { CompositionOptions, CompositionResult } from "./project.ts";

function sameRows(a: readonly TableNode[], b: readonly TableNode[]): boolean {
  return a.length === b.length && a.every((row, i) => row === b[i]);
}

/** Snapshot-to-snapshot memoization over persistent row identities. */
export class CompositionIndex {
  private readonly models = new WeakMap<
    TableNode,
    {
      readonly fields: readonly TableNode[];
      readonly model: CompositionInterface;
    }
  >();
  private readonly results = new WeakMap<
    TableNode,
    {
      readonly model: CompositionInterface;
      readonly owners: readonly TableNode[];
      readonly result: readonly CompositionResult[];
    }
  >();
  private readonly prepared = new WeakMap<
    JsonObject,
    {
      readonly model: CompositionInterface;
      readonly definition: TableNode;
      readonly occurrence: string;
      readonly evaluate: ReturnType<typeof prepareOccurrence>;
      readonly items: WeakMap<TableNode, CompositionResult>;
    }
  >();
  private inferred = 0;
  private evaluated = 0;

  constructor(private readonly options: CompositionOptions = {}) {}

  get counts(): { readonly inferred: number; readonly evaluated: number } {
    return { inferred: this.inferred, evaluated: this.evaluated };
  }

  project(table: Table, id: string): readonly CompositionResult[] {
    const { occurrence, definition, owners } = compositionInputs(table, id);
    const fields = children(table, definition.id);
    const old = this.models.get(definition);
    const model =
      old !== undefined && sameRows(old.fields, fields)
        ? old.model
        : this.rebuild(table, definition, fields);
    const cached = this.results.get(occurrence);
    if (cached !== undefined && cached.model === model && sameRows(cached.owners, owners))
      return cached.result;
    let prepared = this.prepared.get(occurrence.props);
    if (
      prepared === undefined ||
      prepared.model !== model ||
      prepared.definition !== definition ||
      prepared.occurrence !== occurrence.id
    ) {
      prepared = {
        model,
        definition,
        occurrence: occurrence.id,
        evaluate: prepareOccurrence(occurrence, definition, model, this.options),
        items: new WeakMap<TableNode, CompositionResult>(),
      };
      this.prepared.set(occurrence.props, prepared);
    }
    const { items, evaluate } = prepared;
    const result = owners.map((owner) => {
      const known = items.get(owner);
      if (known !== undefined) return known;
      const projected = evaluate(owner);
      items.set(owner, projected);
      this.evaluated += 1;
      return projected;
    });
    this.results.set(occurrence, { model, owners, result });
    return result;
  }

  private rebuild(table: Table, definition: TableNode, fields: readonly TableNode[]) {
    const model = inferComposition(table, definition.id);
    this.models.set(definition, { model, fields });
    this.inferred += 1;
    return model;
  }
}
