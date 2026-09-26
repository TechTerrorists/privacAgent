/**
 * Deterministic fake inference engine (feature C-01).
 *
 * Lets lanes B, C and D write and test real code against local inference
 * before any model exists. It needs no model download, no GPU, no agent server
 * and no worker host, so it runs under Node in Vitest exactly as it does in the
 * browser.
 *
 * ## Determinism
 *
 * Same input, byte-identical output — every run, every machine, both build
 * targets. That is what lets callers assert on real values instead of writing
 * `toBeTruthy()`. It is achieved by deriving everything from a hash of the
 * input's *identity* (operation, frame, dimensions, region), never from
 * ambient state. Nothing here may call `Math.random`, `Date.now`,
 * `crypto.getRandomValues`, or iterate a collection whose order is not fixed.
 *
 * Confidences are derived as integers and then divided by a fixed denominator,
 * rather than accumulated in floating point, so values are exactly
 * representable and survive strict equality across engines.
 *
 * ## What it does not do
 *
 * It never reads pixels. `InferenceImage.bitmap` is ignored and never
 * retained, which is precisely why the surface stays callable under Node,
 * where `ImageBitmap` does not exist.
 *
 * Results are marked `synthetic: true`, so `countsAsDetectorCoverage` refuses
 * them and a development build cannot assemble a payload that merely looks
 * scanned.
 */

import type { InferenceApi, InferenceOperation, InferenceOptions } from './api.js';
import { InvalidInferenceInputError } from './errors.js';
import { FIXTURE_UNAVAILABLE_REASON } from './fixtures.js';
import type {
    BBox,
    Confidence,
    FaceDetection,
    IconClassification,
    InferenceImage,
    InferenceRegion,
    InferenceResult,
    OcrCharacter,
    OcrLine,
    OcrWord,
    UiDetection,
    UiElementClass,
} from './types.js';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Confidence denominator. Integer-then-divide keeps values exact. */
const CONFIDENCE_SCALE = 1000;

/** Detections per ordinary result: 1..MAX. Never zero — `ok` implies non-empty. */
const MAX_ITEMS = 3;

/**
 * Synthetic OCR vocabulary.
 *
 * Deliberately not plausible page text. Fake OCR output flows into PII
 * scanning during integration, and text that resembled a real name or number
 * would make it impossible to tell a genuine detection from fixture noise.
 */
const SYNTHETIC_WORDS = ['SYNTHETIC', 'FAKE', 'SAMPLE', 'PLACEHOLDER'] as const;

/** Icon labels are plausible; synthetic-ness is carried structurally, not cosmetically. */
const ICON_LABELS = ['search', 'menu', 'close', 'settings', 'back'] as const;

const DETECTOR_CLASSES: readonly UiElementClass[] = [
    'button',
    'input',
    'link',
    'icon',
    'text_block',
];

/** FNV-1a over a canonical identity string. Integer ops only, so engine-stable. */
function fnv1a(input: string): number {
    let hash = FNV_OFFSET_BASIS;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
    return hash >>> 0;
}

/** 2^32 — the exclusive upper bound of `createRandom`'s output. */
const RANDOM_RANGE = 0x100000000;

// wtf is this bruh??
/** xorshift32. Small, dependency-free and identical across engines. */
function createRandom(seed: number): () => number {
    let state = seed === 0 ? 1 : seed;
    return () => {
        state ^= (state << 13) >>> 0;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= (state << 5) >>> 0;
        state >>>= 0;
        return state;
    };
}

function seedFor(
    operation: InferenceOperation,
    image: InferenceImage,
    region: InferenceRegion | undefined
): number {
    const regionKey = region ? region.join(',') : '-';
    return fnv1a(`${operation}|${image.frame}|${image.width}x${image.height}|${regionKey}`);
}

function deriveConfidence(next: () => number): Confidence {
    return (next() % (CONFIDENCE_SCALE + 1)) / CONFIDENCE_SCALE;
}

function pick<T>(next: () => number, values: readonly T[]): T {
    // `values` is always a non-empty literal tuple in this module.
    return values[next() % values.length] as T;
}

interface Area {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

/** A value in (0, 1). The generator never returns 0, so neither does this. */
function fraction(next: () => number): number {
    return next() / RANDOM_RANGE;
}

/** Truncates to 2dp. Always rounds *down*, so it can never push a box out of bounds. */
function floor2(value: number): number {
    return Math.floor(value * 100) / 100;
}

/** Offset within an axis, kept to the first 60% so a usable extent remains. */
const OFFSET_SPAN = 0.6;
/** Extent as a proportion of what is left on that axis, in (0.3, 1]. */
const MIN_EXTENT_SHARE = 0.3;

/**
 * A box strictly inside `area`.
 *
 * Offsets and extents are derived as *fractions* of the area rather than by
 * integer modulo. The old `1 + (n % span)` form assumed integral dimensions:
 * for an integer span it yields `[1, span]`, but for a fractional one it yields
 * `[1, 1 + span)` and overruns the edge by up to a whole pixel. Fractional
 * areas are ordinary here — `getBoundingClientRect` returns fractional CSS px
 * and the image frame scales those by DPR — so the arithmetic has to hold for
 * both.
 *
 * `x + w <= area.x + area.w` and `y + h <= area.y + area.h` hold by
 * construction, with `floor2` only ever shrinking the result.
 */
function deriveBox(next: () => number, area: Area): BBox {
    const x = area.x + fraction(next) * area.w * OFFSET_SPAN;
    const y = area.y + fraction(next) * area.h * OFFSET_SPAN;

    const availableW = area.x + area.w - x;
    const availableH = area.y + area.h - y;
    const w = availableW * (MIN_EXTENT_SHARE + fraction(next) * (1 - MIN_EXTENT_SHARE));
    const h = availableH * (MIN_EXTENT_SHARE + fraction(next) * (1 - MIN_EXTENT_SHARE));

    return [floor2(x), floor2(y), floor2(w), floor2(h)];
}

/**
 * The smallest box containing every input box.
 *
 * Computed in integer hundredths. Rounding the extent down would shrink the
 * hull below the boxes it must contain, and rounding up could push it past the
 * area's edge; every input is already at 2dp, so exact integer arithmetic
 * avoids both, and avoids float noise like `0.1 + 0.2` in the output.
 */
function hullOf(boxes: readonly BBox[]): BBox {
    const toHundredths = (value: number): number => Math.round(value * 100);

    const lefts = boxes.map((box) => toHundredths(box[0]));
    const tops = boxes.map((box) => toHundredths(box[1]));
    const rights = boxes.map((box) => toHundredths(box[0]) + toHundredths(box[2]));
    const bottoms = boxes.map((box) => toHundredths(box[1]) + toHundredths(box[3]));

    const left = Math.min(...lefts);
    const top = Math.min(...tops);

    return [
        left / 100,
        top / 100,
        (Math.max(...rights) - left) / 100,
        (Math.max(...bottoms) - top) / 100,
    ];
}

/** Stable ordering, top-to-bottom then left-to-right, so array order is fixed. */
function sortByPosition<T extends { readonly bbox: BBox }>(items: T[]): T[] {
    return [...items].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}

function validate(image: InferenceImage, region: InferenceRegion | undefined): void {
    const { width, height } = image;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        throw new InvalidInferenceInputError(
            `image dimensions must be positive integers, got ${width}x${height}`
        );
    }
    if (!region) return;

    // Regions may be fractional on purpose. `getBoundingClientRect` returns
    // fractional CSS px, and the image frame scales those by DPR, so a region
    // like [0, 0, 2.5, 2.5] is ordinary input rather than a malformed one.
    // `deriveBox` is responsible for staying inside it.
    const [x, y, w, h] = region;
    if (![x, y, w, h].every(Number.isFinite)) {
        throw new InvalidInferenceInputError('region must contain finite numbers');
    }
    if (w < 1 || h < 1) {
        throw new InvalidInferenceInputError(`region must have positive size, got ${w}x${h}`);
    }
    if (x < 0 || y < 0 || x + w > width || y + h > height) {
        throw new InvalidInferenceInputError(
            `region [${region.join(',')}] falls outside a ${width}x${height} image`
        );
    }
}

function areaOf(image: InferenceImage, region: InferenceRegion | undefined): Area {
    if (!region) return { x: 0, y: 0, w: image.width, h: image.height };
    const [x, y, w, h] = region;
    return { x, y, w, h };
}

/**
 * A word plus its raw character confidences in thousandths.
 *
 * The integers are carried alongside so the line can average over *characters*
 * without re-deriving them from the rounded `conf` floats.
 */
interface BuiltWord {
    readonly word: OcrWord;
    readonly charThousandths: readonly number[];
}

function buildOcrWord(next: () => number, area: Area): BuiltWord {
    const text = pick(next, SYNTHETIC_WORDS);
    const bbox = deriveBox(next, area);

    const charThousandths: number[] = [];
    const characters: OcrCharacter[] = [];
    for (const char of text) {
        const thousandths = next() % (CONFIDENCE_SCALE + 1);
        charThousandths.push(thousandths);
        characters.push({ char, conf: thousandths / CONFIDENCE_SCALE });
    }

    // Integer mean, then a single divide: no floating-point accumulation.
    const sum = charThousandths.reduce((total, value) => total + value, 0);
    const meanThousandths = Math.round(sum / charThousandths.length);

    return {
        word: { text, bbox, conf: meanThousandths / CONFIDENCE_SCALE, characters },
        charThousandths,
    };
}

function buildOcrLine(next: () => number, area: Area): OcrLine {
    const wordCount = 1 + (next() % MAX_ITEMS);
    const built: BuiltWord[] = [];
    for (let i = 0; i < wordCount; i += 1) built.push(buildOcrWord(next, area));

    const words = built.map((entry) => entry.word);

    // Mean over every character in the line, not over per-word means. Averaging
    // word means weights a 4-character word the same as an 11-character one, and
    // the §6.8 masking rule keys on this value at a 0.7 threshold — a mis-weighted
    // mean can land a line on the wrong side of it.
    const allThousandths = built.flatMap((entry) => entry.charThousandths);
    const sum = allThousandths.reduce((total, value) => total + value, 0);
    const meanThousandths = Math.round(sum / allThousandths.length);

    return {
        text: words.map((word) => word.text).join(' '),
        // A line box is the hull of its words. Deriving it independently produced
        // boxes that contained none of their own text, which would silently break
        // D-12 alignment and C-13 line-crop classification.
        bbox: hullOf(words.map((word) => word.bbox)),
        meanCharConfidence: meanThousandths / CONFIDENCE_SCALE,
        words,
    };
}

/** Creates a fake engine. Stateless: two instances behave identically. */
export function createFakeInferenceApi(): InferenceApi {
    function run<T extends { readonly bbox: BBox }>(
        operation: InferenceOperation,
        image: InferenceImage,
        options: InferenceOptions | undefined,
        build: (next: () => number, area: Area) => T
    ): InferenceResult<T> {
        const region = options?.region;
        validate(image, region);

        const meta = { frame: image.frame, engine: 'fake', synthetic: true } as const;

        if (options?.fixture === 'unavailable') {
            return { ...meta, status: 'unavailable', reason: FIXTURE_UNAVAILABLE_REASON };
        }
        if (options?.fixture === 'empty') {
            return { ...meta, status: 'empty' };
        }

        const next = createRandom(seedFor(operation, image, region));
        const area = areaOf(image, region);
        const count = 1 + (next() % MAX_ITEMS);

        const items: T[] = [];
        for (let i = 0; i < count; i += 1) items.push(build(next, area));

        return { ...meta, status: 'ok', items: sortByPosition(items) };
    }

    return {
        engine: 'fake',
        synthetic: true,

        // These are `async` rather than returning `Promise.resolve(run(...))` so
        // that input validation surfaces as a rejection. A synchronous throw from
        // a method typed as returning a promise escapes `.catch()` entirely.
        async runDetector(image, options) {
            return run<UiDetection>('runDetector', image, options, (next, area) => ({
                cls: pick(next, DETECTOR_CLASSES),
                bbox: deriveBox(next, area),
                conf: deriveConfidence(next),
            }));
        },

        async runOCR(image, options) {
            return run<OcrLine>('runOCR', image, options, (next, area) => buildOcrLine(next, area));
        },

        async runFaces(image, options) {
            return run<FaceDetection>('runFaces', image, options, (next, area) => ({
                bbox: deriveBox(next, area),
                conf: deriveConfidence(next),
            }));
        },

        async runIcons(image, options) {
            return run<IconClassification>('runIcons', image, options, (next, area) => ({
                bbox: deriveBox(next, area),
                label: pick(next, ICON_LABELS),
                conf: deriveConfidence(next),
            }));
        },
    };
}
