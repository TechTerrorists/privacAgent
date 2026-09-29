/**
 * F-08: the companion character.
 *
 * Drawn as inline SVG built with `createElementNS`, and as plain CSS. No image files, no icon font,
 * no runtime asset fetch — the whole character is a few hundred bytes of markup created in memory,
 * which matters because it is injected into arbitrary pages under arbitrary CSPs where a fetch of
 * even one asset can be blocked.
 *
 * ## Why shape, not colour
 *
 * Each state is distinguishable **with the colour removed entirely**, which is not a nice-to-have:
 * `forced-colors` mode discards author colours, roughly 1 in 20 users runs a colour-vision
 * deficiency, and a companion whose five states differ only in hue is a companion that reports the
 * wrong thing to a real person. So each state has its own silhouette:
 *
 * | state | silhouette | motion |
 * | --- | --- | --- |
 * | `idle` | small ring | none |
 * | `listening` | ring + three radiating arcs | arcs breathe, bounded |
 * | `thinking` | broken ring, open at the top | ring rotates, bounded |
 * | `acting` | solid chevron pointing down-right | none (it is already directional) |
 * | `needs-approval` | ring containing a pause bar | none |
 *
 * The shapes are deliberately different *areas* as well as outlines, so they stay separable at the
 * ~22 px the character is drawn at and for a user with low vision.
 *
 * ## Never a control
 *
 * The character is `aria-hidden` and inert, contains no text node, no button, no link and no
 * tooltip, and its shadow root is `pointer-events: none`. `needs-approval` is a *pointer* — a
 * neutral cue that the user's attention is wanted somewhere they control — and never carries the
 * decision itself. F-06 owns approvals, and they live in the side panel, which is the only trusted
 * UI this extension has.
 */
import type { CompanionState } from './types.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Intrinsic box, in CSS pixels. Read by the core to clamp against the viewport. */
export const COMPANION_SIZE = { width: 28, height: 28 };

/** Gap between the pointer and the character, so it never sits under the real cursor. */
export const COMPANION_OFFSET = 16;

function svg<K extends keyof SVGElementTagNameMap>(
  document: Document,
  name: K
): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, name);
}

/**
 * Builds the character for one state.
 *
 * The node is rebuilt per state change rather than mutated, because the five silhouettes share no
 * geometry worth reconciling, and a rebuild is a handful of element allocations against a
 * transition the user only sees once.
 */
export function buildCharacter(document: Document, state: CompanionState): SVGSVGElement {
  const root = svg(document, 'svg');
  root.setAttribute('viewBox', '0 0 24 24');
  root.setAttribute('width', String(COMPANION_SIZE.width));
  root.setAttribute('height', String(COMPANION_SIZE.height));
  // Decorative by construction: no role, no label, nothing for a screen reader to read out. The
  // real status lives in the side panel, and announcing page-level chatter on every state change
  // would be noise in a page the user did not ask to be interrupted in.
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('focusable', 'false');
  root.dataset.state = state;

  switch (state) {
    case 'idle':
      addIdle(document, root);
      break;
    case 'listening':
      addListening(document, root);
      break;
    case 'thinking':
      addThinking(document, root);
      break;
    case 'acting':
      addActing(document, root);
      break;
    case 'needs-approval':
      addNeedsApproval(document, root);
      break;
  }
  return root;
}

/** A bare ring. The quietest silhouette, and the baseline the others are read against. */
function addIdle(document: Document, root: SVGSVGElement): void {
  const ring = svg(document, 'circle');
  ring.setAttribute('cx', '12');
  ring.setAttribute('cy', '12');
  ring.setAttribute('r', '4.5');
  ring.setAttribute('class', 'pa-companion-shape pa-companion-idle');
  root.append(ring);
}

/**
 * A ring with three arcs opening to the right: the universally read "sound is arriving" form, and
 * structurally unlike every other state because it is the only one with parts outside the ring.
 */
function addListening(document: Document, root: SVGSVGElement): void {
  const ring = svg(document, 'circle');
  ring.setAttribute('cx', '9');
  ring.setAttribute('cy', '12');
  ring.setAttribute('r', '3.2');
  ring.setAttribute('class', 'pa-companion-shape pa-companion-core');
  root.append(ring);

  for (const [index, span] of [40, 68, 96].entries()) {
    const radius = 5.6 + index * 1.9;
    const arc = svg(document, 'path');
    // An arc opening right, drawn as a cubic so the ends taper instead of stopping square.
    const mid = 90;
    const half = span / 2;
    const rad = (deg: number): number => (deg * Math.PI) / 180;
    const x0 = 9 + radius * Math.cos(rad(mid - half));
    const y0 = 12 + radius * Math.sin(rad(mid - half));
    const x1 = 9 + radius * Math.cos(rad(mid + half));
    const y1 = 12 + radius * Math.sin(rad(mid + half));
    arc.setAttribute(
      'd',
      `M${x0.toFixed(2)} ${y0.toFixed(2)} A${radius} ${radius} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
    );
    arc.setAttribute('class', 'pa-companion-shape pa-companion-wave');
    arc.dataset.wave = String(index);
    root.append(arc);
  }
}

/**
 * A ring broken at the top. The gap is the distinguishing feature and the rotation is what makes
 * it read as "working on it" — a static broken ring could be mistaken for a rendering fault.
 */
function addThinking(document: Document, root: SVGSVGElement): void {
  const ring = svg(document, 'path');
  // 300° of arc, leaving a 60° gap centred on top.
  ring.setAttribute('d', 'M12 3.6 A8.4 8.4 0 1 1 4.56 6.3');
  ring.setAttribute('class', 'pa-companion-shape pa-companion-spinner');
  root.append(ring);

  // A dot in the gap, so the shape still has a distinguishable centre when motion is disabled.
  const dot = svg(document, 'circle');
  dot.setAttribute('cx', '12');
  dot.setAttribute('cy', '3.4');
  dot.setAttribute('r', '1.5');
  dot.setAttribute('class', 'pa-companion-shape pa-companion-core');
  root.append(dot);
}

/**
 * A solid chevron. Unambiguously directional, which is why it is `acting`: the only other state
 * with any direction is the waves, and they point *inward* from the right, not down-right.
 */
function addActing(document: Document, root: SVGSVGElement): void {
  const chevron = svg(document, 'path');
  chevron.setAttribute(
    'd',
    'M7.2 4.6 L18.4 12 L12.6 12.9 L15.1 19.4 L11.9 20.6 L9.4 14.1 L4.4 16.2 Z'
  );
  chevron.setAttribute('class', 'pa-companion-shape pa-companion-chevron');
  root.append(chevron);
}

/**
 * A ring holding two pause bars. The bars are the same shape the user sees on any media control
 * they are already waiting on, and they are *not* buttons: the whole subtree is inert and
 * click-through, so a pause bar that looks pressable must not be pressable.
 */
function addNeedsApproval(document: Document, root: SVGSVGElement): void {
  const ring = svg(document, 'circle');
  ring.setAttribute('cx', '12');
  ring.setAttribute('cy', '12');
  ring.setAttribute('r', '8.6');
  ring.setAttribute('class', 'pa-companion-shape pa-companion-halo');
  root.append(ring);

  for (const x of [9.4, 13.2]) {
    const bar = svg(document, 'rect');
    bar.setAttribute('x', String(x));
    bar.setAttribute('y', '8.4');
    bar.setAttribute('width', '1.9');
    bar.setAttribute('height', '7.2');
    bar.setAttribute('rx', '0.95');
    bar.setAttribute('class', 'pa-companion-shape pa-companion-pause');
    root.append(bar);
  }
}

/**
 * The stylesheet, installed once into the core's closed root.
 *
 * Three things are deliberate here.
 *
 * **Contrast is carried by a two-tone stroke, not by the page.** The character sits in a shadow
 * root that inherits nothing useful — a page can set `color: white` on `html` and the companion
 * would vanish — so the fill and the outline are both chosen here, and the outline is the *opposite*
 * tone of the fill. That keeps the silhouette legible on a light page and a dark page without
 * asking the page what colour it is, and it is why the shapes read in forced-colours mode.
 *
 * **Animation is CSS, not rAF.** The only two animated states are `listening` and `thinking`, and
 * both are bounded loops that the browser can throttle or stop on its own when the tab is hidden.
 * A rAF loop would be running code on a page that has nothing to animate.
 *
 * **Reduced motion removes motion, not information.** Under `prefers-reduced-motion` the spinner
 * and the waves stop and the shapes hold a static pose. They are still five different shapes, so
 * nothing is lost but the movement.
 */
export const COMPANION_STYLE_SHEET = `
:host { all: initial; }
.pa-companion {
  position: fixed;
  left: 0;
  top: 0;
  /* The single most important line in the module: the character is never a hit target. */
  pointer-events: none !important;
  will-change: transform;
  contain: layout style;
}
.pa-companion[data-status]:not([data-status="visible"]) { display: none; }

.pa-companion-shape {
  vector-effect: non-scaling-stroke;
  stroke-linecap: round;
  stroke-linejoin: round;
  /* Two-tone: the outline is the opposite tone of the fill so the silhouette survives any
     background, including a page that sets its own colour on html. */
  stroke: var(--pa-companion-outline, #10161a);
  fill: var(--pa-companion-fill, #1f7a5e);
}
.pa-companion-idle,
.pa-companion-core {
  fill: none;
  stroke: var(--pa-companion-fill, #1f7a5e);
  stroke-width: 2.2;
}
.pa-companion-wave { fill: none; stroke-width: 1.7; opacity: 0.9; }
.pa-companion-spinner { fill: none; stroke-width: 2.4; }
.pa-companion-halo { fill: none; stroke-width: 2; }
.pa-companion-pause { stroke: none; }
.pa-companion-chevron { stroke-width: 1.4; }

/* 'listening': the waves breathe. The animation is on the waves only, so the ring stays put and
   the eye can track the core as the thing that is actually capturing. */
@media (prefers-reduced-motion: no-preference) {
  .pa-companion[data-state="listening"] .pa-companion-wave {
    animation: pa-companion-wave 1.6s ease-in-out infinite;
  }
  .pa-companion[data-state="listening"] .pa-companion-wave[data-wave="1"] { animation-delay: 0.18s; }
  .pa-companion[data-state="listening"] .pa-companion-wave[data-wave="2"] { animation-delay: 0.36s; }

  .pa-companion[data-state="thinking"] .pa-companion-spinner {
    transform-box: fill-box;
    transform-origin: center;
    animation: pa-companion-spin 1.15s linear infinite;
  }
}

@keyframes pa-companion-wave {
  0%, 100% { opacity: 0.28; }
  50% { opacity: 1; }
}
@keyframes pa-companion-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* A state change is a bounded cross-fade, not a transition the user waits on. */
.pa-companion { transition: opacity 140ms ease-out; }
@media (prefers-reduced-motion: reduce) {
  .pa-companion { transition: none; }
  .pa-companion-shape { animation: none !important; }
}

@media (prefers-color-scheme: dark) {
  .pa-companion-shape {
    stroke: var(--pa-companion-outline, #e8f1ec);
    fill: var(--pa-companion-fill, #4fd1a5);
  }
  .pa-companion-idle,
  .pa-companion-core {
    fill: none;
    stroke: var(--pa-companion-fill, #4fd1a5);
  }
}

/* Forced colours: hand the silhouette to the system palette and stop trying to be pretty. The
   shapes still differ, which is the point of drawing five different shapes. */
@media (forced-colors: active) {
  .pa-companion-shape {
    fill: CanvasText;
    stroke: Canvas;
    forced-color-adjust: none;
  }
  .pa-companion-idle,
  .pa-companion-core,
  .pa-companion-wave,
  .pa-companion-spinner,
  .pa-companion-halo { fill: none; stroke: CanvasText; }
  .pa-companion-pause,
  .pa-companion-chevron { fill: CanvasText; stroke: Canvas; }
}
`;
