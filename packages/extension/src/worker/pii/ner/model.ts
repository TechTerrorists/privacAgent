import type { ModelDescriptor, OnnxRuntime } from '../../runtime/index.js';
import type { Token } from './tokenizer.js';

export type NerExecutionOutcome =
  | { readonly status: 'ok'; readonly labelIds: readonly number[] }
  | { readonly status: 'error'; readonly reason: string };

function argmaxRow(logits: Float32Array, row: number, numLabels: number): number {
  let bestIndex = 0;
  let bestValue = -Infinity;
  const base = row * numLabels;
  for (let label = 0; label < numLabels; label += 1) {
    const value = logits[base + label]!;
    if (value > bestValue) {
      bestValue = value;
      bestIndex = label;
    }
  }
  return bestIndex;
}

export async function runNerWindow(
  runtime: OnnxRuntime,
  model: ModelDescriptor,
  window: readonly Token[],
  numLabels: number
): Promise<NerExecutionOutcome> {
  try {
    const inputIds = new BigInt64Array(window.map((t) => BigInt(t.id)));
    const attentionMask = new BigInt64Array(window.length).fill(1n);

    const outputs = await runtime.run(model, {
      input_ids: { type: 'int64', data: inputIds, dims: [1, window.length] },
      attention_mask: { type: 'int64', data: attentionMask, dims: [1, window.length] },
    });

    const logits = outputs.logits;
    if (!logits || !(logits.data instanceof Float32Array)) {
      return { status: 'error', reason: 'unexpected_output_shape' };
    }
    const expectedLength = window.length * numLabels;
    if (logits.data.length !== expectedLength) {
      return { status: 'error', reason: 'unexpected_output_shape' };
    }

    const labelIds: number[] = [];
    for (let row = 0; row < window.length; row += 1) {
      labelIds.push(argmaxRow(logits.data, row, numLabels));
    }
    return { status: 'ok', labelIds };
  } catch (cause) {
    return { status: 'error', reason: cause instanceof Error ? cause.name : 'UnknownError' };
  }
}
