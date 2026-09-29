import { describe, expect, it } from 'vitest';

import { createLayeredPiiEngine } from './layered.js';
import { RUN3_NER_CAPABILITY } from './ner/capability.js';
import { parseVocab } from './ner/vocab.js';

const LABEL_TO_ID = { O: 0, 'B-NAME': 1, 'I-NAME': 2 };
const VOCAB = parseVocab(
  ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'contact', 'priya', 'now'].join('\n')
);
const MODEL = { id: 'm', version: '1', bytes: new Uint8Array() };

function runtimeLabelingWordAsName(word: string) {
  return {
    run: async (_model: unknown, feeds: Record<string, { data: BigInt64Array }>) => {
      const targetId = BigInt(VOCAB.tokenToId.get(word)!);
      const inputIds = feeds.input_ids!.data;
      const numLabels = 3;
      const data = new Float32Array(inputIds.length * numLabels);
      for (let row = 0; row < inputIds.length; row += 1) {
        data[row * numLabels + (inputIds[row] === targetId ? 1 : 0)] = 10;
      }
      return { logits: { type: 'float32' as const, data, dims: [1, inputIds.length, numLabels] } };
    },
  };
}

describe('D-08 NER wired into the layered engine, additive-only', () => {
  it('adds a masked span for text_context that L2 alone would have wholly withheld', async () => {
    const engine = createLayeredPiiEngine({
      ner: {
        runtime: runtimeLabelingWordAsName('priya') as never,
        model: MODEL,
        vocab: VOCAB,
        labelToId: LABEL_TO_ID,
        capability: RUN3_NER_CAPABILITY,
      },
    });

    const result = await engine.scanText({
      evidence: 'dom_text',
      text: 'contact priya now',
      location: { kind: 'text_context_entry', index: 0 },
    });

    expect(result.outcome).toBe('redacted');
    expect(result.value).toContain('{{NAME_');
    expect(result.value).not.toContain('priya');
    expect(result.findings?.some((f) => f.detector === 'l3_ner')).toBe(true);
  });

  it('a synthetic NER finding never satisfies coverage (still synthetic:true, below the recall target)', async () => {
    const engine = createLayeredPiiEngine({
      ner: {
        runtime: runtimeLabelingWordAsName('priya') as never,
        model: MODEL,
        vocab: VOCAB,
        labelToId: LABEL_TO_ID,
        capability: RUN3_NER_CAPABILITY,
      },
    });

    const result = await engine.scanText({
      evidence: 'dom_text',
      text: 'contact priya now',
      location: { kind: 'text_context_entry', index: 0 },
    });

    const nerFinding = result.findings?.find((f) => f.detector === 'l3_ner');
    expect(nerFinding?.synthetic).toBe(true);
  });

  it('behaves exactly like no-NER when the NER pass fails, never weakening L2 coverage', async () => {
    const failing = createLayeredPiiEngine({
      ner: {
        runtime: { run: () => Promise.reject(new Error('backend down')) } as never,
        model: MODEL,
        vocab: VOCAB,
        labelToId: LABEL_TO_ID,
        capability: RUN3_NER_CAPABILITY,
      },
    });
    const bare = createLayeredPiiEngine();

    const withFailingNer = await failing.scanText({
      evidence: 'dom_text',
      text: 'CANARY-EMAIL-1@example.test',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
    });
    const withoutNer = await bare.scanText({
      evidence: 'dom_text',
      text: 'CANARY-EMAIL-1@example.test',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
    });

    expect(withFailingNer.outcome).toBe(withoutNer.outcome);
    expect(withFailingNer.piiClass).toBe(withoutNer.piiClass);
  });

  it('a NER match covering only part of a value field still forces whole-field withhold, never a malformed placeholder', async () => {
    const engine = createLayeredPiiEngine({
      ner: {
        runtime: runtimeLabelingWordAsName('priya') as never,
        model: MODEL,
        vocab: VOCAB,
        labelToId: LABEL_TO_ID,
        capability: RUN3_NER_CAPABILITY,
      },
    });

    const result = await engine.scanText({
      evidence: 'dom_text',
      text: 'contact priya now',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
    });

    expect(result.outcome).toBe('withheld');
    expect(result.value).toBe('{{TEXT_WITHHELD}}');
  });
});
