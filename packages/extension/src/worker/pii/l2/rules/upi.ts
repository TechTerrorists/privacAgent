import type { L2Candidate } from '../types.js';

const UPI_HANDLES = [
  'okhdfcbank',
  'oksbi',
  'okicici',
  'okaxis',
  'okbizaxis',
  'ybl',
  'paytm',
  'apl',
  'ibl',
  'axl',
  'upi',
  'sbi',
  'hdfcbank',
  'icici',
  'axisbank',
  'freecharge',
  'airtel',
  'jio',
  'idfcbank',
  'kotak',
  'pnb',
  'unionbank',
] as const;

const UPI_RE = new RegExp(
  `(?<![\\w.])[a-zA-Z0-9.\\-_]{2,100}@(?:${UPI_HANDLES.join('|')})(?![\\w])`,
  'gu'
);

export function findUpi(text: string): L2Candidate[] {
  const out: L2Candidate[] = [];
  for (const m of text.matchAll(UPI_RE)) {
    out.push({
      ruleId: 'upi',
      piiClass: 'upi',
      start: m.index,
      end: m.index + m[0].length,
      verified: true,
    });
  }
  return out;
}
