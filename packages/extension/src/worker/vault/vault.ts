/**
 * Worker-memory vault implementation (feature D-04).
 *
 * Holds sensitive values and their reverse mappings exclusively in this
 * module's own closure state — never in `chrome.storage`, IndexedDB,
 * `localStorage`, a network request, a log line, or a serialized message.
 * When a scope ends (explicitly, by tab closure, or by idle timeout), its
 * `Map`s are dropped; nothing is written anywhere else to survive that, and
 * worker termination drops everything else without any special handling.
 *
 * ## Equality
 *
 * A forward lookup key is the exact `(piiClass, value)` pair — plain `Map`
 * `SameValueZero` equality, so no case-folding, whitespace-trimming or
 * Unicode normalization ever merges two distinct original values or loses
 * the information a later, real restoration (D-09) would need.
 *
 * ## Secrets never become typable
 *
 * `piiClass === 'secret'` returns the literal `{{SECRET}}` placeholder
 * without creating any forward/reverse entry at all — there is nothing to
 * resolve, by construction, regardless of what D-09 eventually implements.
 *
 * ## Expiry
 *
 * Every access path calls `ensureLive`, which checks elapsed time against
 * the scope's `lastActivity` *before* trusting the scope exists — a
 * suspended worker whose one-shot timer never got to run cannot make an
 * expired scope look alive. The one-shot timer is a performance optimization
 * (so an idle scope is cleaned up promptly instead of only at next access),
 * not the sole source of truth.
 */

import type { PiiClass, TabId, TaskId } from '@privacagent/protocol';

import type {
  CreateScopeResult,
  InternInput,
  InternResult,
  VaultApi,
  VaultScopeInit,
} from './api.js';
import type { Clock, TimerHandle } from './clock.js';
import { createRealClock } from './clock.js';
import { InvalidVaultInputError } from './errors.js';
import type { EndScopeReason, Placeholder, UseBinding, VaultScopeId } from './types.js';

/** Default idle expiry (feature-list acceptance criterion: 15 minutes). */
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Default bound on interned entries per scope.
 *
 * Arbitrary but generous for a single task: E-01 caps a Screen State at 300
 * elements, so even a pathological page redacting every element's value
 * would need many observations to approach this. Exists so a runaway or
 * adversarial page cannot grow one scope's memory without bound.
 */
const DEFAULT_MAX_ENTRIES_PER_SCOPE = 500;

interface Entry {
  readonly value: string;
  readonly piiClass: PiiClass;
  readonly bindings: UseBinding[];
}

interface ScopeState {
  readonly scopeId: VaultScopeId;
  readonly taskId: TaskId;
  readonly ownerTabId: TabId;
  readonly forward: Map<PiiClass, Map<string, Placeholder>>;
  readonly reverse: Map<Placeholder, Entry>;
  readonly classCounters: Map<PiiClass, number>;
  lastActivity: number;
  idleTimer: TimerHandle | undefined;
}

/** Builds a class-specific placeholder, e.g. `{{EMAIL_3}}`. Matches the protocol's `Placeholder` pattern. */
function classPlaceholder(piiClass: PiiClass, n: number): Placeholder {
  return `{{${piiClass.toUpperCase()}_${n}}}`;
}

const SECRET_PLACEHOLDER: Placeholder = '{{SECRET}}';

export interface VaultOptions {
  readonly clock?: Clock;
  readonly idleTimeoutMs?: number;
  readonly maxEntriesPerScope?: number;
}

export function createVault(options: VaultOptions = {}): VaultApi {
  const clock = options.clock ?? createRealClock();
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxEntriesPerScope = options.maxEntriesPerScope ?? DEFAULT_MAX_ENTRIES_PER_SCOPE;

  const scopes = new Map<VaultScopeId, ScopeState>();
  const tabIndex = new Map<TabId, Set<VaultScopeId>>();

  function cleanupScope(scopeId: VaultScopeId, _reason: EndScopeReason): void {
    const scope = scopes.get(scopeId);
    if (!scope) return; // Idempotent: already gone is not an error.

    if (scope.idleTimer !== undefined) clock.clearTimeout(scope.idleTimer);

    const owned = tabIndex.get(scope.ownerTabId);
    if (owned) {
      owned.delete(scopeId);
      if (owned.size === 0) tabIndex.delete(scope.ownerTabId);
    }

    // Explicit, not just "let it become unreachable" — makes the guarantee
    // auditable and means a stray reference to the ScopeState object (there
    // should never be one outside this module) would still see empty maps.
    scope.forward.clear();
    scope.reverse.clear();
    scope.classCounters.clear();

    scopes.delete(scopeId);
  }

  function scheduleIdleTimer(scope: ScopeState): void {
    if (scope.idleTimer !== undefined) clock.clearTimeout(scope.idleTimer);
    scope.idleTimer = clock.setTimeout(() => {
      cleanupScope(scope.scopeId, 'idle_timeout');
    }, idleTimeoutMs);
  }

  function touch(scope: ScopeState): void {
    scope.lastActivity = clock.now();
    scheduleIdleTimer(scope);
  }

  /** The single gate every public method passes through before trusting a scope exists. */
  function ensureLive(scopeId: VaultScopeId): ScopeState | undefined {
    const scope = scopes.get(scopeId);
    if (!scope) return undefined;
    if (clock.now() - scope.lastActivity >= idleTimeoutMs) {
      cleanupScope(scopeId, 'idle_timeout');
      return undefined;
    }
    return scope;
  }

  function createScope(init: VaultScopeInit): CreateScopeResult {
    if (!init.scopeId || !init.taskId || !init.ownerTabId) {
      throw new InvalidVaultInputError('scopeId, taskId and ownerTabId are all required');
    }
    if (ensureLive(init.scopeId)) {
      return { outcome: 'error', reason: 'scope_already_exists' };
    }

    const scope: ScopeState = {
      scopeId: init.scopeId,
      taskId: init.taskId,
      ownerTabId: init.ownerTabId,
      forward: new Map(),
      reverse: new Map(),
      classCounters: new Map(),
      lastActivity: clock.now(),
      idleTimer: undefined,
    };
    scopes.set(init.scopeId, scope);
    scheduleIdleTimer(scope);

    let owned = tabIndex.get(init.ownerTabId);
    if (!owned) {
      owned = new Set();
      tabIndex.set(init.ownerTabId, owned);
    }
    owned.add(init.scopeId);

    return { outcome: 'ok' };
  }

  function intern(scopeId: VaultScopeId, input: InternInput): InternResult {
    const scope = ensureLive(scopeId);
    if (!scope) return { outcome: 'unavailable', reason: 'scope_missing' };

    // A mismatched task_id signals a caller bug (interning under the wrong
    // task context), not a value to fall back on — reject rather than
    // silently attributing it to this scope's task.
    if (input.binding.taskId !== scope.taskId) {
      return { outcome: 'unavailable', reason: 'task_mismatch' };
    }

    if (input.piiClass === 'secret') {
      touch(scope);
      return { outcome: 'ok', placeholder: SECRET_PLACEHOLDER };
    }

    let classForward = scope.forward.get(input.piiClass);
    if (!classForward) {
      classForward = new Map();
      scope.forward.set(input.piiClass, classForward);
    }

    const existing = classForward.get(input.value);
    if (existing !== undefined) {
      const entry = scope.reverse.get(existing);
      // `entry` always exists here — every forward-map value is set together
      // with its reverse-map entry below, and cleanup removes both maps
      // together — but the check keeps this function honest either way.
      if (entry) entry.bindings.push(input.binding);
      touch(scope);
      return { outcome: 'ok', placeholder: existing };
    }

    if (scope.reverse.size >= maxEntriesPerScope) {
      touch(scope);
      return { outcome: 'unavailable', reason: 'capacity_exceeded' };
    }

    const n = (scope.classCounters.get(input.piiClass) ?? 0) + 1;
    scope.classCounters.set(input.piiClass, n);
    const placeholder = classPlaceholder(input.piiClass, n);

    classForward.set(input.value, placeholder);
    scope.reverse.set(placeholder, {
      value: input.value,
      piiClass: input.piiClass,
      bindings: [input.binding],
    });
    touch(scope);

    return { outcome: 'ok', placeholder };
  }

  function hasScope(scopeId: VaultScopeId): boolean {
    return ensureLive(scopeId) !== undefined;
  }

  function entryCount(scopeId: VaultScopeId): number {
    return ensureLive(scopeId)?.reverse.size ?? 0;
  }

  function getBindings(
    scopeId: VaultScopeId,
    placeholder: Placeholder
  ): readonly UseBinding[] | undefined {
    const scope = ensureLive(scopeId);
    if (!scope) return undefined;
    const entry = scope.reverse.get(placeholder);
    return entry ? [...entry.bindings] : undefined;
  }

  function endScope(scopeId: VaultScopeId, reason: EndScopeReason): void {
    cleanupScope(scopeId, reason);
  }

  function notifyTabClosed(tabId: TabId): void {
    const owned = tabIndex.get(tabId);
    if (!owned) return;
    for (const scopeId of [...owned]) cleanupScope(scopeId, 'tab_closed');
  }

  function disposeAll(): void {
    for (const scopeId of [...scopes.keys()]) cleanupScope(scopeId, 'disposed');
  }

  return {
    createScope,
    intern,
    hasScope,
    entryCount,
    getBindings,
    endScope,
    notifyTabClosed,
    disposeAll,
  };
}
