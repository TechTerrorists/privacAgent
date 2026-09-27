import { IBAN_LENGTHS, ibanValid } from '../checksums.js';
import type { L2Candidate } from '../types.js';

const IBAN_START_RE = /(?<![A-Z0-9])[A-Z]{2}\d{2}/gu;

export function findIban(text: string): L2Candidate[] {
  const out: L2Candidate[] = [];
  for (const m of text.matchAll(IBAN_START_RE)) {
    const length = IBAN_LENGTHS[m[0].slice(0, 2)];
    if (length === undefined) continue;
    let end = m.index + 4;
    let compact = m[0];
    while (compact.length < length) {
      // Printed IBANs separate groups of four characters with one space.
      if (compact.length % 4 === 0 && text[end] === ' ') end += 1;
      const ch = text[end];
      if (ch === undefined || !/[A-Z0-9]/u.test(ch)) break;
      compact += ch;
      end += 1;
    }
    if (compact.length !== length || /[A-Z0-9]/u.test(text[end] ?? '') || !ibanValid(compact))
      continue;
    out.push({ ruleId: 'iban', piiClass: 'iban', start: m.index, end, verified: true });
  }
  return out;
}
