// @vitest-environment happy-dom
/**
 * F-08: the character itself.
 *
 * These are the properties of the drawing that a closed shadow root makes impossible to check from
 * a browser: what is actually in the node, and that nothing else is. The browser suite covers what
 * only an engine can answer — real hit testing, real animation, real pixels.
 *
 * The two requirements under test here are the ones with privacy consequences. The character is
 * decorative, so it must contain no text node of any kind; and the five states must differ by
 * silhouette rather than by hue, so they stay distinguishable with the colour removed entirely.
 */
import { describe, expect, it } from 'vitest';
import { COMPANION_SIZE, COMPANION_STYLE_SHEET, buildCharacter } from './character.js';
import { COMPANION_STATES, type CompanionState } from './types.js';

function glyph(state: CompanionState): SVGSVGElement {
  return buildCharacter(document, state);
}

/** Every text-bearing node inside the character, at any depth. */
function textNodes(root: Element): string[] {
  const found: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) found.push(text);
    }
    for (const child of [...node.childNodes]) walk(child);
  };
  walk(root);
  return found;
}

describe('the character', () => {
  it('is decorative: no role, no label, no text, nothing focusable', () => {
    for (const state of COMPANION_STATES) {
      const root = glyph(state);
      expect(root.getAttribute('aria-hidden')).toBe('true');
      expect(root.getAttribute('focusable')).toBe('false');
      expect(root.hasAttribute('role')).toBe(false);
      // The whole point: no text anywhere, so there is nothing a page or a screen reader can read
      // out of it and nothing page content could ever end up inside.
      expect(textNodes(root)).toEqual([]);
      expect(root.querySelector('text')).toBeNull();
      expect(root.querySelector('title')).toBeNull();
    }
  });

  it('contains no interactive element, so nothing in it looks pressable', () => {
    for (const state of COMPANION_STATES) {
      const root = glyph(state);
      for (const tag of ['button', 'a', 'input', 'foreignObject']) {
        expect(root.querySelector(tag)).toBeNull();
      }
    }
  });

  it('draws real geometry, not an emoji or a text glyph', () => {
    // A text glyph would render differently per platform and per page font, and could not be
    // recoloured reliably under forced colours.
    for (const state of COMPANION_STATES) {
      const root = glyph(state);
      expect(root.namespaceURI).toBe('http://www.w3.org/2000/svg');
      expect(root.querySelectorAll('path, circle, rect').length).toBeGreaterThan(0);
    }
  });

  it('gives every state a different silhouette, so none of them is colour-only', () => {
    const signatures = new Map<string, CompanionState>();
    for (const state of COMPANION_STATES) {
      const root = glyph(state);
      // The structural signature: which shapes, in which order, at what size. Two states sharing a
      // signature would be distinguishable only by their fill.
      const signature = [...root.children]
        .map((child) => {
          const box = (child as SVGGraphicsElement).getBBox?.();
          const boxKey = box
            ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}`
            : 'no-bbox';
          return `${child.tagName}:${child.getAttribute('class')}:${boxKey}`;
        })
        .join('|');
      expect(signatures.has(signature)).toBe(false);
      signatures.set(signature, state);
    }
    expect(signatures.size).toBe(COMPANION_STATES.length);
  });

  it('marks its own state, for the stylesheet and for tests', () => {
    for (const state of COMPANION_STATES) {
      expect(glyph(state).dataset.state).toBe(state);
    }
  });

  it('reports a fixed intrinsic box for the positioner to clamp against', () => {
    expect(COMPANION_SIZE).toEqual({ width: 28, height: 28 });
    const root = glyph('idle');
    expect(root.getAttribute('width')).toBe('28');
    expect(root.getAttribute('height')).toBe('28');
  });
});

describe('the stylesheet', () => {
  it('makes the character transparent to input, unconditionally', () => {
    // `!important` and not the class alone: a page stylesheet in the shadow root's own tree, or a
    // higher-specificity rule, must not be able to make the companion clickable.
    expect(COMPANION_STYLE_SHEET).toContain('pointer-events: none !important');
  });

  it('animates exactly the two states that have something to say', () => {
    const animated = [
      ...COMPANION_STYLE_SHEET.matchAll(/data-state="([a-z-]+)"\] \.pa-companion-[a-z]+/g),
    ].map((match) => match[1]);
    expect([...new Set(animated)].sort()).toEqual(['listening', 'thinking']);
  });

  it('guards its animations behind a no-preference query', () => {
    // The keyframes exist unconditionally, but the rules that apply them do not, so a user with
    // reduced motion gets the shape and not the movement.
    expect(COMPANION_STYLE_SHEET).toContain('@media (prefers-reduced-motion: no-preference)');
  });

  it('re-paints from the system palette under forced colours, leaving the geometry alone', () => {
    const forced = COMPANION_STYLE_SHEET.slice(
      COMPANION_STYLE_SHEET.indexOf('@media (forced-colors')
    );
    expect(forced).toContain('CanvasText');
    // Addressed by shape class, never by state colour: this is why the five stay apart when every
    // colour in the document is replaced by the system's.
    expect(forced).toContain('.pa-companion-shape');
    expect(forced).toContain('forced-color-adjust: none');
  });

  it('gives every state a class or attribute the stylesheet can address', () => {
    // Only the two animated states are named in the CSS, because the other three need no rule at
    // all. What matters is that each state is drawn from a *different set of shape classes*, which
    // is what the forced-colours block above re-paints.
    const byState = COMPANION_STATES.map((state) => {
      const root = glyph(state);
      return [...root.querySelectorAll('*')]
        .map((node) => node.getAttribute('class'))
        .filter((value): value is string => value !== null)
        .join(' ');
    });
    expect(new Set(byState).size).toBe(COMPANION_STATES.length);
  });
});
