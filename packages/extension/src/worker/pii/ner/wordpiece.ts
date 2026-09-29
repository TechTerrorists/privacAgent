import type { WordPieceVocab } from './vocab.js';

export interface WordPieceToken {
  readonly token: string;
  readonly start: number;
  readonly end: number;
}

const CONTINUATION_PREFIX = '##';
const MAX_INPUT_CHARS_PER_WORD = 100;

export function wordpieceTokenize(
  word: string,
  vocab: WordPieceVocab,
  unkToken: string
): readonly WordPieceToken[] {
  const wholeWordUnk = [{ token: unkToken, start: 0, end: word.length }];
  if (word.length > MAX_INPUT_CHARS_PER_WORD || word.length === 0) return wholeWordUnk;

  const tokens: WordPieceToken[] = [];
  let start = 0;

  while (start < word.length) {
    let end = word.length;
    let matched: string | undefined;

    while (start < end) {
      const candidate =
        start > 0 ? CONTINUATION_PREFIX + word.slice(start, end) : word.slice(start, end);
      if (vocab.tokenToId.has(candidate)) {
        matched = candidate;
        break;
      }
      end -= 1;
    }

    if (matched === undefined) return wholeWordUnk;

    tokens.push({ token: matched, start, end });
    start = end;
  }

  return tokens;
}
