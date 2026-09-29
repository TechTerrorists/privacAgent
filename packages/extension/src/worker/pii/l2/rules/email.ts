import type { L2Candidate } from '../types.js';

const EMAIL_RE =
  /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/gu;

export function findEmail(text: string): L2Candidate[] {
  const out: L2Candidate[] = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    out.push({
      ruleId: 'email',
      piiClass: 'email',
      start: m.index,
      end: m.index + m[0].length,
      verified: true,
    });
  }
  return out;
}
