import type { L2Candidate } from '../types.js';

const OTP_CONTEXT_WINDOW_CHARS = 40;

const OTP_DIGITS_RE = /(?<!\d)\d{4,8}(?!\d)/gu;
const OTP_CONTEXT_RE =
  /\b(?:otp|one[- ]?time (?:password|code|pin)|verification code|passcode|security code)\b/giu;

export function findOtp(text: string): L2Candidate[] {
  const contextRanges: Array<readonly [number, number]> = [];
  for (const m of text.matchAll(OTP_CONTEXT_RE)) {
    contextRanges.push([m.index, m.index + m[0].length]);
  }
  if (contextRanges.length === 0) return [];

  const out: L2Candidate[] = [];
  for (const m of text.matchAll(OTP_DIGITS_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    const nearby = contextRanges.some(
      ([cs, ce]) => cs - OTP_CONTEXT_WINDOW_CHARS <= end && ce + OTP_CONTEXT_WINDOW_CHARS >= start
    );
    if (!nearby) continue;
    out.push({ ruleId: 'otp_context', piiClass: 'secret', start, end, verified: true });
  }
  return out;
}
