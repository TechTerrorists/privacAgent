/**
 * F-08: the cursor companion.
 *
 * A thin presentation layer over F-02's overlay and a state owner that does not exist yet. The
 * public surface is deliberately small: a renderer to wrap the layer's existing one, a resolver to
 * wrap the layer's existing one, a pointer source, and a controller that binds them to an injected
 * provider.
 *
 * With no provider attached the companion renders `idle` and says so. That is the shipping state
 * today, and it is the correct one: A-11 (#46) and F-09 (#106) own the truth, and a companion that
 * animated a plausible run with nothing behind it would be making a privacy claim on the user's
 * behalf.
 */
export { createCompanionController } from './controller.js';
export type { CompanionController, CompanionControllerOptions } from './controller.js';
export { createCompanionResolver, createPointerSource } from './pointer-resolver.js';
export type { PointerSample, PointerSource } from './pointer-resolver.js';
export { createCompanionRenderer } from './renderer.js';
export { COMPANION_KIND, CompanionPrimitive, companionSpec } from './primitive.js';
export type { CompanionSpec } from './primitive.js';
export { COMPANION_SIZE, COMPANION_STYLE_SHEET, buildCharacter } from './character.js';
export { INITIAL_MACHINE, reduceCompanion, toSnapshot } from './reducer.js';
export type { CompanionMachine, ReduceOptions } from './reducer.js';
export {
  COMPANION_ELEMENT_ID,
  COMPANION_STATES,
  companionAnchor,
  UNAVAILABLE_ADAPTER,
  isCompanionState,
} from './types.js';
export type {
  CompanionEvent,
  CompanionIdentity,
  CompanionPresentationAdapter,
  CompanionRejection,
  CompanionSnapshot,
  CompanionState,
} from './types.js';
export { createCompanionPreference } from './preference.js';
export type { CompanionPreference, CompanionPreferenceOptions } from './preference.js';
