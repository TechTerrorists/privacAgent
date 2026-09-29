// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: { id: 'test', onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
    // F-08's companion preference rides on storage. `startContentSession` subscribes at
    // construction, so the stub has to cover `storage.local` and `storage.onChanged` or the
    // session throws before it is ever exercised here. Nothing in this test asserts on the
    // preference itself — `preferences.test.ts` and `companion.test.ts` do that — this is only
    // here so the session can be built.
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined)
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  }
}));
import { startContentSession } from './session.js';
it('owns lazy incremental extraction and retires it with the content session', async () => {
  document.body.innerHTML = '<button>Page</button>';
  const session = startContentSession(document);
  const extraction = session.extraction;
  expect(session.extraction).toBe(extraction);
  expect(extraction.registry).toBe(session.registry);
  const pending = extraction.extract();
  session.dispose();
  expect(['disposed', 'cancelled']).toContain((await pending).status);
  expect(extraction.diagnostics()).toMatchObject({
    roots: 0,
    candidates: 0,
    evidence: 0,
    disposed: true,
  });
  expect(() => session.extraction).toThrow('disposed');
  session.dispose();
  const replacement = startContentSession(document);
  expect(replacement.registry.docId).not.toBe(session.registry.docId);
  replacement.dispose();
});
