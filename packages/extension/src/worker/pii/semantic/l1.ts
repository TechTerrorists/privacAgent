import type { DisplayElement, PiiClass } from '@privacagent/protocol';

import type { TextEvidenceHints } from '../types.js';
import { classifyAutocompleteToken, classifyLabelKeywords } from './keywords.js';

const INPUT_TYPE_CLASS: Partial<Record<NonNullable<DisplayElement['input_type']>, PiiClass>> = {
  email: 'email',
  tel: 'phone',
  password: 'secret',
};

export interface L1Classification {
  readonly piiClass: PiiClass;
  readonly confidence: number;
  readonly rule: string;
  readonly matched: boolean;
}

const UNMATCHED: L1Classification = {
  piiClass: 'other',
  confidence: 0,
  rule: 'none',
  matched: false,
};

export function classifySemanticEvidence(hints: TextEvidenceHints | undefined): L1Classification {
  const inputType = hints?.inputType;
  if (inputType) {
    const fromInputType = INPUT_TYPE_CLASS[inputType as NonNullable<DisplayElement['input_type']>];
    if (fromInputType) {
      return {
        piiClass: fromInputType,
        confidence: 1,
        rule: `input_type:${inputType}`,
        matched: true,
      };
    }
  }

  if (hints?.autocomplete) {
    const fromAutocomplete = classifyAutocompleteToken(hints.autocomplete);
    if (fromAutocomplete) {
      const tokens = hints.autocomplete.trim().toLowerCase().split(/\s+/);
      const lastToken = tokens[tokens.length - 1];
      return {
        piiClass: fromAutocomplete,
        confidence: 0.9,
        rule: `autocomplete:${lastToken}`,
        matched: true,
      };
    }
  }

  if (hints?.labelKeywords && hints.labelKeywords.length > 0) {
    const fromLabel = classifyLabelKeywords(hints.labelKeywords);
    if (fromLabel) {
      return {
        piiClass: fromLabel.piiClass,
        confidence: 0.6,
        rule: `label_keyword:${fromLabel.keyword}`,
        matched: true,
      };
    }
  }

  return UNMATCHED;
}
