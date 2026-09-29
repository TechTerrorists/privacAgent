import type { DisplayElement, PiiClass } from '@privacagent/protocol';

import { buildPiiEngine } from './engineBase.js';
import type { PiiEngineApi } from './api.js';
import type { PiiFinding, PiiTextInput, PiiTextResult } from './types.js';

const INPUT_TYPE_CLASS: Partial<Record<NonNullable<DisplayElement['input_type']>, PiiClass>> = {
  email: 'email',
  tel: 'phone',
  password: 'secret',
};

export const TEXT_WITHHELD = '{{TEXT_WITHHELD}}';
export const SECRET_PLACEHOLDER = '{{SECRET}}';

export function classPlaceholder(piiClass: PiiClass, n: number): string {
  return `{{${piiClass.toUpperCase()}_${n}}}`;
}

export function classifyFromHints(hints: PiiTextInput['hints']): {
  piiClass: PiiClass;
  fromHint: boolean;
} {
  const fromInputType = hints?.inputType
    ? INPUT_TYPE_CLASS[hints.inputType as NonNullable<DisplayElement['input_type']>]
    : undefined;
  return fromInputType
    ? { piiClass: fromInputType, fromHint: true }
    : { piiClass: 'other', fromHint: false };
}

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

    const { piiClass, fromHint } = classifyFromHints(hints);

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

  return buildPiiEngine({ engine: 'stub', synthetic: true, recognizedClasses: [], scanText });
}
