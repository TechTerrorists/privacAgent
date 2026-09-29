import { describe, expect, it } from 'vitest';

import { preTokenizeBert } from './pretokenize.js';

describe('preTokenizeBert', () => {
  it('splits on whitespace', () => {
    const tokens = preTokenizeBert('hello world');
    expect(tokens.map((t) => t.text)).toEqual(['hello', 'world']);
    expect(tokens[0]).toMatchObject({ start: 0, end: 5 });
    expect(tokens[1]).toMatchObject({ start: 6, end: 11 });
  });

  it('splits punctuation into its own tokens', () => {
    const tokens = preTokenizeBert("john@example.com, isn't it?");
    expect(tokens.map((t) => t.text)).toEqual([
      'john',
      '@',
      'example',
      '.',
      'com',
      ',',
      'isn',
      "'",
      't',
      'it',
      '?',
    ]);
  });

  it('collapses runs of whitespace without producing empty tokens', () => {
    const tokens = preTokenizeBert('a   b');
    expect(tokens.map((t) => t.text)).toEqual(['a', 'b']);
  });

  it('handles leading/trailing whitespace', () => {
    const tokens = preTokenizeBert('  a  ');
    expect(tokens.map((t) => t.text)).toEqual(['a']);
  });

  it('keeps Hindi words intact (not punctuation)', () => {
    const tokens = preTokenizeBert('नमस्ते दुनिया');
    expect(tokens.map((t) => t.text)).toEqual(['नमस्ते', 'दुनिया']);
  });

  it('returns no tokens for an empty or all-whitespace string', () => {
    expect(preTokenizeBert('')).toEqual([]);
    expect(preTokenizeBert('   ')).toEqual([]);
  });
});
