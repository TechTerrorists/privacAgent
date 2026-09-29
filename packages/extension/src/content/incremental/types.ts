import type { DocumentId, ElementId } from '@privacagent/protocol';
import type { LocalSemantics, SemanticOptions } from '../semantics/types.js';
import type { WalkMetrics } from '../dom-extract/scheduler.js';

/** Raw LOCAL data. This is deliberately not an E-01 ScreenState or wire diff. */
export interface CandidateSnapshot {
  readonly id: ElementId;
  readonly semantics: Readonly<Omit<LocalSemantics, 'dependencies' | 'workUnits'>>;
  readonly state: Readonly<Record<string, string | boolean>>;
  /** Password values are never read. Other values remain raw local privacy inputs. */
  readonly value: string | null;
  readonly parent: ElementId | null;
  /** B-04 and geometry extraction are not implemented by B-06. */
  readonly geometry: null;
}
export interface EvidenceSnapshot {
  readonly id: string;
  readonly kind: 'text' | 'attributes' | 'value';
  readonly text: string | null;
  readonly attributes: readonly (readonly [string, string])[];
}
export interface LocalDiff<T> {
  readonly added: readonly T[];
  readonly changed: readonly T[];
  readonly removed: readonly string[];
}
export interface Observation {
  readonly status: 'complete';
  readonly doc_id: DocumentId;
  readonly baseline: number | null;
  readonly observation: number;
  readonly full: boolean;
  readonly candidates: LocalDiff<CandidateSnapshot>;
  readonly evidence: LocalDiff<EvidenceSnapshot>;
  readonly metrics: WalkMetrics & {
    fullWalks: number;
    subtreeWalks: number;
    extracted: number;
    cached: number;
  };
}
export type ObservationResult =
  | Observation
  | { status: 'cancelled' | 'stale' | 'error' | 'disposed' | 'busy' | 'unstable' | 'limited' };
export interface IncrementalOptions extends SemanticOptions {
  maxRecords?: number;
  maxEntries?: number;
  maxSnapshotChars?: number;
  maxRoots?: number;
  /** No timer: a full refresh every N requested observations reconciles unobservable changes. */
  reconcileEvery?: number;
  /** Exact extension-owned nodes only; never selectors or arbitrary page subtrees. */
  ownedNodes?: WeakSet<Node>;
}
export type InvalidationReason =
  'mutation' | 'input' | 'layout' | 'roots' | 'generation' | 'explicit' | 'overflow';
