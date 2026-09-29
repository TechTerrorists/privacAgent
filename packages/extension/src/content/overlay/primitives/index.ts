/**
 * F-03: element-anchored overlay primitives.
 *
 * Seven visual primitives drawn in F-02's overlay: pointer/glide, circle, arrow, numbered badge,
 * text label, spotlight, and the optional underline. They all anchor to `(doc_id, element_id)`,
 * are all click-through, and all inherit F-02's lifecycle — nothing here owns a registry, a host,
 * a shadow root, or a frame loop.
 *
 * See `README.md` for the safety rules each primitive satisfies and the contract F-04/E-12
 * code against.
 */
export { createPrimitiveRenderer, isPrimitiveKind, PRIMITIVE_KINDS } from './renderer.js';
export { createPrimitiveOverlay, primitiveSpec, show } from './layer.js';
export { MAX_LABEL_CHARS, sanitizeLabel, setLabel } from './text.js';
export { Glide } from './motion.js';
export { PRIMITIVE_STYLE_SHEET } from './styles.js';
export type { AnyPrimitiveSpec, PrimitiveKind } from './renderer.js';
export type { ShowOptions } from './layer.js';
export type { LabelSpec } from './label.js';
export type { SpotlightSpec } from './spotlight.js';
export type { ArrowSpec, BadgeSpec, CircleSpec, PointerSpec, UnderlineSpec } from './shapes.js';
