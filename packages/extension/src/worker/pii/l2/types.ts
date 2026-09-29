import type { PiiClass } from '@privacagent/protocol';

import type { EvidenceSource, TextSpan } from '../types.js';

export type { TextSpan };

export type L2RuleId =
  | 'email'
  | 'phone_in'
  | 'phone_e164'
  | 'card_luhn'
  | 'aadhaar_verhoeff'
  | 'pan'
  | 'ifsc'
  | 'upi'
  | 'iban'
  | 'otp_context'
  | 'jwt'
  | 'api_key';

export interface L2Candidate {
  readonly ruleId: L2RuleId;
  readonly piiClass: PiiClass;
  readonly start: number;
  readonly end: number;
  readonly verified: boolean;
}

export interface L2Match {
  readonly ruleId: L2RuleId;
  readonly piiClass: PiiClass;
  readonly span: TextSpan;
  readonly verified: boolean;
  readonly evidence: EvidenceSource;
}

export type L2UnavailableReason = 'input_too_large' | 'internal_error';

export type L2ScanResult =
  | { readonly status: 'ok'; readonly matches: readonly L2Match[] }
  | { readonly status: 'unavailable'; readonly reason: L2UnavailableReason };
