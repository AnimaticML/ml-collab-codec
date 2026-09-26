import type { JsonValue } from "./types.ts";
import type { Change } from "./change.ts";
import { destroyedNodes, requiredNodes, subtreeIds } from "./change.ts";
import { canonicalJson } from "./change-codec.ts";
import type { ChangeBuilder } from "./builder.ts";
import { ChangeBuilder as Builder } from "./builder.ts";
import { OPERATION_FORMAT } from "./change.ts";
import type { Decision, Principal } from "./authority.ts";
import { Authority } from "./authority.ts";
import type { CandidateValidator } from "./invariants.ts";
import type { RequestId } from "./identity.ts";
import { requestKey } from "./identity.ts";
import type { ServerEvent } from "./protocol.ts";
import { CONTROL_PROFILE } from "./protocol.ts";
import type { SchemaProfile } from "./schema.ts";
import type { Table, TableNode } from "./table.ts";
import { reshapeRow } from "./table.ts";
import { diffToChanges } from "./diff.ts";
import { fromTable } from "./table.ts";

/**
 * Homogeneous visibility regions (SPEC 13): a component tag can declare
 * `regionOwnerProp`; its subtree is owned by that property's value.
 * Unmarked content is public. This is a delivery/authorization contract on
 * top of the ordinary protocol, not a new operation kind.
 */
export const PUBLIC_REGION = "public";

export function regionOwner(table: Table, profile: SchemaProfile, nodeId: string): string {
  for (let cursor: string | null = nodeId; cursor !== null;) {
    const row: TableNode | undefined = table.get(cursor);
    if (row === undefined) break;
    const ownerProp = profile.components[row.tag]?.regionOwnerProp;
    const owner = ownerProp === undefined ? undefined : row.props[ownerProp];
    if (typeof owner === "string") return owner;
    cursor = row.parentId;
  }
  return PUBLIC_REGION;
}

function canSee(table: Table, profile: SchemaProfile, id: string, principal: string): boolean {
  const owner = regionOwner(table, profile, id);
  return owner === PUBLIC_REGION || owner === principal;
}

/** A participant's authorized snapshot: rows in public or the principal's own regions, child lists filtered. */
export function projectTable(table: Table, profile: SchemaProfile, principal: string): Table {
  const visible = new Map<string, TableNode>();
  for (const [id, row] of table) {
    if (!canSee(table, profile, id, principal)) continue;
    const kids = row.children.filter((child) => canSee(table, profile, child, principal));
    visible.set(
      id,
      kids.length === row.children.length ? row : reshapeRow(row, { children: kids }),
    );
  }
  return visible;
}

/** A trusted application action: builds its changes from current state, or returns false to refuse. */
export type ActionHandler = (
  table: Table,
  principal: string,
  params: Readonly<Record<string, JsonValue>>,
  builder: ChangeBuilder,
) => boolean;

/** Every node a change reads or writes, including list parents whose positions it addresses. */
function touchedByChange(change: Change): string[] {
  const ids = [...requiredNodes(change), ...destroyedNodes(change)];
  if (change.kind === "nodeInsert") ids.push(...subtreeIds(change.subtree));
  return ids;
}

/** A child list can be addressed by position only when every child is visible to the principal. */
function listParents(change: Change): string[] {
  if (
    change.kind === "nodeInsert" ||
    change.kind === "nodeDelete" ||
    change.kind === "split" ||
    change.kind === "merge"
  )
    return [change.parent];
  if (change.kind === "nodeMove") return [change.fromParent, change.toParent];
  return [];
}

/** Every node the changes address is absent or visible, and every addressed child list is fully visible. */
function addressable(
  table: Table,
  profile: SchemaProfile,
  changes: readonly Change[],
  principal: string,
): boolean {
  const visible = (id: string): boolean => canSee(table, profile, id, principal);
  return changes.every(
    (change) =>
      touchedByChange(change).every((id) => !table.has(id) || visible(id)) &&
      listParents(change).every((parent) => (table.get(parent)?.children ?? []).every(visible)),
  );
}

/** Whether a change could move content between regions (an owner property or a component type). */
function regionShaping(table: Table, profile: SchemaProfile, change: Change): boolean {
  if (change.kind === "setTag") return true;
  if (!("path" in change)) return false;
  const row = table.get(change.node);
  const ownerProp = row === undefined ? undefined : profile.components[row.tag]?.regionOwnerProp;
  return ownerProp !== undefined && (change.path.length === 0 || change.path[0] === ownerProp);
}

export interface RestrictedDecision {
  readonly decision: Decision;
  /** Events this principal may receive: projected content, safe receipt; never another region's data. */
  readonly eventsFor: (principal: string) => readonly ServerEvent[];
}

/**
 * Region-scoped writes and trusted authorized actions over one authority.
 * Rights are evaluated against the current trusted state inside the same
 * synchronous admission step that commits (V03/V05).
 */
export class RestrictedAuthority {
  readonly authority: Authority;
  private readonly actions = new Map<string, ActionHandler>();
  private readonly actionReceipts = new Map<string, { key: string; result: RestrictedDecision }>();

  constructor(
    private readonly profile: SchemaProfile,
    documentId: string,
    historyEpoch: string,
    initial: Table,
    validators: readonly CandidateValidator[] = [],
  ) {
    this.authority = Authority.create(documentId, historyEpoch, initial, {
      validators,
      authorize: (actor, changes, current) => this.scopedAllowed(actor, changes, current),
    });
  }

  private scopedAllowed(actor: string, changes: readonly Change[], current: Table): boolean {
    return addressable(current, this.profile, changes, actor);
  }

  view(principal: string): Table {
    return projectTable(this.authority.getTable(), this.profile, principal);
  }

  /** The complete authoritative state (a full authorized export is self-contained). */
  fullView(): Table {
    return this.authority.getTable();
  }

  /**
   * An explicitly partial participant export: only rows the principal may
   * read, no retained transitions, receipts, or inverse payloads. It cannot
   * be imported as a complete replacement of unseen regions.
   */
  exportFor(principal: string): {
    readonly partial: true;
    readonly principal: string;
    readonly revision: number;
    readonly rows: readonly TableNode[];
  } {
    const rows = [...this.view(principal).values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    return { partial: true, principal, revision: this.authority.getRevision(), rows };
  }

  registerAction(name: string, handler: ActionHandler): void {
    this.actions.set(name, handler);
  }

  submit(request: unknown, principal: Principal): RestrictedDecision {
    const before = this.authority.getTable();
    return this.withProjection(this.authority.submit(request, principal), before, principal.actor);
  }

  /** Run a trusted action for `principal` against current state, atomically. */
  submitAction(
    principal: string,
    name: string,
    params: Readonly<Record<string, JsonValue>>,
    request: RequestId,
  ): RestrictedDecision {
    const key = canonicalJson({ name, params, principal });
    const previous = this.actionReceipts.get(requestKey(request));
    if (previous !== undefined) {
      if (previous.key !== key)
        throw new Error("action request id reused with different parameters");
      return previous.result;
    }
    const before = this.authority.getTable();
    const builder = new Builder(before, request);
    const handler = this.actions.get(name);
    const allowed = handler !== undefined && handler(before, principal, params, builder);
    const { documentId, historyEpoch } = this.authority.scope();
    const envelope = {
      profile: CONTROL_PROFILE,
      opFormat: OPERATION_FORMAT,
      documentId,
      historyEpoch,
      replica: request.replica,
      seq: request.seq,
      baseRevision: this.authority.getRevision(),
      changes: allowed ? builder.changes : [],
      meta: {},
    };
    const decision = allowed
      ? this.authority.submitTrusted(envelope, { actor: principal })
      : this.authority.refuse(envelope, { actor: principal }, "not authorized");
    const result = this.withProjection(decision, before, principal);
    this.actionReceipts.set(requestKey(request), { key, result });
    return result;
  }

  private withProjection(decision: Decision, before: Table, actor: string): RestrictedDecision {
    const after = this.authority.getTable();
    const profile = this.profile;
    return {
      decision,
      eventsFor: (principal) => {
        if (decision.kind !== "decided") return [];
        const events: ServerEvent[] = [];
        const transition = decision.transition;
        if (transition !== undefined) {
          const changes = forwardable(transition.changes, before, after, profile, principal)
            ? transition.changes
            : projectedChanges(before, after, profile, principal, transition.request);
          events.push({
            ...transition,
            meta: transition.actor === principal ? transition.meta : {},
            changes,
          });
        }
        if (principal === actor) events.push(decision.receipt);
        return events;
      },
    };
  }
}

/**
 * The original records can be delivered unchanged (same handles, no
 * projection work) when they address only content the principal sees both
 * before and after and cannot move content between regions.
 */
function forwardable(
  changes: readonly Change[],
  before: Table,
  after: Table,
  profile: SchemaProfile,
  principal: string,
): boolean {
  return (
    !changes.some((change) => regionShaping(before, profile, change)) &&
    addressable(before, profile, changes, principal) &&
    addressable(after, profile, changes, principal)
  );
}

/**
 * Fallback when visibility changes (reveals, hides, region moves): diff the
 * principal's projections. This costs a projection of both states, and
 * newly revealed anonymous content gets participant-local handles.
 */
function projectedChanges(
  before: Table,
  after: Table,
  profile: SchemaProfile,
  principal: string,
  author: RequestId,
): Change[] {
  const seen = projectTable(before, profile, principal);
  const target = fromTable(projectTable(after, profile, principal), "projection", "1").root;
  return diffToChanges(seen, target, author);
}
