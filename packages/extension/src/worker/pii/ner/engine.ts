import type { ModelDescriptor, OnnxRuntime } from '../../runtime/index.js';
import { mergeOverlappingSpans, type MergedSpanMatch, type RawSpanMatch } from '../redact.js';
import { meetsCoverageThreshold, type NerCapability } from './capability.js';
import { decodeBioSpans, entityTypeToPiiClass, parseLabelMap } from './labels.js';
import { runNerWindow } from './model.js';
import { tokenizeWindows } from './tokenizer.js';
import type { WordPieceVocab } from './vocab.js';

export interface NerEngineDeps {
  readonly runtime: OnnxRuntime;
  readonly model: ModelDescriptor;
  readonly vocab: WordPieceVocab;
  readonly labelToId: Readonly<Record<string, number>>;
  readonly capability: NerCapability;
  readonly maxWindowTokens?: number;
  readonly stride?: number;
}

export type NerScanStatus = 'ok' | 'unavailable' | 'cancelled';

export interface NerScanResult {
  readonly status: NerScanStatus;
  readonly reason?: string;
  readonly synthetic: boolean;
  readonly spans: readonly MergedSpanMatch[];
}

const UNAVAILABLE_EMPTY: NerScanResult = { status: 'ok', synthetic: true, spans: [] };

export async function runNerScan(
  text: string,
  deps: NerEngineDeps,
  signal?: AbortSignal
): Promise<NerScanResult> {
  if (text === '') return UNAVAILABLE_EMPTY;
  if (signal?.aborted) return { status: 'cancelled', synthetic: true, spans: [] };

  const labelMap = parseLabelMap(deps.labelToId);
  const numLabels = Object.keys(deps.labelToId).length;
  const synthetic = !meetsCoverageThreshold(deps.capability);

  let windows;
  try {
    windows = tokenizeWindows(text, {
      vocab: deps.vocab,
      ...(deps.maxWindowTokens !== undefined && { maxWindowTokens: deps.maxWindowTokens }),
      ...(deps.stride !== undefined && { stride: deps.stride }),
    });
  } catch (cause) {
    return {
      status: 'unavailable',
      reason: cause instanceof Error ? cause.name : 'TokenizerError',
      synthetic: true,
      spans: [],
    };
  }

  const rawMatches: RawSpanMatch[] = [];

  for (const window of windows) {
    if (signal?.aborted) return { status: 'cancelled', synthetic: true, spans: [] };

    const outcome = await runNerWindow(deps.runtime, deps.model, window, numLabels);
    if (outcome.status === 'error') {
      return { status: 'unavailable', reason: outcome.reason, synthetic: true, spans: [] };
    }

    const decoded = decodeBioSpans(window, outcome.labelIds, labelMap);
    for (const span of decoded) {
      rawMatches.push({
        span: { start: span.start, end: span.end },
        piiClass: entityTypeToPiiClass(span.entityType),
        detector: 'l3_ner',
        rule: `ner:${deps.capability.modelId}@${deps.capability.modelVersion}:${span.entityType}`,
        synthetic,
      });
    }
  }

  return { status: 'ok', synthetic, spans: mergeOverlappingSpans(rawMatches) };
}
