import { createIdleScheduler, runInChunks } from '../dom-extract/scheduler.js';
import { walkRegisteredDocument } from '../element-registry/walk.js';
import type { RegisteredWalk } from '../element-registry/walk.js';
import type { ElementRegistry } from '../element-registry/index.js';
import type { DocumentId, ElementId, Element as WireElement } from '@privacagent/protocol';
import { SemanticEngine, live } from './engine.js';
import type { LocalSemantics, SemanticBatch, SemanticOptions } from './types.js';
export type * from './types.js';

/** Independent local semantics. Does not read/replace the B-02 privacy evidence arrays. */
export async function extractSemantics(
  targets: readonly Element[],
  options: SemanticOptions = {}
): Promise<SemanticBatch> {
  const engine = new SemanticEngine(options);
  const win = targets[0]?.ownerDocument.defaultView;
  if (!win && !options.scheduler) {
    if (targets.length) throw new TypeError('Semantic extraction requires a live document');
    return {
      status: 'complete',
      results: [],
      metrics: { chunks: 0, workUnits: 0, activeMs: 0, elapsedMs: 0, longestChunkMs: 0 },
    };
  }
  const results: LocalSemantics[] = [];
  let index = 0;
  let job: Generator<void, LocalSemantics, void> | undefined;
  const run = await runInChunks(
    () => {
      const target = targets[index];
      if (!target) return false;
      job ??= engine.extract(target);
      const step = job.next();
      if (step.done) {
        results.push(step.value);
        index++;
        job = undefined;
      }
      return true;
    },
    { ...options, scheduler: options.scheduler ?? createIdleScheduler(win!) }
  );
  job?.return({
    status: 'stale',
    role: null,
    roleSource: 'none',
    name: '',
    nameSource: 'none',
    description: '',
    descriptionSource: 'none',
    fallback: null,
    dependencies: { nodes: [], scopes: [], references: [] },
    workUnits: 0,
  });
  if (run.status !== 'complete') return { status: run.status, metrics: run.metrics };
  // Validate again: a child document may have detached while later targets were processed.
  const validation = await runInChunks(
    () => {
      const target = targets[--index];
      if (!target) return false;
      if (!live(target)) {
        const result = results[index]!;
        result.status = 'stale';
        result.name = '';
        result.description = '';
        result.fallback = null;
        result.role = null;
        result.roleSource = 'none';
        result.nameSource = 'none';
        result.descriptionSource = 'none';
      }
      return true;
    },
    { ...options, scheduler: options.scheduler ?? createIdleScheduler(win!) }
  );
  if (validation.status !== 'complete')
    return { status: validation.status, metrics: validation.metrics };
  return {
    status: 'complete',
    results,
    metrics: {
      chunks: run.metrics.chunks + validation.metrics.chunks,
      workUnits: run.metrics.workUnits + validation.metrics.workUnits,
      activeMs: run.metrics.activeMs + validation.metrics.activeMs,
      elapsedMs: run.metrics.elapsedMs + validation.metrics.elapsedMs,
      longestChunkMs: Math.max(run.metrics.longestChunkMs, validation.metrics.longestChunkMs),
    },
  };
}

/** B-01 deliberately accepts role strings. Unknown semantics map to generic, never button. */
export function toElementRole(semantics: LocalSemantics): WireElement['role'] {
  return semantics.status === 'complete' ? (semantics.role ?? 'generic') : 'generic';
}

export async function extractRegisteredTarget(
  registry: ElementRegistry,
  id: ElementId,
  docId: DocumentId,
  options: SemanticOptions = {}
) {
  const resolved = registry.resolve(id, docId);
  if (resolved.status !== 'ok') return resolved;
  const extraction = await extractSemantics([resolved.element], options);
  if (extraction.status !== 'complete') return { status: extraction.status };
  const current = registry.resolve(id, docId);
  if (current.status !== 'ok') return current;
  const semantics = extraction.results[0]!;
  return { status: 'complete' as const, id, doc_id: docId, semantics, metrics: extraction.metrics };
}

export type SemanticWalk =
  | {
      status: 'complete';
      registered: Extract<RegisteredWalk, { status: 'complete' }>;
      targets: { id: ElementId; node: Element; semantics: LocalSemantics }[];
      metrics: SemanticBatch['metrics'];
    }
  | { status: 'stale' | 'cancelled' | 'error' | 'disposed' };

/** Existing walker and registry own traversal, IDs and evidence; B-03 only enriches targets. */
export async function walkSemanticDocument(
  document: Document,
  registry: ElementRegistry,
  options: SemanticOptions = {}
): Promise<SemanticWalk> {
  const registered = await walkRegisteredDocument(document, registry, options);
  if (registered.status !== 'complete') return registered;
  const extraction = await extractSemantics(
    registered.targets.map((t) => t.node),
    options
  );
  if (extraction.status !== 'complete') return { status: extraction.status };
  if (registry.isDisposed) return { status: 'disposed' };
  if (registry.docId !== registered.doc_id) return { status: 'stale' };
  const targets: Extract<SemanticWalk, { status: 'complete' }>['targets'] = [];
  let i = 0;
  const validation = await runInChunks(
    () => {
      if (registry.isDisposed || registry.docId !== registered.doc_id) return 'stale';
      const target = registered.targets[i];
      if (!target) return false;
      const semantics = extraction.results[i++]!;
      if (
        registry.resolve(target.id, registered.doc_id).status === 'ok' &&
        semantics.status !== 'stale'
      )
        targets.push({ ...target, semantics });
      return true;
    },
    { ...options, scheduler: options.scheduler ?? createIdleScheduler(document.defaultView!) }
  );
  if (validation.status !== 'complete') return { status: validation.status };
  return { status: 'complete', registered, targets, metrics: extraction.metrics };
}
