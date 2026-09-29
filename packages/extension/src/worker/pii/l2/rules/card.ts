import { luhnValid } from '../checksums.js';
import type { L2Candidate } from '../types.js';

const CARD_CANDIDATE_RE = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/gu;

export function findCard(text: string): L2Candidate[] {
  const out: L2Candidate[] = [];
  for (const m of text.matchAll(CARD_CANDIDATE_RE)) {
    const raw = m[0];
    const digits = raw.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (!luhnValid(digits)) continue;
    out.push({
      ruleId: 'card_luhn',
      piiClass: 'card',
      start: m.index,
      end: m.index + raw.length,
      verified: true,
    });
  }
  return out;
}
