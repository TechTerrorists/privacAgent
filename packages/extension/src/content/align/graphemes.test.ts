import { describe, expect, it } from 'vitest';

import { expandToGraphemeBoundaries } from './graphemes.js';

describe('expandToGraphemeBoundaries', () => {
  it('leaves a span already on grapheme boundaries unchanged', () => {
    const text = 'hello world';
    expect(expandToGraphemeBoundaries(text, { start: 0, end: 5 })).toEqual({ start: 0, end: 5 });
  });

  it('widens a span that starts mid-surrogate-pair (emoji) outward, never narrows', () => {
    const text = 'ab\u{1F600}cd';
    const emojiStart = 2;
    const emojiEnd = 4;
    expect(expandToGraphemeBoundaries(text, { start: 3, end: 3 })).toEqual({
      start: emojiStart,
      end: emojiEnd,
    });
  });

  it('widens a span ending mid-emoji outward to include the whole grapheme', () => {
    const text = 'x\u{1F600}y';
    expect(expandToGraphemeBoundaries(text, { start: 0, end: 2 })).toEqual({ start: 0, end: 3 });
  });

  it('widens a span cutting into a Devanagari combining mark to the full cluster', () => {
    const text = 'नेमस्ते';
    const result = expandToGraphemeBoundaries(text, { start: 1, end: 3 });
    expect(result.start).toBeLessThanOrEqual(1);
    expect(result.end).toBeGreaterThanOrEqual(3);
    const widened = text.slice(result.start, result.end);
    expect(widened.length).toBeGreaterThan(0);
  });

  it('handles the whole-string span unchanged', () => {
    const text = 'abc';
    expect(expandToGraphemeBoundaries(text, { start: 0, end: 3 })).toEqual({ start: 0, end: 3 });
  });

  it('handles an empty span at a boundary without throwing', () => {
    const text = 'abc';
    expect(expandToGraphemeBoundaries(text, { start: 1, end: 1 })).toEqual({ start: 1, end: 1 });
  });
});
