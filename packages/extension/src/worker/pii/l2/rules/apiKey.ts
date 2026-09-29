import type { L2Candidate } from '../types.js';

const PATTERNS: readonly RegExp[] = [
  /(?<![\w-])sk-[A-Za-z0-9]{20,}(?![\w-])/gu,
  /(?<![\w-])AKIA[0-9A-Z]{16}(?![\w-])/gu,
  /(?<![\w-])AIza[0-9A-Za-z_-]{35}(?![\w-])/gu,
  /(?<![\w-])gh[pousr]_[A-Za-z0-9]{36,}(?![\w-])/gu,
  /(?<![\w-])xox[baprs]-[A-Za-z0-9-]{10,}(?![\w-])/gu,
];

export function findApiKey(text: string): L2Candidate[] {
  const out: L2Candidate[] = [];
  for (const pattern of PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      out.push({
        ruleId: 'api_key',
        piiClass: 'api_key',
        start: m.index,
        end: m.index + m[0].length,
        verified: true,
      });
    }
  }
  return out;
}
