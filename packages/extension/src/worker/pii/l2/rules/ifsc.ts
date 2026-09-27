import type { L2Candidate } from '../types.js';

const IFSC_RE = /(?<![A-Z0-9])[A-Z]{4}0[A-Z0-9]{6}(?![A-Z0-9])/gu;

export function findIfsc(text: string): L2Candidate[] {
  const out: L2Candidate[] = [];
  for (const m of text.matchAll(IFSC_RE)) {
    out.push({
      ruleId: 'ifsc',
      piiClass: 'ifsc',
      start: m.index,
      end: m.index + m[0].length,
      verified: true,
    });
  }
  return out;
}
