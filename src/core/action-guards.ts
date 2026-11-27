import { canonicalJson, DecodeError } from "./change-codec.ts";
import type { Table } from "./table.ts";

export interface ActionRead {
  readonly node: string;
  /** A top-level property, or the node's ordered children when omitted. */
  readonly property?: string;
}

export interface ActionGuard extends ActionRead {
  readonly expected: string;
}

const MAX_READS = 1024;
const MAX_BYTES = 256_000;

function read(table: Table, target: ActionRead): string {
  const row = table.get(target.node);
  return canonicalJson(
    row === undefined
      ? []
      : [
          row.tag,
          target.property === undefined
            ? row.children
            : Object.hasOwn(row.props, target.property)
              ? [row.props[target.property]]
              : [],
        ],
  );
}

export function captureActionGuards(table: Table, reads: readonly ActionRead[]): ActionGuard[] {
  return decodeActionGuards(reads.map((target) => ({ ...target, expected: read(table, target) })));
}

export function staleAction(table: Table, guards: readonly ActionGuard[]): boolean {
  return guards.some((guard) => read(table, guard) !== guard.expected);
}

export function decodeActionGuards(value: unknown): ActionGuard[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_READS)
    throw new DecodeError("meta.guards", "expected 1–1024 action reads");
  let size = 0;
  return value.map((item: unknown, index) => {
    const at = `meta.guards[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new DecodeError(at, "expected action read");
    const raw = item as Record<string, unknown>;
    const { node, property, expected } = raw;
    if (
      Object.keys(raw).some((key) => !["node", "property", "expected"].includes(key)) ||
      typeof node !== "string" ||
      node.length === 0 ||
      (property !== undefined && (typeof property !== "string" || property.length === 0)) ||
      typeof expected !== "string"
    )
      throw new DecodeError(at, "invalid action read");
    size += node.length + (property?.length ?? 0) + expected.length;
    if (size > MAX_BYTES) throw new DecodeError(at, "action read budget exceeded");
    return { node, ...(property === undefined ? {} : { property }), expected };
  });
}

export interface GuardedAction {
  readonly policy: string;
  readonly guards: readonly ActionGuard[];
  readonly rules?: readonly string[];
}

export function decodeActionRules(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_READS ||
    !value.every(
      (rule: unknown): rule is string =>
        typeof rule === "string" && rule.length > 0 && rule.length <= 128,
    )
  )
    throw new DecodeError("meta.rules", "expected bounded effect rule names");
  return [...value];
}

export function guardAuthoring(action: GuardedAction | undefined) {
  const guards = action === undefined ? undefined : decodeActionGuards(action.guards);
  const policy = action?.policy;
  const request =
    action === undefined
      ? {}
      : {
          policy: action.policy,
          guards: guards ?? [],
          ...(action.rules === undefined ? {} : { rules: decodeActionRules(action.rules) }),
        };
  return {
    request,
    check<T>(table: Table, build: T): T {
      if (
        action !== undefined &&
        (!policy || policy.length > 128 || guards === undefined || staleAction(table, guards))
      )
        throw new DecodeError("meta.guards", "invalid policy or stale action reads");
      return build;
    },
  };
}
