import { candidateReasons, ignoresContent } from './candidates.js';
import { createIdleScheduler, runInChunks } from './scheduler.js';
import type {
  FrameBoundary,
  LocalCandidate,
  LocalEvidence,
  TraversalContext,
  WalkOptions,
  WalkResult,
} from './types.js';

export type * from './types.js';
export type { WorkScheduler, WorkDeadline, WalkMetrics } from './scheduler.js';

/** B-02: discover local DOM candidates. No serialization, IDs, geometry or egress. */
export async function walkDocument(
  document: Document,
  options: WalkOptions = {}
): Promise<WalkResult> {
  return walkRoot(document, options);
}

/** Same B-02 traversal, limited to an attached subtree (including its root element). */
export async function walkSubtree(
  element: Element,
  options: WalkOptions = {}
): Promise<WalkResult> {
  return walkRoot(element.ownerDocument, options, element);
}

async function walkRoot(
  document: Document,
  options: WalkOptions,
  subtree?: Element
): Promise<WalkResult> {
  const win = document.defaultView;
  if (!win) throw new TypeError('DOM walker requires a live document');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let pageHidden = false;
  const hide = () => {
    pageHidden = true;
    controller.abort();
  };
  const candidates: LocalCandidate[] = [];
  const evidence: LocalEvidence = { textNodes: [], attributeElements: [] };
  const frames: FrameBoundary[] = [];
  const contexts: TraversalContext[] = [];
  const queue: { context: TraversalContext; walker: TreeWalker; first?: Element }[] = [];
  const visited = new WeakSet<Node>();
  const roots = new WeakSet<Node>();
  const excluded = new WeakSet<Node>();
  const invalid = new Set<TraversalContext>();
  let queueIndex = 0;
  let validationIndex = 0;
  let cleanupIndex = 0;
  let phase: 'walk' | 'validate' | 'cleanup' = 'walk';

  const addRoot = (context: TraversalContext, start?: Element) => {
    if (roots.has(context.root)) return;
    roots.add(context.root);
    options.onRoot?.(context);
    contexts.push(context);
    // No candidate filter inside nextNode(): it must return even non-candidates,
    // so a long run of skipped elements cannot bypass the scheduling budget.
    queue.push({
      context,
      walker: context.document.createTreeWalker(start ?? context.root),
      ...(start ? { first: start } : {}),
    });
  };
  const current = (context: TraversalContext): boolean => {
    try {
      if (invalid.has(context) || (context.parent && invalid.has(context.parent))) return false;
      if (context.document.defaultView?.document !== context.document) return false;
      if (
        context.frameElement &&
        (!context.frameElement.isConnected ||
          context.frameElement.contentDocument !== context.document)
      )
        return false;
      if (context.root.nodeType === 11) {
        const host = (context.root as ShadowRoot).host;
        if (!host.isConnected || host.ownerDocument !== context.document) return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  // One item per unit: discarding a large invalid child must also yield to the scheduler.
  const compact = <T>(items: T[], keep: (item: T) => boolean) => {
    let read = 0;
    let write = 0;
    return () => {
      if (read === items.length) {
        items.length = write;
        return false;
      }
      const item = items[read++]!;
      if (keep(item)) items[write++] = item;
      return true;
    };
  };
  const keepNode = ({ node, context }: { node: Node; context: TraversalContext }) =>
    !invalid.has(context) &&
    node.isConnected &&
    node.ownerDocument === context.document &&
    node.getRootNode() === context.root;
  const cleanup = [
    compact(candidates, keepNode),
    compact(evidence.textNodes, keepNode),
    compact(evidence.attributeElements, keepNode),
    compact(frames, keepNode),
    compact(contexts, (context) => !invalid.has(context)),
  ];
  const skip = (context: TraversalContext): true | 'stale' => {
    if (!context.parent) return 'stale';
    invalid.add(context);
    queueIndex++;
    return true;
  };

  const step = (): boolean | 'stale' => {
    if (pageHidden || win.document !== document) return 'stale';
    if (phase === 'cleanup') {
      const clean = cleanup[cleanupIndex];
      if (!clean) return false;
      if (!clean()) cleanupIndex++;
      return true;
    }
    if (phase === 'validate') {
      const context = contexts[validationIndex++];
      if (!context) {
        if (!invalid.size) return false;
        phase = 'cleanup';
        return true;
      }
      // Discovery order is parent-before-child, propagating invalidation without
      // an unbounded recursive ancestry scan or retaining invalid descendants.
      if (!current(context)) {
        if (!context.parent) return 'stale';
        invalid.add(context);
      }
      return true;
    }
    const job = queue[queueIndex];
    if (!job) {
      phase = 'validate';
      return true;
    }
    if (!current(job.context)) return skip(job.context);
    if (
      job.walker.currentNode !== job.context.root &&
      (!job.walker.currentNode.isConnected ||
        job.walker.currentNode.getRootNode() !== job.context.root)
    )
      return skip(job.context);
    const node = job.first ?? job.walker.nextNode();
    delete job.first;
    if (!node) {
      queueIndex++;
      return true;
    }
    if (
      !node.isConnected ||
      node.ownerDocument !== job.context.document ||
      node.getRootNode() !== job.context.root
    )
      return skip(job.context);
    if (visited.has(node)) return true;
    visited.add(node);
    if (node.parentNode && excluded.has(node.parentNode)) {
      excluded.add(node);
      return true;
    }
    if (node.nodeType === 3) {
      if (node.parentElement && !ignoresContent(node.parentElement)) {
        evidence.textNodes.push({ node: node as Text, context: job.context });
      }
      return true;
    }
    if (node.nodeType !== 1) return true;
    const element = node as Element;
    if (ignoresContent(element)) {
      excluded.add(element);
      return true;
    }
    // Attribute nodes and values are not copied, enumerated or interpreted here.
    // Keep the handle separate so D-01 cannot confuse DOM text with attributes.
    if (element.hasAttributes())
      evidence.attributeElements.push({ node: element, context: job.context });
    const reasons = candidateReasons(element);
    if (reasons.length) candidates.push({ node: element, context: job.context, reasons });
    if (element.shadowRoot) {
      addRoot({
        document: job.context.document,
        root: element.shadowRoot,
        frameElement: job.context.frameElement,
        parent: job.context,
      });
    }
    if (element.localName === 'iframe') {
      const frame = element as HTMLIFrameElement;
      let child: Document | null = null;
      try {
        child = frame.contentDocument;
      } catch {
        /* opaque origin */
      }
      const access = child
        ? child.readyState === 'loading'
          ? 'unloaded'
          : 'same-origin'
        : 'opaque';
      frames.push({ node: frame, context: job.context, access });
      if (child && access === 'same-origin') {
        addRoot({ document: child, root: child, frameElement: frame, parent: job.context });
      }
    }
    return true;
  };

  try {
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', cancel, { once: true });
    win.addEventListener('pagehide', hide, { once: true });
    const root = subtree?.getRootNode() ?? document;
    if (
      root.nodeType !== 9 &&
      !(root.nodeType === 11 && 'host' in root && (root as ShadowRoot).mode === 'open')
    )
      throw new Error('Inaccessible traversal root');
    addRoot(
      {
        document,
        root: root as Document | ShadowRoot,
        frameElement: document.defaultView?.frameElement as HTMLIFrameElement | null,
        parent: null,
      },
      subtree
    );
    const result = await runInChunks(step, {
      ...options,
      signal: controller.signal,
      scheduler: options.scheduler ?? createIdleScheduler(win),
    });
    if (result.status !== 'complete') {
      candidates.length =
        evidence.textNodes.length =
        evidence.attributeElements.length =
        frames.length =
        contexts.length =
          0;
      return { ...result, status: pageHidden ? 'stale' : result.status };
    }
    return { ...result, status: 'complete', candidates, evidence, frames, contexts };
  } finally {
    queue.length = 0;
    invalid.clear();
    options.signal?.removeEventListener('abort', cancel);
    win.removeEventListener('pagehide', hide);
  }
}
