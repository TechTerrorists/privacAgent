import { describe, expect, it } from 'vitest';

import fixturesJson from './testdata/tokenizer-parity.json';
import vocabTokens from './testdata/vocab.json';
import { tokenizeWindows } from './tokenizer.js';
import { parseVocabTokens } from './vocab.js';

interface PythonFixture {
  readonly text: string;
  readonly input_ids: readonly number[];
  readonly tokens: readonly string[];
  readonly offsets: readonly (readonly [number, number])[];
}

const VOCAB = parseVocabTokens(vocabTokens);
const FIXTURES = fixturesJson as unknown as readonly PythonFixture[];

function codePointOffsetToUtf16(text: string, codePointOffset: number): number {
  let utf16Index = 0;
  let codePoints = 0;
  for (const ch of text) {
    if (codePoints === codePointOffset) return utf16Index;
    codePoints += 1;
    utf16Index += ch.length;
  }
  return utf16Index;
}

describe('tokenizer parity against Python BertTokenizerFast (real run3 export)', () => {
  it('loaded the real, full-size vocabulary', () => {
    expect(VOCAB.tokenToId.size).toBeGreaterThan(1000);
  });

  it('has fixtures to compare against', () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
  });

  for (const fixture of FIXTURES) {
    it(`matches Python's input_ids for: ${JSON.stringify(fixture.text)}`, () => {
      const [window] = tokenizeWindows(fixture.text, { vocab: VOCAB });
      expect(window).toBeDefined();
      const ids = window!.map((t) => t.id);
      expect(ids).toEqual(fixture.input_ids);
    });

    it(`matches Python's offsets (converted from code points to UTF-16) for: ${JSON.stringify(fixture.text)}`, () => {
      const [window] = tokenizeWindows(fixture.text, { vocab: VOCAB });
      const expectedOffsets = fixture.offsets.map(
        ([start, end]) =>
          [
            codePointOffsetToUtf16(fixture.text, start),
            codePointOffsetToUtf16(fixture.text, end),
          ] as const
      );
      const actualOffsets = window!.map((t) => [t.start, t.end] as const);
      expect(actualOffsets).toEqual(expectedOffsets);
    });
  }
});
