/**
 * F-03: the primitive renderer.
 *
 * This is the whole of F-03's integration with F-02. It implements the same three-method
 * interface as F-02's default marker renderer and is handed to the *same* controller, so the
 * layer gets F-02's host, F-02's closed shadow root, F-02's annotation registry, F-02's
 * `TargetResolver`, F-02's viewport geometry, F-02's `FrameCoalescer` and F-02's heartbeat,
 * without any of them being re-implemented or duplicated.
 *
 * What is added here is a `switch` over seven kinds and a stylesheet. The kinds are a closed set
 * on purpose: a primitive that is not in this list is not a primitive, it is a feature that
 * needs its own review of the safety rules below.
 */
import { PRIMITIVE_STYLE_SHEET } from './styles.js';
import { LabelPrimitive, type LabelSpec } from './label.js';
import { SpotlightPrimitive, type SpotlightSpec } from './spotlight.js';
import {
  ArrowPrimitive,
  BadgePrimitive,
  CirclePrimitive,
  PointerPrimitive,
  UnderlinePrimitive,
  type ArrowSpec,
  type BadgeSpec,
  type CircleSpec,
  type PointerSpec,
  type UnderlineSpec,
} from './shapes.js';
import type {
  OverlayPrimitive,
  OverlayRenderer,
  PrimitiveContext,
  PrimitiveSpec,
} from '../types.js';

export const PRIMITIVE_KINDS = [
  'pointer',
  'circle',
  'arrow',
  'badge',
  'label',
  'spotlight',
  'underline',
] as const;

export type PrimitiveKind = (typeof PRIMITIVE_KINDS)[number];

/** Every spec a caller may pass. A union, so a typo is a type error rather than a blank box. */
export type AnyPrimitiveSpec =
  PointerSpec | CircleSpec | ArrowSpec | BadgeSpec | LabelSpec | SpotlightSpec | UnderlineSpec;

/** Narrows an untyped spec, so the factory below can dispatch without a cast per branch. */
export function isPrimitiveKind(kind: string): kind is PrimitiveKind {
  return (PRIMITIVE_KINDS as readonly string[]).includes(kind);
}

/**
 * F-02's dot marker is *not* a kind this dispatcher accepts, and that is a deliberate boundary
 * rather than an omission. A layer is created with exactly one renderer — F-02's `markerRenderer`
 * by default, or this one — so an annotation either draws as the marker or as a primitive, and a
 * single layer cannot mix the two. Accepting `'marker'` here would mean a `RangeError` on the
 * default path, or a second renderer contract for no caller.
 */

export function createPrimitiveRenderer(): OverlayRenderer {
  return {
    /**
     * One `<style>` appended to the root `mountOverlayHost` already created. Not a new root, not
     * a new host: the page still sees exactly one bare `<div>` on `<html>` with a closed shadow
     * root and no attributes, which is the whole of the isolation contract.
     */
    install(root, document) {
      const style = document.createElement('style');
      style.textContent = PRIMITIVE_STYLE_SHEET;
      root.append(style);
    },

    create(document, spec, context): OverlayPrimitive {
      return build(document, spec, context);
    },

    /**
     * A node can be reused only when it is the same kind *and* the same structure.
     *
     * Reuse is what keeps replacement cheap (rule 7: nodes are reused, not recreated), but it is
     * also what keeps a `retarget` from being asked to morph into something it was not built for.
     * A different kind always rebuilds, and the core releases the old primitive first so its
     * animation frames go with it.
     */
    canReuse(previous, next) {
      return previous.kind === next.kind;
    },
  };
}

function build(
  document: Document,
  spec: PrimitiveSpec,
  context: PrimitiveContext
): OverlayPrimitive {
  switch (spec.kind) {
    case 'pointer':
      return new PointerPrimitive(document, spec as PointerSpec, context);
    case 'circle':
      return new CirclePrimitive(document, spec as CircleSpec, context);
    case 'arrow':
      return new ArrowPrimitive(document, spec as ArrowSpec, context);
    case 'badge':
      return new BadgePrimitive(document, spec as BadgeSpec, context);
    case 'label':
      return new LabelPrimitive(document, spec as LabelSpec, context);
    case 'spotlight':
      return new SpotlightPrimitive(document, spec as SpotlightSpec, context);
    case 'underline':
      return new UnderlinePrimitive(document, spec as UnderlineSpec, context);
    default:
      throw new RangeError(`Unknown overlay primitive kind: ${describeKind(spec.kind)}`);
  }
}

/**
 * The kind name is echoed back in the error so a typo is debuggable. It is a compile-time
 * constant from the caller's own code — never page text and never a target value — so this is
 * not a place where untrusted data becomes a log line.
 */
const describeKind = (kind: string): string => (/^[a-z-]{1,32}$/.test(kind) ? kind : '(invalid)');
