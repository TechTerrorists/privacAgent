import { afterEach, describe, expect, it } from 'vitest';

import type { InferenceApi, InferenceOperation } from './api.js';
import {
  countsAsDetectorCoverage,
  requiresRestrictedEgress,
  unavailableReason,
} from './coverage.js';
import { InvalidInferenceInputError } from './errors.js';
import { createFakeInferenceApi } from './fake.js';
import {
  FIXTURE_CROP,
  FIXTURE_FACE_TILE,
  FIXTURE_ICON,
  FIXTURE_UNAVAILABLE_REASON,
  FIXTURE_VIEWPORT,
} from './fixtures.js';
import { getInferenceApi, resetInferenceApi, setInferenceApi } from './index.js';
import { perceiveRegion } from './example.js';
import type { BBox, InferenceImage, InferenceResult } from './types.js';

const OPERATIONS: readonly InferenceOperation[] = ['runDetector', 'runOCR', 'runFaces', 'runIcons'];

/** Calls an operation by name, so every test can sweep all four uniformly. */
function call(
  api: InferenceApi,
  operation: InferenceOperation,
  image: InferenceImage,
  options?: Parameters<InferenceApi['runDetector']>[1]
): Promise<InferenceResult<{ bbox: BBox }>> {
  return api[operation](image, options) as Promise<InferenceResult<{ bbox: BBox }>>;
}

const IMAGE_FOR: Record<InferenceOperation, InferenceImage> = {
  runDetector: FIXTURE_VIEWPORT,
  runOCR: FIXTURE_CROP,
  runFaces: FIXTURE_FACE_TILE,
  runIcons: FIXTURE_ICON,
};

afterEach(() => {
  resetInferenceApi();
});

describe('fake inference engine', () => {
  const api = createFakeInferenceApi();

  it('exposes all four operations and returns typed async results', async () => {
    for (const operation of OPERATIONS) {
      const result = await call(api, operation, IMAGE_FOR[operation]);
      expect(result.status).toBe('ok');
      expect(result.engine).toBe('fake');
    }
  });

  it('marks every result synthetic, whatever the status', async () => {
    for (const operation of OPERATIONS) {
      const image = IMAGE_FOR[operation];
      for (const fixture of ['ordinary', 'empty', 'unavailable'] as const) {
        const result = await call(api, operation, image, { fixture });
        expect(result.synthetic).toBe(true);
      }
    }
  });

  it('returns boxes in the frame of the input image', async () => {
    const asCrop: InferenceImage = { width: 200, height: 200, frame: 'crop' };
    const asImage: InferenceImage = { width: 200, height: 200, frame: 'image' };

    expect((await api.runDetector(asCrop)).frame).toBe('crop');
    expect((await api.runDetector(asImage)).frame).toBe('image');
  });
});

describe('determinism', () => {
  it('produces byte-identical results for repeated identical calls', async () => {
    const first = createFakeInferenceApi();
    const second = createFakeInferenceApi();

    for (const operation of OPERATIONS) {
      const image = IMAGE_FOR[operation];
      const a = await call(first, operation, image);
      const b = await call(first, operation, image);
      // A second instance must agree too: the engine holds no state.
      const c = await call(second, operation, image);

      expect(a).toEqual(b);
      expect(a).toEqual(c);
    }
  });

  it('distinguishes inputs that differ only by dimensions or region', async () => {
    const api = createFakeInferenceApi();
    const image: InferenceImage = { width: 640, height: 640, frame: 'image' };
    const taller: InferenceImage = { width: 640, height: 641, frame: 'image' };

    const base = await api.runDetector(image);
    const resized = await api.runDetector(taller);
    const regional = await api.runDetector(image, { region: [0, 0, 320, 320] });

    expect(base).not.toEqual(resized);
    expect(base).not.toEqual(regional);
  });

  it('matches committed golden output for the documented fixture', async () => {
    // Fixture output is a stable contract; other lanes assert against it.
    // If this snapshot changes, their suites break too.
    const result = await createFakeInferenceApi().runDetector(FIXTURE_VIEWPORT);
    expect(result).toMatchSnapshot();
  });
});

describe('result contract', () => {
  const api = createFakeInferenceApi();

  it('keeps every derived box inside the image', async () => {
    const image: InferenceImage = { width: 137, height: 89, frame: 'image' };

    for (const operation of OPERATIONS) {
      const result = await call(api, operation, image);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') continue;

      for (const { bbox } of result.items) {
        const [x, y, w, h] = bbox;
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(w).toBeGreaterThan(0);
        expect(h).toBeGreaterThan(0);
        expect(x + w).toBeLessThanOrEqual(image.width);
        expect(y + h).toBeLessThanOrEqual(image.height);
      }
    }
  });

  it('keeps every derived box inside a requested region', async () => {
    const image: InferenceImage = { width: 640, height: 640, frame: 'image' };
    const region: BBox = [100, 120, 200, 180];

    for (const operation of OPERATIONS) {
      const result = await call(api, operation, image, { region });
      if (result.status !== 'ok') continue;

      for (const { bbox } of result.items) {
        expect(bbox[0]).toBeGreaterThanOrEqual(region[0]);
        expect(bbox[1]).toBeGreaterThanOrEqual(region[1]);
        expect(bbox[0] + bbox[2]).toBeLessThanOrEqual(region[0] + region[2]);
        expect(bbox[1] + bbox[3]).toBeLessThanOrEqual(region[1] + region[3]);
      }
    }
  });

  it('keeps confidence within 0..1', async () => {
    const result = await api.runDetector(FIXTURE_VIEWPORT);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    for (const detection of result.items) {
      expect(detection.conf).toBeGreaterThanOrEqual(0);
      expect(detection.conf).toBeLessThanOrEqual(1);
    }
  });

  it('never returns an empty items array under ok', async () => {
    for (const operation of OPERATIONS) {
      const result = await call(api, operation, IMAGE_FOR[operation]);
      if (result.status === 'ok') expect(result.items.length).toBeGreaterThan(0);
    }
  });

  it('orders items top-to-bottom, then left-to-right', async () => {
    const result = await api.runDetector(FIXTURE_VIEWPORT);
    if (result.status !== 'ok') return;

    for (let i = 1; i < result.items.length; i += 1) {
      const previous = result.items[i - 1]!.bbox;
      const current = result.items[i]!.bbox;
      const ordered =
        previous[1] < current[1] || (previous[1] === current[1] && previous[0] <= current[0]);
      expect(ordered).toBe(true);
    }
  });
});

describe('OCR evidence', () => {
  const api = createFakeInferenceApi();

  it('returns words and per-character confidences', async () => {
    const result = await api.runOCR(FIXTURE_CROP);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    for (const line of result.items) {
      expect(line.words.length).toBeGreaterThan(0);
      expect(line.meanCharConfidence).toBeGreaterThanOrEqual(0);
      expect(line.meanCharConfidence).toBeLessThanOrEqual(1);

      for (const word of line.words) {
        expect(word.characters.length).toBe(word.text.length);
        for (const character of word.characters) {
          expect(character.conf).toBeGreaterThanOrEqual(0);
          expect(character.conf).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('emits obviously synthetic text that cannot be mistaken for page content', async () => {
    const result = await api.runOCR(FIXTURE_CROP);
    if (result.status !== 'ok') return;

    const vocabulary = new Set(['SYNTHETIC', 'FAKE', 'SAMPLE', 'PLACEHOLDER']);
    for (const line of result.items) {
      for (const word of line.words) expect(vocabulary.has(word.text)).toBe(true);
    }
  });
});

describe('empty and unavailable are distinct', () => {
  const api = createFakeInferenceApi();

  it('reports an empty result as a successful scan that found nothing', async () => {
    for (const operation of OPERATIONS) {
      const result = await call(api, operation, IMAGE_FOR[operation], { fixture: 'empty' });

      expect(result.status).toBe('empty');
      expect(requiresRestrictedEgress(result)).toBe(false);
      expect(unavailableReason(result)).toBeUndefined();
      expect(result).not.toHaveProperty('items');
    }
  });

  it('reports an unavailable result as a failure to scan, with a reason', async () => {
    for (const operation of OPERATIONS) {
      const result = await call(api, operation, IMAGE_FOR[operation], {
        fixture: 'unavailable',
      });

      expect(result.status).toBe('unavailable');
      expect(requiresRestrictedEgress(result)).toBe(true);
      expect(unavailableReason(result)).toBe(FIXTURE_UNAVAILABLE_REASON);
      expect(result).not.toHaveProperty('items');
    }
  });

  it('never lets unavailable masquerade as an empty detection', async () => {
    const empty = await api.runOCR(FIXTURE_CROP, { fixture: 'empty' });
    const unavailable = await api.runOCR(FIXTURE_CROP, { fixture: 'unavailable' });

    expect(empty.status).not.toBe(unavailable.status);
    expect(requiresRestrictedEgress(empty)).not.toBe(requiresRestrictedEgress(unavailable));
  });
});

describe('detector coverage', () => {
  const api = createFakeInferenceApi();

  it('refuses to count synthetic results as coverage', async () => {
    for (const fixture of ['ordinary', 'empty'] as const) {
      const result = await api.runOCR(FIXTURE_CROP, { fixture });
      expect(result.synthetic).toBe(true);
      expect(countsAsDetectorCoverage(result)).toBe(false);
    }
  });

  it('counts a real empty scan as coverage, but never a real unavailable one', () => {
    const base = { frame: 'image', engine: 'onnx', synthetic: false } as const;

    expect(countsAsDetectorCoverage({ ...base, status: 'empty' })).toBe(true);
    expect(countsAsDetectorCoverage({ ...base, status: 'ok', items: [{}] })).toBe(true);
    expect(
      countsAsDetectorCoverage({ ...base, status: 'unavailable', reason: 'backend_unavailable' })
    ).toBe(false);
  });
});

describe('input validation', () => {
  const api = createFakeInferenceApi();

  it('rejects non-positive or non-integer dimensions', async () => {
    await expect(api.runDetector({ width: 0, height: 10, frame: 'image' })).rejects.toBeInstanceOf(
      InvalidInferenceInputError
    );
    await expect(
      api.runDetector({ width: 10.5, height: 10, frame: 'image' })
    ).rejects.toBeInstanceOf(InvalidInferenceInputError);
  });

  it('rejects a region that escapes the image', async () => {
    await expect(
      api.runDetector(FIXTURE_ICON, { region: [0, 0, 1000, 1000] })
    ).rejects.toBeInstanceOf(InvalidInferenceInputError);
  });

  it('keeps payloads out of error messages', async () => {
    let message = '';
    try {
      await api.runDetector({ width: 0, height: 10, frame: 'image' });
      expect.unreachable('expected invalid dimensions to reject');
    } catch (caught) {
      message = (caught as Error).message;
    }

    // Shapes and sizes only: these strings reach logs.
    expect(message).toContain('0x10');
    expect(message).not.toContain('bitmap');
  });
});

describe('engine registry', () => {
  it('defaults to the fake engine', () => {
    expect(getInferenceApi().engine).toBe('fake');
    expect(getInferenceApi().synthetic).toBe(true);
  });

  it('lets C-02 swap in a real engine without changing callers', async () => {
    const real: InferenceApi = {
      ...createFakeInferenceApi(),
      engine: 'onnx',
      synthetic: false,
      runOCR: () =>
        Promise.resolve({ frame: 'crop', engine: 'onnx', synthetic: false, status: 'empty' }),
    };

    setInferenceApi(real);

    const perception = await perceiveRegion(FIXTURE_CROP);
    // A real empty OCR scan is coverage; the fake face detector still is not.
    expect(perception.textLineCount).toBe(0);
    expect(perception.fullyScanned).toBe(false);
    expect(getInferenceApi().engine).toBe('onnx');
  });

  it('restores the fake on reset', () => {
    setInferenceApi({ ...createFakeInferenceApi(), engine: 'onnx', synthetic: false });
    resetInferenceApi();
    expect(getInferenceApi().engine).toBe('fake');
  });
});

describe('consumer example', () => {
  it('summarises a region through the active engine', async () => {
    const perception = await perceiveRegion(FIXTURE_VIEWPORT);

    expect(perception.detectionCount).toBeGreaterThan(0);
    expect(perception.restricted).toBe(false);
    // The fake can never establish coverage, however ordinary its output looks.
    expect(perception.fullyScanned).toBe(false);
  });

  it('flags restricted egress when a detector is unavailable', async () => {
    const unavailableEverything: InferenceApi = {
      engine: 'onnx',
      synthetic: false,
      runDetector: () =>
        Promise.resolve({
          frame: 'image',
          engine: 'onnx',
          synthetic: false,
          status: 'unavailable',
          reason: 'backend_unavailable',
        }),
      runOCR: () =>
        Promise.resolve({
          frame: 'image',
          engine: 'onnx',
          synthetic: false,
          status: 'unavailable',
          reason: 'backend_unavailable',
        }),
      runFaces: () =>
        Promise.resolve({
          frame: 'image',
          engine: 'onnx',
          synthetic: false,
          status: 'unavailable',
          reason: 'backend_unavailable',
        }),
      runIcons: () =>
        Promise.resolve({
          frame: 'image',
          engine: 'onnx',
          synthetic: false,
          status: 'unavailable',
          reason: 'backend_unavailable',
        }),
    };

    setInferenceApi(unavailableEverything);

    const perception = await perceiveRegion(FIXTURE_VIEWPORT);
    expect(perception.restricted).toBe(true);
    expect(perception.fullyScanned).toBe(false);
    // Crucially, "nothing found" here must not read as a clean scan.
    expect(perception.detectionCount).toBe(0);
  });
});
