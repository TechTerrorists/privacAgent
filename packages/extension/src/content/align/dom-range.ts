import {
  fromBBox,
  invert,
  mapRect,
  frameToPage,
  GeometryError,
  type Capture,
  type FrameLink,
  type Rect,
} from '../../geometry/index.js';
import { expandToGraphemeBoundaries } from './graphemes.js';
import type {
  AlignedRegion,
  AlignmentRejectionReason,
  AlignmentResult,
  EvidenceSpan,
} from './types.js';

const IGNORED_TAGS = new Set(['script', 'style', 'template', 'noscript']);

function collectTextNodes(root: Node, out: Text[] = []): Text[] {
  if (root.nodeType === Node.TEXT_NODE) {
    out.push(root as Text);
    return out;
  }
  if (root.nodeType === Node.ELEMENT_NODE) {
    const element = root as Element;
    if (IGNORED_TAGS.has(element.localName)) return out;
    const shadow = element.shadowRoot;
    if (shadow) {
      for (const child of Array.from(shadow.childNodes)) collectTextNodes(child, out);
      return out;
    }
  }
  for (const child of Array.from(root.childNodes)) collectTextNodes(child, out);
  return out;
}

interface TextLocation {
  readonly node: Text;
  readonly offset: number;
}

function locate(textNodes: readonly Text[], offset: number): TextLocation | undefined {
  let cursor = 0;
  for (const node of textNodes) {
    const length = node.data.length;
    if (offset <= cursor + length) return { node, offset: offset - cursor };
    cursor += length;
  }
  return undefined;
}

export interface DomAlignmentDeps {
  readonly topDocument: Document;
  readonly capture: Capture;
  readonly frameLinks?: readonly FrameLink[];
  readonly fallback?: 'whole_block' | 'withhold';
}

function rectsToPage(
  rects: readonly DOMRect[],
  element: Element,
  deps: DomAlignmentDeps
): readonly Rect<'page'>[] | undefined {
  const inTopDocument = element.ownerDocument === deps.topDocument;

  try {
    if (inTopDocument) {
      const toPage = invert(deps.capture.pageToViewport);
      return rects.map((rect) =>
        mapRect(toPage, fromBBox(deps.capture.viewport, [rect.x, rect.y, rect.width, rect.height]))
      );
    }

    if (!deps.frameLinks || deps.frameLinks.length === 0) return undefined;
    const toPage = frameToPage(deps.capture, deps.frameLinks);
    return rects.map((rect) =>
      mapRect(toPage, fromBBox(toPage.from, [rect.x, rect.y, rect.width, rect.height]))
    );
  } catch (cause) {
    if (cause instanceof GeometryError) return undefined;
    throw cause;
  }
}

function reject(
  reason: AlignmentRejectionReason,
  element: Element,
  deps: DomAlignmentDeps
): AlignmentResult<'page'> {
  if (deps.fallback === 'withhold' || deps.fallback === undefined) {
    return { status: 'withhold', reason };
  }

  const rects = rectsToPage([element.getBoundingClientRect()], element, deps);
  if (!rects || rects.length === 0) return { status: 'withhold', reason };

  const regions: AlignedRegion<'page'>[] = rects.map((rect) => ({
    rect,
    provenance: 'whole_block',
  }));
  return { status: 'fallback', regions, reason };
}

export function alignDomSpan(
  element: Element,
  evidence: EvidenceSpan,
  deps: DomAlignmentDeps
): AlignmentResult<'page'> {
  if (!element.isConnected) return reject('element_detached', element, deps);

  const textNodes = collectTextNodes(element);
  if (textNodes.length === 0) return reject('no_text_nodes', element, deps);

  const fullText = textNodes.map((node) => node.data).join('');
  if (fullText !== evidence.sourceText) return reject('text_mismatch', element, deps);

  const { start, end } = expandToGraphemeBoundaries(fullText, evidence.span);
  const startLocation = locate(textNodes, start);
  const endLocation = locate(textNodes, end);
  if (!startLocation || !endLocation) return reject('text_mismatch', element, deps);

  let range: Range;
  try {
    range = element.ownerDocument.createRange();
    range.setStart(startLocation.node, startLocation.offset);
    range.setEnd(endLocation.node, endLocation.offset);
  } catch {
    return reject('text_mismatch', element, deps);
  }

  if (range.toString() !== fullText.slice(start, end))
    return reject('text_mismatch', element, deps);

  const domRects = Array.from(range.getClientRects());
  if (domRects.length === 0) return reject('no_rects', element, deps);

  const pageRects = rectsToPage(domRects, element, deps);
  if (!pageRects) {
    return reject(
      element.ownerDocument === deps.topDocument ? 'invalid_geometry' : 'frame_measurement_missing',
      element,
      deps
    );
  }

  const regions: AlignedRegion<'page'>[] = pageRects.map((rect) => ({
    rect,
    provenance: 'exact_span',
  }));
  return { status: 'ok', regions };
}
