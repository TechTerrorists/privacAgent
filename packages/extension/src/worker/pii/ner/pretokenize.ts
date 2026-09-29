export interface PreToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const PUNCTUATION_TEST = /\p{P}|\p{S}/u;

function isAsciiPunctuation(cp: number): boolean {
  return (
    (cp >= 33 && cp <= 47) ||
    (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) ||
    (cp >= 123 && cp <= 126)
  );
}

function isPunctuationCodePoint(cp: number): boolean {
  if (isAsciiPunctuation(cp)) return true;
  return PUNCTUATION_TEST.test(String.fromCodePoint(cp));
}

export function preTokenizeBert(normalized: string): PreToken[] {
  const tokens: PreToken[] = [];
  let current = '';
  let currentStart = -1;

  function flush(end: number): void {
    if (current.length > 0) {
      tokens.push({ text: current, start: currentStart, end });
      current = '';
      currentStart = -1;
    }
  }

  let index = 0;
  for (const ch of normalized) {
    const cp = ch.codePointAt(0)!;
    const start = index;
    const end = index + ch.length;
    index = end;

    if (ch === ' ') {
      flush(start);
      continue;
    }

    if (isPunctuationCodePoint(cp)) {
      flush(start);
      tokens.push({ text: ch, start, end });
      continue;
    }

    if (current.length === 0) currentStart = start;
    current += ch;
  }
  flush(normalized.length);

  return tokens;
}
