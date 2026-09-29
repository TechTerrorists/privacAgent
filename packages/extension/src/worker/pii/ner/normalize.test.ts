import { describe, expect, it } from 'vitest';

import { normalizeBert } from './normalize.js';

function reconstruct(text: string): string {
  const { text: normalized, toOriginal } = normalizeBert(text);
  expect(normalized.length).toBe(toOriginal.length);
  return normalized
    .split('')
    .map((ch, i) => `${ch}@${toOriginal[i]![0]}-${toOriginal[i]![1]}`)
    .join(' ');
}

describe('normalizeBert', () => {
  it('leaves plain ASCII text unchanged, offsets 1:1', () => {
    const { text, toOriginal } = normalizeBert('hello world');
    expect(text).toBe('hello world');
    expect(toOriginal[0]).toEqual([0, 1]);
    expect(toOriginal[6]).toEqual([6, 7]);
  });

  it('does not lowercase (do_lower_case=false)', () => {
    expect(normalizeBert('Hello World').text).toBe('Hello World');
  });

  it('preserves Hindi combining marks unchanged', () => {
    const text = 'नमस्ते दुनिया';
    const { text: normalized } = normalizeBert(text);
    expect(normalized).toBe(text);
  });

  it('replaces a tab/newline with a single space, offsets point at the original char', () => {
    const { text, toOriginal } = normalizeBert('a\tb\nc');
    expect(text).toBe('a b c');
    expect(toOriginal[1]).toEqual([1, 2]);
    expect(toOriginal[3]).toEqual([3, 4]);
  });

  it('drops a control character entirely, shifting later offsets back to the original position', () => {
    const withControl = `a${String.fromCharCode(0x01)}b`;
    const { text, toOriginal } = normalizeBert(withControl);
    expect(text).toBe('ab');
    expect(toOriginal[1]).toEqual([2, 3]);
  });

  it('surrounds a CJK character with spaces and maps all three normalized chars to it', () => {
    const { text, toOriginal } = normalizeBert('a中b');
    expect(text).toBe('a 中 b');
    const cjkIndex = text.indexOf('中');
    expect(toOriginal[cjkIndex]).toEqual([1, 2]);
    expect(toOriginal[cjkIndex - 1]).toEqual([1, 2]);
    expect(toOriginal[cjkIndex + 1]).toEqual([1, 2]);
  });

  it('keeps an astral emoji as one unit with a correct two-code-unit original span', () => {
    const text = 'hi 🙂 there';
    const { text: normalized, toOriginal } = normalizeBert(text);
    expect(normalized).toBe(text);
    const emojiIndex = text.indexOf('🙂');
    expect(toOriginal[emojiIndex]).toEqual([emojiIndex, emojiIndex + 2]);
  });

  it('every normalized offset is reconstructible without throwing, for a mixed script sentence', () => {
    expect(() => reconstruct('Contact जॉन at john@example.com 🙂 now')).not.toThrow();
  });
});
