import { CONTENT_NAMES, PROHIBITED_NAMES, inputType, labelable, roleOf } from './roles.js';
import type {
  LocalSemantics,
  NameSource,
  SemanticDependencies,
  SemanticOptions,
  SemanticScope,
} from './types.js';

type Work<T> = Generator<void, T, void>;
type TextAlternative = { text: string; source: NameSource };
interface ScopeIndex {
  ids: Map<string, Element>;
  labels: Map<Element, Element[]>;
}
export class LimitExceeded extends Error {}
const flat = (text: string): string => text.replace(/[\t\n\f\r ]+/g, ' ').trim();
const empty = (): TextAlternative => ({ text: '', source: 'none' });
export function scopeOf(node: Node): SemanticScope | null {
  const root = node.getRootNode();
  if (root.nodeType === 9) return root as Document;
  if (root.nodeType === 11 && 'host' in root && (root as ShadowRoot).mode === 'open')
    return root as ShadowRoot;
  return null;
}
export function live(node: Element): boolean {
  try {
    if (!node.isConnected || node.ownerDocument.defaultView?.document !== node.ownerDocument)
      return false;
    let root = scopeOf(node);
    while (root?.nodeType === 11) {
      root = scopeOf((root as ShadowRoot).host);
    }
    return root?.nodeType === 9;
  } catch {
    return false;
  }
}
/** One-use indexes. Never retain them across a mutation or observation. */
export class SemanticEngine {
  private indexes = new Map<SemanticScope, ScopeIndex>();
  readonly maxWork: number;
  readonly maxDepth: number;
  readonly maxText: number;
  readonly maxScope: number;
  constructor(options: SemanticOptions) {
    this.maxWork = options.maxWork ?? 20000;
    this.maxDepth = options.maxDepth ?? 128;
    this.maxText = options.maxTextLength ?? 8192;
    this.maxScope = options.maxScopeNodes ?? 100000;
    for (const n of [this.maxWork, this.maxDepth, this.maxText, this.maxScope]) {
      if (!Number.isSafeInteger(n) || n <= 0)
        throw new RangeError('Invalid semantic extraction limits');
    }
    if (this.maxDepth > 256 || this.maxText > 65536)
      throw new RangeError('Invalid semantic extraction limits');
  }
  *index(root: SemanticScope): Work<ScopeIndex> {
    const existing = this.indexes.get(root);
    if (existing) return existing;
    const index: ScopeIndex = { ids: new Map(), labels: new Map() };
    const labels: Element[] = [];
    const walker =
      root.ownerDocument?.createTreeWalker(root, 1) ?? (root as Document).createTreeWalker(root, 1);
    let count = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      yield;
      if (++count > this.maxScope) throw new LimitExceeded();
      const element = node as Element;
      const id = element.getAttribute('id');
      if (id && id.length <= this.maxText && !index.ids.has(id)) index.ids.set(id, element);
      if (element.localName === 'label') labels.push(element);
    }
    for (const label of labels) {
      yield;
      const forId = label.getAttribute('for');
      let target = forId === null ? undefined : index.ids.get(forId);
      if (forId === null) {
        const descendants = label.ownerDocument.createTreeWalker(label, 1);
        for (let node = descendants.nextNode(); node; node = descendants.nextNode()) {
          yield;
          if (++count > this.maxScope) throw new LimitExceeded();
          if (labelable(node as Element)) {
            target = node as Element;
            break;
          }
        }
      }
      if (target && labelable(target)) {
        const list = index.labels.get(target) ?? [];
        list.push(label);
        index.labels.set(target, list);
      }
    }
    this.indexes.set(root, index);
    return index;
  }
  *extract(target: Element): Work<LocalSemantics> {
    const reader = new Reader(this, target);
    return yield* reader.extract();
  }
}
class Reader {
  private nodes = new Set<Node>();
  private scopes = new Set<SemanticScope>();
  private references: SemanticDependencies['references'] = [];
  private work = 0;
  constructor(
    private engine: SemanticEngine,
    private target: Element
  ) {}
  private *tick(node?: Node): Work<void> {
    if (++this.work > this.engine.maxWork) throw new LimitExceeded();
    if (node) this.nodes.add(node);
    yield;
  }
  private text(value: string): string {
    if (value.length > this.engine.maxText) throw new LimitExceeded();
    return value;
  }
  private attr(node: Element, name: string): string | null {
    this.nodes.add(node);
    const value = node.getAttribute(name);
    return value === null ? null : this.text(value);
  }
  private *scope(node: Element): Work<ScopeIndex> {
    const root = scopeOf(node);
    if (!root) throw new LimitExceeded();
    this.scopes.add(root);
    return yield* this.engine.index(root);
  }
  private *hidden(node: Element): Work<boolean> {
    let current: Element | null = node;
    let depth = 0;
    while (current) {
      yield* this.tick(current);
      if (++depth > this.engine.maxDepth) throw new LimitExceeded();
      const style = current.ownerDocument.defaultView?.getComputedStyle(current);
      if (
        this.attr(current, 'aria-hidden') === 'true' ||
        current.hasAttribute('hidden') ||
        style?.display === 'none' ||
        style?.contentVisibility === 'hidden'
      )
        return true;
      // visibility is inherited, but a child can override it back to visible.
      if (current === node && (style?.visibility === 'hidden' || style?.visibility === 'collapse'))
        return true;
      const root = scopeOf(current);
      if (root) this.scopes.add(root);
      current = current.parentElement ?? (root?.nodeType === 11 ? (root as ShadowRoot).host : null);
    }
    return false;
  }
  private *refs(node: Element, attribute: string): Work<Element[]> {
    const value = this.attr(node, attribute);
    if (!value) return [];
    const index = yield* this.scope(node);
    const root = scopeOf(node)!;
    const found: Element[] = [];
    const seen = new Set<string>();
    for (const id of value.split(/[\t\n\f\r ]+/).filter(Boolean)) {
      yield* this.tick();
      if (seen.has(id)) continue;
      seen.add(id);
      this.references.push({ scope: root, id });
      const ref = index.ids.get(id);
      if (ref) found.push(ref);
    }
    return found;
  }
  private *children(node: Element): Work<Node[]> {
    yield* this.tick(node);
    if (node.localName === 'slot') {
      // assignedNodes is a native snapshot; cap it before processing.
      const assigned = (node as HTMLSlotElement).assignedNodes();
      if (assigned.length > this.engine.maxWork) throw new LimitExceeded();
      if (assigned.length) return assigned;
    }
    const root: Node = node.shadowRoot ?? node;
    if (node.shadowRoot) this.scopes.add(node.shadowRoot);
    const children: Node[] = [];
    for (let child = root.firstChild; child; child = child.nextSibling) {
      yield* this.tick(child);
      children.push(child);
    }
    return children;
  }
  private *content(
    node: Element,
    seen: Set<Node>,
    includeHidden: boolean,
    inReference: boolean,
    depth: number
  ): Work<string> {
    let text = '';
    for (const child of yield* this.children(node)) {
      yield* this.tick(child);
      if (child.nodeType === 3) text = this.text(text + this.text((child as Text).data));
      else if (child.nodeType === 1) {
        const element = child as Element;
        const alt = yield* this.name(element, seen, includeHidden, inReference, true, depth + 1);
        const display = element.ownerDocument.defaultView?.getComputedStyle(element).display;
        const separator =
          element.localName === 'br' || (display && !['inline', 'contents'].includes(display));
        text = this.text(text + (separator ? ` ${alt.text} ` : alt.text));
      }
    }
    return text;
  }
  private *name(
    node: Element,
    seen: Set<Node>,
    includeHidden = false,
    inReference = false,
    descendant = false,
    depth = 0
  ): Work<TextAlternative> {
    yield* this.tick(node);
    if (depth > this.engine.maxDepth) throw new LimitExceeded();
    if (seen.has(node) || ['script', 'style', 'template', 'noscript'].includes(node.localName))
      return empty();
    if (!includeHidden && (yield* this.hidden(node))) return empty();
    this.attr(node, 'role');
    const role = roleOf(node).role;
    if (!descendant && !inReference && role && PROHIBITED_NAMES.has(role)) return empty();
    if (!inReference) {
      const refs = yield* this.refs(node, 'aria-labelledby');
      if (refs.length) {
        let text = '';
        for (const ref of refs) {
          const alternative = yield* this.name(
            ref,
            seen,
            yield* this.hidden(ref),
            true,
            false,
            depth + 1
          );
          text = this.text(`${text} ${alternative.text}`);
        }
        // Valid empty references intentionally name the node with an empty string.
        return { text: flat(text), source: 'aria-labelledby' };
      }
    }
    seen.add(node);
    if ((descendant || inReference) && node !== this.target) {
      if (node.localName === 'input' && inputType(node) === 'password') return empty();
      if (
        (role === 'textbox' || role === 'searchbox') &&
        ['input', 'textarea'].includes(node.localName)
      )
        return { text: this.text((node as HTMLInputElement).value), source: 'contents' };
      if (role === 'slider' || role === 'spinbutton')
        return {
          text:
            this.attr(node, 'aria-valuetext') ??
            this.attr(node, 'aria-valuenow') ??
            (node.localName === 'input' ? this.text((node as HTMLInputElement).value) : ''),
          source: 'contents',
        };
      if (node.localName === 'select') {
        let text = '';
        for (const option of (node as HTMLSelectElement).options) {
          yield* this.tick(option);
          if (option.selected)
            text = this.text(
              `${text} ${yield* this.content(option, seen, includeHidden, inReference, depth + 1)}`
            );
        }
        return { text: flat(text), source: 'contents' };
      }
    }
    const aria = this.attr(node, 'aria-label');
    if (aria && flat(aria) && node.localName !== 'slot')
      return { text: flat(aria), source: 'aria-label' };
    const tag = node.localName;
    if (tag === 'input' && inputType(node) === 'password' && (descendant || inReference))
      return empty();
    if (labelable(node)) {
      const index = yield* this.scope(node);
      const labels = index.labels.get(node);
      if (labels?.length) {
        let text = '';
        for (const label of labels) {
          const alt = yield* this.name(
            label,
            seen,
            yield* this.hidden(label),
            inReference,
            true,
            depth + 1
          );
          text = this.text(`${text} ${alt.text}`);
        }
        return { text: flat(text), source: 'label' };
      }
    }
    if (tag === 'img' || tag === 'area' || (tag === 'input' && inputType(node) === 'image')) {
      const alt = this.attr(node, 'alt');
      if (alt !== null) return { text: flat(alt), source: 'alt' };
    }
    if (tag === 'input' && ['button', 'submit', 'reset'].includes(inputType(node))) {
      const value = this.attr(node, 'value');
      return {
        text: flat(
          value ??
            (inputType(node) === 'submit' ? 'Submit' : inputType(node) === 'reset' ? 'Reset' : '')
        ),
        source: 'native',
      };
    }
    const childAlternative =
      tag === 'svg'
        ? 'title'
        : tag === 'fieldset'
          ? 'legend'
          : tag === 'table'
            ? 'caption'
            : tag === 'figure'
              ? 'figcaption'
              : null;
    if (childAlternative) {
      for (const child of yield* this.children(node)) {
        if (child.nodeType === 1 && (child as Element).localName === childAlternative) {
          return {
            text: flat(
              yield* this.content(child as Element, seen, includeHidden, inReference, depth + 1)
            ),
            source: tag === 'svg' ? 'svg-title' : 'native',
          };
        }
      }
    }
    if (descendant || inReference || (role && CONTENT_NAMES.has(role))) {
      const text = flat(yield* this.content(node, seen, includeHidden, inReference, depth));
      if (text) return { text, source: 'contents' };
    }
    const title = this.attr(node, 'title');
    if (title && flat(title)) return { text: flat(title), source: 'title' };
    if (tag === 'input' && inputType(node) === 'image')
      return { text: 'Submit Query', source: 'native' };
    return empty();
  }
  *extract(): Work<LocalSemantics> {
    let result: LocalSemantics = {
      status: 'complete',
      role: null,
      roleSource: 'none',
      name: '',
      nameSource: 'none',
      description: '',
      descriptionSource: 'none',
      fallback: null,
      dependencies: { nodes: [], references: [], scopes: [] },
      workUnits: 0,
    };
    try {
      if (!live(this.target)) {
        result.status = 'stale';
        return result;
      }
      const hidden = yield* this.hidden(this.target);
      // Bound raw role/token inputs before tokenizing them.
      this.attr(this.target, 'role');
      const role = roleOf(this.target);
      const name = yield* this.name(this.target, new Set());
      result = { ...result, ...role, name: flat(name.text), nameSource: name.source };
      if (!hidden) {
        const refs = yield* this.refs(this.target, 'aria-describedby');
        if (refs.length) {
          const seen = new Set<Node>();
          let description = '';
          for (const ref of refs) {
            const alt = yield* this.name(ref, seen, yield* this.hidden(ref), true);
            description = this.text(`${description} ${alt.text}`);
          }
          result.description = flat(description);
          result.descriptionSource = 'aria-describedby';
        } else {
          const description = this.attr(this.target, 'aria-description');
          if (description !== null) {
            result.description = flat(description);
            result.descriptionSource = 'aria-description';
          } else if (this.target.localName === 'svg') {
            for (const child of yield* this.children(this.target)) {
              if (child.nodeType === 1 && (child as Element).localName === 'desc') {
                result.description = flat(
                  yield* this.content(child as Element, new Set(), false, true, 0)
                );
                result.descriptionSource = 'svg-desc';
                break;
              }
            }
          }
          if (result.descriptionSource === 'none' && name.source !== 'title') {
            const title = this.attr(this.target, 'title');
            if (title !== null) {
              result.description = flat(title);
              result.descriptionSource = 'title';
            }
          }
        }
        if (
          !result.name &&
          name.source === 'none' &&
          !(role.role && PROHIBITED_NAMES.has(role.role))
        ) {
          const placeholder = ['input', 'textarea'].includes(this.target.localName)
            ? this.attr(this.target, 'placeholder')
            : null;
          const alt = this.attr(this.target, 'alt');
          if (placeholder && flat(placeholder))
            result.fallback = { text: flat(placeholder), source: 'placeholder' };
          else if (alt && flat(alt)) result.fallback = { text: flat(alt), source: 'alt' };
        }
      }
      if (!live(this.target)) result.status = 'stale';
    } catch (error) {
      if (!(error instanceof LimitExceeded)) throw error;
      result.status = 'limited';
    } finally {
      result.dependencies = {
        nodes: [...this.nodes],
        scopes: [...this.scopes],
        references: this.references,
      };
      result.workUnits = this.work;
      if (result.status !== 'complete') {
        result.role = null;
        result.roleSource = 'none';
        result.name = '';
        result.nameSource = 'none';
        result.description = '';
        result.descriptionSource = 'none';
        result.fallback = null;
      }
    }
    return result;
  }
}
