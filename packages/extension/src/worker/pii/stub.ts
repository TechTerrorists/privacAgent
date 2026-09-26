/**
 * Conservative stub PII engine (feature D-01).
 *
 * Lets lanes A, B and C write and test real code against the PII engine
 * interface before any detector exists (mirrors `worker/inference`'s fake
 * engine). It ships **no detection**: every non-empty piece of text is
 * treated as potentially sensitive and masked or withheld, because "no
 * detector pass or privacy clearance may be invented to make an integration
 * succeed."
 *
 * ## What "conservative" means here
 *
 * - A non-empty `value` field is masked to a class-specific placeholder only
 *   when DOM semantics already on the candidate (L1: `input_type`) name a
 *   class — never from inspecting the text itself, which would be a
 *   pattern-matching detector (D-03's job). Without that signal, `value` is
 *   treated the same as "no detector examined this" and withheld.
 * - Any non-empty `name`, `title`, `url`, `text_context` entry, user/task
 *   text, or an unclassified `value`, is replaced by the protocol's
 *   standalone `{{TEXT_WITHHELD}}` placeholder.
 * - Crops are always withheld — D-01 ships no image pipeline.
 * - Empty text is the *only* content this stub ever returns unmodified.
 *
 * No field is ever passed through unexamined: an empty string is genuinely
 * safe (there is nothing to hide), not a gap the stub failed to cover.
 */

import type {
  DisplayElement,
  DocumentId,
  Element,
  EmptyElement,
  PiiClass,
} from '@privacagent/protocol';

import type {
  PiiCropInput,
  PiiEngineApi,
  RawElementCandidate,
  RedactedTextContext,
  RedactElementOutcome,
} from './api.js';
import { InvalidPiiInputError } from './errors.js';
import type {
  EvidenceSource,
  FindingLocation,
  PiiCropOutcome,
  PiiFinding,
  PiiTextInput,
  PiiTextResult,
} from './types.js';

/** L1 semantic mapping (CLAUDE.md detector layers): DOM `input_type` -> `pii_class`. Never a pattern match over text. */
const INPUT_TYPE_CLASS: Partial<Record<NonNullable<DisplayElement['input_type']>, PiiClass>> = {
  email: 'email',
  tel: 'phone',
  password: 'secret',
};

/** The protocol's standalone "no safe classification available" marker (see `PiiTextOutcome`). */
const TEXT_WITHHELD = '{{TEXT_WITHHELD}}';
/** The protocol's literal secret placeholder — never numbered, never resolved by the executor. */
const SECRET_PLACEHOLDER = '{{SECRET}}';

function isFiniteBox(bbox: readonly number[]): boolean {
  return bbox.length === 4 && bbox.every((n) => Number.isFinite(n));
}

/** Builds a class-specific placeholder, e.g. `{{EMAIL_3}}`. Matches the protocol's `Placeholder` pattern. */
function classPlaceholder(piiClass: PiiClass, n: number): string {
  return `{{${piiClass.toUpperCase()}_${n}}}`;
}

/** Creates a stub engine. Each instance owns its own per-class placeholder counters. */
export function createStubPiiEngine(): PiiEngineApi {
  const counters = new Map<PiiClass, number>();
  function nextIndex(piiClass: PiiClass): number {
    const n = (counters.get(piiClass) ?? 0) + 1;
    counters.set(piiClass, n);
    return n;
  }

  function classify(hints: PiiTextInput['hints']): { piiClass: PiiClass; fromHint: boolean } {
    const fromInputType = hints?.inputType
      ? INPUT_TYPE_CLASS[hints.inputType as NonNullable<DisplayElement['input_type']>]
      : undefined;
    return fromInputType
      ? { piiClass: fromInputType, fromHint: true }
      : { piiClass: 'other', fromHint: false };
  }

  async function scanText(input: PiiTextInput): Promise<PiiTextResult> {
    const { text, location, evidence, hints } = input;

    if (text === '') {
      return { outcome: 'clear', value: '' };
    }

    const { piiClass, fromHint } = classify(hints);

    // A `value` field is only ever `redacted` (a classified placeholder) when
    // some local signal actually named a class. Without one, this is
    // functionally the same situation D-10 calls "detector unavailable" — no
    // layer examined the content — and the safe move is the same one the
    // protocol's own fixture demonstrates (`text-withheld` in
    // packages/protocol/fixtures/valid.json): `{{TEXT_WITHHELD}}` with
    // `pii_class: 'other'`, not a fabricated class-specific placeholder.
    if (location.kind === 'element_field' && location.field === 'value' && fromHint) {
      const value =
        piiClass === 'secret'
          ? SECRET_PLACEHOLDER
          : classPlaceholder(piiClass, nextIndex(piiClass));
      const finding: PiiFinding = {
        evidence,
        location,
        piiClass,
        detector: 'l1_semantic',
        confidence: 1,
        decision: 'mask',
        synthetic: true,
      };
      return { outcome: 'redacted', value, piiClass, finding };
    }

    const finding: PiiFinding = {
      evidence,
      location,
      piiClass,
      detector: fromHint ? 'l1_semantic' : 'stub',
      confidence: 1,
      decision: 'withhold',
      synthetic: true,
    };
    return { outcome: 'withheld', value: TEXT_WITHHELD, piiClass, finding };
  }

  function evidenceFor(
    src: RawElementCandidate['src'],
    override: EvidenceSource | undefined
  ): EvidenceSource {
    return override ?? (src === 'vision' ? 'ocr' : 'dom_text');
  }

  async function redactElement(candidate: RawElementCandidate): Promise<RedactElementOutcome> {
    if (!candidate.id || !candidate.role) {
      return { outcome: 'withheld', reason: 'missing id or role' };
    }
    if (!isFiniteBox(candidate.bbox)) {
      return { outcome: 'withheld', reason: 'non-finite bbox' };
    }
    if (candidate.hasValue && candidate.rawValue === undefined) {
      throw new InvalidPiiInputError('hasValue is true but rawValue is undefined');
    }

    const nameLocation: FindingLocation = {
      kind: 'element_field',
      elementId: candidate.id,
      field: 'name',
    };
    const nameResult = await scanText({
      evidence: evidenceFor(candidate.src, candidate.nameEvidence),
      text: candidate.rawName,
      location: nameLocation,
    });

    const shared = {
      id: candidate.id,
      role: candidate.role,
      name: nameResult.value,
      bbox: candidate.bbox,
      src: candidate.src,
      conf: candidate.conf,
      // Built with conditional spreads, not `key: candidate.key`, because
      // `exactOptionalPropertyTypes` rejects assigning `undefined` to an
      // optional wire field — the key must be absent, not present-as-undefined.
      ...(candidate.state !== undefined && { state: candidate.state }),
      ...(candidate.inputType !== undefined && { input_type: candidate.inputType }),
      ...(candidate.landmark !== undefined && { landmark: candidate.landmark }),
      ...(candidate.image !== undefined && { image: candidate.image }),
    };

    if (!candidate.hasValue) {
      const element: DisplayElement = shared;
      return { outcome: 'ok', element };
    }

    if (candidate.rawValue === '') {
      const element: EmptyElement = { ...shared, value_state: 'empty', value: '' };
      return { outcome: 'ok', element };
    }

    const valueLocation: FindingLocation = {
      kind: 'element_field',
      elementId: candidate.id,
      field: 'value',
    };
    const valueResult = await scanText({
      evidence: evidenceFor(candidate.src, candidate.valueEvidence),
      text: candidate.rawValue as string,
      location: valueLocation,
      ...(candidate.inputType !== undefined && { hints: { inputType: candidate.inputType } }),
    });

    // Every non-empty value becomes a RedactedElement, whether masked to a
    // classified placeholder or withheld to `{{TEXT_WITHHELD}}` — either way
    // `value_state` is `redacted` and `pii_class` is required by the wire
    // schema. `valueResult.piiClass` is always set here: `scanText` only
    // omits it on the `clear` branch, unreachable for non-empty text.
    const element: Element = {
      ...shared,
      value_state: 'redacted',
      value: valueResult.value,
      pii_class: valueResult.piiClass as PiiClass,
    };
    return { outcome: 'ok', element };
  }

  // `docId` names the observation these entries belong to; it is not part of
  // a text_context finding's location (see `FindingLocation` — `element_field`
  // and `page_field` don't carry it either, since the enclosing Screen State
  // already does), so the stub has nothing to key it against yet.
  async function redactTextContext(
    entries: readonly string[],
    _docId: DocumentId
  ): Promise<RedactedTextContext> {
    const values: string[] = [];
    let withheldCount = 0;

    for (const [index, text] of entries.entries()) {
      const result = await scanText({
        evidence: 'dom_text',
        text,
        location: { kind: 'text_context_entry', index },
      });
      if (result.outcome === 'clear') {
        values.push(result.value);
      } else {
        withheldCount += 1;
      }
    }

    return { values, withheldCount };
  }

  async function redactCrop(input: PiiCropInput): Promise<PiiCropOutcome> {
    const finding: PiiFinding = {
      evidence: 'ocr',
      location: { kind: 'region', docId: input.docId, bbox: input.bbox },
      piiClass: 'other',
      detector: 'stub',
      confidence: 1,
      decision: 'withhold',
      synthetic: true,
    };
    return { outcome: 'withheld', finding };
  }

  return {
    engine: 'stub',
    synthetic: true,
    recognizedClasses: [],
    scanText,
    redactElement,
    redactTextContext,
    redactCrop,
  };
}
