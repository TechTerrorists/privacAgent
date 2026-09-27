/**
 * PII engine finding and redaction types (feature D-01).
 *
 * These describe what the local PII engine (D-02 onward) takes and returns.
 * Like `worker/inference`, everything here is *local* evidence — it never
 * extends the outbound E-01 schema, because a finding records raw text
 * location and provenance that must never reach the network. The only things
 * borrowed from E-01 are `ElementId`, `DocumentId`, `BBox`, `Placeholder` and
 * `PiiClass`, so a redaction decision needs no reshaping to become part of a
 * Screen State.
 */

import type { BBox, DocumentId, ElementId, Placeholder, PiiClass } from '@privacagent/protocol';

export type { BBox, DocumentId, ElementId, Placeholder, PiiClass };

/**
 * Where a piece of text came from (PRD §6.1).
 *
 * Kept distinct because DOM text, DOM attribute values and OCR text must be
 * scanned independently: an image button whose DOM label reads "Profile" may
 * render a person's name in pixels, and merging the two evidence streams
 * would destroy the distinction redaction needs.
 *
 * `dom_structure` (D-03) is not text evidence at all: a site/user policy
 * finding comes from matching an element via a CSS selector, never from
 * reading its text content, so it needs a provenance value that does not
 * imply any text was scanned.
 */
export type EvidenceSource =
  'dom_text' | 'dom_attribute' | 'ocr' | 'user_text' | 'task_text' | 'dom_structure';

/** Character offsets into the original evidence text, for provenance only. */
export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * The E-01 text field a finding affects, when the evidence is element-scoped.
 *
 * `title` and `url` cover `Page.title` / `Page.url`, which are page-scoped
 * rather than element-scoped but carry the same withhold-or-mask treatment.
 */
export type TextField = 'name' | 'value' | 'text_context' | 'title' | 'url';

/**
 * Where a finding applies. A finding always names exactly one of these; there
 * is no free-floating "somewhere in the page" location, because the Egress
 * Guard's coverage check (PRD §10.2) needs to attribute every finding to a
 * field it can then verify was actually redacted.
 *
 * `element_scope` (D-03) is coarser than `element_field`: it covers every
 * field an element carries, for callers (site/user policy) that decide by
 * matching the element itself — a CSS selector, not a specific text field —
 * and cannot know in advance which fields that element will turn out to have.
 */
export type FindingLocation =
  | {
      readonly kind: 'element_field';
      readonly elementId: ElementId;
      readonly field: TextField;
      readonly span?: TextSpan;
    }
  | { readonly kind: 'page_field'; readonly field: 'title' | 'url'; readonly span?: TextSpan }
  | { readonly kind: 'text_context_entry'; readonly index: number; readonly span?: TextSpan }
  | { readonly kind: 'region'; readonly docId: DocumentId; readonly bbox: BBox }
  | {
      readonly kind: 'user_task_text';
      readonly source: 'user_turn' | 'task';
      readonly span?: TextSpan;
    }
  | { readonly kind: 'element_scope'; readonly elementId: ElementId; readonly docId: DocumentId };

/**
 * Which detector layer produced a finding (CLAUDE.md, PII detector layers).
 *
 * `'stub'` is not a real layer — it is D-01's explicit marker that no
 * detector examined the evidence and the decision is a conservative default.
 * A finding's `synthetic` flag is what callers must check, not this field:
 * `detector` names *which* stand-in produced the finding, `synthetic` says
 * whether it may be trusted as detector coverage.
 */
export type DetectorLayer =
  'l1_semantic' | 'l2_pattern' | 'l3_ner' | 'l4_vision' | 'l5_policy' | 'stub';

/** What the engine decided to do with the evidence at a location. */
export type RedactionDecision = 'mask' | 'withhold';

/**
 * One piece of evidence and the decision made about it.
 *
 * This is raw internal evidence, not outbound data: `piiClass` may be present
 * even when `decision` is `withhold`, because classifying *why* something was
 * withheld is useful for the vault and for C-16 assertions, and it never
 * reaches the wire either way.
 */
export interface PiiFinding {
  readonly evidence: EvidenceSource;
  readonly location: FindingLocation;
  readonly piiClass: PiiClass;
  readonly detector: DetectorLayer;
  /** 0..1. The stub always reports 1 — it is certain only in the sense that it never guesses "safe". */
  readonly confidence: number;
  readonly decision: RedactionDecision;
  /**
   * Which specific rule or policy within `detector` produced this finding
   * (D-03), e.g. `'input_type:email'`, `'label_keyword:phone'`,
   * `'always_redact_selector'`. Optional and free-form: `detector` names the
   * layer, this names the rule inside it, for diagnostics and for telling two
   * findings from the same layer apart. Never derived from page content.
   */
  readonly rule?: string;
  /**
   * True when this finding was fabricated by a stand-in rather than produced
   * by a real detector pass. Mirrors `worker/inference`'s `synthetic` flag:
   * a synthetic finding must never satisfy the Egress Guard's
   * detector-coverage check (PRD §10.2), even though its decision is safe.
   */
  readonly synthetic: boolean;
}

/**
 * Outcome of scanning one piece of text.
 *
 * - `clear`: the text was empty. Nothing to hide, so it passes through as-is.
 *   This is the *only* case in which the stub returns original content.
 * - `redacted`: a `value` field for which some local signal (L1 semantics,
 *   or a real detector later) positively named a `pii_class`, replaced by a
 *   class-specific placeholder (`{{EMAIL_1}}`, or the literal `{{SECRET}}`
 *   for a password field) that travels with that `pii_class` on the wire.
 * - `withheld`: everything else that is non-empty — a `name`, `title`,
 *   `url`, `text_context` entry or user/task text field (none of which
 *   carries a companion `pii_class` slot at all), or a `value` field no
 *   signal could classify. Replaced by the protocol's standalone
 *   `{{TEXT_WITHHELD}}` placeholder — the same one used in the protocol's
 *   own fixture example for an unclassified redacted value
 *   (`packages/protocol/fixtures/valid.json`, case `text-withheld`).
 *   Inventing a class-specific placeholder here would claim a detection that
 *   never happened.
 */
export type PiiTextOutcome = 'clear' | 'redacted' | 'withheld';

/**
 * The result of scanning a single text field.
 *
 * `value` is always safe to place on the wire for the corresponding outcome:
 * the original text when `clear`, a class-specific placeholder when
 * `redacted`, and the literal `{{TEXT_WITHHELD}}` when `withheld`. `piiClass`
 * is set for both `redacted` and `withheld` (the wire still needs one when
 * the field carries a `pii_class` slot, e.g. `'other'` for an unclassified
 * `value`) and absent only for `clear`. Whether a `withheld` result is
 * inlined (a required string field, e.g. `name`) or causes the caller to
 * drop the item entirely (an array entry, e.g. `text_context`) is the
 * caller's decision, not this result's.
 */
export interface PiiTextResult {
  readonly outcome: PiiTextOutcome;
  readonly value: string;
  readonly piiClass?: PiiClass;
  readonly finding?: PiiFinding;
}

/** Optional DOM semantic hints (PRD L1) that help classify, never authorize, a redaction. */
export interface TextEvidenceHints {
  readonly inputType?: string;
  readonly autocomplete?: string;
  readonly labelKeywords?: readonly string[];
}

/** Input to a text scan. */
export interface PiiTextInput {
  readonly evidence: EvidenceSource;
  readonly text: string;
  readonly location: FindingLocation;
  readonly hints?: TextEvidenceHints;
}

/**
 * Outcome of evaluating whether a crop region may leave the client (§6.8).
 *
 * D-01 ships no crop pipeline: the stub always withholds. This type exists so
 * the Tier-2 escalation caller (D-13/D-14) and Egress Guard have a stable
 * contract to build against before that pipeline lands.
 */
export interface PiiCropOutcome {
  readonly outcome: 'withheld';
  readonly finding: PiiFinding;
}
