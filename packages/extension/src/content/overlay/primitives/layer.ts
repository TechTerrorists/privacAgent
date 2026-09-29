/**
 * F-03: the layer facade.
 *
 * A thin, typed front door over F-02's controller. It exists for two reasons and no more:
 *
 * 1. **Typing.** `handle.update(anchor, { primitive })` takes an opaque `PrimitiveSpec` because
 *    the core must not know F-03's kinds. `show()` accepts the real spec union, so a caller
 *    cannot pass a `kind` that does not exist without a type error, and does not have to know
 *    that the core treats the spec as opaque.
 * 2. **Not owning anything.** There is no annotation map here, no host, no resolver, no frame
 *    loop. `hide`, `hideAll` and `dispose` are direct calls through to the F-02 handle, which
 *    already does the right thing on every path.
 */
import { createOverlay } from '../controller.js';
import { createPrimitiveRenderer, type AnyPrimitiveSpec, type PrimitiveKind } from './renderer.js';
import type {
  AnchorId,
  OverlayAnchor,
  OverlayHandle,
  OverlayOptions,
  Placement,
} from '../types.js';

export interface ShowOptions {
  /** Which side of the target to sit on. Defaults to the core's `auto`, which flips at edges. */
  readonly placement?: Placement;
  /** Gap between the target edge and the marker, in CSS pixels. Defaults to 8. */
  readonly offset?: number;
}

/**
 * Builds an overlay handle that draws F-03's primitives.
 *
 * Any other option is F-02's and passes straight through, including the resolver — F-03 has no
 * opinion about how a target is found, and supplying a different one here would be the easiest
 * way to accidentally create a second element registry.
 */
export function createPrimitiveOverlay(options: OverlayOptions): OverlayHandle {
  return createOverlay({
    ...options,
    // An explicit renderer still wins, so a caller can wrap or instrument the primitives without
    // forking this file.
    renderer: options.renderer ?? createPrimitiveRenderer(),
  });
}

/**
 * Adds or re-points an annotation. The returned id is `doc_id/element_id`, and calling this again
 * for the same anchor **replaces** the annotation rather than adding a second one.
 */
export function show(
  handle: OverlayHandle,
  anchor: OverlayAnchor,
  spec: AnyPrimitiveSpec,
  options: ShowOptions = {}
): AnchorId {
  return handle.update(anchor, {
    primitive: spec,
    ...(options.placement ? { placement: options.placement } : {}),
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
  });
}

/** Convenience narrowing for callers that build a kind from a runtime string. */
export function primitiveSpec<K extends PrimitiveKind>(
  kind: K,
  fields: Omit<Extract<AnyPrimitiveSpec, { kind: K }>, 'kind'>
): AnyPrimitiveSpec {
  return { kind, ...fields } as AnyPrimitiveSpec;
}
