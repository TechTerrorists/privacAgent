/**
 * The worker vault interface (feature D-04).
 *
 * A session-scoped, worker-memory-only store: sensitive values in, opaque
 * placeholders out. Every method's return type is scoped to what a consumer
 * (D-05's text substitution, eventually D-09's authorized resolution) may
 * safely see: placeholders, counts, and non-sensitive binding metadata.
 * **There is no method that returns a raw stored value by placeholder** —
 * that is D-09's entire job, and until D-09 exists, resolution is simply
 * absent from this surface rather than implemented insecurely.
 */

import type { TabId, TaskId } from '@privacagent/protocol';

import type { EndScopeReason, PiiClass, Placeholder, UseBinding, VaultScopeId } from './types.js';

export interface VaultScopeInit {
  readonly scopeId: VaultScopeId;
  readonly taskId: TaskId;
  /** The tab that owns this scope. `notifyTabClosed` ends every scope this tab owns. */
  readonly ownerTabId: TabId;
}

export type CreateScopeResult =
  | { readonly outcome: 'ok' }
  | { readonly outcome: 'error'; readonly reason: 'scope_already_exists' };

export interface InternInput {
  readonly piiClass: PiiClass;
  readonly value: string;
  readonly binding: UseBinding;
}

export type InternUnavailableReason = 'scope_missing' | 'capacity_exceeded' | 'task_mismatch';

/**
 * `ok.placeholder` is always safe to place in a Screen State. There is no
 * outcome that returns the interned value — a caller that needs to display
 * something back to the user displays the placeholder, never the value.
 */
export type InternResult =
  | { readonly outcome: 'ok'; readonly placeholder: Placeholder }
  | { readonly outcome: 'unavailable'; readonly reason: InternUnavailableReason };

/**
 * On-device, worker-memory-only sensitive value store.
 *
 * Implementations must not perform network I/O, persist to extension
 * storage/IndexedDB/logs/telemetry, or expose a stored value through any
 * method — including error messages and thrown exceptions.
 */
export interface VaultApi {
  /** Opens a new scope. Fails if `scopeId` already names a live scope. */
  createScope(init: VaultScopeInit): CreateScopeResult;

  /**
   * Interns a value, returning a consistent placeholder for repeat calls
   * with the same `(scope, piiClass, value)`. Refreshes the scope's idle
   * timer — this is the vault's one "legitimate activity" operation.
   */
  intern(scopeId: VaultScopeId, input: InternInput): InternResult;

  /** Whether `scopeId` names a live, non-expired scope. Read-only — never refreshes activity. */
  hasScope(scopeId: VaultScopeId): boolean;

  /** Number of interned entries in a scope. `0` for a missing or expired scope. Read-only. */
  entryCount(scopeId: VaultScopeId): number;

  /**
   * The recorded use-bindings for a placeholder, in the order they were
   * granted. `undefined` if the scope or placeholder is unknown. Returns a
   * copy — mutating the result never affects vault state. Read-only.
   */
  getBindings(scopeId: VaultScopeId, placeholder: Placeholder): readonly UseBinding[] | undefined;

  /** Explicitly invalidates a scope (task end/cancel, explicit disposal). Idempotent. */
  endScope(scopeId: VaultScopeId, reason: EndScopeReason): void;

  /** Invalidates every scope owned by `tabId`. Idempotent; a no-op if none exist. */
  notifyTabClosed(tabId: TabId): void;

  /** Invalidates every live scope. For worker teardown and test cleanup. */
  disposeAll(): void;
}
