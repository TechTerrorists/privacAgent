import type { PiiClass } from '@privacagent/protocol';

export const AUTOCOMPLETE_TOKEN_CLASS: Readonly<Record<string, PiiClass>> = {
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  'tel-local': 'phone',
  'tel-country-code': 'phone',
  name: 'name',
  'given-name': 'name',
  'family-name': 'name',
  'additional-name': 'name',
  'honorific-prefix': 'name',
  'honorific-suffix': 'name',
  'street-address': 'address',
  'address-line1': 'address',
  'address-line2': 'address',
  'address-line3': 'address',
  'address-level1': 'address',
  'address-level2': 'address',
  'postal-code': 'address',
  country: 'address',
  'country-name': 'address',
  bday: 'dob',
  'bday-day': 'dob',
  'bday-month': 'dob',
  'bday-year': 'dob',
  organization: 'organization',
  'cc-number': 'card',
  'current-password': 'secret',
  'new-password': 'secret',
};

export function classifyAutocompleteToken(value: string): PiiClass | undefined {
  const tokens = value.trim().toLowerCase().split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (!last) return undefined;
  return AUTOCOMPLETE_TOKEN_CLASS[last];
}

interface LabelClassEntry {
  readonly piiClass: PiiClass;
  readonly keywords: readonly string[];
}

export const LABEL_KEYWORD_CLASSES: readonly LabelClassEntry[] = [
  {
    piiClass: 'secret',
    keywords: ['password', 'pin', 'otp', 'secret', 'passcode', 'गुप्त', 'पासवर्ड'],
  },
  { piiClass: 'email', keywords: ['email', 'e-mail', 'mail', 'ईमेल', 'इमेल'] },
  {
    piiClass: 'phone',
    keywords: ['phone', 'mobile', 'telephone', 'contact number', 'फोन', 'मोबाइल', 'संपर्क'],
  },
  {
    piiClass: 'dob',
    keywords: ['dob', 'date of birth', 'birthdate', 'birthday', 'जन्म तिथि', 'जन्मतिथि'],
  },
  {
    piiClass: 'address',
    keywords: ['address', 'street', 'city', 'postal', 'zip', 'pincode', 'पता', 'शहर', 'पिनकोड'],
  },
  {
    piiClass: 'organization',
    keywords: ['organization', 'organisation', 'company', 'employer', 'संगठन', 'कंपनी'],
  },
  { piiClass: 'name', keywords: ['name', 'full name', 'first name', 'last name', 'नाम'] },
  { piiClass: 'location', keywords: ['location', 'place', 'region', 'स्थान', 'क्षेत्र'] },
];

export interface LabelKeywordMatch {
  readonly piiClass: PiiClass;
  readonly keyword: string;
}

export function classifyLabelKeywords(
  labelKeywords: readonly string[]
): LabelKeywordMatch | undefined {
  const normalized = labelKeywords.map((keyword) => keyword.trim().toLowerCase());
  for (const entry of LABEL_KEYWORD_CLASSES) {
    for (const keyword of entry.keywords) {
      if (normalized.includes(keyword)) {
        return { piiClass: entry.piiClass, keyword };
      }
    }
  }
  return undefined;
}
