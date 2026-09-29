/**
 * F-08: the presentation reducer.
 *
 * No DOM, no overlay, no provider. Everything asserted here is a rule about which state a given
 * event sequence may produce, and the two rules that are hardest to get right are the ones with
 * the most cases below: a stale event must be *inert* (not merely rejected in its effect), and
 * `listening` must be unreachable by anything other than a confirmed capture.
 */
import { describe, expect, it } from 'vitest';
import { INITIAL_MACHINE, reduceCompanion, toSnapshot, type CompanionMachine } from './reducer.js';
import type { CompanionEvent, CompanionIdentity } from './types.js';

const AVAILABLE = { providerAvailable: true };
const UNAVAILABLE = { providerAvailable: false };

const identity = (generation: number, taskId = 'task-1'): CompanionIdentity => ({
  generation,
  taskId,
});

/** Folds a sequence, returning the final machine. */
function run(
  events: CompanionEvent[],
  from: CompanionMachine = INITIAL_MACHINE,
  options = AVAILABLE
): CompanionMachine {
  return events.reduce((state, event) => reduceCompanion(state, event, options), from);
}

function event(type: CompanionEvent['type'], gen = 1, taskId = 'task-1'): CompanionEvent {
  return { type, identity: identity(gen, taskId) } as CompanionEvent;
}

describe('listening is reachable only from a confirmed capture', () => {
  it('shows listening when capture is confirmed and nothing more urgent is true', () => {
    const machine = run([event('audio-capture-confirmed')]);
    expect(machine.state).toBe('listening');
    expect(machine.captureConfirmed).toBe(true);
  });

  it.each<CompanionEvent['type']>([
    'task-started',
    'thinking',
    'acting',
    'approval-requested',
    'approval-resolved',
    'task-finished',
    'task-cancelled',
  ])('never shows listening from %s alone', (type) => {
    expect(run([event(type)]).state).not.toBe('listening');
  });

  it('does not treat a mode change as proof of a microphone', () => {
    // The specific bug this guards: a provider that knows a *task* started and infers the user
    // must therefore be talking.
    const machine = run([event('task-started'), event('thinking'), event('acting')]);
    expect(machine.state).toBe('acting');
    expect(machine.captureConfirmed).toBe(false);
  });

  it('keeps listening visible underneath a thinking task', () => {
    const machine = run([event('audio-capture-confirmed'), event('task-started')]);
    expect(machine.captureConfirmed).toBe(true);
    expect(machine.state).toBe('thinking');
  });

  it('returns to listening when a task finishes but capture really is open', () => {
    const machine = run([
      event('audio-capture-confirmed'),
      event('task-started'),
      event('task-finished'),
    ]);
    expect(machine.state).toBe('listening');
  });

  it('clears listening the moment capture ends', () => {
    const machine = run([event('audio-capture-confirmed'), event('audio-capture-ended')]);
    expect(machine.state).toBe('idle');
    expect(machine.captureConfirmed).toBe(false);
  });

  it('clears listening when capture is denied', () => {
    const machine = run([event('audio-capture-confirmed'), event('audio-capture-denied')]);
    expect(machine.state).toBe('idle');
    expect(machine.captureConfirmed).toBe(false);
  });
});

describe('precedence', () => {
  it('puts approval above acting', () => {
    const machine = run([event('acting'), event('approval-requested')]);
    expect(machine.state).toBe('needs-approval');
  });

  it('keeps approval showing when a late acting event arrives', () => {
    const machine = run([event('approval-requested'), event('acting')]);
    expect(machine.state).toBe('needs-approval');
  });

  it('releases approval only on an explicit resolution', () => {
    const machine = run([event('approval-requested'), event('approval-resolved'), event('acting')]);
    expect(machine.state).toBe('acting');
  });

  it('puts acting above thinking', () => {
    expect(run([event('thinking'), event('acting')]).state).toBe('acting');
  });

  it('returns to thinking after an action completes and a new step is planned', () => {
    const machine = run([event('acting'), event('thinking')]);
    expect(machine.state).toBe('thinking');
  });
});

describe('staleness', () => {
  it('rejects an event from an older generation', () => {
    const current = run([event('task-started', 5)]);
    const next = reduceCompanion(current, event('acting', 4), AVAILABLE);
    expect(next.state).toBe('thinking');
    expect(next.lastRejected).toBe('stale-generation');
  });

  it('rejects an event from a different task inside the same generation', () => {
    const current = run([event('task-started', 5)]);
    const next = reduceCompanion(current, event('acting', 5, 'task-2'), AVAILABLE);
    expect(next.state).toBe('thinking');
    expect(next.lastRejected).toBe('stale-task');
  });

  it('leaves the state completely untouched when rejecting', () => {
    const current = run([event('task-started', 5), event('approval-requested', 5)]);
    const before = { ...current };
    const next = reduceCompanion(current, event('acting', 4), AVAILABLE);
    // The identity, the sticky approval flag and the capture flag all survive. A rejected event
    // must not be able to clear an approval the user is still being asked about.
    expect(next.state).toBe(before.state);
    expect(next.identity).toEqual(before.identity);
    expect(next.approvalPending).toBe(true);
    expect(next.actionInFlight).toBe(before.actionInFlight);
  });

  it('accepts a strictly newer generation even for the same event type', () => {
    const current = run([event('task-started', 5)]);
    const next = reduceCompanion(current, event('task-started', 6), AVAILABLE);
    expect(next.state).toBe('thinking');
    expect(next.lastRejected).toBeNull();
  });

  it('clears the rejection record once a valid event lands', () => {
    const stale = reduceCompanion(run([event('task-started', 5)]), event('acting', 4), AVAILABLE);
    expect(stale.lastRejected).not.toBeNull();
    const fresh = reduceCompanion(stale, event('acting', 6), AVAILABLE);
    expect(fresh.lastRejected).toBeNull();
  });

  it('rejects an event with a non-finite generation', () => {
    const next = reduceCompanion(
      INITIAL_MACHINE,
      { type: 'acting', identity: { generation: Number.NaN, taskId: 't' } },
      AVAILABLE
    );
    expect(next.state).toBe('idle');
    expect(next.lastRejected).toBe('unknown-event');
  });

  it('rejects an event with an empty task id', () => {
    const next = reduceCompanion(
      INITIAL_MACHINE,
      { type: 'acting', identity: { generation: 1, taskId: '' } },
      AVAILABLE
    );
    expect(next.lastRejected).toBe('unknown-event');
  });

  it('rejects an event type it does not know', () => {
    const next = reduceCompanion(
      INITIAL_MACHINE,
      { type: 'not-a-real-event', identity: identity(1) } as unknown as CompanionEvent,
      AVAILABLE
    );
    expect(next.state).toBe('idle');
    expect(next.lastRejected).toBe('unknown-event');
  });
});

describe('terminal events', () => {
  it.each<CompanionEvent['type']>(['task-finished', 'task-cancelled', 'host-lost'])(
    '%s returns to idle immediately',
    (type) => {
      const machine = run([event('acting'), event(type)]);
      expect(machine.state).toBe('idle');
    }
  );

  it('leaves a tombstone, so a late event cannot resurrect the cancelled run', () => {
    const cancelled = run([event('acting', 7), event('task-cancelled', 7)]);
    expect(cancelled.identity).toBeNull();
    expect(cancelled.state).toBe('idle');

    // The straggler: the same run, still talking, after it was cancelled. The live identity is
    // gone, so only the tombstone can refuse this, and it does. This is the case the old
    // drop-everything behaviour got wrong, by accepting it.
    const late = reduceCompanion(cancelled, event('acting', 7), AVAILABLE);
    expect(late.state).toBe('idle');
    expect(late.lastRejected).toBe('stale-generation');

    // A late event from a different task in the same retired generation is refused too.
    const sibling = reduceCompanion(cancelled, event('acting', 7, 'other'), AVAILABLE);
    expect(sibling.state).toBe('idle');
    expect(sibling.lastRejected).toBe('stale-task');

    // An even older generation is refused as well: the floor is a floor.
    const older = reduceCompanion(cancelled, event('acting', 3), AVAILABLE);
    expect(older.state).toBe('idle');
    expect(older.lastRejected).toBe('stale-generation');

    // The floor is a floor, not a lock: a genuinely new run is newer by contract, and is heard
    // without any help from the previous run's teardown.
    const nextRun = reduceCompanion(cancelled, event('task-started', 8, 'task-2'), AVAILABLE);
    expect(nextRun.state).toBe('thinking');
    expect(nextRun.identity).toEqual(identity(8, 'task-2'));
  });

  it('raises the tombstone to the newest retired identity', () => {
    // Two runs in a row, each cancelled: a straggler from the *first* one must still be refused
    // after the second has come and gone, which only works if the floor moved rather than reset.
    let machine = run([event('acting', 7), event('task-cancelled', 7)]);
    machine = reduceCompanion(machine, event('task-started', 8, 'task-2'), AVAILABLE);
    machine = reduceCompanion(machine, event('task-cancelled', 8, 'task-2'), AVAILABLE);
    expect(machine.state).toBe('idle');

    expect(reduceCompanion(machine, event('acting', 7), AVAILABLE).lastRejected).toBe(
      'stale-generation'
    );
    expect(reduceCompanion(machine, event('acting', 8, 'task-2'), AVAILABLE).lastRejected).toBe(
      'stale-generation'
    );
    expect(reduceCompanion(machine, event('task-started', 9, 'task-3'), AVAILABLE).state).toBe(
      'thinking'
    );
  });

  it('honours a capture stop that arrives after the confirming run was retired', () => {
    // The bug this pins. `task-finished` keeps the confirmed-capture flag on purpose, so the
    // companion falls back to "listening" instead of under-reporting an open microphone. But it
    // also retires that run's identity, and the `audio-capture-ended` that eventually arrives
    // carries exactly that retired identity — so the staleness floor refused it, and the companion
    // claimed to be listening to a microphone nobody had stopped, with no event left that could
    // ever correct it.
    const finished = run([event('audio-capture-confirmed', 4), event('task-finished', 4)]);
    expect(finished.state).toBe('listening');
    expect(finished.captureConfirmed).toBe(true);

    const stopped = reduceCompanion(finished, event('audio-capture-ended', 4), AVAILABLE);
    expect(stopped.captureConfirmed).toBe(false);
    expect(stopped.state).toBe('idle');
  });

  it('honours a capture denial that arrives after the confirming run was retired', () => {
    const finished = run([event('audio-capture-confirmed', 4), event('task-finished', 4)]);
    const denied = reduceCompanion(finished, event('audio-capture-denied', 4), AVAILABLE);
    expect(denied.captureConfirmed).toBe(false);
  });

  it('still refuses a stale capture confirmation, so a dead run cannot claim it is listening', () => {
    // The exemption is deliberately one-directional. Accepting a stale "capture ended" can only
    // retract a claim, but accepting a stale "capture confirmed" would let a run that no longer
    // exists assert that it is listening — which is the failure the staleness floor exists to
    // prevent, pointed the other way.
    const cancelled = run([event('audio-capture-confirmed', 7), event('task-cancelled', 7)]);
    const stale = reduceCompanion(cancelled, event('audio-capture-confirmed', 7), AVAILABLE);
    expect(stale.captureConfirmed).toBe(false);
    expect(stale.lastRejected).toBe('stale-generation');
  });

  it('still refuses a stale capture stop once capture is already closed, as noise', () => {
    // Nothing to retract, so the event is not exempt and is recorded as refused rather than
    // silently accepted: "nothing happened" and "something was ignored" stay distinguishable.
    const closed = run([event('audio-capture-confirmed', 4), event('task-finished', 4)]);
    const stopped = reduceCompanion(closed, event('audio-capture-ended', 4), AVAILABLE);
    const again = reduceCompanion(stopped, event('audio-capture-ended', 4), AVAILABLE);
    expect(again.lastRejected).toBe('stale-generation');
  });

  it('closes capture on cancellation and on a lost host, but not on a finished task', () => {
    const open = run([event('audio-capture-confirmed')]);
    expect(reduceCompanion(open, event('task-cancelled'), AVAILABLE).captureConfirmed).toBe(false);
    expect(reduceCompanion(open, event('host-lost'), AVAILABLE).captureConfirmed).toBe(false);
    expect(reduceCompanion(open, event('task-finished'), AVAILABLE).captureConfirmed).toBe(true);
  });
});

describe('with no provider connected', () => {
  it.each<CompanionEvent['type']>([
    'task-started',
    'thinking',
    'acting',
    'audio-capture-confirmed',
    'approval-requested',
  ])('refuses to leave idle for %s', (type) => {
    // The shipping configuration today: A-11 and F-09 do not exist, so the truthful answer is a
    // still character rather than a plausible-looking run.
    const machine = run([event(type)], INITIAL_MACHINE, UNAVAILABLE);
    expect(machine.state).toBe('idle');
    expect(machine.identity).toBeNull();
    expect(machine.captureConfirmed).toBe(false);
    expect(machine.lastRejected).toBe('host-unavailable');
  });

  it('reports why, and reports it as a rejection rather than a state', () => {
    const machine = run([event('acting')], INITIAL_MACHINE, UNAVAILABLE);
    expect(toSnapshot(machine).lastRejected).toBe('host-unavailable');
  });
});

describe('the published snapshot', () => {
  it('projects the machine without leaking the sticky flags', () => {
    const machine = run([event('approval-requested')]);
    const snapshot = toSnapshot(machine);
    expect(snapshot).toEqual({
      state: 'needs-approval',
      identity: identity(1),
      reason: 'approval-requested',
      captureConfirmed: false,
      lastRejected: null,
    });
  });
});
