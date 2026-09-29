import type { L2Candidate } from '../types.js';

const JWT_RE = /(?<![\w-])[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![\w-])/gu;

function looksLikeJwtHeader(segment: string): boolean {
  try {
    const padLength = (4 - (segment.length % 4)) % 4;
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLength);
    const decoded: unknown = JSON.parse(atob(base64));
    return (
      typeof decoded === 'object' &&
      decoded !== null &&
      'alg' in decoded &&
      typeof (decoded as { alg: unknown }).alg === 'string'
    );
  } catch {
    return false;
  }
}

export function findJwt(text: string): L2Candidate[] {
  const out: L2Candidate[] = [];
  for (const m of text.matchAll(JWT_RE)) {
    const [header] = m[0].split('.');
    if (!header || !looksLikeJwtHeader(header)) continue;
    out.push({
      ruleId: 'jwt',
      piiClass: 'jwt',
      start: m.index,
      end: m.index + m[0].length,
      verified: true,
    });
  }
  return out;
}
