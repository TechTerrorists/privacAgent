import { describe, expect, it } from 'vitest';

import { space } from '../../geometry/index.js';
import type { OcrLine, OcrWord } from '../../worker/inference/types.js';
import { alignOcrSpan, alignOcrSpanToRegions, recoverWordOffsets } from './ocr.js';

function word(text: string, bbox: readonly [number, number, number, number]): OcrWord {
  return {
    text,
    bbox: bbox as never,
    conf: 0.95,
    characters: text.split('').map((char) => ({ char, conf: 0.95 })),
  };
}

function line(text: string, words: readonly OcrWord[], meanCharConfidence = 0.95): OcrLine {
  return { text, bbox: [0, 0, 200, 20], meanCharConfidence, words };
}

describe('recoverWordOffsets', () => {
  it('recovers sequential offsets for well-formed OCR output', () => {
    const l = line('john smith', [word('john', [0, 0, 40, 20]), word('smith', [45, 0, 50, 20])]);
    const offsets = recoverWordOffsets(l);
    expect(offsets).toEqual([
      { word: l.words[0], start: 0, end: 4 },
      { word: l.words[1], start: 5, end: 10 },
    ]);
  });

  it('returns undefined when a word cannot be located in the line text (mismatched OCR)', () => {
    const l = line('john smith', [word('priya', [0, 0, 40, 20])]);
    expect(recoverWordOffsets(l)).toBeUndefined();
  });

  it('handles a repeated word by matching in order, not by first occurrence', () => {
    const l = line('a a', [word('a', [0, 0, 5, 20]), word('a', [10, 0, 5, 20])]);
    const offsets = recoverWordOffsets(l);
    expect(offsets).toEqual([
      { word: l.words[0], start: 0, end: 1 },
      { word: l.words[1], start: 2, end: 3 },
    ]);
  });
});

describe('alignOcrSpan', () => {
  it('returns the whole-word box for a span fully inside one word', () => {
    const l = line('contact john now', [
      word('contact', [0, 0, 60, 20]),
      word('john', [65, 0, 40, 20]),
      word('now', [110, 0, 30, 20]),
    ]);
    const johnStart = l.text.indexOf('john');
    const result = alignOcrSpan(l, { start: johnStart, end: johnStart + 4 });
    expect(result).toEqual({ status: 'ok', boxes: [[65, 0, 40, 20]] });
  });

  it('masks the whole word for a partial-character match inside it', () => {
    const l = line('contact john now', [
      word('contact', [0, 0, 60, 20]),
      word('john', [65, 0, 40, 20]),
      word('now', [110, 0, 30, 20]),
    ]);
    const johnStart = l.text.indexOf('john');
    const result = alignOcrSpan(l, { start: johnStart + 1, end: johnStart + 2 });
    expect(result).toEqual({ status: 'ok', boxes: [[65, 0, 40, 20]] });
  });

  it('spans multiple words when the span crosses a word boundary', () => {
    const l = line('john smith lives here', [
      word('john', [0, 0, 30, 20]),
      word('smith', [35, 0, 40, 20]),
      word('lives', [80, 0, 40, 20]),
      word('here', [125, 0, 30, 20]),
    ]);
    const result = alignOcrSpan(l, { start: 0, end: l.text.indexOf('lives') });
    expect(result.status).toBe('ok');
    expect(result.boxes).toEqual([
      [0, 0, 30, 20],
      [35, 0, 40, 20],
    ]);
  });

  it('falls back to the whole line when confidence is below 0.7 (§6.8)', () => {
    const l = line('contact john now', [word('john', [65, 0, 40, 20])], 0.5);
    const result = alignOcrSpan(l, { start: 8, end: 12 });
    expect(result).toEqual({ status: 'whole_line', boxes: [l.bbox], reason: 'low_confidence' });
  });

  it('falls back to the whole line when OCR word text is inconsistent with the line text', () => {
    const l = line('contact john now', [word('priya', [65, 0, 40, 20])]);
    const result = alignOcrSpan(l, { start: 8, end: 12 });
    expect(result).toEqual({
      status: 'whole_line',
      boxes: [l.bbox],
      reason: 'word_offset_mismatch',
    });
  });

  it('falls back to the whole line for an out-of-range span rather than guessing', () => {
    const l = line('short', [word('short', [0, 0, 40, 20])]);
    const result = alignOcrSpan(l, { start: 0, end: 999 });
    expect(result.status).toBe('whole_line');
  });

  it('falls back to the whole line when no word overlaps the span at all', () => {
    const l = line('a   b', [word('a', [0, 0, 5, 20]), word('b', [40, 0, 5, 20])]);
    const result = alignOcrSpan(l, { start: 1, end: 3 });
    expect(result).toEqual({
      status: 'whole_line',
      boxes: [l.bbox],
      reason: 'no_overlapping_word',
    });
  });
});

describe('alignOcrSpanToRegions', () => {
  const SPACE = space('image', 'img-1', { docId: 'd1', observationId: 1 });

  it('wraps an ok outcome as exact-span regions in the requested space', () => {
    const l = line('contact john now', [
      word('contact', [0, 0, 60, 20]),
      word('john', [65, 0, 40, 20]),
    ]);
    const johnStart = l.text.indexOf('john');
    const result = alignOcrSpanToRegions(l, { start: johnStart, end: johnStart + 4 }, SPACE);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.regions).toEqual([
      { rect: { space: SPACE, x: 65, y: 0, width: 40, height: 20 }, provenance: 'exact_span' },
    ]);
  });

  it('wraps a whole-line fallback as a fallback region with the same rejection reason', () => {
    const l = line('contact john now', [word('priya', [65, 0, 40, 20])]);
    const result = alignOcrSpanToRegions(l, { start: 8, end: 12 }, SPACE);
    expect(result.status).toBe('fallback');
    if (result.status !== 'fallback') throw new Error('unreachable');
    expect(result.reason).toBe('word_offset_mismatch');
    expect(result.regions[0]?.provenance).toBe('whole_line');
  });
});
