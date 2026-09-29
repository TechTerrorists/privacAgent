import type { WalkOptions } from '../dom-extract/types.js';
import type { WalkMetrics } from '../dom-extract/scheduler.js';

export type NameSource =
  | 'none'
  | 'aria-labelledby'
  | 'aria-label'
  | 'label'
  | 'alt'
  | 'contents'
  | 'title'
  | 'native'
  | 'svg-title';
export type SemanticScope = Document | ShadowRoot;
/** Live local DOM dependencies, not a transport or persistence format. */
export interface SemanticDependencies {
  nodes: Node[];
  /** Includes missing IDREFs: additions/ID changes in these scopes invalidate the result. */
  references: { scope: SemanticScope; id: string }[];
  /** Conservative B-06 invalidation boundary for labels, styles and slot distribution. */
  scopes: SemanticScope[];
}
export interface LocalSemantics {
  status: 'complete' | 'limited' | 'stale';
  role: string | null;
  roleSource: 'explicit' | 'implicit' | 'none';
  name: string;
  nameSource: NameSource;
  description: string;
  descriptionSource: 'none' | 'aria-describedby' | 'aria-description' | 'title' | 'svg-desc';
  /** Never pass this off as a standards-computed accessible name. */
  fallback: { text: string; source: 'placeholder' | 'alt' } | null;
  dependencies: SemanticDependencies;
  workUnits: number;
}
export interface SemanticOptions extends WalkOptions {
  /** Per-target semantic work; exceeding a limit withholds the entire result. */
  maxWork?: number;
  maxDepth?: number;
  maxTextLength?: number;
  /** Per tree scope; standalone calls use fresh indexes, B-06 owns observed invalidation. */
  maxScopeNodes?: number;
}
export type SemanticBatch =
  | { status: 'complete'; results: LocalSemantics[]; metrics: WalkMetrics }
  | { status: 'cancelled' | 'stale' | 'error'; metrics: WalkMetrics };
