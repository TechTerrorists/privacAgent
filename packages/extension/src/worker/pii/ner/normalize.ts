export interface NormalizedText {
  readonly text: string;
  readonly toOriginal: readonly (readonly [number, number])[];
}

const CHINESE_RANGES: readonly (readonly [number, number])[] = [
  [0x4e00, 0x9fff],
  [0x3400, 0x4dbf],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2b73f],
  [0x2b740, 0x2b81f],
  [0x2b820, 0x2ceaf],
  [0xf900, 0xfaff],
  [0x2f800, 0x2fa1f],
];

function isChineseCodePoint(cp: number): boolean {
  return CHINESE_RANGES.some(([start, end]) => cp >= start && cp <= end);
}

function isControlCodePoint(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  const category = codePointGeneralCategory(cp);
  return category === 'Cc' || category === 'Cf';
}

function isWhitespaceCodePoint(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x20) return true;
  return codePointGeneralCategory(cp) === 'Zs';
}

const CONTROL_TEST = /\p{Cc}|\p{Cf}/u;
const SPACE_SEPARATOR_TEST = /\p{Zs}/u;

function codePointGeneralCategory(cp: number): 'Cc' | 'Cf' | 'Zs' | 'other' {
  const ch = String.fromCodePoint(cp);
  if (SPACE_SEPARATOR_TEST.test(ch)) return 'Zs';
  if (CONTROL_TEST.test(ch)) return /\p{Cc}/u.test(ch) ? 'Cc' : 'Cf';
  return 'other';
}

export function normalizeBert(text: string): NormalizedText {
  const chars: string[] = [];
  const toOriginal: (readonly [number, number])[] = [];
  let utf16Index = 0;

  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const start = utf16Index;
    const end = start + ch.length;
    utf16Index = end;

    if (isControlCodePoint(cp)) {
      continue;
    }

    const normalizedChar = isWhitespaceCodePoint(cp) ? ' ' : ch;

    const piece = isChineseCodePoint(cp) ? ` ${normalizedChar} ` : normalizedChar;
    chars.push(piece);
    for (let unit = 0; unit < piece.length; unit += 1) {
      toOriginal.push([start, end]);
    }
  }

  return { text: chars.join(''), toOriginal };
}
