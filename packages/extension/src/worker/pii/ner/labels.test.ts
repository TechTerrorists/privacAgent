import { describe, expect, it } from 'vitest';

import { decodeBioSpans, entityTypeToPiiClass, parseLabelMap } from './labels.js';

const LABEL_MAP = parseLabelMap({
  O: 0,
  'B-NAME': 1,
  'I-NAME': 2,
  'B-ADDRESS': 3,
  'I-ADDRESS': 4,
  'B-ORG': 5,
  'I-ORG': 6,
});

function tok(start: number, end: number) {
  return { start, end };
}

describe('entityTypeToPiiClass', () => {
  it('maps every trained entity type to its PiiClass', () => {
    expect(entityTypeToPiiClass('NAME')).toBe('name');
    expect(entityTypeToPiiClass('ADDRESS')).toBe('address');
    expect(entityTypeToPiiClass('ORG')).toBe('organization');
    expect(entityTypeToPiiClass('LOCATION')).toBe('location');
    expect(entityTypeToPiiClass('DOB')).toBe('dob');
  });

  it('falls back to other for an unrecognized entity type, never invents a class', () => {
    expect(entityTypeToPiiClass('NOT_A_REAL_TYPE')).toBe('other');
  });
});

describe('decodeBioSpans', () => {
  it('decodes a single B-only entity', () => {
    const tokens = [tok(0, 0), tok(0, 4), tok(0, 0)];
    const spans = decodeBioSpans(
      tokens,
      [undefined as unknown as number, 1, undefined as unknown as number],
      LABEL_MAP
    );
    expect(spans).toEqual([{ start: 0, end: 4, entityType: 'NAME' }]);
  });

  it('extends a span across B- then matching I- tokens', () => {
    const tokens = [tok(0, 0), tok(0, 4), tok(5, 9), tok(0, 0)];
    const spans = decodeBioSpans(tokens, [0, 1, 2, 0], LABEL_MAP);
    expect(spans).toEqual([{ start: 0, end: 9, entityType: 'NAME' }]);
  });

  it('closes the current span at a special (zero-width) token', () => {
    const tokens = [tok(0, 0), tok(0, 4), tok(0, 0), tok(5, 9)];
    const spans = decodeBioSpans(tokens, [0, 1, 0, 0], LABEL_MAP);
    expect(spans).toEqual([{ start: 0, end: 4, entityType: 'NAME' }]);
  });

  it('starts a fresh span when I- follows a different entity type (never merges mismatched types)', () => {
    const tokens = [tok(0, 4), tok(5, 12)];
    const spans = decodeBioSpans(tokens, [1, 4], LABEL_MAP);
    expect(spans).toEqual([
      { start: 0, end: 4, entityType: 'NAME' },
      { start: 5, end: 12, entityType: 'ADDRESS' },
    ]);
  });

  it('produces two adjacent entities when B- follows B- with no O between', () => {
    const tokens = [tok(0, 4), tok(5, 9)];
    const spans = decodeBioSpans(tokens, [1, 3], LABEL_MAP);
    expect(spans).toEqual([
      { start: 0, end: 4, entityType: 'NAME' },
      { start: 5, end: 9, entityType: 'ADDRESS' },
    ]);
  });

  it('closes the open span at O', () => {
    const tokens = [tok(0, 4), tok(5, 7), tok(8, 12)];
    const spans = decodeBioSpans(tokens, [1, 0, 5], LABEL_MAP);
    expect(spans).toEqual([
      { start: 0, end: 4, entityType: 'NAME' },
      { start: 8, end: 12, entityType: 'ORG' },
    ]);
  });

  it('returns nothing for an all-O sequence', () => {
    const tokens = [tok(0, 4), tok(5, 9)];
    expect(decodeBioSpans(tokens, [0, 0], LABEL_MAP)).toEqual([]);
  });
});
