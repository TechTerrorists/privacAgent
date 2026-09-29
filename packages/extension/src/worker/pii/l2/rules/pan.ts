import type { L2Candidate } from '../types.js';

const PAN_RE = /(?<![A-Z0-9])[A-Z]{5}\d{4}[A-Z](?![A-Z0-9])/gu;

export function findPan(text: string): L2Candidate[] {
  const out: L2Candidate[] = [];
  for (const m of text.matchAll(PAN_RE)) {
    out.push({
      ruleId: 'pan',
      piiClass: 'pan',
      start: m.index,
      end: m.index + m[0].length,
      verified: true,
    });
  }
  return out;
}
