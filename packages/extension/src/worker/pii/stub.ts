import type { PiiClass } from '@privacagent/protocol';

import { buildPiiEngine } from './engineBase.js';
import { classifySemanticEvidence } from './semantic/l1.js';
import type { PiiEngineApi } from './api.js';
import type { PiiFinding, PiiTextInput, PiiTextResult } from './types.js';

export const TEXT_WITHHELD = '{{TEXT_WITHHELD}}';
export const SECRET_PLACEHOLDER = '{{SECRET}}';

export function classPlaceholder(piiClass: PiiClass, n: number): string {
  return `{{${piiClass.toUpperCase()}_${n}}}`;
}

export { classifySemanticEvidence } from './semantic/l1.js';

export function createStubPiiEngine(): PiiEngineApi {
  const counters = new Map<PiiClass, number>();
  function nextIndex(piiClass: PiiClass): number {
    const n = (counters.get(piiClass) ?? 0) + 1;
    counters.set(piiClass, n);
    return n;
  }

  async function scanText(input: PiiTextInput): Promise<PiiTextResult> {
    const { text, location, evidence, hints } = input;

    if (text === '') {
      return { outcome: 'clear', value: '' };
    }

    const classification = classifySemanticEvidence(hints);
    const { piiClass, matched, confidence, rule } = classification;

    if (location.kind === 'element_field' && location.field === 'value' && matched) {
      const value =
        piiClass === 'secret'
          ? SECRET_PLACEHOLDER
          : classPlaceholder(piiClass, nextIndex(piiClass));
      const finding: PiiFinding = {
        evidence,
        location,
        piiClass,
        detector: 'l1_semantic',
        confidence,
        decision: 'mask',
        synthetic: true,
        rule,
      };
      return { outcome: 'redacted', value, piiClass, finding };
    }

    const finding: PiiFinding = {
      evidence,
      location,
      piiClass,
      detector: matched ? 'l1_semantic' : 'stub',
      confidence: matched ? confidence : 1,
      decision: 'withhold',
      synthetic: true,
      rule,
    };
    return { outcome: 'withheld', value: TEXT_WITHHELD, piiClass, finding };
  }

  return buildPiiEngine({ engine: 'stub', synthetic: true, recognizedClasses: [], scanText });
}
