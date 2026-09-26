import type { Change } from "./change.ts";
import { OPERATION_FORMAT } from "./change.ts";
import { canonicalJson } from "./change-codec.ts";
import type { PendingEntry } from "./client-queue.ts";
import { compose } from "./compose.ts";
import type {
  CoalescingPolicy,
  EditShape,
  HistoryPolicy,
  PreviousLocalChange,
} from "./grouping.ts";
import { conservativeCoalescing, typingHistoryPolicy } from "./grouping.ts";
import type { RequestEnvelope, RequestMeta } from "./protocol.ts";
import { CONTROL_PROFILE } from "./protocol.ts";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** The immutable submitted form of an entry at the current confirmed revision (canonical bytes, frozen). */
export function envelopeFor(
  scope: { readonly documentId: string; readonly historyEpoch: string },
  entry: PendingEntry,
  baseRevision: number,
): RequestEnvelope {
  const bytes = canonicalJson({
    profile: CONTROL_PROFILE,
    opFormat: OPERATION_FORMAT,
    documentId: scope.documentId,
    historyEpoch: scope.historyEpoch,
    replica: entry.id.replica,
    seq: entry.id.seq,
    baseRevision,
    changes: entry.working,
    meta: entry.meta,
  });
  return deepFreeze(JSON.parse(bytes) as RequestEnvelope);
}

/**
 * Local grouping state (v3 §7): the previous own change, explicit gesture/
 * task tokens, explicit closes, and whether remote work intervened. The
 * application policies decide; the library only offers safe compositions.
 */
export class AuthoringState {
  private previous: PreviousLocalChange | undefined;
  private remoteSincePrevious = false;
  private closed = false;
  private explicit: { token: string; label: string } | undefined;

  constructor(
    private readonly identity: { readonly actor: string; readonly session: string },
    private readonly historyPolicy: HistoryPolicy = typingHistoryPolicy(),
    private readonly coalescing: CoalescingPolicy = conservativeCoalescing,
  ) {}

  get label(): string | undefined {
    return this.explicit?.label;
  }

  begin(token: string, label: string): void {
    this.explicit = { token, label };
  }
  end(): void {
    this.explicit = undefined;
    this.closed = true;
  }
  close(): void {
    this.closed = true;
  }
  noteRemote(): void {
    this.remoteSincePrevious = true;
  }

  /** Choose the group of a new local change; `known` says whether a group is still retained. */
  chooseGroup(
    fresh: string,
    shape: EditShape,
    now: number,
    known: (group: string) => boolean,
  ): string {
    const decision = this.historyPolicy.group({
      ...this.identity,
      explicitToken: this.explicit?.token,
      previous: this.previous,
      current: shape,
      now,
      remoteSincePrevious: this.remoteSincePrevious,
      closed: this.closed,
    });
    const previous = this.previous;
    return decision === "extend" && previous !== undefined && known(previous.group)
      ? previous.group
      : fresh;
  }

  noteAuthored(group: string, shape: EditShape, at: number): void {
    this.previous = { group, shape, at, explicitToken: this.explicit?.token };
    this.remoteSincePrevious = false;
    this.closed = false;
  }

  /**
   * Pre-send compression into the last unsent request of the same group.
   * `allow` only permits an attempt; the pack happens only when the algebra
   * actually simplifies, and never touches an in-flight or accepted request.
   */
  pack(
    pending: readonly PendingEntry[],
    changes: readonly Change[],
    shape: EditShape,
    group: string,
    seq: number,
  ): PendingEntry[] | undefined {
    const last = pending[pending.length - 1];
    if (last === undefined || last.state !== "unsent" || last.meta.group !== group)
      return undefined;
    const allowed = this.coalescing.allow({
      sameGroup: true,
      previousUnsent: true,
      previous: last.shape,
      current: shape,
      explicitToken: this.explicit?.token,
    });
    if (!allowed) return undefined;
    const composed = compose(last.working, changes);
    if (composed.length >= last.working.length + changes.length) return undefined;
    const meta: RequestMeta = { ...last.meta, packed: [...(last.meta.packed ?? []), seq] };
    return [...pending.slice(0, -1), { ...last, meta, working: composed, shape }];
  }
}
