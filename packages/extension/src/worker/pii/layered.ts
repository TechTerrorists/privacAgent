import type { PiiClass } from '@privacagent/protocol';

import { classifyFromHints, classPlaceholder, SECRET_PLACEHOLDER, TEXT_WITHHELD } from './stub.js';
import { buildPiiEngine } from './engineBase.js';
import { scanText as l2ScanText } from './l2/scan.js';
import type { L2Match } from './l2/types.js';
import type { PiiEngineApi } from './api.js';
import type { PiiFinding, PiiTextInput, PiiTextResult } from './types.js';

const L2_RECOGNIZED_CLASSES: readonly PiiClass[] = [
  'email',
  'phone',
  'card',
  'aadhaar',
  'pan',
  'ifsc',
  'upi',
  'iban',
  'jwt',
  'api_key',
  'secret',
];

export function createLayeredPiiEngine(): PiiEngineApi {
  const counters = new Map<PiiClass, number>();
  function nextIndex(piiClass: PiiClass): number {
    const n = (counters.get(piiClass) ?? 0) + 1;
    counters.set(piiClass, n);
    return n;
  }

  function bestMatch(matches: readonly L2Match[]): L2Match | undefined {
    return matches[0];
  }

  async function scanText(input: PiiTextInput): Promise<PiiTextResult> {
    const { text, location, evidence, hints } = input;

    if (text === '') {
      return { outcome: 'clear', value: '' };
    }

    const isPasswordValue =
      location.kind === 'element_field' &&
      location.field === 'value' &&
      hints?.inputType === 'password';
    if (isPasswordValue) {
      const finding: PiiFinding = {
        evidence,
        location,
        piiClass: 'secret',
        detector: 'l1_semantic',
        confidence: 1,
        decision: 'mask',
        synthetic: true,
      };
      return { outcome: 'redacted', value: SECRET_PLACEHOLDER, piiClass: 'secret', finding };
    }

    const l2Result = l2ScanText(text, evidence);
    const l2Ran = l2Result.status === 'ok';
    const match = l2Ran ? bestMatch(l2Result.matches) : undefined;

    if (location.kind === 'element_field' && location.field === 'value') {
      if (match) {
        const value =
          match.piiClass === 'secret'
            ? SECRET_PLACEHOLDER
            : classPlaceholder(match.piiClass, nextIndex(match.piiClass));
        const finding: PiiFinding = {
          evidence,
          location,
          piiClass: match.piiClass,
          detector: 'l2_pattern',
          confidence: 1,
          decision: 'mask',
          synthetic: false,
        };
        return { outcome: 'redacted', value, piiClass: match.piiClass, finding };
      }

      const { piiClass, fromHint } = classifyFromHints(hints);
      if (fromHint) {
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
        detector: 'stub',
        confidence: 1,
        decision: 'withhold',
        synthetic: true,
      };
      return { outcome: 'withheld', value: TEXT_WITHHELD, piiClass, finding };
    }

    const piiClass = match?.piiClass ?? 'other';
    const finding: PiiFinding = {
      evidence,
      location,
      piiClass,
      detector: l2Ran ? 'l2_pattern' : 'stub',
      confidence: 1,
      decision: 'withhold',
      synthetic: !l2Ran,
    };
    return { outcome: 'withheld', value: TEXT_WITHHELD, piiClass, finding };
  }

  return buildPiiEngine({
    engine: 'layered',
    synthetic: false,
    recognizedClasses: L2_RECOGNIZED_CLASSES,
    scanText,
  });
}
