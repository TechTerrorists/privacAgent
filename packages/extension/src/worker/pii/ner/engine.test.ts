import { describe, expect, it } from 'vitest';

import { RUN3_NER_CAPABILITY, type NerCapability } from './capability.js';
import { runNerScan } from './engine.js';
import { parseVocab } from './vocab.js';

const LABEL_TO_ID = {
  O: 0,
  'B-NAME': 1,
  'I-NAME': 2,
  'B-ORG': 3,
  'I-ORG': 4,
};

const VOCAB = parseVocab(
  ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'john', 'works', 'at', 'acme'].join('\n')
);

function runtimeReturning(labelIdsByWindow: readonly (readonly number[])[]) {
  let call = 0;
  return {
    run: async () => {
      const labelIds = labelIdsByWindow[call]!;
      call += 1;
      const numLabels = Object.keys(LABEL_TO_ID).length;
      const data = new Float32Array(labelIds.length * numLabels);
      for (const [row, label] of labelIds.entries()) data[row * numLabels + label] = 10;
      return { logits: { type: 'float32' as const, data, dims: [1, labelIds.length, numLabels] } };
    },
  };
}

function runtimeLabelingAllContentAsName() {
  return {
    run: async (_model: unknown, feeds: Record<string, { data: BigInt64Array }>) => {
      const inputIds = feeds.input_ids!.data;
      const numLabels = Object.keys(LABEL_TO_ID).length;
      const data = new Float32Array(inputIds.length * numLabels);
      const clsId = BigInt(VOCAB.tokenToId.get('[CLS]')!);
      const sepId = BigInt(VOCAB.tokenToId.get('[SEP]')!);
      for (let row = 0; row < inputIds.length; row += 1) {
        const isSpecial = inputIds[row] === clsId || inputIds[row] === sepId;
        data[row * numLabels + (isSpecial ? 0 : 1)] = 10;
      }
      return { logits: { type: 'float32' as const, data, dims: [1, inputIds.length, numLabels] } };
    },
  };
}

const MODEL = { id: 'm', version: '1', bytes: new Uint8Array() };

describe('runNerScan', () => {
  it('returns clear for empty text without calling the runtime', async () => {
    const runtime = { run: () => Promise.reject(new Error('must not be called')) };
    const result = await runNerScan('', {
      runtime: runtime as never,
      model: MODEL,
      vocab: VOCAB,
      labelToId: LABEL_TO_ID,
      capability: RUN3_NER_CAPABILITY,
    });
    expect(result).toEqual({ status: 'ok', synthetic: true, spans: [] });
  });

  it('decodes a real entity span and always marks it synthetic when the capability is below threshold', async () => {
    const runtime = runtimeReturning([[0, 1, 0, 0]]);
    const result = await runNerScan('john works', {
      runtime: runtime as never,
      model: MODEL,
      vocab: VOCAB,
      labelToId: LABEL_TO_ID,
      capability: RUN3_NER_CAPABILITY,
    });
    expect(result.status).toBe('ok');
    expect(result.synthetic).toBe(true);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({
      piiClass: 'name',
      detector: 'l3_ner',
      synthetic: true,
    });
  });

  it('marks spans non-synthetic only when the capability clears the recall threshold', async () => {
    const validated: NerCapability = { ...RUN3_NER_CAPABILITY, measuredMicroRecall: 0.99 };
    const runtime = runtimeReturning([[0, 1, 0, 0]]);
    const result = await runNerScan('john works', {
      runtime: runtime as never,
      model: MODEL,
      vocab: VOCAB,
      labelToId: LABEL_TO_ID,
      capability: validated,
    });
    expect(result.synthetic).toBe(false);
    expect(result.spans[0]?.synthetic).toBe(false);
  });

  it('reports unavailable instead of an empty successful scan when the model fails', async () => {
    const runtime = { run: () => Promise.reject(new Error('backend down')) };
    const result = await runNerScan('john works', {
      runtime: runtime as never,
      model: MODEL,
      vocab: VOCAB,
      labelToId: LABEL_TO_ID,
      capability: RUN3_NER_CAPABILITY,
    });
    expect(result.status).toBe('unavailable');
    expect(result.spans).toEqual([]);
  });

  it('reports cancelled when the signal is already aborted, never runs the model', async () => {
    const runtime = { run: () => Promise.reject(new Error('must not be called')) };
    const controller = new AbortController();
    controller.abort();
    const result = await runNerScan(
      'john works',
      {
        runtime: runtime as never,
        model: MODEL,
        vocab: VOCAB,
        labelToId: LABEL_TO_ID,
        capability: RUN3_NER_CAPABILITY,
      },
      controller.signal
    );
    expect(result.status).toBe('cancelled');
  });

  it('stitches duplicate predictions from overlapping windows into non-overlapping spans', async () => {
    let calls = 0;
    const base = runtimeLabelingAllContentAsName();
    const runtime = {
      run: async (...args: Parameters<typeof base.run>) => {
        calls += 1;
        return base.run(...args);
      },
    };

    const result = await runNerScan('john works at acme', {
      runtime: runtime as never,
      model: MODEL,
      vocab: VOCAB,
      labelToId: LABEL_TO_ID,
      capability: RUN3_NER_CAPABILITY,
      maxWindowTokens: 4,
      stride: 2,
    });

    expect(result.status).toBe('ok');
    expect(calls).toBeGreaterThan(1);
    const sorted = [...result.spans].sort((a, b) => a.span.start - b.span.start);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]!.span.start).toBeGreaterThanOrEqual(sorted[i - 1]!.span.end);
    }
  });
});
