import type { Change } from "./change.ts";
import { invertChanges } from "./change.ts";
import type { CleanHandle, LogEntry, Recovery } from "./history-recovery.ts";
import { cancelPairs, degraded, mapChanges, mapOver, RECOVERY_LIMIT } from "./history-recovery.ts";
import type { TransitionEvent } from "./protocol.ts";

/**
 * A current-context cancellation (or redo) handle: complete reversible
 * primitives already mapped to the client's confirmed revision, plus how
 * many original contributions are no longer effective. A handle that met a
 * later incompatible change becomes a conflict and is never applied blindly.
 * A handle degraded by a transition (conflict or lost contribution) keeps a
 * `recovery` while it can still be restored by an own undo/redo that
 * cancels that transition (v3 §8, SPEC §20).
 */
export type Handle = (CleanHandle | { readonly conflict: string }) & {
  readonly recovery?: Recovery;
};

export type GroupState = "active" | "undone" | "spent";

export interface GroupRecord {
  readonly id: string;
  readonly label?: string;
  readonly order: number;
  readonly members: readonly number[];
  readonly state: GroupState;
  readonly undo: Handle;
  readonly redo?: Handle;
  /** Sequence of an own undo/redo request that is still unresolved. */
  readonly pendingRequest?: number;
  readonly lastError?: string;
}

export interface HistoryExport {
  readonly revision: number;
  readonly groups: readonly GroupRecord[];
  readonly redoStack: readonly string[];
  readonly nextOrder: number;
}

const EMPTY: Handle = { changes: [], dropped: 0 };

type Mapped = CleanHandle | { readonly conflict: string };

/** Map a handle that keeps no recovery; start one when the transition degrades it. */
function step(handle: Mapped, entry: LogEntry): Handle {
  if ("conflict" in handle) return { conflict: handle.conflict };
  const mapped = mapChanges(handle, entry.changes);
  const next: Mapped =
    "conflict" in mapped
      ? { conflict: mapped.conflict }
      : { changes: mapped.changes, dropped: mapped.dropped };
  if (!degraded(handle, next)) return next;
  const base = { changes: handle.changes, dropped: handle.dropped };
  return { ...next, recovery: { base, since: [entry] } };
}

/**
 * Fold one accepted transition into a handle. A degraded handle also logs
 * the transition; when it is an own undo/redo that cancels earlier own
 * effects, the handle is recomputed from its last clean form.
 */
function advance(handle: Handle | undefined, entry: LogEntry): Handle | undefined {
  if (handle === undefined) return undefined;
  const { recovery, ...current } = handle;
  if (recovery === undefined) return step(current, entry);
  const reduced = cancelPairs([...recovery.since, entry]);
  if (reduced !== undefined) {
    const next = mapOver(recovery.base, reduced);
    return degraded(recovery.base, next)
      ? { ...next, recovery: { base: recovery.base, since: reduced } }
      : next;
  }
  const { recovery: _fresh, ...next } = step(current, entry);
  const since = [...recovery.since, entry];
  return since.length > RECOVERY_LIMIT ? next : { ...next, recovery: { ...recovery, since } };
}

function tagOf(transition: TransitionEvent, own: boolean): LogEntry["own"] {
  const meta = transition.meta;
  if (!own) return undefined;
  if (meta.undoOf !== undefined) return { group: meta.undoOf, kind: "undo" };
  if (meta.redoOf !== undefined) return { group: meta.redoOf, kind: "redo" };
  return meta.group === undefined ? undefined : { group: meta.group, kind: "do" };
}

/** A new own member's inverse runs first; recovery cannot span the group's own growth. */
function prepend(inverse: readonly Change[], handle: Handle): Handle {
  if ("conflict" in handle) return { conflict: handle.conflict };
  return { changes: [...inverse, ...handle.changes], dropped: handle.dropped };
}

/**
 * The caller's own user history (v3 §8): groups spanning any number of
 * accepted transactions, each with an undo handle maintained in the
 * confirmed context as transitions arrive — an own member's inverse is
 * prepended; every other transition rebases the handle. Undo and redo are
 * new requests linked to the group; accepted history is never rewritten.
 */
export class UndoHistory {
  private readonly groups = new Map<string, GroupRecord>();
  private redoStack: string[] = [];
  private nextOrder = 0;
  private revision: number;

  constructor(
    revision: number,
    private readonly limit = 100,
  ) {
    this.revision = revision;
  }

  static restore(data: HistoryExport, limit = 100): UndoHistory {
    const history = new UndoHistory(data.revision, limit);
    for (const group of data.groups) history.groups.set(group.id, group);
    history.redoStack = [...data.redoStack];
    history.nextOrder = data.nextOrder;
    return history;
  }

  export(): HistoryExport {
    return {
      revision: this.revision,
      groups: [...this.groups.values()],
      redoStack: [...this.redoStack],
      nextOrder: this.nextOrder,
    };
  }

  get(id: string): GroupRecord | undefined {
    return this.groups.get(id);
  }

  list(): readonly GroupRecord[] {
    return [...this.groups.values()].sort((a, b) => a.order - b.order);
  }

  /** Record that local request `seq` belongs to `group` (created on first use). */
  addMember(group: string, seq: number, label?: string): void {
    const existing = this.groups.get(group);
    if (existing !== undefined) {
      this.groups.set(group, { ...existing, members: [...existing.members, seq] });
      return;
    }
    this.groups.set(group, {
      id: group,
      ...(label === undefined ? {} : { label }),
      order: this.nextOrder++,
      members: [seq],
      state: "active",
      undo: EMPTY,
    });
    const overflow = [...this.groups.values()]
      .sort((a, b) => a.order - b.order)
      .slice(0, Math.max(0, this.groups.size - this.limit));
    for (const old of overflow) this.groups.delete(old.id);
  }

  /** Default redo policy: fresh normal local work clears the active redo branch. */
  clearRedo(): void {
    for (const id of this.redoStack) {
      const group = this.groups.get(id);
      if (group?.state === "undone") this.groups.set(id, { ...group, state: "spent", redo: EMPTY });
    }
    this.redoStack = [];
  }

  setPending(group: string, seq: number | undefined, error?: string): void {
    const record = this.groups.get(group);
    if (record === undefined) return;
    const { pendingRequest: _p, lastError: _e, ...rest } = record;
    this.groups.set(group, {
      ...rest,
      ...(seq === undefined ? {} : { pendingRequest: seq }),
      ...(error === undefined ? {} : { lastError: error }),
    });
  }

  /** Fold one confirmed transition, in revision order. `own` is true for this replica's requests. */
  onTransition(transition: TransitionEvent, own: boolean): void {
    this.revision = transition.revision;
    const meta = transition.meta;
    const inverse = invertChanges(transition.changes);
    const tag = tagOf(transition, own);
    const entry: LogEntry =
      tag === undefined
        ? { changes: transition.changes }
        : { changes: transition.changes, own: tag };
    const target = tag?.group;
    for (const group of this.groups.values()) {
      if (group.id === target) continue;
      const undo = advance(group.undo, entry) ?? EMPTY;
      const redo = advance(group.redo, entry);
      this.groups.set(group.id, { ...group, undo, ...(redo === undefined ? {} : { redo }) });
    }
    const group = target === undefined ? undefined : this.groups.get(target);
    if (group === undefined) return;
    const { pendingRequest: _p, lastError: _e, redo: _r, ...rest } = group;
    if (meta.undoOf !== undefined) {
      this.groups.set(group.id, {
        ...rest,
        state: "undone",
        undo: EMPTY,
        redo: { changes: inverse, dropped: 0 },
      });
      this.redoStack.push(group.id);
    } else if (meta.redoOf !== undefined) {
      this.groups.set(group.id, {
        ...rest,
        state: "active",
        undo: { changes: inverse, dropped: 0 },
      });
      this.redoStack = this.redoStack.filter((id) => id !== group.id);
    } else {
      this.groups.set(group.id, { ...group, undo: prepend(inverse, group.undo) });
    }
  }

  /** Latest own group that can still be undone (skipping spent ones). */
  latestUndoable(): GroupRecord | undefined {
    return this.list()
      .filter((group) => group.state === "active" && group.pendingRequest === undefined)
      .pop();
  }

  latestRedoable(): GroupRecord | undefined {
    const id = this.redoStack[this.redoStack.length - 1];
    return id === undefined ? undefined : this.groups.get(id);
  }

  markSpent(group: string): void {
    const record = this.groups.get(group);
    if (record !== undefined) this.groups.set(group, { ...record, state: "spent" });
  }

  /** The handles' context is gone (history reset / resync): every retained group becomes unavailable. */
  forgetAll(revision: number): void {
    this.groups.clear();
    this.redoStack = [];
    this.revision = revision;
  }
}
