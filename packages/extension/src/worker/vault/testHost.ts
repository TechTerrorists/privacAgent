/**
 * Executable stand-in for A-04's production lifecycle host (feature D-04).
 *
 * A-04 will wire real `chrome.tabs.onRemoved` / `browser.tabs.onRemoved`
 * events and the session controller's task-end/cancel signals to the vault.
 * Until that host exists, this gives other lanes — and this module's own
 * tests — a concrete, executable demonstration that a lifecycle event
 * *reaching the worker* actually invalidates the right scope, rather than
 * only ever calling `endScope`/`notifyTabClosed` directly from a test.
 *
 * The contract is deliberately minimal and carries only non-sensitive
 * identifiers (`VaultScopeId`, `TabId`) — the same identifiers the real host
 * will have on hand, since it never sees vault contents either.
 *
 * ## What remains for A-04
 *
 * Subscribe this same call pattern to the real `tabs.onRemoved` event and to
 * whatever message the background/session controller sends on task end,
 * task cancellation, or explicit session disposal. This module does not
 * implement that subscription — there is no production event source to wire
 * up yet, and a fake one would just be more code to delete later.
 */

import type { TabId } from '@privacagent/protocol';

import type { VaultApi } from './api.js';
import type { VaultScopeId } from './types.js';

export interface TestLifecycleHost {
  emitTaskEnded(scopeId: VaultScopeId): void;
  emitTaskCancelled(scopeId: VaultScopeId): void;
  emitTabClosed(tabId: TabId): void;
}

/** Wires simulated lifecycle events to a real `VaultApi` instance. */
export function createTestLifecycleHost(vault: VaultApi): TestLifecycleHost {
  return {
    emitTaskEnded(scopeId) {
      vault.endScope(scopeId, 'task_ended');
    },
    emitTaskCancelled(scopeId) {
      vault.endScope(scopeId, 'task_cancelled');
    },
    emitTabClosed(tabId) {
      vault.notifyTabClosed(tabId);
    },
  };
}
