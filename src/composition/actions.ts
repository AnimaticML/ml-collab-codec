import { ChangeBuilder } from "../core/builder.ts";
import type { PropPath } from "../core/json-path.ts";
import type { JsonValue } from "../core/types.ts";
import type { Change } from "../core/change.ts";
import type { Client } from "../core/client.ts";
import type { CandidateValidator } from "../core/invariants.ts";
import type { Authorizer } from "../core/authority-types.ts";
import type { Table } from "../core/table.ts";
import { captureActionGuards } from "../core/action-guards.ts";
import type { ActionGuard, ActionRead } from "../core/action-guards.ts";
import { fail } from "./native.ts";

export interface ActionStep {
  /** Stable identifier for a requested operation or a versioned consequence rule. */
  readonly rule: string;
  readonly apply: (builder: {
    set(node: string, path: PropPath | string, value: JsonValue | undefined): void;
  }) => void;
}

export interface SemanticPlan {
  readonly policy: string;
  readonly guards: readonly ActionGuard[];
  readonly effects: readonly {
    readonly rule: string;
    readonly requested: boolean;
    readonly change: Change;
  }[];
}

export interface ActionChecks {
  readonly validators?: readonly CandidateValidator[];
  readonly authorize?: Authorizer;
  readonly actor?: string;
  readonly maxSteps?: number;
  readonly maxEffects?: number;
}

/** Run trusted synchronous steps once, in their declared dependency order, on a private candidate. */
export function planSemanticAction(
  table: Table,
  policy: string,
  reads: readonly ActionRead[],
  requested: ActionStep,
  consequences: readonly ActionStep[],
  checks: ActionChecks = {},
): SemanticPlan {
  if (policy.length === 0 || consequences.length + 1 > Math.min(checks.maxSteps ?? 64, 64))
    fail(policy, "action step budget exceeded or missing policy");
  const steps = [requested, ...consequences];
  if (
    steps.some((step) => !step.rule || step.rule.length > 128) ||
    new Set(steps.map((step) => step.rule)).size !== steps.length
  )
    fail(policy, "rules require unique names in dependency order");
  const captured = new Map(reads.map((read) => [JSON.stringify([read.node, read.property]), read]));
  let commands = 0;
  const maxEffects = Math.min(checks.maxEffects ?? 1024, 1024);
  const builder = new ChangeBuilder(table, { replica: "action-preview", seq: 1 });
  const effects: SemanticPlan["effects"][number][] = [];
  for (const [index, step] of steps.entries()) {
    step.apply({
      set: (...args) => {
        if (++commands > maxEffects) fail(policy, "action effect budget exceeded");
        const [node, path] = args;
        const property = typeof path === "string" ? path : path[0];
        if (typeof property !== "string") fail(policy, "expected a top-level property");
        captured.set(JSON.stringify([node, property]), { node, property });
        builder.set(...args);
      },
    });
    for (const change of builder.changes.slice(effects.length))
      effects.push({ rule: step.rule, requested: index === 0, change });
  }
  if (
    checks.authorize !== undefined &&
    !checks.authorize(checks.actor ?? "", builder.changes, table)
  )
    fail(policy, "not authorized");
  const candidate = builder.current();
  for (const validate of checks.validators ?? []) {
    const reason = validate(candidate, builder.changes, table);
    if (reason !== null) fail(policy, reason);
  }
  return { policy, guards: captureActionGuards(table, [...captured.values()]), effects };
}

/** Reattribute inspected effects to the actual local request; recorded undo keeps those origins. */
export function submitSemanticPlan(client: Client, plan: SemanticPlan) {
  return client.transact(
    (builder) => {
      for (const { change } of plan.effects) {
        if (change.kind !== "set") fail(plan.policy, "unsupported planned primitive");
        builder.set(change.node, change.path, change.after);
      }
    },
    { policy: plan.policy, guards: plan.guards, rules: plan.effects.map(({ rule }) => rule) },
  );
}
