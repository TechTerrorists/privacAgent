import { describe, expect, it } from 'vitest';

import { parseVocab } from './vocab.js';
import { wordpieceTokenize } from './wordpiece.js';

const VOCAB = parseVocab(
  ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'john', 'jo', '##hn', 'a', '##b', '##c'].join('\n')
);

describe('wordpieceTokenize', () => {
  it('matches a whole word directly when it is in the vocab', () => {
    const tokens = wordpieceTokenize('john', VOCAB, '[UNK]');
    expect(tokens).toEqual([{ token: 'john', start: 0, end: 4 }]);
  });

  it('splits into the longest-match subwords with a continuation prefix', () => {
    const tokens = wordpieceTokenize('abc', VOCAB, '[UNK]');
    expect(tokens).toEqual([
      { token: 'a', start: 0, end: 1 },
      { token: '##b', start: 1, end: 2 },
      { token: '##c', start: 2, end: 3 },
    ]);
  });

  it('falls back to [UNK] when no split can cover the word', () => {
    const tokens = wordpieceTokenize('xyz', VOCAB, '[UNK]');
    expect(tokens).toEqual([{ token: '[UNK]', start: 0, end: 3 }]);
  });

  it('falls back to [UNK] for a word longer than the 100-char limit', () => {
    const tokens = wordpieceTokenize('a'.repeat(101), VOCAB, '[UNK]');
    expect(tokens).toEqual([{ token: '[UNK]', start: 0, end: 101 }]);
  });

  it('prefers the greedy longest match over a prefix that would also work', () => {
    const tokens = wordpieceTokenize('john', VOCAB, '[UNK]');
    expect(tokens).not.toEqual([
      { token: 'jo', start: 0, end: 2 },
      { token: '##hn', start: 2, end: 4 },
    ]);
  });
});
