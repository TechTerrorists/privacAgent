import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElementRegistry } from './index.js';

function fixture() {
  const win = Object.assign(new EventTarget(), { document: {} });
  const document = Object.assign(new EventTarget(), {
    nodeType: 9,
    defaultView: win,
    location: { href: 'https://local.test/' },
  });
  win.document = document;
  const node = () => ({
    isConnected: true,
    ownerDocument: document,
    getRootNode: () => document,
  });
  return { document: document as unknown as Document, node };
}

afterEach(() => vi.unstubAllGlobals());

describe('B-05 weak registry bookkeeping', () => {
  it('reuses only the same live node and never reuses explicitly retired IDs', () => {
    const f = fixture();
    const registry = new ElementRegistry(f.document);
    const element = f.node() as unknown as Element;
    const first = registry.register(element, registry.docId);
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') throw new Error('registration');
    expect(registry.register(element, registry.docId)).toEqual(first);
    registry.unregister(first.id);
    expect(registry.resolve(first.id, first.doc_id)).toEqual({ status: 'missing' });
    expect(registry.register(element, registry.docId)).not.toEqual(first);
    registry.dispose();
  });

  it('sweeps detached entries without GC and ignores old document IDs', () => {
    const f = fixture();
    const registry = new ElementRegistry(f.document);
    const node = f.node();
    const first = registry.register(node as unknown as Element, registry.docId);
    if (first.status !== 'ok') throw new Error('registration');
    node.isConnected = false;
    registry.sweep();
    expect(registry.resolve(first.id, first.doc_id)).toEqual({ status: 'missing' });
    registry.invalidate();
    expect(registry.resolve(first.id, first.doc_id)).toEqual({ status: 'stale' });
    expect(registry.register(node as unknown as Element, first.doc_id)).toEqual({
      status: 'stale',
    });
    registry.dispose();
    expect(registry.resolve(first.id, registry.docId)).toEqual({ status: 'disposed' });
  });

  it('handles dead WeakRefs and delayed finalizers deterministically', () => {
    const refs: { value: object | undefined }[] = [];
    let finalize: (id: string) => void = () => {};
    const held: string[] = [];
    const unregister = vi.fn();
    vi.stubGlobal(
      'WeakRef',
      class {
        value: object | undefined;
        constructor(value: object) {
          this.value = value;
          refs.push(this);
        }
        deref() {
          return this.value;
        }
      }
    );
    vi.stubGlobal(
      'FinalizationRegistry',
      class {
        constructor(callback: (id: string) => void) {
          finalize = callback;
        }
        register(_node: unknown, value: string) {
          held.push(value);
        }
        unregister = unregister;
      }
    );
    const f = fixture();
    const registry = new ElementRegistry(f.document);
    const element = f.node() as unknown as Element;
    const first = registry.register(element, registry.docId);
    if (first.status !== 'ok') throw new Error('registration');
    // Only an ID is retained by the finalizer, never the node/context.
    expect(held).toEqual([first.id]);
    for (const ref of refs) if (ref.value === element) ref.value = undefined;
    registry.sweep();
    expect(registry.resolve(first.id, first.doc_id)).toEqual({ status: 'missing' });
    const second = registry.register(element, registry.docId);
    if (second.status !== 'ok') throw new Error('registration');
    finalize(first.id);
    expect(registry.resolve(second.id, second.doc_id).status).toBe('ok');
    registry.invalidate();
    const third = registry.register(element, registry.docId);
    if (third.status !== 'ok') throw new Error('registration');
    finalize(second.id);
    expect(registry.resolve(third.id, third.doc_id).status).toBe('ok');
    registry.dispose();
    finalize(third.id);
    expect(unregister).toHaveBeenCalled();
  });

  it('cleans up listeners, isolates subscribers and supports explicit rerender invalidation', () => {
    const f = fixture();
    const registry = new ElementRegistry(f.document);
    const change = vi.fn();
    registry.onGenerationChange(() => {
      throw new Error('PRIVATE');
    });
    const unsubscribe = registry.onGenerationChange(change);
    const initial = registry.docId;
    registry.invalidate();
    expect(registry.docId).not.toBe(initial);
    expect(change).toHaveBeenCalledWith({
      doc_id: registry.docId,
      reason: 'explicit',
      scope: 'top',
    });
    unsubscribe();
    registry.dispose();
    const finalId = registry.docId;
    f.document.defaultView!.dispatchEvent(new Event('pagehide'));
    expect(registry.docId).toBe(finalId);
    expect(change).toHaveBeenCalledTimes(1);
  });
});
