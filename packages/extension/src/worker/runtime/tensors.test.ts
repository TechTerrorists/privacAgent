import { describe, expect, it } from 'vitest';

import { TensorScope, withTensorScope, type Disposable } from './tensors.js';

function fakeTensor(): Disposable & { disposed: number } {
  return {
    disposed: 0,
    dispose() {
      this.disposed += 1;
    },
  };
}

describe('TensorScope', () => {
  it('frees everything it owns', () => {
    const scope = new TensorScope();
    const a = scope.own(fakeTensor());
    const b = scope.own(fakeTensor());

    scope.disposeAll();

    expect(a.disposed).toBe(1);
    expect(b.disposed).toBe(1);
    expect(scope.size).toBe(0);
  });

  it('leaves released tensors alone', () => {
    const scope = new TensorScope();
    const kept = scope.own(fakeTensor());
    const temporary = scope.own(fakeTensor());

    scope.release(kept);
    scope.disposeAll();

    // The returned output must survive the operation that produced it.
    expect(kept.disposed).toBe(0);
    expect(temporary.disposed).toBe(1);
  });

  it('is idempotent', () => {
    const scope = new TensorScope();
    const tensor = scope.own(fakeTensor());

    scope.disposeAll();
    scope.disposeAll();

    expect(tensor.disposed).toBe(1);
  });

  it('keeps freeing after one tensor fails to dispose', () => {
    const scope = new TensorScope();
    scope.own({
      dispose() {
        throw new Error('already destroyed');
      },
    });
    const healthy = scope.own(fakeTensor());

    expect(() => scope.disposeAll()).not.toThrow();
    // One bad tensor must not turn into a full leak.
    expect(healthy.disposed).toBe(1);
  });
});

describe('withTensorScope', () => {
  it('frees temporaries on the success path', async () => {
    const temporary = fakeTensor();

    await withTensorScope(async (scope) => {
      scope.own(temporary);
      return 'done';
    });

    expect(temporary.disposed).toBe(1);
  });

  it('frees temporaries on the failure path', async () => {
    const temporary = fakeTensor();

    await expect(
      withTensorScope(async (scope) => {
        scope.own(temporary);
        throw new Error('inference failed');
      })
    ).rejects.toThrow('inference failed');

    // Failure is exactly when temporaries are most likely to be left behind.
    expect(temporary.disposed).toBe(1);
  });

  it('never disposes a caller-owned input', async () => {
    const callerOwned = fakeTensor();

    await withTensorScope(async () => {
      // Deliberately not registered: the caller may still hold its backing data.
      return callerOwned;
    });

    expect(callerOwned.disposed).toBe(0);
  });

  it('preserves a returned output while freeing the rest', async () => {
    const output = fakeTensor();
    const temporary = fakeTensor();

    const returned = await withTensorScope(async (scope) => {
      scope.own(temporary);
      return scope.release(scope.own(output));
    });

    expect(returned).toBe(output);
    expect(output.disposed).toBe(0);
    expect(temporary.disposed).toBe(1);
  });
});
