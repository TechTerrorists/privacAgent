export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

const VERHOEFF_D: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeffValid(digits: string): boolean {
  let c = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const d = digits.charCodeAt(digits.length - 1 - i) - 48;
    const pRow = VERHOEFF_P[i % 8];
    if (pRow === undefined) return false;
    c = VERHOEFF_D[c]![pRow[d]!]!;
  }
  return c === 0;
}

export const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24,
  AE: 23,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BR: 29,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  DO: 28,
  EE: 20,
  ES: 24,
  FI: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LC: 32,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MR: 27,
  MT: 31,
  MU: 30,
  NL: 18,
  NO: 15,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  SA: 24,
  SC: 31,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  TL: 23,
  TN: 24,
  TR: 26,
  UA: 29,
  VG: 24,
  XK: 20,
};

function mod97(rearranged: string): number {
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i += 1) {
    const ch = rearranged[i]!;
    if (ch >= '0' && ch <= '9') {
      remainder = (remainder * 10 + Number(ch)) % 97;
    } else {
      const value = ch.charCodeAt(0) - 55;
      remainder = (remainder * 100 + value) % 97;
    }
  }
  return remainder;
}

export function ibanValid(compact: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) return false;
  const country = compact.slice(0, 2);
  const expected = IBAN_LENGTHS[country];
  if (expected === undefined || compact.length !== expected) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  return mod97(rearranged) === 1;
}
