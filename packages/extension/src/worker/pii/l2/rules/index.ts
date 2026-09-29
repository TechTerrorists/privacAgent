import { findAadhaar } from './aadhaar.js';
import { findApiKey } from './apiKey.js';
import { findCard } from './card.js';
import { findEmail } from './email.js';
import { findIban } from './iban.js';
import { findIfsc } from './ifsc.js';
import { findJwt } from './jwt.js';
import { findOtp } from './otp.js';
import { findPan } from './pan.js';
import { findPhoneE164, findPhoneIn } from './phone.js';
import { findUpi } from './upi.js';
import type { L2Candidate } from '../types.js';

export {
  findAadhaar,
  findApiKey,
  findCard,
  findEmail,
  findIban,
  findIfsc,
  findJwt,
  findOtp,
  findPan,
  findPhoneE164,
  findPhoneIn,
  findUpi,
};

export const L2_RULES: readonly ((text: string) => readonly L2Candidate[])[] = [
  findEmail,
  findPhoneIn,
  findPhoneE164,
  findCard,
  findAadhaar,
  findPan,
  findIfsc,
  findUpi,
  findIban,
  findOtp,
  findJwt,
  findApiKey,
];
