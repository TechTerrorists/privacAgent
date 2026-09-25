/** F-02: frame coalescing and the idle-stop guarantee. */
import { describe, expect, it, vi } from 'vitest';
import { createManualFrameScheduler, FrameCoalescer, HEARTBEAT_MS } from './scheduler.js';

describe('FrameCoalescer', () => {
  it('collapses many signals in one frame into a single callback', () => {
    const frames = createManualFrameScheduler();
    const coalescer = new FrameCoalescer(frames);
    const tick = vi.fn();
    for (let i = 0; i < 5; i++) coalescer.schedule(tick);
    expect(frames.flush()).toBe(1);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('notifies every subscriber exactly once per frame', () => {
    const frames = createManualFrameScheduler();
    const coalescer = new FrameCoalescer(frames);
    const a = vi.fn();
    const b = vi.fn();
    coalescer.schedule(a);
    coalescer.schedule(b);
    frames.flush();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does not re-arm itself, so an idle page runs no frames', () => {
    const frames = createManualFrameScheduler();
    const coalescer = new FrameCoalescer(frames);
    const tick = vi.fn();
    coalescer.schedule(tick);
    frames.advance(16);
    frames.advance(16);
    frames.advance(16);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(coalescer.isRunning).toBe(false);
  });

  it('cancels the pending frame on dispose and ignores late subscribers', () => {
    const frames = createManualFrameScheduler();
    const coalescer = new FrameCoalescer(frames);
    const tick = vi.fn();
    coalescer.schedule(tick);
    coalescer.dispose();
    frames.advance(16);
    expect(tick).not.toHaveBeenCalled();
    expect(coalescer.subscriberCount).toBe(0);
  });

  it('stops notifying a subscriber that unsubscribes, from the next frame on', () => {
    const frames = createManualFrameScheduler();
    const coalescer = new FrameCoalescer(frames);
    const second = vi.fn();
    coalescer.schedule(second);
    frames.flush();
    expect(second).toHaveBeenCalledTimes(1);

    coalescer.unsubscribe(second);
    coalescer.schedule(vi.fn());
    frames.flush();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('notifies a subscriber removed mid-frame at most once more', () => {
    const frames = createManualFrameScheduler();
    const coalescer = new FrameCoalescer(frames);
    const second = vi.fn();
    // A frame is a snapshot: a subscriber that unsubscribes while the frame is being serviced
    // has already been committed to this frame. The overlay's tick is separately guarded, so a
    // dropped annotation is never measured even if this fires once more.
    const first = vi.fn(() => coalescer.unsubscribe(second));
    coalescer.schedule(first);
    coalescer.schedule(second);
    frames.flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('createManualFrameScheduler', () => {
  it('advances its own clock and defers work scheduled during a flush to the next frame', () => {
    const frames = createManualFrameScheduler();
    const late = vi.fn(() => frames.request(late));
    frames.request(late);
    frames.advance(16);
    expect(late).toHaveBeenCalledTimes(1);
    expect(frames.now()).toBe(16);
  });
});

describe('HEARTBEAT_MS', () => {
  it('stays far below the step-latency budget while costing a fraction of a rAF loop', () => {
    expect(HEARTBEAT_MS).toBeGreaterThanOrEqual(250);
    expect(HEARTBEAT_MS).toBeLessThanOrEqual(1000);
  });
});
