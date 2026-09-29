/**
 * Shared test scaffolding for the companion's tests.
 *
 * Kept in its own file because the controller defaults to the *unavailable* adapter, which is
 * correct in production and useless in a test: every test that wants to see a state has to inject
 * a provider anyway. A fake one lives here so the two test files cannot drift apart on what a
 * "provider" means.
 */
import type { DocumentId } from '@privacagent/protocol';
import {
  createCompanionResolver,
  createPointerSource,
  type PointerSource,
} from './pointer-resolver.js';
import type { CompanionEvent, CompanionPresentationAdapter } from './types.js';
import type { TargetResolver } from '../overlay/types.js';

/**
 * A resolver for tests that care about the preference rather than the pointer.
 *
 * Wraps a resolver that reports the pointer as permanently unseen, so a companion enabled by a
 * test draw is in the "nothing to point at yet" state — the honest default — without every test
 * having to move a pointer it does not care about.
 */
export function createFakePointerlessResolver(docId: DocumentId): TargetResolver {
  return createCompanionResolver(
    { currentDocId: () => docId, resolve: () => ({ status: 'missing' }) },
    createPointerSource(window)
  );
}

/**
 * A provider standing in for A-11 (#46) and F-09 (#106), which do not exist yet.
 *
 * `available: true` is the only thing that makes a test's events reach the reducer, and it is
 * always explicit: nothing in the production path sets it.
 */
export function createTestAdapter(available = true): CompanionPresentationAdapter & {
  deliver(event: CompanionEvent): void;
  get subscriberCount(): number;
} {
  const sinks = new Set<(event: CompanionEvent) => void>();
  return {
    available,
    label: available ? 'test provider' : 'unavailable',
    deliver: (event: CompanionEvent) => {
      for (const sink of sinks) sink(event);
    },
    subscribe: (sink: (event: CompanionEvent) => void) => {
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
      };
    },
    get subscriberCount() {
      return sinks.size;
    },
  };
}

/** A pointer whose position a test sets directly, with no real cursor and no window listener. */
export function createTestPointer(): PointerSource & { moveTo(x: number, y: number): void } {
  let sample: { x: number; y: number } | null = null;
  let onMove: (() => void) | null = null;
  return {
    // A method rather than a getter, matching the interface exactly.
    current: () => sample,
    get isTracking() {
      return onMove !== null;
    },
    start: (next: () => void) => {
      onMove = next;
    },
    stop: () => {
      onMove = null;
      sample = null;
    },
    moveTo: (x: number, y: number) => {
      sample = { x, y };
      onMove?.();
    },
  };
}
