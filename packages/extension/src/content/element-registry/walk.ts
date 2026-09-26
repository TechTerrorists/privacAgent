import { walkDocument } from '../dom-extract/index.js';
import type { WalkOptions, WalkResult } from '../dom-extract/types.js';
import type { ElementRegistry } from './index.js';
import type { DocumentId, ElementId } from '@privacagent/protocol';

/** Local-only result; caller owns (and must release) the walk's DOM references. */
export type RegisteredWalk =
  | {
      status: 'complete';
      doc_id: DocumentId;
      walk: Extract<WalkResult, { status: 'complete' }>;
      targets: { id: ElementId; node: Element }[];
    }
  | { status: 'stale' | 'cancelled' | 'error' | 'disposed' };

export async function walkRegisteredDocument(
  document: Document,
  registry: ElementRegistry,
  options: WalkOptions = {}
): Promise<RegisteredWalk> {
  if (registry.isDisposed) return { status: 'disposed' };
  if (!registry.isForDocument(document)) return { status: 'stale' };
  registry.sweep();
  const docId = registry.docId;
  const controller = new AbortController();
  let invalidated = false;
  const unsubscribe = registry.onGenerationChange(({ scope }) => {
    if (scope === 'top') {
      invalidated = true;
      controller.abort();
    }
  });
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const walk = await walkDocument(document, { ...options, signal: controller.signal });
    if (invalidated || registry.docId !== docId) return { status: 'stale' };
    if (walk.status !== 'complete') return { status: walk.status };
    const targets: { id: ElementId; node: Element }[] = [];
    for (const candidate of walk.candidates) {
      const result = registry.register(candidate.node, docId);
      if (result.status === 'disposed') return result;
      if (result.status === 'ok') targets.push({ id: result.id, node: candidate.node });
    }
    if (registry.docId !== docId) return { status: 'stale' };
    return { status: 'complete', doc_id: docId, walk, targets };
  } finally {
    unsubscribe();
    options.signal?.removeEventListener('abort', abort);
    registry.sweep();
  }
}
