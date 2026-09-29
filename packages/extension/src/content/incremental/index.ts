import { walkDocument, walkSubtree } from '../dom-extract/index.js';
import { createIdleScheduler, runInChunks } from '../dom-extract/scheduler.js';
import type { WalkMetrics } from '../dom-extract/scheduler.js';
import type { WalkResult, TraversalContext } from '../dom-extract/types.js';
import { candidateReasons, ignoresContent } from '../dom-extract/candidates.js';
import { ElementRegistry } from '../element-registry/index.js';
import { extractSemantics } from '../semantics/index.js';
import { SemanticEngine } from '../semantics/engine.js';
import type { LocalSemantics, SemanticScope } from '../semantics/types.js';
import type { ElementId } from '@privacagent/protocol';
import type {
  CandidateSnapshot,
  EvidenceSnapshot,
  IncrementalOptions,
  InvalidationReason,
  LocalDiff,
  ObservationResult,
} from './types.js';
export type * from './types.js';

interface Entry {
  node: Element;
  snapshot: CandidateSnapshot;
  dependencies: LocalSemantics['dependencies'];
  key: string;
}
interface Evidence {
  node: Node;
  snapshot: EvidenceSnapshot;
  key: string;
}
interface RootOwner {
  cleanup(): void;
  observer: MutationObserver;
  context: TraversalContext;
}
class Limit extends Error {}
const zero = (): WalkMetrics => ({
  chunks: 0,
  workUnits: 0,
  activeMs: 0,
  elapsedMs: 0,
  longestChunkMs: 0,
});
function addMetrics(target: WalkMetrics, source: WalkMetrics) {
  target.chunks += source.chunks;
  target.workUnits += source.workUnits;
  target.activeMs += source.activeMs;
  target.longestChunkMs = Math.max(target.longestChunkMs, source.longestChunkMs);
}
function contains(root: Node, node: Node): boolean {
  let current: Node | null = node;
  for (let depth = 0; current && depth < 256; depth++) {
    if (root === current || root.contains(current)) return true;
    const scope: Node = current.getRootNode();
    if (scope.nodeType === 11 && 'host' in scope) current = (scope as ShadowRoot).host;
    else if (scope.nodeType === 9) {
      try {
        current = (scope as Document).defaultView?.frameElement ?? null;
      } catch {
        return false;
      }
    } else return false;
  }
  return false;
}
function diff<T extends { readonly id: string }>(
  before: Map<string, { snapshot: T; key: string }>,
  after: Map<string, { snapshot: T; key: string }>
): LocalDiff<T> {
  const added: T[] = [],
    changed: T[] = [],
    removed: string[] = [];
  for (const [id, entry] of after) {
    const prior = before.get(id);
    if (!prior) added.push(entry.snapshot);
    else if (prior.key !== entry.key) changed.push(entry.snapshot);
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  const compare = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id, 'en');
  return Object.freeze({
    added: Object.freeze(added.sort(compare)),
    changed: Object.freeze(changed.sort(compare)),
    removed: Object.freeze(removed.sort()),
  });
}

/** One on-demand local observation owner. No polling, persistence or outbound messages. */
export class IncrementalSession {
  readonly registry: ElementRegistry;
  private readonly ownRegistry: boolean;
  private readonly engine: SemanticEngine;
  private entries = new Map<string, Entry>();
  private evidence = new Map<string, Evidence>();
  private evidenceIds = new WeakMap<Node, Map<string, string>>();
  private sequence = 0;
  private observation = 0;
  private baselineDoc: string | null = null;
  private revision = 0;
  private full = true;
  private dirty = new Set<Node>();
  private records: MutationRecord[] = [];
  private roots = new Map<SemanticScope, RootOwner>();
  private listeners = new Set<(reason: InvalidationReason) => void>();
  private unsubscribe: () => void;
  private disposed = false;
  private active: AbortController | null = null;
  private overflow = false;
  private readonly maxRecords: number;
  private readonly maxEntries: number;
  private readonly maxChars: number;
  private readonly maxRoots: number;
  private readonly reconcileEvery: number;
  constructor(
    private document: Document,
    private options: IncrementalOptions = {},
    registry?: ElementRegistry
  ) {
    if (!document.defaultView)
      throw new TypeError('Incremental extraction requires a live document');
    this.registry = registry ?? new ElementRegistry(document);
    if (!this.registry.isForDocument(document))
      throw new TypeError('Registry belongs to another document');
    this.ownRegistry = !registry;
    this.engine = new SemanticEngine(options);
    this.maxRecords = options.maxRecords ?? 1024;
    this.maxEntries = options.maxEntries ?? 20000;
    this.maxChars = options.maxSnapshotChars ?? 65536;
    this.maxRoots = options.maxRoots ?? 128;
    this.reconcileEvery = options.reconcileEvery ?? 20;
    for (const n of [
      this.maxRecords,
      this.maxEntries,
      this.maxChars,
      this.maxRoots,
      this.reconcileEvery,
    ])
      if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('Invalid incremental limits');
    this.unsubscribe = this.registry.onGenerationChange((change) => {
      if (change.scope === 'top') {
        this.entries.clear();
        this.evidence.clear();
        this.baselineDoc = null;
        this.active?.abort();
      }
      this.invalidate('generation');
    });
    this.observeRoot({ document, root: document, frameElement: null, parent: null });
  }
  onRelevantMutation(listener: (reason: InvalidationReason) => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(reason: InvalidationReason) {
    for (const listener of this.listeners) {
      try {
        listener(reason);
      } catch {
        /* No page data in diagnostics. */
      }
    }
  }
  /** Use after CSSOM/attachShadow/programmatic state changes that observers cannot see. */
  invalidate(reason: InvalidationReason = 'explicit', target?: Element): void {
    if (this.disposed) return;
    this.revision++;
    if (target && reason !== 'layout' && reason !== 'roots' && contains(this.document, target))
      this.dirty.add(target);
    else this.full = true;
    if (this.dirty.size > this.maxRecords) {
      this.full = true;
      this.dirty.clear();
    }
    if (reason !== 'input') this.engine.invalidateIndexes();
    this.notify(reason);
  }
  reset(): void {
    if (this.disposed) return;
    this.active?.abort();
    this.entries.clear();
    this.evidence.clear();
    this.baselineDoc = null;
    this.evidenceIds = new WeakMap();
    this.invalidate();
  }
  private relevant(record: MutationRecord): boolean {
    const owned = this.options.ownedNodes;
    if (!owned) return true;
    // Ignore only exact extension-owned targets/additions. Mixed page batches remain relevant.
    if (owned.has(record.target)) return false;
    return (
      record.type !== 'childList' ||
      [...record.addedNodes, ...record.removedNodes].some((node) => !owned.has(node))
    );
  }
  private accept(records: MutationRecord[]) {
    let changed = false;
    for (const record of records) {
      // A single replaceChildren() record can contain an arbitrarily large node list.
      if (record.addedNodes.length + record.removedNodes.length > this.maxRecords) {
        changed = true;
        this.full = true;
        this.records.length = 0;
        this.overflow = true;
        break;
      }
      if (!this.relevant(record)) continue;
      changed = true;
      if (this.records.length < this.maxRecords) this.records.push(record);
      else {
        this.full = true;
        this.records.length = 0;
        this.overflow = true;
        break;
      }
      if (
        (record.type === 'childList' &&
          [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 1)) ||
        record.attributeName === 'id' ||
        record.attributeName === 'for' ||
        record.attributeName === 'type'
      )
        this.engine.invalidateIndexes();
      const element =
        record.target.nodeType === 1 ? (record.target as Element) : record.target.parentElement;
      if (
        element?.closest('style,link') ||
        ['class', 'style', 'hidden', 'slot', 'name'].includes(record.attributeName ?? '')
      )
        this.full = true;
    }
    if (changed) {
      this.revision++;
      this.notify(this.overflow ? 'overflow' : 'mutation');
    }
  }
  private observeRoot(context: TraversalContext) {
    if (this.roots.has(context.root)) return;
    if (this.roots.size >= this.maxRoots) throw new Limit();
    const win = context.document.defaultView;
    if (!win) return;
    const Observer = (win as Window & typeof globalThis).MutationObserver;
    const observer = new Observer((records) => this.accept(records));
    observer.observe(context.root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    const input = (event: Event) => {
      const node = event.composedPath()[0];
      if (node && 'nodeType' in node && node.nodeType === 1) {
        const element = node as HTMLInputElement;
        // Radio activation can silently uncheck another control in the same group.
        this.invalidate('input', element.type === 'radio' ? undefined : element);
      }
    };
    const layout = () => this.invalidate('layout');
    const roots = () => this.invalidate('roots');
    context.root.addEventListener('input', input, true);
    context.root.addEventListener('change', input, true);
    context.root.addEventListener('scroll', layout, true);
    context.root.addEventListener('slotchange', roots, true);
    context.root.addEventListener('load', roots, true);
    win.addEventListener('resize', layout);
    win.visualViewport?.addEventListener('resize', layout);
    win.visualViewport?.addEventListener('scroll', layout);
    this.roots.set(context.root, {
      context,
      observer,
      cleanup: () => {
        observer.disconnect();
        context.root.removeEventListener('input', input, true);
        context.root.removeEventListener('change', input, true);
        context.root.removeEventListener('scroll', layout, true);
        context.root.removeEventListener('slotchange', roots, true);
        context.root.removeEventListener('load', roots, true);
        win.removeEventListener('resize', layout);
        win.visualViewport?.removeEventListener('resize', layout);
        win.visualViewport?.removeEventListener('scroll', layout);
      },
    });
  }
  private drain() {
    for (const owner of this.roots.values()) this.accept(owner.observer.takeRecords());
  }
  private validRoot(root: SemanticScope): boolean {
    try {
      if (root === this.document) return this.document.defaultView?.document === this.document;
      const node =
        root.nodeType === 11 ? (root as ShadowRoot).host : (root as Document).documentElement;
      return (
        !!node &&
        contains(this.document, node) &&
        node.isConnected &&
        node.ownerDocument.defaultView?.document === node.ownerDocument
      );
    } catch {
      return false;
    }
  }
  private pruneRoots() {
    for (const [root, owner] of this.roots)
      if (!this.validRoot(root)) {
        owner.cleanup();
        this.roots.delete(root);
        this.full = true;
      }
  }
  private id(node: Node, kind: string): string {
    let ids = this.evidenceIds.get(node);
    if (!ids) {
      ids = new Map();
      this.evidenceIds.set(node, ids);
    }
    let id = ids.get(kind);
    if (!id) {
      id = `local-evidence-${++this.sequence}`;
      ids.set(kind, id);
    }
    return id;
  }
  private checkedText(text: string): string {
    if (text.length > this.maxChars) throw new Limit();
    return text;
  }
  private snapshotEvidence(node: Node, kind: EvidenceSnapshot['kind']): Evidence {
    let text: string | null = null;
    const attributes: (readonly [string, string])[] = [];
    if (kind === 'text') text = this.checkedText((node as Text).data);
    if (kind === 'attributes') {
      let size = 0;
      for (const attribute of (node as Element).attributes) {
        size += attribute.name.length + attribute.value.length;
        if (size > this.maxChars || attributes.length > 512) throw new Limit();
        attributes.push(Object.freeze([attribute.name, attribute.value] as const));
      }
      attributes.sort((a, b) => a[0].localeCompare(b[0], 'en'));
    }
    if (kind === 'value') text = this.value(node as Element);
    const snapshot = Object.freeze({
      id: this.id(node, kind),
      kind,
      text,
      attributes: Object.freeze(attributes),
    });
    return { node, snapshot, key: JSON.stringify(snapshot) };
  }
  private value(node: Element): string | null {
    if (node.localName === 'input' && (node as HTMLInputElement).type === 'password') return null;
    return ['input', 'textarea', 'select'].includes(node.localName)
      ? this.checkedText((node as HTMLInputElement).value)
      : null;
  }
  private snapshot(node: Element, id: ElementId, semantics: LocalSemantics): Entry {
    const { dependencies, workUnits: _work, ...fields } = semantics;
    const state: Record<string, string | boolean> = {};
    for (const key of ['disabled', 'checked', 'selected', 'multiple', 'required', 'readOnly'])
      if (key in node && typeof (node as unknown as Record<string, unknown>)[key] === 'boolean')
        state[key] = (node as unknown as Record<string, boolean>)[key]!;
    for (const key of [
      'expanded',
      'invalid',
      'checked',
      'selected',
      'required',
      'readonly',
      'disabled',
    ]) {
      const value = node.getAttribute(`aria-${key}`);
      if (value !== null) state[`aria-${key}`] = this.checkedText(value);
    }
    let parent: ElementId | null = null;
    if (node.parentElement) {
      const registered = this.registry.register(node.parentElement, this.registry.docId);
      if (registered.status === 'ok') parent = registered.id;
    }
    const snapshot: CandidateSnapshot = Object.freeze({
      id,
      semantics: Object.freeze({
        ...fields,
        fallback: fields.fallback ? Object.freeze({ ...fields.fallback }) : null,
      }),
      state: Object.freeze(state),
      value: this.value(node),
      parent,
      geometry: null,
    });
    return { node, snapshot, dependencies, key: JSON.stringify(snapshot) };
  }
  /** Returns counters only; never raw page data. */
  diagnostics() {
    return {
      roots: this.roots.size,
      candidates: this.entries.size,
      evidence: this.evidence.size,
      queued: this.records.length,
      dirty: this.dirty.size,
      disposed: this.disposed,
    };
  }
  async extract(signal: AbortSignal | undefined = this.options.signal): Promise<ObservationResult> {
    if (this.disposed) return { status: 'disposed' };
    if (this.active) return { status: 'busy' };
    this.drain();
    this.pruneRoots();
    const docId = this.registry.docId;
    const full =
      this.full ||
      this.baselineDoc !== docId ||
      (this.observation > 0 && this.observation % this.reconcileEvery === 0);
    const revision = this.revision;
    const controller = new AbortController();
    this.active = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const start = performance.now();
    const metrics = {
      ...zero(),
      fullWalks: 0,
      subtreeWalks: 0,
      extracted: 0,
      cached: this.entries.size,
    };
    const options = {
      ...this.options,
      signal: controller.signal,
      scheduler: this.options.scheduler ?? createIdleScheduler(this.document.defaultView!),
      onRoot: (context: TraversalContext) => this.observeRoot(context),
    };
    const run = async (work: Generator<void, void, void>) => {
      let failure: unknown;
      const result = await runInChunks(() => {
        try {
          return !work.next().done;
        } catch (error) {
          failure = error;
          throw error;
        }
      }, options);
      if (failure) throw failure;
      addMetrics(metrics, result.metrics);
      if (result.status !== 'complete') throw new Error(result.status);
    };
    try {
      if (full) this.engine.invalidateIndexes();
      const affected = new Set<Node>(this.dirty);
      const scan = new Set<Element>();
      const dirtyScopes = new Set<Node>();
      // Structural changes need subtree discovery. Semantic dependencies are invalidated independently.
      for (const record of this.records) {
        affected.add(record.target);
        if (
          (record.type === 'childList' &&
            [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 1)) ||
          ['id', 'for', 'type'].includes(record.attributeName ?? '')
        )
          dirtyScopes.add(record.target.getRootNode());
        if (record.type === 'childList') {
          const target =
            record.target.nodeType === 1
              ? (record.target as Element)
              : (record.target as ShadowRoot).host;
          if (target) scan.add(target);
          else this.full = true;
          for (const node of record.removedNodes) affected.add(node);
          for (const node of record.addedNodes) affected.add(node);
        } else if (record.type === 'attributes') scan.add(record.target as Element);
      }
      if (this.full && !full) return { status: 'unstable' };
      const roots: Element[] = [];
      for (const node of scan)
        if (
          node.isConnected &&
          contains(this.document, node) &&
          ![...scan].some((other) => other !== node && contains(other, node))
        )
          roots.push(node);
      const next = full ? new Map<string, Entry>() : new Map(this.entries);
      const nextEvidence = full ? new Map<string, Evidence>() : new Map(this.evidence);
      const candidates = new Set<Element>();
      const evidenceNodes: { node: Node; kind: EvidenceSnapshot['kind'] }[] = [];
      const consume = function* (walk: Extract<WalkResult, { status: 'complete' }>) {
        for (const candidate of walk.candidates) {
          candidates.add(candidate.node);
          yield;
        }
        for (const item of walk.evidence.textNodes) {
          evidenceNodes.push({ node: item.node, kind: 'text' });
          yield;
        }
        for (const item of walk.evidence.attributeElements) {
          evidenceNodes.push({ node: item.node, kind: 'attributes' });
          yield;
        }
      };
      if (full) {
        metrics.fullWalks++;
        const walk = await walkDocument(this.document, options);
        addMetrics(metrics, walk.metrics);
        if (walk.status !== 'complete') return { status: walk.status };
        await run(consume(walk));
      } else {
        await run(
          function* (this: IncrementalSession) {
            for (const [id, entry] of next) {
              if (this.registry.resolve(entry.snapshot.id, docId).status !== 'ok') next.delete(id);
              else if (roots.some((root) => contains(root, entry.node))) {
                next.delete(id);
              } else if (
                entry.dependencies.scopes.some((scope) => dirtyScopes.has(scope)) ||
                [...affected].some(
                  (node) =>
                    contains(node, entry.node) ||
                    entry.dependencies.nodes.some(
                      (dependency) => node === dependency || contains(node, dependency)
                    ) ||
                    (node.nodeType === 1 &&
                      ['label', 'style', 'link'].includes((node as Element).localName) &&
                      entry.dependencies.scopes.includes(node.getRootNode() as SemanticScope))
                )
              )
                candidates.add(entry.node);
              yield;
            }
            for (const [id, entry] of nextEvidence) {
              if (
                !entry.node.isConnected ||
                !contains(this.document, entry.node) ||
                roots.some((root) => contains(root, entry.node))
              )
                nextEvidence.delete(id);
              else if ([...affected].some((node) => contains(node, entry.node)))
                evidenceNodes.push({ node: entry.node, kind: entry.snapshot.kind });
              yield;
            }
            for (const node of affected) {
              if (
                node.nodeType === 3 &&
                node.isConnected &&
                !node.parentElement?.closest('script,style,template,noscript')
              )
                evidenceNodes.push({ node, kind: 'text' });
              if (node.nodeType === 1 && node.isConnected) {
                const element = node as Element;
                if (!ignoresContent(element) && candidateReasons(element).length)
                  candidates.add(element);
                if (['input', 'textarea', 'select'].includes(element.localName))
                  evidenceNodes.push({ node, kind: 'value' });
              }
              yield;
            }
          }.call(this)
        );
        for (const root of roots) {
          metrics.subtreeWalks++;
          const walk = await walkSubtree(root, options);
          addMetrics(metrics, walk.metrics);
          if (walk.status !== 'complete') {
            this.full = true;
            return { status: 'unstable' };
          }
          await run(consume(walk));
        }
      }
      if (candidates.size > this.maxEntries || evidenceNodes.length > this.maxEntries)
        throw new Limit();
      const nodes = [...candidates].filter(
        (node) =>
          !this.options.ownedNodes?.has(node) && node.isConnected && contains(this.document, node)
      );
      const semantics = await extractSemantics(nodes, options, this.engine);
      addMetrics(metrics, semantics.metrics);
      if (semantics.status !== 'complete') return { status: semantics.status };
      metrics.extracted = nodes.length;
      await run(
        function* (this: IncrementalSession) {
          for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i]!;
            const registered = this.registry.register(node, docId);
            if (registered.status === 'ok' && semantics.results[i]!.status !== 'stale') {
              const entry = this.snapshot(node, registered.id, semantics.results[i]!);
              next.set(registered.id, entry);
              if (['input', 'textarea', 'select'].includes(node.localName))
                evidenceNodes.push({ node, kind: 'value' });
            }
            yield;
          }
          for (const item of evidenceNodes) {
            if (
              item.node.isConnected &&
              contains(this.document, item.node) &&
              !this.options.ownedNodes?.has(item.node)
            ) {
              const evidence = this.snapshotEvidence(item.node, item.kind);
              nextEvidence.set(evidence.snapshot.id, evidence);
            }
            if (next.size > this.maxEntries || nextEvidence.size > this.maxEntries)
              throw new Limit();
            yield;
          }
        }.call(this)
      );
      this.drain();
      if (this.disposed) return { status: 'disposed' };
      if (controller.signal.aborted) return { status: 'cancelled' };
      if (this.registry.docId !== docId) return { status: 'stale' };
      if (revision !== this.revision) {
        this.engine.invalidateIndexes();
        return { status: 'unstable' };
      }
      const baseline = this.baselineDoc === docId ? this.observation : null;
      const candidateDiff = diff(baseline === null ? new Map() : this.entries, next);
      const evidenceDiff = diff(baseline === null ? new Map() : this.evidence, nextEvidence);
      this.entries = next;
      this.evidence = nextEvidence;
      this.baselineDoc = docId;
      this.observation++;
      this.full = false;
      this.overflow = false;
      this.dirty.clear();
      this.records.length = 0;
      this.pruneRoots();
      metrics.elapsedMs = performance.now() - start;
      return Object.freeze({
        status: 'complete',
        doc_id: docId,
        baseline,
        observation: this.observation,
        full,
        candidates: candidateDiff,
        evidence: evidenceDiff,
        metrics: Object.freeze(metrics),
      });
    } catch (error) {
      this.full = true;
      this.engine.invalidateIndexes();
      if (error instanceof Limit) return { status: 'limited' };
      return {
        status: this.disposed ? 'disposed' : controller.signal.aborted ? 'cancelled' : 'error',
      };
    } finally {
      signal?.removeEventListener('abort', abort);
      this.active = null;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.abort();
    this.unsubscribe();
    for (const root of this.roots.values()) root.cleanup();
    this.roots.clear();
    this.entries.clear();
    this.evidence.clear();
    this.dirty.clear();
    this.records.length = 0;
    this.listeners.clear();
    this.engine.invalidateIndexes();
    this.evidenceIds = new WeakMap();
    if (this.ownRegistry) this.registry.dispose();
  }
}
