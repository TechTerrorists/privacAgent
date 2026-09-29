import { isMessage } from '@privacagent/protocol';
import { describe, expect, it } from 'vitest';

import { createLayeredPiiEngine } from './layered.js';

function screenStateWithValue(value: string): unknown {
  return {
    protocol: '1.0',
    session_id: 's_demo',
    task_id: 't_demo',
    task_version: 1,
    seq: 1,
    doc_id: 'd_demo',
    observation_id: 1,
    step: 0,
    page: {
      url: 'https://example.test/profile',
      title: 'Profile',
      viewport: { w: 1280, h: 720, scroll_y: 0, page_h: 1000 },
    },
    redaction_scheme: 'v1',
    mode: 'agent',
    kind: 'full',
    elements: [
      {
        id: 'e1',
        role: 'textbox',
        name: 'Email',
        bbox: [20, 40, 200, 32],
        src: 'dom',
        conf: 1,
        value_state: 'redacted',
        value,
        pii_class: 'email',
      },
    ],
    text_context: [],
    suspicious: false,
  };
}

describe('D-05 wire-schema safety: RedactedElement.value must stay a single Placeholder token', () => {
  it('rejects a multi-segment composed string in the value slot (would have been the pre-fix output)', () => {
    expect(
      isMessage(
        'ScreenState',
        screenStateWithValue('{{TEXT_WITHHELD}}{{EMAIL_1}}{{TEXT_WITHHELD}}')
      )
    ).toBe(false);
  });

  it('accepts a single exact placeholder', () => {
    expect(isMessage('ScreenState', screenStateWithValue('{{EMAIL_1}}'))).toBe(true);
    expect(isMessage('ScreenState', screenStateWithValue('{{SECRET}}'))).toBe(true);
    expect(isMessage('ScreenState', screenStateWithValue('{{TEXT_WITHHELD}}'))).toBe(true);
  });

  it('the layered engine never produces a schema-invalid value for a multi-match or partial-match value field', async () => {
    const engine = createLayeredPiiEngine();

    const multiMatch = await engine.scanText({
      evidence: 'dom_text',
      text: 'a@x.test and b@y.test',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
    });
    expect(isMessage('ScreenState', screenStateWithValue(multiMatch.value))).toBe(true);
    expect(multiMatch.outcome).toBe('withheld');
    expect(multiMatch.value).toBe('{{TEXT_WITHHELD}}');

    const partialMatch = await engine.scanText({
      evidence: 'dom_text',
      text: 'contact a@x.test now',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
    });
    expect(isMessage('ScreenState', screenStateWithValue(partialMatch.value))).toBe(true);
    expect(partialMatch.outcome).toBe('withheld');
    expect(partialMatch.value).toBe('{{TEXT_WITHHELD}}');

    const fullMatch = await engine.scanText({
      evidence: 'dom_text',
      text: 'a@x.test',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
    });
    expect(isMessage('ScreenState', screenStateWithValue(fullMatch.value))).toBe(true);
    expect(fullMatch.outcome).toBe('redacted');
  });

  it('a name field is free to carry a composed multi-segment string — no Placeholder constraint on name', () => {
    expect(
      isMessage(
        'ScreenState',
        (() => {
          const state = screenStateWithValue('{{EMAIL_1}}') as {
            elements: Array<Record<string, unknown>>;
          };
          state.elements[0]!.name = 'Contact {{EMAIL_1}} for help';
          return state;
        })()
      )
    ).toBe(true);
  });
});
