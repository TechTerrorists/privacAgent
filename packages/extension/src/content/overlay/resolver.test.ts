// @vitest-environment happy-dom
/**
 * F-02: the B-05 coupling.
 *
 * These cases belong here rather than in the browser suite because they are about the overlay's
 * contract with the registry, not about rendering: a cross-document target and a vision-only id
 * cannot be produced from a page-context driver at all.
 */
import { describe, expect, it } from 'vitest';
import { ElementRegistry } from '../element-registry/index.js';
import { createRegistryResolver, createViewportGeometry } from './resolver.js';

function setup() {
  const registry = new ElementRegistry(document);
  const resolver = createRegistryResolver(registry, document);
  const register = (node: Element) => {
    const registration = registry.register(node, registry.docId);
    if (registration.status !== 'ok') throw new Error(`registration: ${registration.status}`);
    return { doc_id: registration.doc_id, element_id: registration.id };
  };
  return { registry, resolver, register };
}

const element = (): HTMLElement => {
  const node = document.createElement('button');
  document.body.append(node);
  return node;
};

describe('createRegistryResolver', () => {
  it('resolves a registered element to its viewport rectangle', () => {
    const { resolver, register } = setup();
    const node = element();
    node.getBoundingClientRect = () => ({ x: 10, y: 20, width: 30, height: 40 }) as DOMRect;
    const anchor = register(node);
    const result = resolver.resolve(anchor);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.rect).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    expect(result.element).toBe(node);
  });

  it('reports an unknown element id as missing rather than guessing a replacement', () => {
    const { registry, resolver } = setup();
    // The generation matches; only the element id is unknown. A generation mismatch is a
    // different failure and is reported as staleness, not as a missing element.
    expect(resolver.resolve({ doc_id: registry.docId, element_id: 'e-nope' })).toEqual({
      status: 'missing',
    });
  });

  it('reports an id from a retired generation as stale', () => {
    const { resolver, register } = setup();
    const anchor = register(element());
    const result = resolver.resolve({
      doc_id: 'd-some-other-generation',
      element_id: anchor.element_id,
    });
    expect(result).toEqual({ status: 'stale' });
  });

  it('reports every id as stale once the registry is disposed', () => {
    const { registry, resolver, register } = setup();
    const anchor = register(element());
    registry.dispose();
    expect(resolver.currentDocId()).toBeNull();
    expect(resolver.resolve(anchor)).toEqual({ status: 'stale' });
  });

  it('reports a detached node as missing even while the registry still holds it', () => {
    const { resolver, register } = setup();
    const node = element();
    const anchor = register(node);
    node.remove();
    expect(resolver.resolve(anchor)).toEqual({ status: 'missing' });
  });

  it('refuses vision-only ids, which have no node to anchor to', () => {
    const { resolver, register } = setup();
    const anchor = register(element());
    // `v`-prefixed ids are executed by coordinates (A-08/A-09); anchoring one to an element
    // would be a guess, so it is reported as unsupported instead.
    expect(resolver.resolve({ doc_id: anchor.doc_id, element_id: 'v-0001' })).toEqual({
      status: 'unsupported',
    });
  });

  it('cannot be handed a cross-document target at all', () => {
    const { registry } = setup();
    // An element inside a child frame reports a rect in that frame's viewport. The registry
    // scopes registrations to its own document set, so such a node is never resolvable in the
    // first place and the overlay never gets the chance to misread its coordinate space.
    const other = document.implementation.createHTMLDocument('frame');
    const framed = other.createElement('button');
    other.body.append(framed);
    expect(registry.register(framed, registry.docId).status).toBe('stale');
  });
});

describe('createViewportGeometry', () => {
  it('measures the initial containing block, which is what fixed positioning resolves against', () => {
    const geometry = createViewportGeometry(document, window);
    const viewport = geometry.viewport();
    expect(viewport).toEqual({
      x: 0,
      y: 0,
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight,
    });
    expect(viewport.width).toBeGreaterThan(0);
    expect(viewport.height).toBeGreaterThan(0);
  });
});
