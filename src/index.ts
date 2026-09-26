export type {
  JsonScalar,
  JsonValue,
  JsonObject,
  ComponentNode,
  ContentItem,
  DocumentModel,
} from "./core/types.ts";
export { isComponentNode } from "./core/types.ts";

export type { Diagnostic, DiagnosticCode, SourceSpan, Result } from "./core/diagnostics.ts";
export { DiagnosticError, ok, err } from "./core/diagnostics.ts";

export type {
  AdditionalPolicy,
  ComponentSchema,
  ContentMode,
  PropertySchema,
  SchemaProfile,
  ValueType,
} from "./core/schema.ts";
export { getComponentSchema } from "./core/schema.ts";
export type {
  ComponentDefinition,
  DocumentSchemaDefinition,
  JsonSchema,
} from "./core/schema-definition.ts";
export { SUPPORTED_KEYWORDS, SCHEMA_LIMITS } from "./core/schema-definition.ts";
export { defineDocumentSchema } from "./core/schema-document.ts";
export type {
  LegacyComponentSchema,
  LegacyPropertySchema,
  LegacySchemaProfile,
} from "./core/schema-legacy.ts";
export { migrateLegacySchema, registerSchema } from "./core/schema-legacy.ts";

export { normalizeComponentProps, deepEqual } from "./core/normalize.ts";
export type { EditableDocument, EditableNode, MutableJsonValue } from "./core/json-copy.ts";
export { editableCopy } from "./core/json-copy.ts";
export { attributeNameToProperty } from "./core/naming.ts";

export { parseDocument, parseFragment, parseMultiRoot } from "./core/parser.ts";
export { serializeDocument, serializeFragment } from "./core/serializer.ts";

export {
  decodeDocumentJson,
  normalizeDocument,
  validateDocument,
  DOCUMENT_LIMITS,
} from "./core/document-check.ts";
export { validateTable } from "./core/validate.ts";
export type { Located } from "./core/address.ts";
export { findNodeById } from "./core/address.ts";

export type { Table, TableNode } from "./core/table.ts";
export {
  toTable,
  fromTable,
  createAllocator,
  children,
  textOf,
  ROOT_ID,
  TEXT_TAG,
} from "./core/table.ts";
export type { PropPath } from "./core/json-path.ts";

export type { Change, ChangeKind, Origin, SubtreeRecord } from "./core/change.ts";
export {
  CHANGE_KINDS,
  invertChange,
  invertChanges,
  compareOrigin,
  OPERATION_FORMAT,
} from "./core/change.ts";
export { canonicalJson, decodeChanges, DecodeError } from "./core/change-codec.ts";
export { applyChanges } from "./core/apply.ts";
export { ApplyError } from "./core/staging.ts";
export type { ApplyErrorCode } from "./core/staging.ts";
export type { TransformConflict, TransformConflictCode, Transformed } from "./core/transform.ts";
export { transformPair, rebase, isConflict, TransformLimitError } from "./core/transform.ts";
export { compose } from "./core/compose.ts";
export type { AuthoredBy, NodeSpec } from "./core/builder.ts";
export { ChangeBuilder } from "./core/builder.ts";
export type { OccurrenceLookup } from "./core/builder-rich.ts";
export {
  wrapText,
  unwrap,
  splitContainer,
  mergeContainers,
  findOccurrence,
} from "./core/builder-rich.ts";
export { diffToChanges, minimalSplice } from "./core/diff.ts";

export type { RequestId, AllocatorState, AllocatorStore } from "./core/identity.ts";
export {
  SequenceAllocator,
  IdentityError,
  isReplicaId,
  requestKey,
  MAX_SEQUENCE,
} from "./core/identity.ts";
export type {
  Outcome,
  RequestMeta,
  RequestEnvelope,
  TransitionEvent,
  ReceiptEvent,
  ServerEvent,
  ProtocolErrorCode,
} from "./core/protocol.ts";
export { CONTROL_PROFILE, ProtocolError, decodeRequest, fingerprint } from "./core/protocol.ts";
export type {
  AuthorityState,
  AuthorityOptions,
  Authorizer,
  Decision,
  DecisionRecord,
  Prepared,
  Principal,
} from "./core/authority.ts";
export { Authority, StaleDecisionError, recordOf } from "./core/authority.ts";
export type { CandidateValidator } from "./core/invariants.ts";
export { schemaValidator } from "./core/invariants.ts";
export type { CheckpointBundle } from "./core/checkpoint.ts";
export {
  exportCheckpoint,
  importCheckpoint,
  restoreAuthority,
  CheckpointError,
  CHECKPOINT_FORMAT,
} from "./core/checkpoint.ts";
export type { DurableStore, StoredHistory } from "./core/host.ts";
export { AuthorityHost, StaleOwnerError } from "./core/host.ts";

export type { ClientOptions, ClientSession, ClientStatus, TransactResult } from "./core/client.ts";
export { Client } from "./core/client.ts";
export type { PendingEntry, RetainedIntent, RetainedStatus } from "./core/client-queue.ts";
export type { UndoResult } from "./core/client-undo.ts";
export type { GroupRecord, Handle, HistoryExport } from "./core/history.ts";
export type {
  CoalescingPolicy,
  EditShape,
  GroupingContext,
  HistoryPolicy,
  UnsentCoalescingContext,
} from "./core/grouping.ts";
export { typingHistoryPolicy, conservativeCoalescing, noCoalescing } from "./core/grouping.ts";
export type {
  CommitCause,
  DocumentSnapshot,
  DocumentStore,
  ModelCommit,
  StatusEvent,
} from "./core/store.ts";
export type { ChangeSummary } from "./core/summary.ts";
export type { Anchor, AnchorResult, TextSegment } from "./core/anchors.ts";
export { mapAnchor, mapAnchorFrom, anchoredContent } from "./core/anchors.ts";
export type { Proposal, ProposalRebase, TransitionSource } from "./core/proposal.ts";
export { proposeEdit, rebaseProposal } from "./core/proposal.ts";

export type { AsyncState, DerivationContext, Scheduler } from "./runtime/derived.ts";
export { DerivedGraph, DependencyCycleError } from "./runtime/derived.ts";
export type { ProjectedInstance, ProjectionOptions } from "./runtime/projection.ts";
export { ClassProjection } from "./runtime/projection.ts";
export type { Selector } from "./runtime/selector.ts";
export { createSelector } from "./runtime/selector.ts";

export type { Budget, ProviderId, ProviderProfile } from "./core/provider-profiles.ts";
export { PROVIDER_PROFILES } from "./core/provider-profiles.ts";
export type { ProviderExport } from "./core/provider-export.ts";
export { exportComponentProperties, exportDocument } from "./core/provider-export.ts";
export type { ProviderResponse } from "./core/provider-decode.ts";
export { decodeProviderOutput, decodeProviderResponse } from "./core/provider-decode.ts";
export { encodeProviderOutput } from "./core/provider-encode.ts";

export {
  PUBLIC_REGION,
  regionOwner,
  projectTable,
  RestrictedAuthority,
} from "./core/visibility.ts";
export type { ActionHandler, RestrictedDecision } from "./core/visibility.ts";
