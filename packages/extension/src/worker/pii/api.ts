/**
 * The local PII engine interface (feature D-01).
 *
 * Three operations: scan a piece of text, redact a candidate element into an
 * outbound E-01 `Element`, and redact a crop region. Every call is
 * asynchronous because a real detector pass (D-03 NER, D-04 vision) runs
 * inside the ML worker and may not resolve synchronously; the stub (D-01)
 * resolves immediately.
 *
 * Callers depend on this interface, never on a concrete engine — the same
 * pattern as `worker/inference`. D-02 through D-14 swap the implementation
 * through `setPiiEngineApi` without touching a single caller.
 *
 * Fail-closed by contract: an implementation must return `withheld` for any
 * input it cannot positively classify as safe. Returning `clear` is a claim
 * that this evidence was examined and found to carry no PII — the stub never
 * makes that claim for non-empty text.
 */

import type {
  BBox,
  DisplayElement,
  DocumentId,
  Element,
  ElementId,
  PiiClass,
} from '@privacagent/protocol';

import type { EvidenceSource, PiiCropOutcome, PiiTextInput, PiiTextResult } from './types.js';

export type { PiiCropOutcome, PiiTextInput, PiiTextResult };

/** Which engine produced a result. D-02+ add real detector-backed names. */
export type PiiEngineName = 'stub' | 'layered';

/**
 * A candidate element, before a redaction decision has been made.
 *
 * Mirrors the four E-01 `Element` variants' shared fields, plus the raw text
 * evidence the engine needs and has not yet cleared for egress. `value` is
 * absent when the control genuinely carries no value (e.g. a link or a
 * button), distinct from an empty string, which is itself evidence to scan.
 */
export interface RawElementCandidate {
  readonly id: ElementId;
  readonly role: string;
  readonly rawName: string;
  readonly bbox: BBox;
  readonly src: 'dom' | 'vision' | 'fused' | 'server_vlm';
  readonly conf: number;
  readonly state?: DisplayElement['state'];
  readonly inputType?: DisplayElement['input_type'];
  readonly landmark?: string;
  readonly image?: 'face_redacted' | 'masked';
  readonly hasValue: boolean;
  readonly rawValue?: string;
  /** Defaults to `'ocr'` when `src` is `'vision'`, else `'dom_text'` (PRD §6.1). */
  readonly nameEvidence?: EvidenceSource;
  /** Defaults the same way as {@link nameEvidence}. */
  readonly valueEvidence?: EvidenceSource;
}

/**
 * The element is safe to place in a Screen State as-is or with fields
 * replaced by placeholders. `withheld` means no safe representation exists —
 * the caller must drop the element from `elements` entirely rather than send
 * a partially-redacted one, per D-01's "safe suppression over convenience".
 */
export type RedactElementOutcome =
  | { readonly outcome: 'ok'; readonly element: Element }
  | { readonly outcome: 'withheld'; readonly reason: string };

/** Result of redacting the free-form `text_context` list. */
export interface RedactedTextContext {
  /** Safe entries only — a withheld entry is dropped, never sent as `''`. */
  readonly values: readonly string[];
  readonly withheldCount: number;
}

/** Input to a crop redaction decision (§6.8 Tier-2 allowlist). */
export interface PiiCropInput {
  readonly docId: DocumentId;
  readonly elementId?: ElementId;
  readonly bbox: BBox;
}

/**
 * On-device PII detection and redaction.
 *
 * Implementations must not perform network I/O, persist the vault, log raw
 * evidence, or fabricate a `clear`/coverage claim they cannot back.
 */
export interface PiiEngineApi {
  readonly engine: PiiEngineName;
  /** True when this engine cannot back its decisions with a real detector pass. */
  readonly synthetic: boolean;
  /** Which PII classes this engine can positively recognize. Empty for the stub. */
  readonly recognizedClasses: readonly PiiClass[];

  /** Scan and redact one piece of evidence. Never returns raw PII in `value` unless `outcome` is `clear`. */
  scanText(input: PiiTextInput): Promise<PiiTextResult>;

  /** Redact a candidate element into a wire-safe `Element`, or withhold it. */
  redactElement(candidate: RawElementCandidate): Promise<RedactElementOutcome>;

  /** Redact the free-form `text_context` list. */
  redactTextContext(entries: readonly string[], docId: DocumentId): Promise<RedactedTextContext>;

  /** Decide whether a crop region may leave the client. The stub always withholds. */
  redactCrop(input: PiiCropInput): Promise<PiiCropOutcome>;
}
