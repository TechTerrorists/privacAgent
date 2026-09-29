/**
 * F-08: the presentation contract for the cursor companion.
 *
 * The companion is a **thin presentation layer**. It draws a state that something else decided; it
 * does not decide anything, and it must never be able to. That constraint is the whole reason this
 * file exists as a separate, deliberately small contract rather than a callback the side panel
 * fires at an overlay.
 *
 * There is no state owner in the repository yet. A-11 (#46) is the intended owner of invocation and
 * mode state, and F-09 (#106) of real audio capture; both are open. So the companion defines the
 * interface it needs and refuses to invent an implementation: with no provider connected the only
 * state it can reach is `idle`, and it says so rather than animating a plausible lie.
 *
 * Two rules shape everything below.
 *
 * **Every event carries identity, and identity is checked before the event is applied.** Task and
 * generation numbers are the only thing standing between a late message from a cancelled run and a
 * companion that has gone back to "acting" on a page the user has since moved on from. The reducer
 * in `reducer.ts` drops anything that is not strictly newer, and the rejection is observable
 * rather than silent.
 *
 * **`listening` has exactly one source.** Not a hotkey press, not an intent, not a mode change:
 * a confirmed audio-capture event, and nothing else. A companion that shows "listening" when the
 * microphone is closed is worse than no companion, because it is a privacy claim the UI makes on
 * the user's behalf and cannot keep.
 */
import type { DocumentId, ElementId } from '@privacagent/protocol';
import type { OverlayAnchor } from '../overlay/types.js';

/**
 * The five states. Each is visually distinct by **shape and motion**, never by colour alone, so
 * the companion is still readable to a user who cannot separate the hues — and in forced-colours
 * mode, where the colours are discarded entirely.
 *
 * - `idle` — nothing is happening. Static.
 * - `listening` — audio capture is *confirmed* open. Radiating arcs.
 * - `thinking` — a task is running and the agent is deciding. A rotating broken ring.
 * - `acting` — the agent is performing an action right now. A directional chevron.
 * - `needs-approval` — a consequential action is waiting on the user. A held ring with a pause bar.
 */
export type CompanionState = 'idle' | 'listening' | 'thinking' | 'acting' | 'needs-approval';

export const COMPANION_STATES: readonly CompanionState[] = [
  'idle',
  'listening',
  'thinking',
  'acting',
  'needs-approval',
];

export function isCompanionState(value: unknown): value is CompanionState {
  return (
    value === 'idle' ||
    value === 'listening' ||
    value === 'thinking' ||
    value === 'acting' ||
    value === 'needs-approval'
  );
}

/**
 * Identity of the run an event belongs to.
 *
 * `generation` is the authority and `taskId` is the detail: a new generation supersedes every
 * event of an older one no matter what the task id says, and within one generation a different
 * task id is a different task. Comparing them as a pair is what makes a late event from a
 * superseded run rejectable rather than merely unlikely.
 */
export interface CompanionIdentity {
  /** Monotonic. Higher always wins. Never reused within a document. */
  readonly generation: number;
  readonly taskId: string;
}

/**
 * Events the companion understands. This is a closed union on purpose: a presentation layer with an
 * open-ended event type ends up reading whatever shape is convenient at the call site, and the
 * staleness and precedence rules stop being enforceable.
 *
 * Every variant carries {@link CompanionIdentity} except the two that mean "nothing is running
 * any more", which are still carried alongside the identity they invalidate so a late event from
 * the run being cancelled cannot resurrect it.
 */
export type CompanionEvent =
  /** A-11: a task started. Not proof of a microphone. */
  | { readonly type: 'task-started'; readonly identity: CompanionIdentity }
  /** A-11: the agent finished deciding and is about to act. */
  | { readonly type: 'thinking'; readonly identity: CompanionIdentity }
  /** A-11: an action is executing. */
  | { readonly type: 'acting'; readonly identity: CompanionIdentity }
  /** A-11: the run ended on its own. */
  | { readonly type: 'task-finished'; readonly identity: CompanionIdentity }
  /** A-11: the user or the run cancelled. Always clears to idle, immediately. */
  | { readonly type: 'task-cancelled'; readonly identity: CompanionIdentity }
  /** F-06: a consequential action needs a decision. Pointer only — never a control. */
  | { readonly type: 'approval-requested'; readonly identity: CompanionIdentity }
  /** F-06: the decision was made. */
  | { readonly type: 'approval-resolved'; readonly identity: CompanionIdentity }
  /**
   * F-09: audio capture is **confirmed** open. The only event that may produce `listening`.
   *
   * A provider that cannot actually open the microphone must not send this. The event name is
   * the contract: `capture-requested` or `push-to-talk` would both be lies by construction.
   */
  | { readonly type: 'audio-capture-confirmed'; readonly identity: CompanionIdentity }
  /** F-09: capture stopped, cleanly. Clears `listening` immediately. */
  | { readonly type: 'audio-capture-ended'; readonly identity: CompanionIdentity }
  /** F-09: permission was denied or the device failed. Clears `listening` immediately. */
  | { readonly type: 'audio-capture-denied'; readonly identity: CompanionIdentity }
  /** Transport to the host went away. Everything is unverifiable, so everything clears. */
  | { readonly type: 'host-lost'; readonly identity: CompanionIdentity };

/**
 * The injectable seam between "what is true" and "what the page shows".
 *
 * Deliberately an **event** interface and not a `getState()` poll. A poll invites an
 * implementation that computes a state the page then has to trust, which is how a fake gets into
 * a production path; a push interface keeps the truth on the provider's side and makes the
 * companion's only job — decide what to draw, and refuse stale draws — visible in one file.
 */
export interface CompanionPresentationAdapter {
  /**
   * Delivers one event. Implementations must not throw; a rejected promise from a provider must
   * not be able to leave the companion showing a state nothing supports.
   */
  deliver(event: CompanionEvent): void;
  /**
   * Registers the sink for future events. Returns an unsubscribe that removes the listener and
   * nothing else — no timers, no polling, nothing to tear down. F-08 asserts that after disposal
   * this leaves no listener behind at all.
   */
  subscribe(sink: (event: CompanionEvent) => void): () => void;
  /**
   * True when a real provider is attached.
   *
   * A `false` here is not an error state to hide: it is the honest answer in production today,
   * because A-11 and F-09 do not exist yet. The companion renders `idle` and the side panel is
   * where the real status lives.
   */
  readonly available: boolean;
  /** Short label for the side panel and tests. Never shown in the page. */
  readonly label: string;
}

/** Read-only view of the companion, for the side panel, tests and the gallery. */
export interface CompanionSnapshot {
  readonly state: CompanionState;
  /** Identity of the run that produced {@link state}, or `null` while idle with no run. */
  readonly identity: CompanionIdentity | null;
  /** Why the current state is showing. Surfaced for tests and docs, never drawn in the page. */
  readonly reason: string;
  /** True when audio capture is confirmed open. Independent of the drawn state. */
  readonly captureConfirmed: boolean;
  /**
   * Whether the last event was rejected for being stale. The companion's state is unaffected by a
   * rejected event, so this is the only way a test (or the side panel) can tell the difference
   * between "nothing arrived" and "something arrived and was correctly refused".
   */
  readonly lastRejected: CompanionRejection | null;
}

export type CompanionRejection =
  'stale-generation' | 'stale-task' | 'unknown-event' | 'host-unavailable';

/**
 * The default provider used in production until A-11 and F-09 land.
 *
 * It is not a stub that fakes activity. It delivers nothing, ever, and reports
 * `available: false`, which pins the companion to `idle`. This is the single most important
 * behaviour in the module: with no real state owner connected, the page shows a still character
 * and the side panel shows the truth, rather than the page inventing a plausible-looking run.
 */
export const UNAVAILABLE_ADAPTER: CompanionPresentationAdapter = {
  deliver: () => undefined,
  subscribe: () => () => undefined,
  available: false,
  label: 'no provider connected',
};

/**
 * Sentinel element id for the companion's synthetic target.
 *
 * The companion is not anchored to a page element — it follows the pointer — so it needs a target
 * identity of its own. It is built with the *live* document generation rather than a fixed one,
 * because F-02 treats an anchor whose `doc_id` no longer matches `currentDocId()` as `stale` and
 * stops drawing it; a hardcoded document id would therefore never resolve at all. See
 * {@link companionAnchor}.
 *
 * A page cannot collide with this id. Element ids are minted by the extension's own registry with
 * a reserved prefix and a generation suffix, and the companion is answered by its own resolver
 * before the registry is ever consulted, so there is no path by which a page node could be mistaken
 * for the companion's anchor.
 */
export const COMPANION_ELEMENT_ID = '__pa-companion__' as ElementId;

/**
 * Builds the companion's anchor for the current document generation.
 *
 * Returns `null` when the document is no longer addressable, which is the signal to withdraw the
 * annotation rather than draw against a retired generation.
 */
export function companionAnchor(docId: DocumentId | null): OverlayAnchor | null {
  if (docId === null) return null;
  return { doc_id: docId, element_id: COMPANION_ELEMENT_ID };
}
