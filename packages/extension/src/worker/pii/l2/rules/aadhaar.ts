import { verhoeffValid } from '../checksums.js';
import type { L2Candidate } from '../types.js';

const AADHAAR_RE = /(?<!\d)[2-9]\d{11}(?!\d)/gu;

export function findAadhaar(text: string): L2Candidate[] {
  const out: L2Candidate[] = [];
  for (const m of text.matchAll(AADHAAR_RE)) {
    const digits = m[0];
    if (!verhoeffValid(digits)) continue;
    out.push({
      ruleId: 'aadhaar_verhoeff',
      piiClass: 'aadhaar',
      start: m.index,
      end: m.index + digits.length,
      verified: true,
    });
  }
  return out;
}
