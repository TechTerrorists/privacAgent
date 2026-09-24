import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  isMessage,
  parseMessage,
  ProtocolValidationError,
  MESSAGE_NAMES,
  PROTOCOL_VERSION,
  type MessageName,
  type Action,
  type Element,
  type BBox,
  type ElementState,
  type DocumentId,
} from './index.js';

interface Fixture {
  name: string;
  message: MessageName;
  payload: unknown;
}
const valid: Fixture[] = JSON.parse(
  readFileSync(new URL('../fixtures/valid.json', import.meta.url), 'utf8')
);
const invalid: Fixture[] = JSON.parse(
  readFileSync(new URL('../fixtures/invalid.json', import.meta.url), 'utf8')
);

describe('wire contract', () => {
  it.each(valid)('accepts and preserves $name', ({ message, payload }) => {
    expect(isMessage(message, payload)).toBe(true);
    const serialized = JSON.stringify(parseMessage(message, payload));
    expect(parseMessage(message, JSON.parse(serialized))).toEqual(payload);
  });

  it.each(invalid)('rejects $name without exposing payloads', ({ message, payload }) => {
    expect(isMessage(message, payload)).toBe(false);
    expect(() => parseMessage(message, payload)).toThrowError(ProtocolValidationError);
    expect(() => parseMessage(message, payload)).toThrowError(/^Invalid protocol message$/);
  });

  it('has a valid fixture for every public message and action variant', () => {
    expect(new Set(valid.map((c) => c.message))).toEqual(new Set(MESSAGE_NAMES));
    const commands = valid
      .filter((c) => c.message === 'Action')
      .map((c) => (c.payload as Action).action.type);
    expect(new Set(commands)).toEqual(
      new Set([
        'click',
        'type',
        'select',
        'scroll',
        'press_key',
        'wait',
        'navigate',
        'extract',
        'ask_user',
        'escalate',
        'done',
        'point',
        'annotate',
        'say',
        'answer',
        'switch_tab',
        'report',
      ])
    );
  });

  it('pins the protocol version and rejects unknown versions at every boundary', () => {
    expect(PROTOCOL_VERSION).toBe('1.0');
    for (const { message, payload } of valid) {
      expect(isMessage(message, { ...(payload as object), protocol: '2.0' })).toBe(false);
    }
  });

  it('narrows generated discriminated action types', () => {
    const data: unknown = valid.find((c) => c.name === 'typed-action')?.payload;
    if (!isMessage('Action', data)) throw new Error('Fixture must validate');
    if (data.action.type !== 'type') throw new Error('Expected a type command');
    const target: string = data.action.target;
    const clear: boolean = data.action.clear_first;
    expect([target, clear]).toEqual(['e1', true]);
    // @ts-expect-error TypeCommand does not have NavigateCommand's URL field.
    expect(data.action.url).toBeUndefined();
  });

  it('rejects non-JSON numbers', () => {
    const fixture = valid.find((c) => c.message === 'ScreenState');
    for (const number of [NaN, Infinity, -Infinity]) {
      const data = JSON.parse(JSON.stringify(fixture?.payload));
      data.elements[0].bbox[0] = number;
      expect(isMessage('ScreenState', data)).toBe(false);
    }
  });

  it('exposes the B-01 element model with document context and optional state', () => {
    const fixture = valid.find((c) => c.name === 'b01-element-catalog');
    const observation = parseMessage('ScreenState', fixture?.payload);
    const docId: DocumentId = observation.doc_id;
    const element: Element | undefined = observation.elements.find((e) => e.id === 'e_button');
    if (!element) throw new Error('Missing button fixture');
    const bbox: BBox = element.bbox;
    const source: Element['src'] = element.src;
    const state: ElementState | undefined = element.state;
    expect({ docId, id: element.id, bbox, source, state }).toEqual({
      docId: 'doc_element_catalog',
      id: 'e_button',
      bbox: [20, 40, 120, 32],
      source: 'dom',
      state: { disabled: false, focused: true, occluded: false },
    });
    expect(state?.invalid).toBeUndefined();
    expect(observation.elements.find((e) => e.id === 'v_help')).not.toHaveProperty('state');
  });

  it('narrows form-value variants without treating display elements as empty inputs', () => {
    const fixture = valid.find((c) => c.name === 'b01-element-catalog');
    const observation = parseMessage('ScreenState', fixture?.payload);
    const variants = observation.elements.map((element: Element) => {
      if (!('value_state' in element)) return 'display';
      switch (element.value_state) {
        case 'empty': {
          const value: '' = element.value;
          expect(value).toBe('');
          return 'empty';
        }
        case 'filled':
          expect(element.value.length).toBeGreaterThan(0);
          return 'filled';
        case 'redacted':
          expect([element.value, element.pii_class]).toEqual(['{{EMAIL_1}}', 'email']);
          return 'redacted';
      }
    });
    expect(variants).toEqual([
      'display',
      'display',
      'filled',
      'display',
      'empty',
      'redacted',
      'display',
      'display',
    ]);
  });

  it('uses a standalone browser validator without dynamic evaluation or Node dependencies', () => {
    const source = readFileSync(new URL('./generated/validators.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\beval\s*\(|\bnew\s+Function\s*\(|from\s+['"]node:/);
  });

  it('runs the bundled browser API with runtime code generation disabled', () => {
    const bundle = buildSync({
      stdin: {
        contents: "import { isMessage } from './index.ts'; globalThis.validateMessage = isMessage;",
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      write: false,
    });
    const context: { validateMessage?: typeof isMessage } = {};
    runInNewContext(bundle.outputFiles[0]!.text, context, {
      contextCodeGeneration: { strings: false, wasm: false },
      timeout: 5000,
    });
    for (const fixture of valid) {
      expect(context.validateMessage?.(fixture.message, fixture.payload), fixture.name).toBe(true);
    }
    for (const fixture of invalid) {
      expect(context.validateMessage?.(fixture.message, fixture.payload), fixture.name).toBe(false);
    }
  });

  it('round-trips TypeScript -> Python -> TypeScript with matching rejection', () => {
    const fixtures = [...valid, ...invalid];
    const result = execFileSync(
      'uv',
      [
        'run',
        '--locked',
        '--project',
        fileURLToPath(new URL('../../..', import.meta.url)),
        'python',
        fileURLToPath(new URL('../tests/roundtrip.py', import.meta.url)),
      ],
      { input: JSON.stringify(fixtures), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
    );
    const outputs = JSON.parse(result) as { name: string; valid: boolean; payload?: unknown }[];
    expect(outputs).toHaveLength(fixtures.length);
    for (const [index, fixture] of fixtures.entries()) {
      const output = outputs[index];
      expect(output?.name).toBe(fixture.name);
      expect(output?.valid, fixture.name).toBe(isMessage(fixture.message, fixture.payload));
      if (output?.valid) {
        expect(parseMessage(fixture.message, output.payload), fixture.name).toEqual(
          fixture.payload
        );
      }
    }
  }, 30_000);
});
