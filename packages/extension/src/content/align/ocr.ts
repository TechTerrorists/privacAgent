import type { BBox } from '@privacagent/protocol';
import { fromBBox, type Rect, type SpaceRef } from '../../geometry/index.js';
import type { OcrLine, OcrWord } from '../../worker/inference/types.js';
import type {
  AlignedRegion,
  AlignmentRejectionReason,
  AlignmentResult,
  CharSpan,
} from './types.js';

const MIN_LINE_CONFIDENCE = 0.7;

export interface WordOffset {
  readonly word: OcrWord;
  readonly start: number;
  readonly end: number;
}

export function recoverWordOffsets(line: OcrLine): readonly WordOffset[] | undefined {
  const offsets: WordOffset[] = [];
  let cursor = 0;

  for (const word of line.words) {
    const index = line.text.indexOf(word.text, cursor);
    if (index === -1) return undefined;
    offsets.push({ word, start: index, end: index + word.text.length });
    cursor = index + word.text.length;
  }

  return offsets;
}

export type OcrAlignmentOutcome =
  | { readonly status: 'ok'; readonly boxes: readonly BBox[] }
  | {
      readonly status: 'whole_line';
      readonly boxes: readonly [BBox];
      readonly reason: AlignmentRejectionReason;
    };

export function alignOcrSpan(line: OcrLine, span: CharSpan): OcrAlignmentOutcome {
  const wholeLine = (reason: AlignmentRejectionReason): OcrAlignmentOutcome => ({
    status: 'whole_line',
    boxes: [line.bbox],
    reason,
  });

  if (line.meanCharConfidence < MIN_LINE_CONFIDENCE) return wholeLine('low_confidence');
  if (span.start >= span.end) return wholeLine('empty_span');
  if (span.start < 0 || span.end > line.text.length) return wholeLine('span_out_of_range');

  const offsets = recoverWordOffsets(line);
  if (!offsets) return wholeLine('word_offset_mismatch');

  const boxes: BBox[] = [];
  for (const offset of offsets) {
    const overlaps = offset.start < span.end && span.start < offset.end;
    if (overlaps) boxes.push(offset.word.bbox);
  }

  if (boxes.length === 0) return wholeLine('no_overlapping_word');
  return { status: 'ok', boxes };
}

export function alignOcrSpanToRegions<S extends 'image' | 'crop'>(
  line: OcrLine,
  span: CharSpan,
  space: SpaceRef<S>
): AlignmentResult<S> {
  const outcome = alignOcrSpan(line, span);
  const toRect = (bbox: BBox): Rect<S> => fromBBox(space, bbox);

  if (outcome.status === 'ok') {
    const regions: AlignedRegion<S>[] = outcome.boxes.map((bbox) => ({
      rect: toRect(bbox),
      provenance: 'exact_span',
    }));
    return { status: 'ok', regions };
  }

  const regions: AlignedRegion<S>[] = outcome.boxes.map((bbox) => ({
    rect: toRect(bbox),
    provenance: 'whole_line',
  }));
  return { status: 'fallback', regions, reason: outcome.reason };
}
