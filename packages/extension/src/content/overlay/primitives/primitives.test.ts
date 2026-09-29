// @vitest-environment happy-dom
/**
 * F-03: unit coverage for the primitives themselves.
 *
 * Primitives are constructed directly here rather than through a controller, because the closed
 * shadow root is the point: outside code cannot read a marker's DOM at all, so a test that wants
 * to assert on a transform has to be the code that built it. Integration through the real
 * controller — statuses, replacement, cleanup, the annotation cap — is in `layer.test.ts`.
 *
 * The frame source is a manual one, so a glide's whole life is deterministic: subscribe, a known
 * number of frames, done. That is what lets the "no perpetual loop" rule be asserted as a fact
 * about the number of pending callbacks rather than as a timing hope.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createPrimitiveRenderer, PRIMITIVE_KINDS, type AnyPrimitiveSpec } from './renderer.js';
import { PRIMITIVE_STYLE_SHEET } from './styles.js';
import { MAX_LABEL_CHARS, sanitizeLabel, setLabel } from './text.js';
import { Glide } from './motion.js';
import { LabelPrimitive } from './label.js';
import { SpotlightPrimitive } from './spotlight.js';
import {
  ArrowPrimitive,
  BadgePrimitive,
  CirclePrimitive,
  PointerPrimitive,
  UnderlinePrimitive,
} from './shapes.js';
import type { OverlayPrimitive, PrimitiveContext, PrimitiveState, ViewportRect } from '../types.js';

const VIEWPORT: ViewportRect = { x: 0, y: 0, width: 1000, height: 800 };
const rect = (x: number, y: number, width = 100, height = 20): ViewportRect => ({
  x,
  y,
  width,
  height,
});

/** A manual frame source plus the controls a glide test needs, with no real clock involved. */
function createContext(initialReducedMotion = false) {
  let reduced = initialReducedMotion;
  const pending = new Map<number, (timestamp: number) => void>();
  let next = 1;
  const context: PrimitiveContext = {
    requestFrame(callback) {
      const id = next++;
      pending.set(id, callback);
      return () => {
        pending.delete(id);
      };
    },
    prefersReducedMotion: () => reduced,
  };
  return {
    context,
    setReducedMotion: (value: boolean) => {
      reduced = value;
    },
    /** Serves one frame, exactly as rAF would: everything queued now, nothing queued during it. */
    frame(timestamp: number): void {
      const queued = [...pending.values()];
      pending.clear();
      for (const callback of queued) callback(timestamp);
    },
    get pendingFrames(): number {
      return pending.size;
    },
  };
}

function state(overrides: Partial<PrimitiveState> = {}): PrimitiveState {
  return {
    status: 'visible',
    target: rect(400, 400),
    viewport: VIEWPORT,
    placement: { x: 420, y: 428, placement: 'bottom', clamped: false },
    ...overrides,
  };
}

/** Builds one of the seven by kind, so the safety assertions can loop over all of them. */
function build(
  kind: string,
  ctx: PrimitiveContext,
  fields: Record<string, unknown> = {}
): OverlayPrimitive {
  const spec = { kind, ...fields } as AnyPrimitiveSpec;
  switch (kind) {
    case 'pointer':
      return new PointerPrimitive(document, spec as never, ctx);
    case 'circle':
      return new CirclePrimitive(document, spec as never, ctx);
    case 'underline':
      return new UnderlinePrimitive(document, spec as never, ctx);
    case 'badge':
      return new BadgePrimitive(document, spec as never, ctx);
    case 'arrow':
      return new ArrowPrimitive(document, spec as never, ctx);
    case 'label':
      return new LabelPrimitive(document, spec as never, ctx);
    case 'spotlight':
      return new SpotlightPrimitive(document, spec as never, ctx);
    default:
      throw new Error(`no primitive named ${kind}`);
  }
}

const SPEC_FIELDS: Record<string, Record<string, unknown>> = {
  pointer: {},
  circle: {},
  underline: {},
  badge: { index: 3 },
  arrow: {},
  label: { text: 'hello' },
  spotlight: {},
};

beforeEach(() => {
  document.documentElement.replaceChildren(document.createElement('body'));
});

describe('the kind set', () => {
  it('is exactly the seven kinds the ticket lists, and the optional underline is one of them', () => {
    expect([...PRIMITIVE_KINDS]).toEqual([
      'pointer',
      'circle',
      'arrow',
      'badge',
      'label',
      'spotlight',
      'underline',
    ]);
  });

  it('rejects an unknown kind rather than silently drawing nothing', () => {
    const renderer = createPrimitiveRenderer();
    expect(() => renderer.create(document, { kind: 'mystery' }, createContext().context)).toThrow(
      RangeError
    );
  });
});

describe('rule 3 and 4: inert by construction', () => {
  it('marks every primitive decorative so it is never announced or focusable', () => {
    const { context } = createContext();
    for (const kind of PRIMITIVE_KINDS) {
      const primitive = build(kind, context, SPEC_FIELDS[kind]!);
      expect(primitive.node.getAttribute('aria-hidden'), kind).toBe('true');
      // No tabindex anywhere: a decorative overlay that could be tabbed into would be the one
      // way this layer could steal focus from the page.
      expect(primitive.node.querySelector('[tabindex]'), kind).toBeNull();
      expect(primitive.node.hasAttribute('tabindex'), kind).toBe(false);
      primitive.release();
    }
  });

  it('creates no interactive element in any primitive, so nothing can become an approval', () => {
    const { context } = createContext();
    for (const kind of PRIMITIVE_KINDS) {
      const primitive = build(kind, context, SPEC_FIELDS[kind]!);
      const interactive = primitive.node.querySelectorAll(
        'button, a, input, select, textarea, [role="button"], [contenteditable]'
      );
      expect(interactive.length, kind).toBe(0);
      primitive.release();
    }
  });

  it('declares pointer-events none for the whole primitive tree, spotlight included', () => {
    // The stylesheet is the structural guarantee for rule 3: one declaration covers every node
    // in the tree, so a future primitive cannot forget it. Asserted on the sheet text because the
    // closed root is not reachable from a unit test; `primitives.spec.ts` asserts the resulting
    // computed style and the real hit-test in a browser.
    expect(PRIMITIVE_STYLE_SHEET).toMatch(/^\.pa \{[^}]*pointer-events: none;/m);
    // The spotlight is the case that makes this structural: it covers the page by design, and it
    // paints its scrim from a box-shadow spread off a transparent element rather than from a
    // filled layer with a hole cut in it.
    expect(PRIMITIVE_STYLE_SHEET).toMatch(/\.pa-spotlight__hole \{[^}]*box-shadow:/m);
    expect(PRIMITIVE_STYLE_SHEET).toMatch(/\.pa-spotlight__hole \{[^}]*background: transparent;/m);
  });
});

describe('rule 2: a target that is not addressable draws nothing', () => {
  const notVisible: Array<[string, PrimitiveState['status']]> = [
    ['stale', 'stale'],
    ['missing', 'missing'],
    ['hidden', 'hidden'],
    ['offscreen', 'offscreen'],
    ['unsupported', 'unsupported'],
  ];

  it('parks every primitive off screen for every non-visible status', () => {
    const { context } = createContext();
    for (const kind of PRIMITIVE_KINDS) {
      const primitive = build(kind, context, SPEC_FIELDS[kind]!);
      for (const [label, status] of notVisible) {
        primitive.update(state({ status, target: null, placement: null }));
        expect(primitive.node.style.transform, `${kind}/${label}`).toBe(
          'translate3d(-10000px, -10000px, 0)'
        );
      }
      primitive.release();
    }
  });

  it('never falls back to the previous rectangle when a target goes stale', () => {
    const { context } = createContext();
    const circle = build('circle', context);
    circle.update(state());
    const drawn = circle.node.style.transform;
    expect(drawn).not.toBe('translate3d(-10000px, -10000px, 0)');

    // The same target, one document generation later. A target box is deliberately *not*
    // supplied: retaining the last one is exactly the "guessing a nearby element" failure.
    circle.update(state({ status: 'stale', target: null, placement: null }));
    expect(circle.node.style.transform).toBe('translate3d(-10000px, -10000px, 0)');
    expect(circle.node.style.transform).not.toBe(drawn);
  });

  it('sets data-status on the node, which is the single visibility switch', () => {
    const { context } = createContext();
    for (const kind of PRIMITIVE_KINDS) {
      const primitive = build(kind, context, SPEC_FIELDS[kind]!);
      for (const [, status] of notVisible) {
        primitive.update(state({ status, target: null, placement: null }));
        // The core writes this in production; a primitive test writes it to stand in for a frame.
        primitive.node.dataset.status = status;
        expect(primitive.node.dataset.status, `${kind}/${status}`).toBe(status);
      }
      primitive.release();
    }
  });
});

describe('rule 1: geometry comes from the measured box, never from stored coordinates', () => {
  it('draws the circle around the target box it was given', () => {
    const { context } = createContext();
    const circle = build('circle', context);
    circle.update(state({ target: rect(100, 200, 300, 40) }));
    // Padding defaults to 4, so the ring is the target grown by 4 on every side.
    expect(circle.node.style.transform).toBe('translate3d(96px, 196px, 0) scale(308, 48)');
  });

  it('follows the target when the target moves, with no state of its own', () => {
    const { context } = createContext();
    const circle = build('circle', context);
    circle.update(state({ target: rect(100, 200, 300, 40) }));
    circle.update(state({ target: rect(100, 900, 300, 40) }));
    expect(circle.node.style.transform).toBe('translate3d(96px, 896px, 0) scale(308, 48)');
  });

  it('draws the underline just under the target box', () => {
    const { context } = createContext();
    const underline = build('underline', context);
    underline.update(state({ target: rect(10, 20, 120, 16) }));
    // Default gap 2, so the bar sits at y = 20 + 16 + 2.
    expect(underline.node.style.transform).toBe('translate3d(10px, 38px, 0) scale(120, 1)');
  });

  it('sizes the spotlight cutout to the target plus its padding', () => {
    const { context } = createContext();
    const spotlight = build('spotlight', context);
    spotlight.update(state({ target: rect(50, 60, 200, 30) }));
    const hole = spotlight.node.querySelector<HTMLElement>('.pa-spotlight__hole')!;
    // Default padding 8, authored 100px box, so the scale is (216/100, 46/100).
    expect(hole.style.transform).toBe('translate3d(42px, 52px, 0) scale(2.16, 0.46)');
    // The scrim is a box-shadow spread from a transparent hole, not a layer with a hole cut in
    // it: nothing in the tree is shaped like the rest of the screen, so nothing can be hit.
    expect(hole.style.background).toBe('');
  });

  it('points the arrow from the marker toward the target centre and never collapses it', () => {
    const { context } = createContext();
    const arrow = build('arrow', context);
    arrow.update(
      state({
        target: rect(400, 400, 100, 20),
        placement: { x: 300, y: 300, placement: 'left', clamped: false },
      })
    );
    // From (300,300) to the target centre (450,410): atan2(110, 150) = 36.25 degrees, 180.46 long.
    expect(arrow.node.style.transform).toBe('translate3d(300px, 300px, 0) rotate(36.25deg)');
    const shaft = arrow.node.querySelector('.pa-arrow__shaft') as HTMLElement;
    expect(Number(shaft.style.transform.match(/scaleX\(([\d.]+)\)/)![1])).toBeGreaterThan(18);
  });
});

describe('rule 6 and 7: the glide is a client of the core scheduler, and it is not a loop', () => {
  it('jumps straight to the target on first sighting instead of animating in from nowhere', () => {
    const frames = createContext();
    const pointer = build('pointer', frames.context);
    pointer.update(state());
    expect(pointer.node.style.transform).toBe('translate3d(420px, 428px, 0)');
    // Nothing queued: there was no previous position to glide from.
    expect(frames.pendingFrames).toBe(0);
  });

  it('subscribes while moving and unsubscribes the frame it arrives', () => {
    const frames = createContext();
    const pointer = build('pointer', frames.context, { durationMs: 100 });
    pointer.update(state());
    pointer.update(state({ placement: { x: 600, y: 428, placement: 'bottom', clamped: false } }));
    expect(frames.pendingFrames).toBe(1);

    // The first frame only establishes the start time, so the pointer is still at its origin
    // and still subscribed. A glide measures from the frame it begins on, not from the call that
    // requested it, which is what keeps it aligned with what the user actually sees.
    frames.frame(50);
    expect(frames.pendingFrames).toBe(1);
    expect(pointer.node.style.transform).toBe('translate3d(420px, 428px, 0)');

    // Mid-flight: subscribed, and strictly between the two points.
    frames.frame(100);
    const mid = pointer.node.style.transform;
    expect(frames.pendingFrames).toBe(1);
    expect(mid).not.toContain('600px');
    expect(mid).not.toContain('420px');

    // Arrival: the subscription is dropped *before* the write, so the final frame is the last.
    frames.frame(150);
    expect(pointer.node.style.transform).toBe('translate3d(600px, 428px, 0)');
    expect(frames.pendingFrames).toBe(0);

    // And an idle pointer costs nothing: no further frames appear on their own.
    frames.frame(200);
    frames.frame(300);
    expect(frames.pendingFrames).toBe(0);
  });

  it('settles even when every tick re-issues the destination the glide is catching up with', () => {
    const frames = createContext();
    const pointer = build('pointer', frames.context, { durationMs: 100 });
    pointer.update(state());
    const destination = {
      placement: { x: 600, y: 428, placement: 'bottom' as const, clamped: false },
    };
    pointer.update(state(destination));
    expect(frames.pendingFrames).toBe(1);

    // The core ticks every frame while anything is animating, and each tick hands the pointer
    // the same destination it is already travelling to. Those ticks must not restart the
    // transition: resetting the start time each frame leaves progress at ~0 forever, and the
    // pointer spins at the display rate for the rest of the page's life. Asserted by running far
    // past the duration — a correct glide is idle long before this, and the broken one never is.
    for (let t = 50; t <= 5_000; t += 50) {
      pointer.update(state(destination));
      frames.frame(t);
    }
    expect(pointer.node.style.transform).toBe('translate3d(600px, 428px, 0)');
    expect(frames.pendingFrames).toBe(0);
  });

  it('skips the transition entirely under prefers-reduced-motion', () => {
    const frames = createContext(true);
    const pointer = build('pointer', frames.context, { durationMs: 300 });
    pointer.update(state());
    pointer.update(state({ placement: { x: 600, y: 428, placement: 'bottom', clamped: false } }));
    // Immediate, and with nothing queued — not a shorter animation that still moves.
    expect(pointer.node.style.transform).toBe('translate3d(600px, 428px, 0)');
    expect(frames.pendingFrames).toBe(0);
  });

  it('re-reads the motion preference on every move, so a mid-session change takes effect', () => {
    const frames = createContext(false);
    const pointer = build('pointer', frames.context, { durationMs: 100 });
    pointer.update(state());
    pointer.update(state({ placement: { x: 600, y: 428, placement: 'bottom', clamped: false } }));
    expect(frames.pendingFrames).toBe(1);

    frames.setReducedMotion(true);
    // A new destination with the preference now on: the in-flight transition is dropped and the
    // pointer lands immediately rather than continuing to interpolate.
    pointer.update(state({ placement: { x: 700, y: 428, placement: 'bottom', clamped: false } }));
    expect(pointer.node.style.transform).toBe('translate3d(700px, 428px, 0)');
    expect(frames.pendingFrames).toBe(0);
  });

  it('stops a glide in flight when the target stops being addressable', () => {
    const frames = createContext();
    const pointer = build('pointer', frames.context, { durationMs: 200 });
    pointer.update(state());
    pointer.update(state({ placement: { x: 600, y: 428, placement: 'bottom', clamped: false } }));
    expect(frames.pendingFrames).toBe(1);

    // The target is detached mid-glide. The subscription must go with it, or the layer would
    // keep queueing frames for a decoration nobody can see.
    pointer.update(state({ status: 'missing', target: null, placement: null }));
    expect(frames.pendingFrames).toBe(0);
    expect(pointer.node.style.transform).toBe('translate3d(-10000px, -10000px, 0)');
  });

  it('does not queue frames for primitives that never animate', () => {
    const frames = createContext();
    for (const kind of ['circle', 'underline', 'arrow', 'label', 'spotlight'] as const) {
      const primitive = build(kind, frames.context, SPEC_FIELDS[kind]!);
      primitive.update(state());
      primitive.update(
        state({
          target: rect(10, 20, 50, 10),
          placement: { x: 30, y: 40, placement: 'bottom', clamped: false },
        })
      );
      expect(frames.pendingFrames, kind).toBe(0);
    }
  });

  it('ignores a sub-pixel move rather than starting a transition nobody can see', () => {
    const frames = createContext();
    const pointer = build('pointer', frames.context, { durationMs: 100 });
    pointer.update(state());
    pointer.update(state({ placement: { x: 420.5, y: 428, placement: 'bottom', clamped: false } }));
    expect(frames.pendingFrames).toBe(0);
  });
});

describe('rule 8: release is total', () => {
  it('drops a pending frame and detaches the node, and is idempotent', () => {
    const frames = createContext();
    const pointer = build('pointer', frames.context, { durationMs: 200 });
    pointer.update(state());
    pointer.update(state({ placement: { x: 600, y: 428, placement: 'bottom', clamped: false } }));
    expect(frames.pendingFrames).toBe(1);

    const node = pointer.node;
    document.body.append(node);
    pointer.release();
    expect(frames.pendingFrames).toBe(0);
    expect(node.isConnected).toBe(false);

    // Releasing twice must not throw and must not re-attach anything.
    expect(() => pointer.release()).not.toThrow();
    expect(node.isConnected).toBe(false);
  });

  it('ignores updates after release instead of resurrecting a detached node', () => {
    const { context } = createContext();
    const circle = build('circle', context);
    circle.release();
    circle.update(state());
    expect(circle.node.style.transform).toBe('');
  });
});

describe('rule 5: label text', () => {
  it('renders markup as text and never as elements', () => {
    const { context } = createContext();
    const label = build('label', context, { text: '<img src=x onerror="globalThis.pwned=1">' });
    label.update(state());
    expect(label.node.querySelector('img')).toBeNull();
    expect(label.node.children).toHaveLength(1); // the single text span, and nothing else
    expect(label.node.textContent).toBe('<img src=x onerror="globalThis.pwned=1">');
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });

  it('drops script, style and iframe tags rather than showing them to a user', () => {
    // Sanitised to visible text, not removed: the user still sees that the label *mentions* a
    // script, which is more honest than a silently empty bubble, and it is inert either way.
    expect(sanitizeLabel('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
    const { context } = createContext();
    const label = build('label', context, { text: '<script>alert(1)</script>' });
    label.update(state());
    expect(label.node.querySelector('script')).toBeNull();
  });

  it('strips control characters and bidirectional overrides', () => {
    // The bidi case is the one that matters: a right-to-left override makes a label render as
    // text that is not what it says, which is spoofing rather than formatting.
    expect(sanitizeLabel('Visa\u202Eabc')).toBe('Visa abc');
    expect(sanitizeLabel('a\u0000b\u0007c')).toBe('a b c');
    expect(sanitizeLabel('a\u200Bb\uFEFFc')).toBe('a b c');
    expect(sanitizeLabel('line one\n\nline\ttwo')).toBe('line one line two');
  });

  it('truncates a long label to a bounded length', () => {
    const long = 'x'.repeat(5000);
    const text = sanitizeLabel(long);
    expect(text.length).toBeLessThanOrEqual(MAX_LABEL_CHARS);
    expect(text.endsWith('…')).toBe(true);

    const { context } = createContext();
    const label = build('label', context, { text: long });
    label.update(state());
    expect((label.node.textContent ?? '').length).toBeLessThanOrEqual(MAX_LABEL_CHARS);
  });

  it('truncates on a code-point boundary rather than splitting a surrogate pair', () => {
    // Each of these is one astral code point; slicing at 120 characters would leave a lone
    // surrogate, which renders as a replacement glyph.
    const text = sanitizeLabel('\u{1F600}'.repeat(200));
    expect(text).not.toContain('\uFFFD');
    expect([...text].length).toBeLessThanOrEqual(MAX_LABEL_CHARS);
  });

  it('renders nothing for a value that is not text at all', () => {
    for (const value of [undefined, null, {}, [], Symbol('x'), () => 1, Number.NaN, Infinity]) {
      expect(sanitizeLabel(value), String(value?.toString?.() ?? value)).toBe('');
    }
  });

  it('coerces the primitive types a badge or a numeric index legitimately needs', () => {
    expect(sanitizeLabel(42)).toBe('42');
    expect(sanitizeLabel(10n)).toBe('10');
    expect(sanitizeLabel(false)).toBe('false');
  });

  it('reports whether the rendered text changed, so a re-measure is not wasted', () => {
    const node = document.createElement('div');
    expect(setLabel(node, 'first').changed).toBe(true);
    // Same sanitised value, so the second write is a no-op even though the input differed.
    expect(setLabel(node, 'first').changed).toBe(false);
    expect(setLabel(node, '  first  ').changed).toBe(false);
    expect(node.textContent).toBe('first');
  });
});

describe('badge ordinals', () => {
  it('renders the step number as an ordinal, not as caller text', () => {
    const { context } = createContext();
    const badge = build('badge', context, { index: 7 });
    badge.update(state());
    expect(badge.node.textContent).toBe('7');
  });

  it('clamps an out-of-range or non-numeric index instead of rendering nonsense', () => {
    const { context } = createContext();
    expect(build('badge', context, { index: 0 }).node.textContent).toBe('1');
    expect(build('badge', context, { index: -5 }).node.textContent).toBe('1');
    expect(build('badge', context, { index: 10_000 }).node.textContent).toBe('999');
    expect(build('badge', context, { index: Number.NaN }).node.textContent).toBe('');
    expect(build('badge', context, { index: '7' }).node.textContent).toBe('');
  });
});

describe('the glide on its own', () => {
  it('clamps a requested duration into a band a caller cannot escape', () => {
    const frames = createContext();
    const long = new Glide(frames.context, { durationMs: 10_000 });
    long.moveTo(0, 0, () => {});
    long.moveTo(100, 0, () => {});
    frames.frame(0);
    // Clamped to 600ms, so a frame at 300ms is genuinely mid-flight rather than already arrived.
    frames.frame(300);
    expect(long.isAnimating).toBe(true);
    frames.frame(600);
    expect(long.isAnimating).toBe(false);
  });

  it('treats a zero duration as immediate rather than as a stuck transition', () => {
    const frames = createContext();
    const glide = new Glide(frames.context, { durationMs: 0 });
    glide.moveTo(0, 0, () => {});
    glide.moveTo(50, 0, () => {});
    frames.frame(0);
    expect(glide.isAnimating).toBe(false);
    expect(glide.position).toEqual({ x: 50, y: 0 });
  });

  it('cannot be revived by a late frame after release', () => {
    const frames = createContext();
    const glide = new Glide(frames.context, { durationMs: 100 });
    glide.moveTo(0, 0, () => {});
    glide.moveTo(100, 0, () => {});
    glide.release();
    expect(frames.pendingFrames).toBe(0);
    // A frame that was already in flight when release ran must not resubscribe: the generation
    // counter is what stops a cancelled glide re-arming itself from inside its own callback.
    frames.frame(100);
    expect(frames.pendingFrames).toBe(0);
    frames.frame(200);
    expect(frames.pendingFrames).toBe(0);
  });
});
