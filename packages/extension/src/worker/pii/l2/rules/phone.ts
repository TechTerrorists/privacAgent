import type { L2Candidate } from '../types.js';

const PHONE_IN_RE = /(?<!\d)(?:\+91[\s-]?|0)?[6-9]\d{9}(?!\d)/gu;

const PHONE_E164_RE = /(?<!\d)\+[1-9]\d{7,14}(?!\d)/gu;

export function findPhoneIn(text: string): L2Candidate[] {
  const out: L2Candidate[] = [];
  for (const m of text.matchAll(PHONE_IN_RE)) {
    out.push({
      ruleId: 'phone_in',
      piiClass: 'phone',
      start: m.index,
      end: m.index + m[0].length,
      verified: true,
    });
  }
  return out;
}

export function findPhoneE164(text: string): L2Candidate[] {
  const out: L2Candidate[] = [];
  for (const m of text.matchAll(PHONE_E164_RE)) {
    out.push({
      ruleId: 'phone_e164',
      piiClass: 'phone',
      start: m.index,
      end: m.index + m[0].length,
      verified: true,
    });
  }
  return out;
}
