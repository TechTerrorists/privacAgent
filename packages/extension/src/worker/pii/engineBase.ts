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
  PiiEngineName,
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

function isFiniteBox(bbox: readonly number[]): boolean {
  return bbox.length === 4 && bbox.every((n) => Number.isFinite(n));
}

export interface EngineBaseDeps {
  readonly engine: PiiEngineName;
  readonly synthetic: boolean;
  readonly recognizedClasses: readonly PiiClass[];
  readonly scanText: (input: PiiTextInput) => Promise<PiiTextResult>;
}

export function buildPiiEngine(deps: EngineBaseDeps): PiiEngineApi {
  const { scanText } = deps;

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

    const element: Element = {
      ...shared,
      value_state: 'redacted',
      value: valueResult.value,
      pii_class: valueResult.piiClass as PiiClass,
    };
    return { outcome: 'ok', element };
  }

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
    engine: deps.engine,
    synthetic: deps.synthetic,
    recognizedClasses: deps.recognizedClasses,
    scanText,
    redactElement,
    redactTextContext,
    redactCrop,
  };
}
