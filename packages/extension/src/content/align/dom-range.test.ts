// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { createCapture, type FrameLink } from '../../geometry/index.js';
import { alignDomSpan } from './dom-range.js';
import type { EvidenceSpan } from './types.js';

function makeCapture() {
  return createCapture({
    identity: { docId: 'd1', observationId: 1 },
    captureId: 'c1',
    scroll: { x: 0, y: 0 },
    layoutViewport: { width: 800, height: 600 },
    visualViewport: { width: 800, height: 600, offsetLeft: 0, offsetTop: 0, scale: 1 },
    capturedViewport: 'layout',
    image: { width: 800, height: 600 },
    devicePixelRatio: 1,
    browserZoom: 1,
  });
}

function stubRects(range: Range, rects: readonly DOMRect[]): void {
  Object.defineProperty(range, 'getClientRects', {
    value: () => rects,
    configurable: true,
  });
}

function fakeRect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height } as DOMRect;
}

function evidence(sourceText: string, span: { start: number; end: number }): EvidenceSpan {
  return { docId: 'd1', observationId: 1, elementId: 'e1', sourceText, span };
}

describe('alignDomSpan', () => {
  it('withholds when the element is detached', () => {
    const div = document.createElement('div');
    div.textContent = 'hello world';
    const result = alignDomSpan(div, evidence('hello world', { start: 0, end: 5 }), {
      topDocument: document,
      capture: makeCapture(),
    });
    expect(result).toEqual({ status: 'withhold', reason: 'element_detached' });
  });

  it('withholds when the recorded evidence text no longer matches the live DOM (stale)', () => {
    const div = document.createElement('div');
    div.textContent = 'changed text';
    document.body.appendChild(div);
    const result = alignDomSpan(div, evidence('original text', { start: 0, end: 5 }), {
      topDocument: document,
      capture: makeCapture(),
    });
    expect(result).toEqual({ status: 'withhold', reason: 'text_mismatch' });
    div.remove();
  });

  it('withholds for an element with no text nodes', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    const result = alignDomSpan(div, evidence('', { start: 0, end: 0 }), {
      topDocument: document,
      capture: makeCapture(),
    });
    expect(result).toEqual({ status: 'withhold', reason: 'no_text_nodes' });
    div.remove();
  });

  it('returns exact-span page rects for a matching, connected element', () => {
    const div = document.createElement('div');
    div.textContent = 'contact john now';
    document.body.appendChild(div);

    const originalCreateRange = document.createRange.bind(document);
    document.createRange = () => {
      const range = originalCreateRange();
      stubRects(range, [fakeRect(10, 20, 40, 15)]);
      return range;
    };

    const start = div.textContent.indexOf('john');
    const result = alignDomSpan(div, evidence('contact john now', { start, end: start + 4 }), {
      topDocument: document,
      capture: makeCapture(),
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.provenance).toBe('exact_span');
    expect(result.regions[0]?.rect).toMatchObject({ x: 10, y: 20, width: 40, height: 15 });

    document.createRange = originalCreateRange;
    div.remove();
  });

  it('falls back to a whole-block region when fallback is requested and the span cannot be aligned', () => {
    const div = document.createElement('div');
    div.textContent = 'changed text';
    document.body.appendChild(div);
    Object.defineProperty(div, 'getBoundingClientRect', {
      value: () => fakeRect(5, 5, 100, 20),
      configurable: true,
    });

    const result = alignDomSpan(div, evidence('original text', { start: 0, end: 5 }), {
      topDocument: document,
      capture: makeCapture(),
      fallback: 'whole_block',
    });

    expect(result.status).toBe('fallback');
    if (result.status !== 'fallback') throw new Error('unreachable');
    expect(result.reason).toBe('text_mismatch');
    expect(result.regions[0]?.provenance).toBe('whole_block');
    expect(result.regions[0]?.rect).toMatchObject({ x: 5, y: 5, width: 100, height: 20 });

    div.remove();
  });

  it('withholds a cross-frame element when no frame measurement is supplied', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const frameDoc = iframe.contentDocument!;
    const div = frameDoc.createElement('div');
    div.textContent = 'inside frame';
    frameDoc.body.appendChild(div);

    const originalCreateRange = frameDoc.createRange.bind(frameDoc);
    frameDoc.createRange = () => {
      const range = originalCreateRange();
      stubRects(range, [fakeRect(1, 1, 10, 10)]);
      return range;
    };

    const result = alignDomSpan(div, evidence('inside frame', { start: 0, end: 6 }), {
      topDocument: document,
      capture: makeCapture(),
    });

    expect(result).toEqual({ status: 'withhold', reason: 'frame_measurement_missing' });
    iframe.remove();
  });

  it('reads text across shadow DOM boundaries', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('span');
    inner.textContent = 'shadow text';
    shadow.appendChild(inner);

    const originalCreateRange = document.createRange.bind(document);
    document.createRange = () => {
      const range = originalCreateRange();
      stubRects(range, [fakeRect(0, 0, 50, 10)]);
      return range;
    };

    const result = alignDomSpan(host, evidence('shadow text', { start: 0, end: 6 }), {
      topDocument: document,
      capture: makeCapture(),
    });

    expect(result.status).toBe('ok');
    document.createRange = originalCreateRange;
    host.remove();
  });

  it('widens a span to grapheme boundaries before building the range', () => {
    const div = document.createElement('div');
    div.textContent = 'x\u{1F600}y';
    document.body.appendChild(div);

    let capturedText = '';
    const originalCreateRange = document.createRange.bind(document);
    document.createRange = () => {
      const range = originalCreateRange();
      stubRects(range, [fakeRect(0, 0, 20, 10)]);
      const originalToString = range.toString.bind(range);
      Object.defineProperty(range, 'toString', {
        value: () => (capturedText = originalToString()),
        configurable: true,
      });
      return range;
    };

    const result = alignDomSpan(div, evidence('x\u{1F600}y', { start: 2, end: 2 }), {
      topDocument: document,
      capture: makeCapture(),
    });

    expect(result.status).toBe('ok');
    expect(capturedText).toBe('\u{1F600}');

    document.createRange = originalCreateRange;
    div.remove();
  });

  it('produces a page-space transform using frameToPage when frame links are supplied', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const frameDoc = iframe.contentDocument!;
    const div = frameDoc.createElement('div');
    div.textContent = 'inside frame';
    frameDoc.body.appendChild(div);

    const originalCreateRange = frameDoc.createRange.bind(frameDoc);
    frameDoc.createRange = () => {
      const range = originalCreateRange();
      stubRects(range, [fakeRect(1, 1, 10, 10)]);
      return range;
    };

    const capture = makeCapture();
    const frameLinks: readonly FrameLink[] = [
      {
        identity: capture.metadata.identity,
        captureId: capture.metadata.captureId,
        childDocId: 'child-doc',
        parentDocId: 'd1',
        childScroll: { x: 0, y: 0 },
        borderBoxOrigin: { x: 50, y: 60 },
        border: { left: 0, top: 0 },
        padding: { left: 0, top: 0 },
        linear: { a: 1, b: 0, c: 0, d: 1, perspective: false },
      },
    ];

    const result = alignDomSpan(div, evidence('inside frame', { start: 0, end: 6 }), {
      topDocument: document,
      capture,
      frameLinks,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.regions[0]?.rect).toMatchObject({ x: 51, y: 61, width: 10, height: 10 });

    iframe.remove();
  });
});
