import type { DocumentId, ElementId } from '@privacagent/protocol';
import type { Rect, Space } from '../../geometry/index.js';

export interface CharSpan {
  readonly start: number;
  readonly end: number;
}

export interface EvidenceSpan {
  readonly docId: DocumentId;
  readonly observationId: number;
  readonly elementId: ElementId;
  readonly sourceText: string;
  readonly span: CharSpan;
}

export type AlignmentProvenance = 'exact_span' | 'whole_line' | 'whole_block';

export interface AlignedRegion<S extends Space = Space> {
  readonly rect: Rect<S>;
  readonly provenance: AlignmentProvenance;
}

export type AlignmentRejectionReason =
  | 'element_detached'
  | 'text_mismatch'
  | 'no_text_nodes'
  | 'frame_measurement_missing'
  | 'unsupported_transform'
  | 'invalid_geometry'
  | 'no_rects'
  | 'low_confidence'
  | 'empty_span'
  | 'span_out_of_range'
  | 'word_offset_mismatch'
  | 'no_overlapping_word';

export type AlignmentResult<S extends Space = Space> =
  | { readonly status: 'ok'; readonly regions: readonly AlignedRegion<S>[] }
  | {
      readonly status: 'fallback';
      readonly regions: readonly AlignedRegion<S>[];
      readonly reason: AlignmentRejectionReason;
    }
  | { readonly status: 'withhold'; readonly reason: AlignmentRejectionReason };
