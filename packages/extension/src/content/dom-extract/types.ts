import type { SchedulingOptions, WalkMetrics } from './scheduler.js';

/** Local references only. Never send this structure through extension messaging or egress. */
export interface TraversalContext {
  document: Document;
  root: Document | ShadowRoot;
  /** The iframe containing this document, if any. Shadow roots inherit it. */
  frameElement: HTMLIFrameElement | null;
  parent: TraversalContext | null;
}

export type CandidateReason =
  'native-control' | 'role' | 'editable' | 'tabindex' | 'pointer' | 'context' | 'frame';

export interface LocalCandidate {
  node: Element;
  context: TraversalContext;
  reasons: CandidateReason[];
}

/** Text and attribute evidence are intentionally separate; these are live DOM handles. */
export interface LocalEvidence {
  textNodes: { node: Text; context: TraversalContext }[];
  attributeElements: { node: Element; context: TraversalContext }[];
}

export interface FrameBoundary {
  node: HTMLIFrameElement;
  context: TraversalContext;
  access: 'same-origin' | 'opaque' | 'unloaded';
}

export interface WalkOptions extends Omit<SchedulingOptions, 'scheduler'> {
  scheduler?: SchedulingOptions['scheduler'];
}

export type WalkResult =
  | {
      status: 'complete';
      candidates: LocalCandidate[];
      evidence: LocalEvidence;
      frames: FrameBoundary[];
      contexts: TraversalContext[];
      metrics: WalkMetrics;
    }
  | {
      /** Partial page data is discarded on cancellation, staleness or failure. */
      status: 'cancelled' | 'stale' | 'error';
      metrics: WalkMetrics;
    };
