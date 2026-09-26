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
    for (const change of changes) {
      if (
        !touchedByChange(change).every(
          (id) => !current.has(id) || canSee(current, this.profile, id, actor),
        )
      )
        return false;
      for (const parent of listParents(change))
        if (
          !(current.get(parent)?.children ?? []).every((child) =>
            canSee(current, this.profile, child, actor),
          )
        )
          return false;
    }
    return true;
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
          const seen = projectTable(before, profile, principal);
          const target = fromTable(projectTable(after, profile, principal), "projection", "1").root;
          const changes = diffToChanges(seen, target, transition.request);
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
