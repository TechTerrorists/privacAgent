/**
 * F-03: the primitives' stylesheet, installed into F-02's existing closed shadow root.
 *
 * It is a second `<style>` element, never a second root: `mountOverlayHost` created the root and
 * F-02's own sheet is in it, and this is appended alongside. That matters for the isolation
 * contract — one root means one thing for page script to fail to reach, and one thing to tear
 * down.
 *
 * Properties that decide whether the overlay is safe rather than merely decorative are declared
 * `!important`, matching the host's sheet. A page stylesheet is not in this cascade, but a
 * primitive that is overridden into being interactive, or into a layout-affecting property, would
 * break rules that the rest of the layer cannot see.
 */

/** Shared shape rules. The --pa-* custom properties are the single place a colour is chosen. */
const PRIMITIVE_STYLES = `
:host { --pa-ink: #1a1f36; --pa-accent: #1a56db; --pa-contrast: #ffffff; }

/* Every F-03 node is a fixed-position, transform-driven box. Fixed, because the geometry the
   core hands over is viewport coordinates; transform-driven, because that is the only thing an
   animation here is allowed to touch. "contain: layout style" keeps a primitive's own internals
   from invalidating anything outside it. */
.pa {
  position: fixed;
  top: 0;
  left: 0;
  pointer-events: none;
  transform: translate3d(-10000px, -10000px, 0);
  will-change: transform, opacity;
  contain: layout style;
}

/* One visibility switch, driven by the status the core writes onto every node.
   data-status is set for *every* status, so a stale, missing, hidden, off-screen or
   unsupported target removes its own decoration with no per-primitive handling. There is no
   "keep the last frame around" case: the geometry that produced it no longer identifies
   anything. */
.pa[data-status="visible"] { display: block; }
.pa[data-status="offscreen"],
.pa[data-status="hidden"],
.pa[data-status="stale"],
.pa[data-status="missing"],
.pa[data-status="unsupported"],
.pa[data-status="unknown"] { display: none !important; }

/* Reduced motion is enforced in CSS as well as in the glide driver. The driver stops *creating*
   transitions; this stops a transition that was already in flight when the preference changed
   mid-glide from continuing to interpolate. */
:host([data-motion="reduced"]) .pa,
:host([data-motion="reduced"]) .pa * {
  transition: none !important;
  animation: none !important;
}

/* ---------------------------------------------------------------- pointer */
.pa-pointer {
  width: 14px;
  height: 14px;
}
.pa-pointer::before {
  content: "";
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: var(--pa-accent);
  box-shadow: 0 0 0 2px var(--pa-contrast), 0 1px 3px rgba(0, 0, 0, 0.35);
}

/* ---------------------------------------------------------------- circle */
.pa-circle {
  /* The element is scaled to the target box by the primitive, so it is authored at 1px and
     transformed. Width/height stay unset so the box is exactly what the transform says it is. */
  border: 2px solid var(--pa-accent);
  border-radius: 999px;
  box-shadow: 0 0 0 2px var(--pa-contrast), 0 0 0 4px rgba(26, 86, 219, 0.18);
}

/* ---------------------------------------------------------------- underline */
.pa-underline {
  height: 3px;
  border-radius: 2px;
  background: var(--pa-accent);
  box-shadow: 0 0 0 1px var(--pa-contrast);
}

/* ---------------------------------------------------------------- badge */
.pa-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 9px;
  background: var(--pa-accent);
  color: var(--pa-contrast);
  font: 700 11px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 0 0 2px var(--pa-contrast);
}

/* ---------------------------------------------------------------- label */
.pa-label {
  max-width: 220px;
  padding: 3px 6px;
  border-radius: 4px;
  background: var(--pa-ink);
  color: var(--pa-contrast);
  font: 500 11px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  /* Labels are single-line by construction: the sanitiser already collapsed newlines, and this
     stops a long word from widening the bubble past the clamp the positioner did. */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}

/* ---------------------------------------------------------------- arrow */
.pa-arrow {
  /* A zero-size box with the shaft and head escaping it as absolutely positioned children. The
     size is declared here rather than written per frame by the arrow's draw, because it never
     varies and a layout-affecting write on every frame is exactly what the transform-only rule
     exists to avoid. The shaft then scales to any measured length and rotates about the marker's
     own origin without a second measuring element. */
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  transform-origin: 0 0;
  will-change: transform;
}
.pa-arrow__shaft {
  position: absolute;
  top: -1px;
  left: 0;
  height: 2px;
  border-radius: 1px;
  background: var(--pa-accent);
  transform-origin: 0 0;
  /* The shaft is authored 1px long and scaled to the measured distance, so following a target
     that moves never reflows anything. */
  width: 1px;
}
.pa-arrow__head {
  position: absolute;
  top: -4px;
  left: 0;
  width: 0;
  height: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 7px solid var(--pa-accent);
  transform-origin: 0 0;
}

/* ---------------------------------------------------------------- spotlight */
.pa-spotlight {
  /* Covers the viewport and is transparent: the dimming is done by the hole's box-shadow, which
     spreads the scrim *around* the target rather than punching through it. Doing it this way
     means there is no mask, no clip-path and no compositing layer whose support varies by
     engine, and — the part that matters — no element whose geometry could ever be hit-tested. */
  width: 0;
  height: 0;
  overflow: visible;
  will-change: transform;
}
.pa-spotlight__hole {
  position: absolute;
  top: 0;
  left: 0;
  /* Authored 100×100 and scaled by the primitive, so a moving target costs one transform. */
  width: 100px;
  height: 100px;
  /* Resolved against the 100px box and scaled with it: slightly elliptical on a very wide
     target, which is the price for not writing four layout properties every frame. */
  border-radius: 10%;
  box-shadow: 0 0 0 9999px rgba(10, 14, 28, 0.55);
  /* A visible edge around the cutout, so the target reads as "this one" rather than as a hole. */
  outline: 2px solid var(--pa-accent);
  outline-offset: 2px;
  background: transparent;
}
`;

export const PRIMITIVE_STYLE_SHEET = PRIMITIVE_STYLES;
