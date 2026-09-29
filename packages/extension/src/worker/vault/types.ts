/**
 * Vault identity, binding and lifecycle types (feature D-04).
 *
 * Built on D-01's privacy types (`PiiClass`, `Placeholder`) and E-01's
 * identifiers (`SessionId`, `TaskId`, `TabId`, `DocumentId`, `ElementId`).
 * This module defines no competing PII classification and no competing wire
 * schema — a vault entry's `piiClass` and generated `Placeholder` are exactly
 * D-01's/E-01's types, reused, not reshaped.
 */

import type {
  DocumentId,
  ElementId,
  PiiClass,
  Placeholder,
  SessionId,
  TabId,
  TaskId,
} from '@privacagent/protocol';

export type { DocumentId, ElementId, PiiClass, Placeholder, TabId, TaskId };

/**
 * A vault scope is keyed by the session it belongs to — one scope per live
 * session, matching the PRD's session-scoped placeholder consistency rule
 * ("{{EMAIL_1}} always maps to the same value" within a session).
 */
export type VaultScopeId = SessionId;

/**
 * Which action types may later type a resolved value back into the page.
 * Provisional — D-09 owns the authoritative enforcement of this and may
 * extend the set; D-04 only stores it as opaque metadata.
 */
export type VaultOperation = 'type' | 'select';

/**
 * Authorization metadata carried with an interned entry (PRD vault
 * architecture; AGENTS.md use-binding requirements).
 *
 * Recorded, never merged: interning the same value again under a different
 * binding appends a new entry to that placeholder's binding history (see
 * `VaultApi.getBindings`) rather than replacing or widening the existing
 * one. A later observation can therefore never silently broaden what an
 * earlier one granted — enforcement of "is this specific request covered by
 * some recorded binding" is D-09's job, not this module's.
 */
export interface UseBinding {
  readonly taskId: TaskId;
  readonly origin: string;
  readonly docId: DocumentId;
  readonly allowedTargets: readonly ElementId[];
  readonly operations: readonly VaultOperation[];
}

/** Why a scope was invalidated. Carried only for lifecycle bookkeeping — never a resolution decision. */
export type EndScopeReason =
  'task_ended' | 'task_cancelled' | 'tab_closed' | 'disposed' | 'idle_timeout';
