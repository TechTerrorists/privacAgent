import type { L2RuleId } from './types.js';

export interface ExpectedMatch {
  readonly ruleId: L2RuleId;
  readonly start: number;
  readonly end: number;
}

export interface L2Fixture {
  readonly id: string;
  readonly text: string;
  readonly expected: readonly ExpectedMatch[];
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function positive(
  prefix: string,
  ruleId: L2RuleId,
  value: string,
  before: string,
  after: string
): L2Fixture {
  const text = `${before}${value}${after}`;
  return {
    id: nextId(prefix),
    text,
    expected: [{ ruleId, start: before.length, end: before.length + value.length }],
  };
}

function negative(prefix: string, text: string): L2Fixture {
  return { id: nextId(prefix), text, expected: [] };
}

function multi(prefix: string, text: string, expected: readonly ExpectedMatch[]): L2Fixture {
  return { id: nextId(prefix), text, expected };
}

function at(ruleId: L2RuleId, before: string, value: string): ExpectedMatch {
  return { ruleId, start: before.length, end: before.length + value.length };
}

const EN_BEFORE = [
  'Please reach out at ',
  'Contact: ',
  'For support, email ',
  'My details: ',
  'Reference — ',
];
const EN_AFTER = [' for follow-up.', ', thanks.', ' (verified).', '.', ' as discussed.'];
const HI_BEFORE = ['कृपया संपर्क करें ', 'यह जानकारी दी गई है: ', 'नमस्ते, विवरण — '];
const HI_AFTER = [' धन्यवाद।', ', कृपया देखें।', ' के लिए।'];
const PUNCT_BEFORE = ['("', '[', '{value: ', '"', '«'];
const PUNCT_AFTER = ['")', ']', '}', '"', '»'];
const NON_BMP_BEFORE = ['🔒 secure: ', '📧 '];
const NON_BMP_AFTER = [' ✅', ' 👍'];
const LINE_BREAK_BEFORE = ['Line one.\nLine two: ', 'Header\r\n\r\nBody: '];
const LINE_BREAK_AFTER = ['\nNext line.', '\r\nFooter.'];

function contextFixtures(prefix: string, ruleId: L2RuleId, value: string): L2Fixture[] {
  const out: L2Fixture[] = [];
  EN_BEFORE.forEach((b, i) =>
    out.push(positive(prefix, ruleId, value, b, EN_AFTER[i % EN_AFTER.length]!))
  );
  HI_BEFORE.forEach((b, i) =>
    out.push(positive(prefix, ruleId, value, b, HI_AFTER[i % HI_AFTER.length]!))
  );
  PUNCT_BEFORE.forEach((b, i) => out.push(positive(prefix, ruleId, value, b, PUNCT_AFTER[i]!)));
  NON_BMP_BEFORE.forEach((b, i) => out.push(positive(prefix, ruleId, value, b, NON_BMP_AFTER[i]!)));
  LINE_BREAK_BEFORE.forEach((b, i) =>
    out.push(positive(prefix, ruleId, value, b, LINE_BREAK_AFTER[i]!))
  );
  return out;
}

const emailFixtures: L2Fixture[] = [
  ...contextFixtures('email', 'email', 'canary.person+test@example.test'),
  ...contextFixtures('email', 'email', 'a1@sub.example.co.in'),
  positive('email', 'email', "o'brien.canary@example.test", 'Name: ', ' registered.'),
  negative('email', 'plainaddress'),
  negative('email', '@missinglocal.test'),
  negative('email', 'missing-domain@'),
  negative('email', 'no-tld@localhost'),
  negative('email', 'spaced @example.test'),
  negative('email', 'canary [at] example [dot] test'),
];

const phoneInValues = [
  '9812345670',
  '+919812345670',
  '+91 9812345670',
  '09812345670',
  '7000011122',
];
const phoneInFixtures: L2Fixture[] = [
  ...phoneInValues.flatMap((v) => contextFixtures('phone_in', 'phone_in', v).slice(0, 4)),
  negative('phone_in', 'call 981234567 now'),
  negative('phone_in', 'call 98123456701 now'),
  negative('phone_in', 'call 5812345670 now'),
  negative('phone_in', 'order 12345 of 9812345670123 units'),
];

const phoneE164Values = ['+442071838750', '+14155552671', '+8613800138000', '+61491570156'];
const phoneE164Fixtures: L2Fixture[] = [
  ...phoneE164Values.flatMap((v) => contextFixtures('phone_e164', 'phone_e164', v).slice(0, 4)),
  negative('phone_e164', 'call +1234567 now'),
  negative('phone_e164', 'call 4155552671 now'),
  multi('phone_e164', 'India office: +919812345670 direct line', [
    at('phone_in', 'India office: ', '+919812345670'),
  ]),
];

const validCards = ['4111111111111111', '5512345678901231', '3400000000000000', '6011111111111117'];
const cardFixtures: L2Fixture[] = [
  ...validCards.flatMap((v) => contextFixtures('card', 'card_luhn', v).slice(0, 4)),
  positive('card', 'card_luhn', '4111 1111 1111 1111', 'Card on file: ', '.'),
  positive('card', 'card_luhn', '4111-1111-1111-1111', 'Card on file: ', '.'),
  positive('card', 'card_luhn', '4000000000006', 'Test card (13 digits): ', ' processed.'),
  positive('card', 'card_luhn', '601111111111111114', 'Long card: ', ' on file.'),
  negative('card', 'invalid card 4111111111111112 on file'),
  negative('card', 'invalid card 4111 1111 1111 1112 on file'),
  negative('card', 'short number 41111111111 here'),
  negative('card', 'we said "order code" but the number 4111111111111112 fails Luhn'),
  negative('card', 'a 20-digit run 12345678901234567890 exceeds the plausible length range'),
];

const validAadhaar = ['234123412346', '876543210988', '555666777881', '299887766553'];
const aadhaarFixtures: L2Fixture[] = [
  ...validAadhaar.flatMap((v) => contextFixtures('aadhaar', 'aadhaar_verhoeff', v).slice(0, 4)),
  negative('aadhaar', 'my aadhaar number is 234123412340'),
  negative('aadhaar', 'my aadhaar number is 123412341234'),
  negative('aadhaar', 'my aadhaar number is 023412341234'),
  negative('aadhaar', 'too short aadhaar 23412341234'),
  negative('aadhaar', 'they called it "aadhaar" but wrote 234123412340'),
];

const validPan = ['ABCDE1234F', 'ZQXWR9081K', 'HOLDR5566T', 'CANRY7890P', 'MJKLN4455Q'];
const panFixtures: L2Fixture[] = [
  ...validPan.flatMap((v) => contextFixtures('pan', 'pan', v).slice(0, 5)),
  negative('pan', 'PAN abcde1234f is lowercase'),
  negative('pan', 'PAN ABCD1234FG is wrong shape'),
  negative('pan', 'PAN ABCDE12345 has one too many digits'),
  negative('pan', 'PAN ABCDEF234F has six letters up front'),
];

const validIfsc = [
  'HDFC0001234',
  'SBIN0005678',
  'ICIC0009012',
  'UTIB0000345',
  'KKBK0CANARY',
  'PUNB0567890',
];
const ifscFixtures: L2Fixture[] = [
  ...validIfsc.flatMap((v) => contextFixtures('ifsc', 'ifsc', v).slice(0, 5)),
  negative('ifsc', 'code hdfc0001234 is lowercase'),
  negative('ifsc', 'code HDFC1001234 has no 0 in position 5'),
  negative('ifsc', 'code HDF0001234 has only 3 bank letters'),
  negative('ifsc', 'code HDFC000123 is one digit short'),
];

const validUpi = [
  'canary.user@ybl',
  'test_pay@oksbi',
  'shop.owner@paytm',
  'rider99@okhdfcbank',
  'canary-driver@apl',
  'merchant_1@axl',
];
const upiFixtures: L2Fixture[] = [
  ...validUpi.flatMap((v) => contextFixtures('upi', 'upi', v).slice(0, 5)),
  negative('upi', 'pay to user@randombank now'),
  multi('upi', 'pay to user@ybl.co.in now', [at('email', 'pay to ', 'user@ybl.co.in')]),
  negative('upi', 'pay to @ybl now'),
];

const validIban = [
  'DE89370400440532013000',
  'GB29NWBK60161331926819',
  'FR1420041010050500013M02606',
  'NL91ABNA0417164300',
  'BE68539007547034',
  'ES9121000418450200051332',
];
const validIbanSpaced = ['DE89 3704 0044 0532 0130 00', 'GB29 NWBK 6016 1331 9268 19'];
const ibanFixtures: L2Fixture[] = [
  ...validIban.flatMap((v) => contextFixtures('iban', 'iban', v).slice(0, 4)),
  ...validIbanSpaced.map((v) => positive('iban', 'iban', v, 'IBAN: ', ' for transfer.')),
  negative('iban', 'IBAN DE00370400440532013000 is wrong'),
  negative('iban', 'IBAN XX89370400440532013000 unknown country'),
  negative('iban', 'IBAN DE893704004405320130 is too short'),
];

const otpContextPhrases = [
  ['Your OTP is ', ', do not share it.'],
  ['One-time password: ', ' expires in 5 minutes.'],
  ['Use verification code ', ' to continue.'],
  ['Your passcode is ', ' — enter it now.'],
  ['Security code ', ' was just sent to you.'],
] as const;
const otpValues = ['482913', '0451', '77002211', '390847'];
const otpFixtures: L2Fixture[] = [
  ...otpContextPhrases.flatMap(([before, after], i) =>
    positive('otp', 'otp_context', otpValues[i % otpValues.length]!, before, after)
  ),
  positive('otp', 'otp_context', '1234', 'कृपया OTP दर्ज करें: ', ' और जारी रखें।'),
  positive('otp', 'otp_context', '556677', 'security code (', ') — enter within 5 minutes.'),
  positive('otp', 'otp_context', '8899', 'one time code: "', '" confirmed.'),
  negative('otp', 'Order number 482913 confirmed'),
  negative('otp', 'Your OTP was sent earlier.' + ' '.repeat(60) + '482913 is unrelated'),
  negative('otp', 'Invoice total: 4829'),
  negative('otp', 'The year 2023 and the count 481200 are just numbers'),
  negative('otp', 'तारीख 20230415 है'),
];

function b64url(obj: unknown): string {
  const base64 = btoa(JSON.stringify(obj));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const jwtValues = [
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'canary1', iat: 1 })}.CANARYSIGNATUREONEXXXXXXXXXXXXX`,
  `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ sub: 'canary2', role: 'user' })}.CANARYSIGNATURETWOXXXXXXXXXXXXX`,
  `${b64url({ alg: 'ES256' })}.${b64url({ exp: 999999999 })}.CANARYSIGNATURETHREEXXXXXXXXXXX`,
];
const jwtFixtures: L2Fixture[] = [
  ...jwtValues.flatMap((v) => contextFixtures('jwt', 'jwt', v).slice(0, 4)),
  positive('jwt', 'jwt', jwtValues[0]!, 'नमस्ते, टोकन: ', ' समाप्त हो चुका है।'),
  negative('jwt', 'not.a.jwt.token.at.all.since.header.is.not.json'),
  negative('jwt', `${b64url({ alg: 'HS256' })}.onlytwosegments`),
  negative('jwt', 'aGVsbG8.d29ybGQ.c2hvcnQ'),
];

const apiKeyValues = [
  'sk-CANARY1234567890ABCDEFGHIJ',
  'AKIACANARY0123456789',
  'AIzaCANARY12345678901234567890123456789',
  'ghp_CANARY0123456789ABCDEFGHIJ0123456789',
  'xoxb-CANARY-0123456789-ABCDEFGHIJKLMN',
];
const apiKeyFixtures: L2Fixture[] = [
  ...apiKeyValues.flatMap((v) => contextFixtures('apikey', 'api_key', v).slice(0, 4)),
  positive('apikey', 'api_key', apiKeyValues[0]!, 'गुप्त कुंजी: ', ' का उपयोग न करें।'),
  negative('apikey', 'sk-tooshort'),
  negative('apikey', 'AKIA' + '1'.repeat(10)),
  negative('apikey', 'a random string that is not sk- or AKIA prefixed at all'),
  negative('apikey', 'internal token: 7f3a9c21e8b6445dabf209914c7e5a01'),
];

const overlapFixtures: L2Fixture[] = [
  multi('overlap', 'Email canary.user@example.test or call +919812345670 for support.', [
    at('email', 'Email ', 'canary.user@example.test'),
    at('phone_in', 'Email canary.user@example.test or call ', '+919812345670'),
  ]),
  multi('overlap', 'Card 4111111111111111 and Aadhaar 234123412346 on file.', [
    at('card_luhn', 'Card ', '4111111111111111'),
    at('aadhaar_verhoeff', 'Card 4111111111111111 and Aadhaar ', '234123412346'),
  ]),
  multi('overlap', 'Reach me on +919812345670 anytime.', [
    at('phone_in', 'Reach me on ', '+919812345670'),
  ]),
  multi('overlap', 'IFSC HDFC0001234 and UPI canary.user@ybl for the same payee.', [
    at('ifsc', 'IFSC ', 'HDFC0001234'),
    at('upi', 'IFSC HDFC0001234 and UPI ', 'canary.user@ybl'),
  ]),
  negative(
    'overlap',
    'A phone-shaped fragment 9812345670123456 that is actually a 16-digit non-Luhn card fragment'
  ),
  multi('overlap', 'canary.user@example.test', [at('email', '', 'canary.user@example.test')]),
  multi('overlap', 'contact us at canary.user@example.test', [
    at('email', 'contact us at ', 'canary.user@example.test'),
  ]),
];

const unicodeFixtures: L2Fixture[] = [
  multi('unicode', '🔥canary.user@example.test🔥', [at('email', '🔥', 'canary.user@example.test')]),
  multi('unicode', '📱+919812345670📱', [at('phone_in', '📱', '+919812345670')]),
  multi('unicode', 'संपर्कcanary.user@example.testधन्यवाद', [
    at('email', 'संपर्क', 'canary.user@example.test'),
  ]),
  multi('unicode', 'Card: 4111111111111111\r\nAadhaar: 234123412346', [
    at('card_luhn', 'Card: ', '4111111111111111'),
    at('aadhaar_verhoeff', 'Card: 4111111111111111\r\nAadhaar: ', '234123412346'),
  ]),
  multi('unicode', '🇮🇳 +919812345670', [at('phone_in', '🇮🇳 ', '+919812345670')]),
];

const adversarialFixtures: L2Fixture[] = [
  positive(
    'adversarial',
    'email',
    'canary.needle@example.test',
    'x'.repeat(4000) + ' ',
    ' ' + 'y'.repeat(4000)
  ),
  negative('adversarial', '@'.repeat(2000)),
  negative('adversarial', '1'.repeat(2000)),
  negative('adversarial', 'a@'.repeat(1000)),
  negative('adversarial', ('OTP ' + '9'.repeat(3) + ' ').repeat(500)),
];

export const L2_FIXTURES: readonly L2Fixture[] = [
  ...emailFixtures,
  ...phoneInFixtures,
  ...phoneE164Fixtures,
  ...cardFixtures,
  ...aadhaarFixtures,
  ...panFixtures,
  ...ifscFixtures,
  ...upiFixtures,
  ...ibanFixtures,
  ...otpFixtures,
  ...jwtFixtures,
  ...apiKeyFixtures,
  ...overlapFixtures,
  ...unicodeFixtures,
  ...adversarialFixtures,
];
