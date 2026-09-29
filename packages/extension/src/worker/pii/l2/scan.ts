import type { EvidenceSource } from '../types.js';
import { L2_RULES } from './rules/index.js';
import type { L2Candidate, L2Match, L2RuleId, L2ScanResult } from './types.js';

export const MAX_L2_INPUT_LENGTH = 20_000;

const RULE_PRIORITY: readonly L2RuleId[] = [
  'iban',
  'card_luhn',
  'aadhaar_verhoeff',
  'jwt',
  'pan',
  'ifsc',
  'email',
  'upi',
  'api_key',
  'phone_in',
  'phone_e164',
  'otp_context',
];
const PRIORITY_RANK: ReadonlyMap<L2RuleId, number> = new Map(
  RULE_PRIORITY.map((id, index) => [id, index])
);

function mergeOverlaps(candidates: readonly L2Candidate[]): L2Candidate[] {
  const sorted = [...candidates].sort((a, b) => {
    const rankA = PRIORITY_RANK.get(a.ruleId) ?? RULE_PRIORITY.length;
    const rankB = PRIORITY_RANK.get(b.ruleId) ?? RULE_PRIORITY.length;
    if (rankA !== rankB) return rankA - rankB;
    const lengthA = a.end - a.start;
    const lengthB = b.end - b.start;
    if (lengthA !== lengthB) return lengthB - lengthA;
    return a.start - b.start;
  });

  const kept: L2Candidate[] = [];
  for (const candidate of sorted) {
    // Only equivalent findings may be coalesced. Different classes or spans
    // remain independent evidence, even when one contains the other.
    const duplicate = kept.some(
      (existing) =>
        existing.start === candidate.start &&
        existing.end === candidate.end &&
        existing.piiClass === candidate.piiClass
    );
    if (!duplicate) kept.push(candidate);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export function scanText(text: string, evidence: EvidenceSource): L2ScanResult {
  if (text.length > MAX_L2_INPUT_LENGTH) {
    return { status: 'unavailable', reason: 'input_too_large' };
  }

  let candidates: L2Candidate[];
  try {
    candidates = L2_RULES.flatMap((rule) => rule(text));
  } catch {
    return { status: 'unavailable', reason: 'internal_error' };
  }

  const matches: L2Match[] = mergeOverlaps(candidates).map((candidate) => ({
    ruleId: candidate.ruleId,
    piiClass: candidate.piiClass,
    verified: candidate.verified,
    span: { start: candidate.start, end: candidate.end },
    evidence,
  }));

  return { status: 'ok', matches };
}
