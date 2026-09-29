import { ibanValid } from '../checksums.js';
import type { L2Candidate } from '../types.js';

const IBAN_CANDIDATE_RE =
  /(?<![A-Z0-9])[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,8}(?:[ ]?[A-Z0-9]{1,3})?(?![A-Z0-9])/gu;

export function findIban(text: string): L2Candidate[] {
  const out: L2Candidate[] = [];
  for (const m of text.matchAll(IBAN_CANDIDATE_RE)) {
    const raw = m[0];
    const compact = raw.replace(/ /g, '');
    if (!ibanValid(compact)) continue;
    out.push({
      ruleId: 'iban',
      piiClass: 'iban',
      start: m.index,
      end: m.index + raw.length,
      verified: true,
    });
  }
  return out;
}
