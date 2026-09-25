import type { DocumentId, ElementId } from '@privacagent/protocol';

// getRandomValues is also available on ordinary HTTP pages.
function newDocumentId(): DocumentId {
  return `d${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export const NAVIGATION_HINT = 'privacagent:b05:navigation';
export type ChangeReason = 'route' | 'pagehide' | 'pageshow' | 'explicit' | 'dispose';
export interface GenerationChange {
  doc_id: DocumentId;
  reason: ChangeReason;
  /** Child changes invalidate only that document's entries, not the enclosing observation. */
  scope: 'top' | 'child';
}
export type Resolution =
  { status: 'ok'; element: Element } | { status: 'missing' | 'stale' | 'disposed' };
export type Registration =
  { status: 'ok'; doc_id: DocumentId; id: ElementId } | { status: 'stale' | 'disposed' };

interface DocumentState {
  document: WeakRef<Document>;
  href: string;
  version: number;
  hidden: boolean;
  removeListeners: () => void;
}
interface Scope {
  root: WeakRef<Document | ShadowRoot>;
  document: DocumentState;
  version: number;
  frame: WeakRef<Element> | null;
}
interface Entry {
  node: WeakRef<Element>;
  scopes: Scope[];
  token: object;
}

/**
 * Local DOM identity only. Never serialize this object or the resolved nodes.
 * Each instance belongs to one requested top document, including its accessible children.
 */
export class ElementRegistry {
  private readonly top: WeakRef<Document>;
  private forward = new WeakMap<Element, ElementId>();
  private readonly reverse = new Map<ElementId, Entry>();
  private readonly documents = new Set<DocumentState>();
  private readonly documentStates = new WeakMap<Document, DocumentState>();
  private readonly listeners = new Set<(change: GenerationChange) => void>();
  private readonly finalizer: FinalizationRegistry<ElementId>;
  private generation: DocumentId = newDocumentId();
  private sequence = 0;
  private disposed = false;

  constructor(document: Document) {
    // Required in supported browsers; deliberately no strong-reference fallback.
    this.top = new WeakRef(document);
    this.finalizer = new FinalizationRegistry((id) => this.remove(id));
    this.watch(document);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  isForDocument(document: Document): boolean {
    return !this.disposed && this.top.deref() === document;
  }

  get docId(): DocumentId {
    this.refresh();
    return this.generation;
  }

  onGenerationChange(listener: (change: GenerationChange) => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  register(element: Element, expectedDocId: DocumentId): Registration {
    if (this.disposed) return { status: 'disposed' };
    this.refresh();
    if (expectedDocId !== this.generation) return { status: 'stale' };
    const prior = this.forward.get(element);
    if (prior && this.resolve(prior, expectedDocId).status === 'ok') {
      return { status: 'ok', doc_id: this.generation, id: prior };
    }
    const scopes = this.capture(element);
    if (!scopes || expectedDocId !== this.generation) return { status: 'stale' };
    const id: ElementId = `e${++this.sequence}`;
    const token = {};
    this.reverse.set(id, { node: new WeakRef(element), scopes, token });
    this.forward.set(element, id);
    this.finalizer.register(element, id, token);
    return { status: 'ok', doc_id: this.generation, id };
  }

  resolve(id: ElementId, expectedDocId: DocumentId): Resolution {
    if (this.disposed) return { status: 'disposed' };
    this.refresh();
    if (expectedDocId !== this.generation) return { status: 'stale' };
    const entry = this.reverse.get(id);
    if (!entry) return { status: 'missing' };
    const element = entry.node.deref();
    if (!element || !this.valid(element, entry.scopes)) {
      this.remove(id);
      return { status: 'missing' };
    }
    return { status: 'ok', element };
  }

  unregister(id: ElementId): void {
    this.remove(id);
  }

  /** Call for an explicit major rerender that keeps the URL unchanged. */
  invalidate(): void {
    if (this.disposed) return;
    const doc = this.top.deref();
    if (doc) this.change(this.watch(doc), 'explicit');
  }

  /** Per-step cleanup: deterministic, with no reliance on GC/finalizer scheduling. */
  sweep(): void {
    if (this.disposed) return;
    this.refresh();
    const used = new Set<DocumentState>();
    for (const [id, entry] of this.reverse) {
      const node = entry.node.deref();
      if (!node || !this.valid(node, entry.scopes)) this.remove(id);
      else for (const scope of entry.scopes) used.add(scope.document);
    }
    for (const state of this.documents) {
      const document = state.document.deref();
      if (document === this.top.deref() || used.has(state)) continue;
      state.removeListeners();
      this.documents.delete(state);
      if (document) this.documentStates.delete(document);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    for (const state of this.documents) state.removeListeners();
    this.documents.clear();
    this.emit('dispose', 'top');
    this.listeners.clear();
  }

  private remove(id: ElementId): void {
    const entry = this.reverse.get(id);
    if (!entry) return;
    const node = entry.node.deref();
    if (node && this.forward.get(node) === id) this.forward.delete(node);
    this.finalizer.unregister(entry.token);
    this.reverse.delete(id);
  }

  private clear(): void {
    for (const entry of this.reverse.values()) this.finalizer.unregister(entry.token);
    this.reverse.clear();
    this.forward = new WeakMap();
  }

  private emit(reason: ChangeReason, scope: 'top' | 'child'): void {
    for (const listener of this.listeners) {
      // A broken UI subscriber must not prevent lifecycle cleanup or other subscribers.
      try {
        listener({ doc_id: this.generation, reason, scope });
      } catch {
        /* local only */
      }
    }
  }

  private change(state: DocumentState, reason: ChangeReason): void {
    state.version++;
    const top = state.document.deref() === this.top.deref();
    if (top) {
      this.clear();
      this.generation = newDocumentId();
    } else {
      for (const [id, entry] of this.reverse) {
        if (entry.scopes.some((scope) => scope.document === state)) this.remove(id);
      }
    }
    this.emit(reason, top ? 'top' : 'child');
  }

  private watch(document: Document): DocumentState {
    const existing = this.documentStates.get(document);
    if (existing) return existing;
    const weak = new WeakRef(document);
    const state: DocumentState = {
      document: weak,
      href: document.location.href,
      version: 0,
      hidden: false,
      removeListeners: () => {},
    };
    const route = () => this.checkRoute(state);
    const entryChange = () => {
      const doc = weak.deref();
      if (!doc || this.disposed) return;
      state.href = doc.location.href;
      this.change(state, 'route');
    };
    const hide = () => {
      state.hidden = true;
      this.change(state, 'pagehide');
    };
    const show = (event: PageTransitionEvent) => {
      if (state.hidden || event.persisted) {
        state.hidden = false;
        this.change(state, 'pageshow');
      }
      route();
    };
    // Native Navigation events are visible across isolated worlds. The browser
    // bridge supplies this hint on older engines as well. Hints contain no data.
    // Page-forged hints can only invalidate IDs, never resolve/authorize a target.
    document.addEventListener(NAVIGATION_HINT, entryChange);
    const win = document.defaultView;
    win?.addEventListener('popstate', route);
    win?.addEventListener('hashchange', route);
    win?.addEventListener('pagehide', hide);
    win?.addEventListener('pageshow', show);
    const navigation = (win as (Window & { navigation?: EventTarget }) | null)?.navigation;
    navigation?.addEventListener('currententrychange', entryChange);
    state.removeListeners = () => {
      const doc = weak.deref();
      const window = doc?.defaultView;
      doc?.removeEventListener(NAVIGATION_HINT, entryChange);
      window?.removeEventListener('popstate', route);
      window?.removeEventListener('hashchange', route);
      window?.removeEventListener('pagehide', hide);
      window?.removeEventListener('pageshow', show);
      (
        window as (Window & { navigation?: EventTarget }) | null | undefined
      )?.navigation?.removeEventListener('currententrychange', entryChange);
    };
    this.documentStates.set(document, state);
    this.documents.add(state);
    return state;
  }

  private checkRoute(state: DocumentState): void {
    if (this.disposed) return;
    const doc = state.document.deref();
    try {
      if (doc && doc.location.href !== state.href) {
        state.href = doc.location.href;
        this.change(state, 'route');
      }
    } catch {
      // Navigated/cross-origin documents fail structural validation below.
    }
  }

  private refresh(): void {
    for (const state of this.documents) this.checkRoute(state);
  }

  /** Capture only weak roots and documents, never the walk's strongly-held context. */
  private capture(element: Element): Scope[] | null {
    const scopes: Scope[] = [];
    let node = element;
    try {
      for (;;) {
        if (!node.isConnected) return null;
        const document = node.ownerDocument;
        if (document.defaultView?.document !== document) return null;
        const state = this.watch(document);
        this.checkRoute(state);
        if (state.hidden) return null;
        const root = node.getRootNode();
        if (root.nodeType === 11) {
          const shadow = root as ShadowRoot;
          if (shadow.mode !== 'open' || shadow.host.shadowRoot !== shadow) return null;
          scopes.push({
            root: new WeakRef(shadow),
            document: state,
            version: state.version,
            frame: null,
          });
          node = shadow.host;
        } else {
          if (root !== document) return null;
          const frame = document === this.top.deref() ? null : document.defaultView?.frameElement;
          if (document !== this.top.deref() && !frame) return null;
          // Same-origin frameElement is null across inaccessible ancestor boundaries.
          if (frame && (frame as HTMLIFrameElement).contentDocument !== document) return null;
          scopes.push({
            root: new WeakRef(document),
            document: state,
            version: state.version,
            frame: frame ? new WeakRef(frame) : null,
          });
          if (!frame) return scopes;
          node = frame;
        }
      }
    } catch {
      return null;
    }
  }

  private valid(node: Element, scopes: Scope[]): boolean {
    const current = this.capture(node);
    return (
      current !== null &&
      current.length === scopes.length &&
      current.every((scope, index) => {
        const previous = scopes[index]!;
        return (
          scope.root.deref() === previous.root.deref() &&
          scope.document === previous.document &&
          scope.version === previous.version &&
          scope.frame?.deref() === previous.frame?.deref()
        );
      })
    );
  }
}
