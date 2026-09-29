/**
 * F-08: event -> state, with staleness rejection and a fixed precedence order.
 *
 * Pure and dependency-free on purpose. Everything that can go wrong in a presentation layer that
 * learns about identity too late is a bug in this file, so it is separated from the DOM, the frame
 * loop and the provider, and tested without any of them.
 *
 * The machine state is richer than the published {@link CompanionSnapshot} on purpose. Two pieces
 * of *sticky* state have to survive a late sibling event: an outstanding approval and an action
 * already in flight. Inferring them from a reason string was the obvious shortcut and it is wrong
 * — a rejected event overwrites the reason, and the inference then silently loses the approval the
 * user is still being asked about. So the flags are fields, and the snapshot is a projection of
 * them, which is what lets a test assert on the visible state and a reducer test assert on the
 * machinery without conflating the two.
 *
 * Rules, applied in this order:
 *
 * 1. **No provider means no state but `idle`.** Checked first, so no event can animate a run that
 *    nothing is actually reporting.
 * 2. **Staleness, before the event is allowed to want anything.** Older generation refused first,
 *    then a different task inside the current generation. The state is left untouched and the
 *    refusal is recorded, so "nothing arrived" and "something arrived and was refused" stay
 *    distinguishable.
 * 3. **Precedence, most urgent first:** `needs-approval` > `acting` > `thinking` > `listening` >
 *    `idle`. Approval outranks everything because a consequential action is waiting on a person,
 *    and `acting` outranks `thinking` because "doing it" is truer than "deciding to do it".
 * 4. **Terminal events clear immediately, and leave a tombstone.** A cancel, a denied permission
 *    or a lost host drops both the state and the identity, and remembers the identity it dropped.
 *    Every later event from that generation or an older one is refused for as long as no newer
 *    generation arrives, so a late event cannot resurrect the run that was cancelled.
 *
 * On the tombstone rather than keeping the identity live: keeping it would refuse a genuinely new
 * run that reused a generation, which is precisely the assumption rule 2 exists to distrust. The
 * tombstone is the floor instead of the window — a new run has to be *newer* to be heard, which
 * generations are by contract, and everything at or below the retired generation stays refused
 * whether or not anyone has started anything new.
 */
import type {
  CompanionEvent,
  CompanionIdentity,
  CompanionRejection,
  CompanionSnapshot,
  CompanionState,
} from './types.js';

/** Internal state. Not published: the side panel and tests read {@link CompanionSnapshot}. */
export interface CompanionMachine {
  readonly state: CompanionState;
  readonly identity: CompanionIdentity | null;
  /**
   * The newest identity that has been retired by a terminal event. Not published: it is a
   * staleness floor, and exposing it would invite a caller to reason about it.
   */
  readonly retired: CompanionIdentity | null;
  readonly captureConfirmed: boolean;
  /** An approval is outstanding and must not be dropped by a late sibling event. */
  readonly approvalPending: boolean;
  /** An action is executing; `thinking` ends it, nothing else does. */
  readonly actionInFlight: boolean;
  /** Why the current state is showing. Never drawn in the page. */
  readonly reason: string;
  readonly lastRejected: CompanionRejection | null;
  readonly lastRejectedDetail: string | null;
}

export const INITIAL_MACHINE: CompanionMachine = Object.freeze({
  state: 'idle',
  identity: null,
  retired: null,
  captureConfirmed: false,
  approvalPending: false,
  actionInFlight: false,
  reason: 'no provider connected',
  lastRejected: null,
  lastRejectedDetail: null,
});

/** Events that mean "nothing is running", clearing the state and the identity together. */
const TERMINAL_EVENTS: ReadonlySet<CompanionEvent['type']> = new Set([
  'task-finished',
  'task-cancelled',
  'host-lost',
]);

export function toSnapshot(machine: CompanionMachine): CompanionSnapshot {
  return {
    state: machine.state,
    identity: machine.identity,
    reason: machine.reason,
    captureConfirmed: machine.captureConfirmed,
    lastRejected: machine.lastRejected,
  };
}

export interface ReduceOptions {
  /**
   * Whether a real provider is attached. `false` pins the companion to `idle` regardless of what
   * arrives, which is the truthful production behaviour before A-11 and F-09 exist.
   */
  readonly providerAvailable: boolean;
}

export function reduceCompanion(
  previous: CompanionMachine,
  event: CompanionEvent,
  options: ReduceOptions
): CompanionMachine {
  // Rule 1, ahead of staleness: a fabricated provider is a worse problem than a stale event.
  if (!options.providerAvailable) {
    return refuse(previous, 'host-unavailable', 'no presentation provider connected');
  }
  if (!isKnownEvent(event)) {
    return refuse(previous, 'unknown-event', `unknown event ${String(event?.type)}`);
  }
  if (!isIdentity(event.identity)) {
    return refuse(previous, 'unknown-event', 'event is missing a usable identity');
  }

  const incoming = event.identity;
  const staleness = classifyStale(previous.identity, previous.retired, incoming);
  if (staleness !== null) {
    if (isCaptureStop(event.type) && previous.captureConfirmed) {
      // The one way a refused event still changes something, and the change is strictly subtractive.
      // Note what is *not* touched: the identity stays whatever it was. Letting the incoming
      // identity become the live one would resurrect the very run the floor just rejected, and
      // that run's own late events would then be accepted as current. `retired` is left alone too,
      // so a second retraction is refused normally instead of being quietly re-honoured.
      const captureConfirmed = false;
      return {
        ...previous,
        state: chooseState(
          event.type,
          {
            approvalPending: previous.approvalPending,
            actionInFlight: previous.actionInFlight,
          },
          captureConfirmed
        ),
        captureConfirmed,
        reason: event.type,
        lastRejected: null,
        lastRejectedDetail: null,
      };
    }
    // The state is carried through byte for byte: a rejected event must not move the companion,
    // and a rejected event must not clear a flag the user is still waiting on either.
    return refuse(
      previous,
      staleness,
      `${event.type} from ${incoming.taskId} (gen ${incoming.generation})`
    );
  }

  // Rule 4.
  if (TERMINAL_EVENTS.has(event.type)) {
    // A finished task does not close a microphone that is genuinely open, so the capture flag
    // survives and the companion falls back to the one background state it can still honestly
    // show. A cancellation and a lost host both mean the run's context is gone, so capture cannot
    // be assumed either way and the flag is dropped with it.
    const captureSurvives = event.type === 'task-finished' && previous.captureConfirmed;
    return {
      // `listening` rather than a hard `idle`: returning to idle while the microphone is provably
      // open would under-report the one fact the companion is certain of.
      state: captureSurvives ? 'listening' : 'idle',
      identity: null,
      // The floor moves up to whatever was just retired, so a late sibling of *this* event is
      // refused even though the live identity is now null.
      retired: previous.identity ?? previous.retired,
      approvalPending: false,
      actionInFlight: false,
      captureConfirmed: captureSurvives,
      reason: event.type,
      lastRejected: null,
      lastRejectedDetail: null,
    };
  }

  const captureConfirmed = nextCapture(previous.captureConfirmed, event.type);
  const approvalPending = nextApproval(previous.approvalPending, event.type);
  const actionInFlight = nextAction(previous.actionInFlight, event.type);

  return {
    state: chooseState(event.type, { approvalPending, actionInFlight }, captureConfirmed),
    identity: incoming,
    // The floor is left where it is: a live identity supersedes it, and it is raised again if this
    // run is retired later.
    retired: previous.retired,
    captureConfirmed,
    approvalPending,
    actionInFlight,
    reason: event.type,
    lastRejected: null,
    lastRejectedDetail: null,
  };
}

/**
 * `listening` is a *background* fact, so it is computed rather than assigned: the companion shows
 * it whenever capture is confirmed and nothing more urgent is true. That is what makes it
 * impossible for a stray event to switch it on — only `audio-capture-confirmed` sets the flag, and
 * only `audio-capture-ended`/`audio-capture-denied` clear it.
 */
function chooseState(
  type: CompanionEvent['type'],
  flags: { approvalPending: boolean; actionInFlight: boolean },
  captureConfirmed: boolean
): CompanionState {
  if (type === 'approval-requested' || flags.approvalPending) return 'needs-approval';
  if (type === 'acting' || flags.actionInFlight) return 'acting';
  if (type === 'thinking' || type === 'task-started') return 'thinking';
  if (captureConfirmed) return 'listening';
  return 'idle';
}

function nextCapture(current: boolean, type: CompanionEvent['type']): boolean {
  if (type === 'audio-capture-confirmed') return true;
  if (type === 'audio-capture-ended' || type === 'audio-capture-denied') return false;
  return current;
}

/**
 * Whether the event is one that can only *retract* a capture claim.
 *
 * This exists because staleness and capture have different jobs. Staleness protects a *run*: a
 * late event from a cancelled or finished run must not resurrect it, and the tombstone does that.
 * But capture is not part of a run, it is a fact about the microphone, and it outlives any one
 * task. `task-finished` deliberately keeps the confirmed-capture flag, so the companion can keep
 * reporting "listening" after a task ends — and that leaves exactly one hole: the run that
 * confirmed capture has been retired, so the eventual `audio-capture-ended` arrives carrying a
 * retired identity and is refused as stale. The companion then claims to be listening to a
 * microphone nobody has stopped, and nothing will ever correct it, because the only event that
 * could is the one being refused.
 *
 * Retractions are therefore exempt from the staleness floor. It is safe because these events can
 * only *remove* a claim, never add one: accepting a stale "capture ended" makes the companion
 * quieter, never louder, and cannot bring back a run or a state. A stale `audio-capture-confirmed`
 * is *not* exempt — that one would let a dead run assert that it is listening.
 */
function isCaptureStop(type: CompanionEvent['type']): boolean {
  return type === 'audio-capture-ended' || type === 'audio-capture-denied';
}

function nextApproval(current: boolean, type: CompanionEvent['type']): boolean {
  if (type === 'approval-requested') return true;
  // Only an explicit resolution, a new task, or a terminal event releases the approval.
  if (type === 'approval-resolved' || type === 'task-started') return false;
  return current;
}

function nextAction(current: boolean, type: CompanionEvent['type']): boolean {
  if (type === 'acting') return true;
  if (type === 'thinking' || type === 'task-started') return false;
  return current;
}

/**
 * Returns the rejection reason, or `null` when the event is current. A strictly newer generation
 * always wins, even for a repeated event type: a new generation is a new run, and a new run is
 * entitled to change its mind.
 */
function classifyStale(
  current: CompanionIdentity | null,
  retired: CompanionIdentity | null,
  incoming: CompanionIdentity
): CompanionRejection | null {
  if (current !== null) {
    if (incoming.generation > current.generation) return null;
    if (incoming.generation < current.generation) return 'stale-generation';
    return incoming.taskId === current.taskId ? null : 'stale-task';
  }
  // Nothing is running. A newer generation than anything retired is a new run and is heard; at or
  // below the floor it is a straggler from a run that is already over, and is refused.
  if (retired === null) return null;
  if (incoming.generation > retired.generation) return null;
  if (incoming.generation < retired.generation) return 'stale-generation';
  return incoming.taskId === retired.taskId ? 'stale-generation' : 'stale-task';
}

function refuse(
  previous: CompanionMachine,
  reason: CompanionRejection,
  detail: string
): CompanionMachine {
  return { ...previous, lastRejected: reason, lastRejectedDetail: detail };
}

function isIdentity(value: unknown): value is CompanionIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CompanionIdentity>;
  return (
    typeof candidate.generation === 'number' &&
    Number.isFinite(candidate.generation) &&
    typeof candidate.taskId === 'string' &&
    candidate.taskId.length > 0
  );
}

const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  'task-started',
  'thinking',
  'acting',
  'task-finished',
  'task-cancelled',
  'approval-requested',
  'approval-resolved',
  'audio-capture-confirmed',
  'audio-capture-ended',
  'audio-capture-denied',
  'host-lost',
]);

function isKnownEvent(event: CompanionEvent): boolean {
  return typeof event?.type === 'string' && KNOWN_EVENTS.has(event.type);
}
