import { describe, expect, it } from 'vitest';

import { runNerWindow } from './model.js';
import type { Token } from './tokenizer.js';

function fakeRuntime(logitsByRow: readonly (readonly number[])[]) {
  return {
    run: async () => ({
      logits: {
        type: 'float32' as const,
        data: new Float32Array(logitsByRow.flat()),
        dims: [1, logitsByRow.length, logitsByRow[0]!.length],
      },
    }),
  };
}

const WINDOW: readonly Token[] = [
  { id: 2, start: 0, end: 0 },
  { id: 100, start: 0, end: 4 },
  { id: 3, start: 0, end: 0 },
];

describe('runNerWindow', () => {
  it('argmaxes each token row into a label id', async () => {
    const runtime = fakeRuntime([
      [0, 5, 0],
      [0, 0, 9],
      [1, 0, 0],
    ]);
    const outcome = await runNerWindow(
      runtime as never,
      { id: 'm', version: '1', bytes: new Uint8Array() },
      WINDOW,
      3
    );
    expect(outcome).toEqual({ status: 'ok', labelIds: [1, 2, 0] });
  });

  it('reports an error outcome instead of throwing when the output shape is wrong', async () => {
    const runtime = {
      run: async () => ({
        logits: { type: 'float32' as const, data: new Float32Array([1, 2]), dims: [1, 3, 3] },
      }),
    };
    const outcome = await runNerWindow(
      runtime as never,
      { id: 'm', version: '1', bytes: new Uint8Array() },
      WINDOW,
      3
    );
    expect(outcome).toEqual({ status: 'error', reason: 'unexpected_output_shape' });
  });

  it('reports an error outcome instead of throwing when the logits output is missing', async () => {
    const runtime = { run: async () => ({}) };
    const outcome = await runNerWindow(
      runtime as never,
      { id: 'm', version: '1', bytes: new Uint8Array() },
      WINDOW,
      3
    );
    expect(outcome).toEqual({ status: 'error', reason: 'unexpected_output_shape' });
  });

  it('reports an error outcome instead of throwing when the runtime rejects', async () => {
    const runtime = {
      run: async () => {
        throw new Error('boom');
      },
    };
    const outcome = await runNerWindow(
      runtime as never,
      { id: 'm', version: '1', bytes: new Uint8Array() },
      WINDOW,
      3
    );
    expect(outcome).toEqual({ status: 'error', reason: 'Error' });
  });
});
