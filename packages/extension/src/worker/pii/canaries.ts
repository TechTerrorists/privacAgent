/**
 * Synthetic canary case list for the intercepting-proxy leak harness (C-16).
 *
 * Every value here is fabricated and carries a unique `CANARY-…` marker
 * (never real personal data), so a leak means the marker string itself
 * appears in captured egress. Mirrors `bench/mock-sites`' canary convention
 * (`profile.email`, `canaries` in `bench/mock-sites/src/fixtures.ts`), scoped
 * to what D-01 owns: the PII engine's own scan/redact decisions, not a live
 * page.
 *
 * C-16 runs these against whatever engine is active (`getPiiEngineApi()`)
 * and asserts two things for every case: the marker is absent from every
 * returned outbound-facing value, and the outcome matches what the case
 * expects — not merely that *some* value came back. See `pii.test.ts` for
 * the reference assertions this file is built to support.
 */

import type { EvidenceSource, FindingLocation, PiiClass, TextEvidenceHints } from './types.js';

/** The protocol's `Placeholder` pattern (packages/protocol/schemas/protocol.schema.json). */
export const PLACEHOLDER_PATTERN = /^\{\{(?:[A-Z][A-Z0-9_]*_[1-9][0-9]*|SECRET|TEXT_WITHHELD)\}\}$/;

export interface PiiCanaryCase {
  readonly id: string;
  readonly description: string;
  /** Unique synthetic substring. Must never appear in any outbound-facing value. */
  readonly marker: string;
  readonly evidence: EvidenceSource;
  readonly text: string;
  readonly location: FindingLocation;
  readonly hints?: TextEvidenceHints;
  /** What `scanText` must return for this input. */
  readonly expectedOutcome: 'clear' | 'redacted' | 'withheld';
  /** Only meaningful when `expectedOutcome` is `redacted`. */
  readonly expectedPiiClass?: PiiClass;
}

const EL = 'canary-el-01';

/**
 * Covers: PII classes (email, phone, secret, aadhaar-shaped, card-shaped,
 * other), DOM text vs. DOM attribute vs. OCR vs. user/task text evidence,
 * English and Hindi text, a field with no companion `pii_class` slot
 * (`name`/`title`/`url`/`text_context`), a detector-unavailable value (no
 * local signal names a class, so it is withheld exactly like the protocol's
 * own `text-withheld` fixture example rather than ever inferring safety —
 * this is the case the D-10 degraded-device suite extends once real
 * detectors exist and can be disabled one at a time), and the empty-string
 * control case that proves the engine does not over-redact.
 */
export const PII_CANARIES: readonly PiiCanaryCase[] = [
  {
    id: 'value-email-l1',
    description: 'DOM value on an email input, classified via L1 input_type semantics.',
    marker: 'CANARY-EMAIL-771001',
    evidence: 'dom_text',
    text: 'canary.771001@example.test',
    location: { kind: 'element_field', elementId: EL, field: 'value' },
    hints: { inputType: 'email' },
    expectedOutcome: 'redacted',
    expectedPiiClass: 'email',
  },
  {
    id: 'value-phone-l1',
    description: 'DOM value on a tel input.',
    marker: 'CANARY-PHONE-559002',
    evidence: 'dom_text',
    text: '+91CANARY559002',
    location: { kind: 'element_field', elementId: EL, field: 'value' },
    hints: { inputType: 'tel' },
    expectedOutcome: 'redacted',
    expectedPiiClass: 'phone',
  },
  {
    id: 'value-password-secret',
    description:
      'Password field must yield the literal {{SECRET}} placeholder, never a numbered one.',
    marker: 'CANARY-SECRET-330912',
    evidence: 'dom_text',
    text: 'CANARY-SECRET-330912!',
    location: { kind: 'element_field', elementId: EL, field: 'value' },
    hints: { inputType: 'password' },
    expectedOutcome: 'redacted',
    expectedPiiClass: 'secret',
  },
  {
    id: 'value-detector-unavailable',
    description:
      'Value with no DOM semantic hint at all — the local analogue of "detector unavailable". No local signal fires, so it is withheld to {{TEXT_WITHHELD}} with pii_class "other" (matching the protocol\'s own text-withheld fixture), never masked with an invented class or passed through.',
    marker: 'CANARY-UNSCANNED-118820',
    evidence: 'ocr',
    text: 'CANARY-UNSCANNED-118820',
    location: { kind: 'element_field', elementId: EL, field: 'value' },
    expectedOutcome: 'withheld',
    expectedPiiClass: 'other',
  },
  {
    id: 'name-english',
    description:
      "Accessible name carries a person's name — no pii_class slot exists for `name`, so it is withheld outright.",
    marker: 'CANARY-NAME-Priya-402',
    evidence: 'dom_text',
    text: 'CANARY-NAME-Priya-402 Sharma',
    location: { kind: 'element_field', elementId: EL, field: 'name' },
    expectedOutcome: 'withheld',
  },
  {
    id: 'name-hindi',
    description: 'Hindi-script accessible name, same withhold path as English.',
    marker: 'कैनरी-CANARY-512',
    evidence: 'dom_text',
    text: 'कैनरी-CANARY-512 गोपनीय नाम',
    location: { kind: 'element_field', elementId: EL, field: 'name' },
    expectedOutcome: 'withheld',
  },
  {
    id: 'title-aadhaar-shaped',
    description: 'DOM attribute (title) carrying an Aadhaar-shaped number.',
    marker: 'CANARY-AADHAAR-234567890123',
    evidence: 'dom_attribute',
    text: 'CANARY-AADHAAR-234567890123',
    location: { kind: 'page_field', field: 'title' },
    expectedOutcome: 'withheld',
  },
  {
    id: 'url-token',
    description: 'Page URL carrying a reset token in the query string.',
    marker: 'CANARY-TOKEN-abcdef99',
    evidence: 'dom_attribute',
    text: 'https://example.test/reset?token=CANARY-TOKEN-abcdef99',
    location: { kind: 'page_field', field: 'url' },
    expectedOutcome: 'withheld',
  },
  {
    id: 'text-context-card-shaped',
    description:
      'OCR-derived text_context entry carrying a card-shaped number. Dropped from the array by redactTextContext, not merely masked in place.',
    marker: 'CANARY-CARD-4111111111119001',
    evidence: 'ocr',
    text: 'Card on file: CANARY-CARD-4111111111119001',
    location: { kind: 'text_context_entry', index: 0 },
    expectedOutcome: 'withheld',
  },
  {
    id: 'user-task-text-ssn-shaped',
    description: 'User-turn text carrying an SSN-shaped value.',
    marker: 'CANARY-SSN-000112222',
    evidence: 'user_text',
    text: 'my number is CANARY-SSN-000112222',
    location: { kind: 'user_task_text', source: 'user_turn' },
    expectedOutcome: 'withheld',
  },
  {
    id: 'task-text-hindi',
    description: 'Task-derived text in Hindi, task_text evidence.',
    marker: 'CANARY-TASK-887766',
    evidence: 'task_text',
    text: 'यह गोपनीय है CANARY-TASK-887766',
    location: { kind: 'user_task_text', source: 'task' },
    expectedOutcome: 'withheld',
  },
  {
    id: 'value-empty-control',
    description:
      'Negative control: an empty value must pass through unmodified — proves the stub does not over-redact structurally safe content.',
    marker: '__no_marker__',
    evidence: 'dom_text',
    text: '',
    location: { kind: 'element_field', elementId: EL, field: 'value' },
    expectedOutcome: 'clear',
  },
];
