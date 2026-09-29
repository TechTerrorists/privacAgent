import type { CharSpan } from './types.js';

function graphemeBoundaries(text: string): readonly number[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const boundaries: number[] = [0];
    for (const { index, segment } of segmenter.segment(text)) {
      boundaries.push(index + segment.length);
    }
    return boundaries;
  }

  const boundaries: number[] = [0];
  let index = 0;
  for (const ch of text) {
    index += ch.length;
    boundaries.push(index);
  }
  return boundaries;
}

export function expandToGraphemeBoundaries(text: string, span: CharSpan): CharSpan {
  const boundaries = graphemeBoundaries(text);

  let start = boundaries[0]!;
  for (const boundary of boundaries) {
    if (boundary > span.start) break;
    start = boundary;
  }

  let end = boundaries[boundaries.length - 1]!;
  for (let i = boundaries.length - 1; i >= 0; i -= 1) {
    const boundary = boundaries[i]!;
    if (boundary < span.end) break;
    end = boundary;
  }

  return { start, end };
}
