import { describe, expect, it } from 'vitest';

import { tokenizeWindows } from './tokenizer.js';
import { parseVocab } from './vocab.js';

const VOCAB = parseVocab(
  ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'john', 'lives', 'in', 'delhi', '.', 'a', '##b', '##c'].join(
    '\n'
  )
);

describe('tokenizeWindows', () => {
  it('wraps content tokens with [CLS]/[SEP] and keeps original-text offsets', () => {
    const [window] = tokenizeWindows('john lives in delhi.', { vocab: VOCAB });
    expect(window).toBeDefined();
    const tokens = window!;
    expect(tokens[0]).toMatchObject({ id: VOCAB.tokenToId.get('[CLS]') });
    expect(tokens.at(-1)).toMatchObject({ id: VOCAB.tokenToId.get('[SEP]') });

    const john = tokens[1]!;
    expect(john.id).toBe(VOCAB.tokenToId.get('john'));
    expect(john).toMatchObject({ start: 0, end: 4 });

    const delhi = tokens[4]!;
    expect(delhi.id).toBe(VOCAB.tokenToId.get('delhi'));
    expect(delhi).toMatchObject({ start: 14, end: 19 });
  });

  it('produces exactly one window when content fits', () => {
    const windows = tokenizeWindows('john lives in delhi', { vocab: VOCAB, maxWindowTokens: 64 });
    expect(windows).toHaveLength(1);
  });

  it('splits into overlapping windows when content exceeds capacity, covering every token', () => {
    const text = 'john lives in delhi a b c john lives in delhi';
    const windows = tokenizeWindows(text, { vocab: VOCAB, maxWindowTokens: 6, stride: 2 });
    expect(windows.length).toBeGreaterThan(1);
    for (const window of windows) {
      expect(window.length).toBeLessThanOrEqual(6);
      expect(window[0]?.id).toBe(VOCAB.tokenToId.get('[CLS]'));
      expect(window.at(-1)?.id).toBe(VOCAB.tokenToId.get('[SEP]'));
    }
  });

  it('handles empty text with a bare [CLS][SEP] window', () => {
    const windows = tokenizeWindows('', { vocab: VOCAB });
    expect(windows).toHaveLength(1);
    expect(windows[0]).toHaveLength(2);
  });

  it('throws when a special token is missing from the vocab', () => {
    const badVocab = parseVocab(['[PAD]', '[UNK]'].join('\n'));
    expect(() => tokenizeWindows('john', { vocab: badVocab })).toThrow();
  });
});
