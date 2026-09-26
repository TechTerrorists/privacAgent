import { isMessage } from '@privacagent/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { PII_CANARIES, PLACEHOLDER_PATTERN } from './canaries.js';
import { InvalidPiiInputError } from './errors.js';
import { getPiiEngineApi, resetPiiEngineApi, setPiiEngineApi } from './index.js';
import { createStubPiiEngine } from './stub.js';
import type { RawElementCandidate } from './api.js';

afterEach(() => {
  resetPiiEngineApi();
});

describe('C-16 canaries', () => {
  it('never leaks a marker and matches the expected outcome, for every canary', async () => {
    const engine = createStubPiiEngine();

    for (const canary of PII_CANARIES) {
      const result = await engine.scanText({
        evidence: canary.evidence,
        text: canary.text,
        location: canary.location,
        ...(canary.hints && { hints: canary.hints }),
      });

      expect(result.outcome, canary.id).toBe(canary.expectedOutcome);
      expect(result.value, canary.id).not.toContain(canary.marker);

      if (canary.expectedOutcome === 'clear') {
        expect(result.value, canary.id).toBe(canary.text);
        expect(result.finding, canary.id).toBeUndefined();
      } else {
        expect(result.value, canary.id).toMatch(PLACEHOLDER_PATTERN);
        expect(result.finding?.synthetic, canary.id).toBe(true);
      }

      if (canary.expectedOutcome === 'redacted') {
        expect(result.piiClass, canary.id).toBe(canary.expectedPiiClass);
        expect(result.finding?.decision, canary.id).toBe('mask');
      }
      if (canary.expectedOutcome === 'withheld') {
        expect(result.value, canary.id).toBe('{{TEXT_WITHHELD}}');
        expect(result.finding?.decision, canary.id).toBe('withhold');
        if (canary.expectedPiiClass)
          expect(result.piiClass, canary.id).toBe(canary.expectedPiiClass);
      }
    }
  });

  it('never leaks a marker through a full element redaction, including nested fields', async () => {
    const engine = createStubPiiEngine();

    for (const canary of PII_CANARIES.filter((c) => c.location.kind === 'element_field')) {
      const field = (canary.location as { field: string }).field;
      const candidate: RawElementCandidate = {
        id: 'canary-el-full',
        role: 'textbox',
        rawName: field === 'name' ? canary.text : 'label',
        bbox: [0, 0, 10, 10],
        src: canary.evidence === 'ocr' ? 'vision' : 'dom',
        conf: 1,
        hasValue: true,
        rawValue: field === 'value' ? canary.text : 'placeholder-value',
        ...(canary.hints?.inputType && {
          inputType: canary.hints.inputType as RawElementCandidate['inputType'],
        }),
      };

      const outcome = await engine.redactElement(candidate);
      const serialized = JSON.stringify(outcome);
      expect(serialized, canary.id).not.toContain(canary.marker);
    }
  });
});

describe('stub PII engine', () => {
  const engine = createStubPiiEngine();

  const displayCandidate: RawElementCandidate = {
    id: 'e1',
    role: 'link',
    rawName: 'Email address',
    bbox: [0, 0, 100, 20],
    src: 'dom',
    conf: 1,
    hasValue: false,
  };

  const baseCandidate: RawElementCandidate = {
    ...displayCandidate,
    role: 'textbox',
    hasValue: true,
    rawValue: '',
  };

  it('produces a DisplayElement for controls with no value concept', async () => {
    const outcome = await engine.redactElement(displayCandidate);
    expect(outcome.outcome).toBe('ok');
    if (outcome.outcome !== 'ok') throw new Error('unreachable');
    expect('value_state' in outcome.element).toBe(false);
    expect(outcome.element.name).toBe('{{TEXT_WITHHELD}}');
  });

  it('produces an EmptyElement for a genuinely empty value', async () => {
    const outcome = await engine.redactElement({ ...baseCandidate, rawValue: '' });
    expect(outcome.outcome).toBe('ok');
    if (outcome.outcome !== 'ok') throw new Error('unreachable');
    expect(outcome.element).toMatchObject({ value_state: 'empty', value: '' });
  });

  it('masks a classified non-empty value — never produces a FilledElement', async () => {
    const outcome = await engine.redactElement({
      ...baseCandidate,
      rawValue: 'CANARY-EMAIL-990001',
      inputType: 'email',
    });
    expect(outcome.outcome).toBe('ok');
    if (outcome.outcome !== 'ok') throw new Error('unreachable');
    expect(outcome.element).toMatchObject({ value_state: 'redacted', pii_class: 'email' });
    if ('value' in outcome.element) {
      expect(outcome.element.value).not.toContain('CANARY-EMAIL-990001');
      expect(outcome.element.value).toMatch(PLACEHOLDER_PATTERN);
    }
  });

  it('withholds an unclassified non-empty value to {{TEXT_WITHHELD}} rather than inventing a class', async () => {
    const outcome = await engine.redactElement({
      ...baseCandidate,
      rawValue: 'CANARY-UNCLASSIFIED-445',
    });
    expect(outcome.outcome).toBe('ok');
    if (outcome.outcome !== 'ok') throw new Error('unreachable');
    expect(outcome.element).toMatchObject({
      value_state: 'redacted',
      value: '{{TEXT_WITHHELD}}',
      pii_class: 'other',
    });
    expect(JSON.stringify(outcome)).not.toContain('CANARY-UNCLASSIFIED-445');
  });

  it('uses the literal {{SECRET}} placeholder for password fields, never a numbered one', async () => {
    const outcome = await engine.redactElement({
      ...baseCandidate,
      rawValue: 'CANARY-PASSWORD-778',
      inputType: 'password',
    });
    expect(outcome.outcome).toBe('ok');
    if (outcome.outcome !== 'ok') throw new Error('unreachable');
    expect(outcome.element).toMatchObject({ value_state: 'redacted', pii_class: 'secret' });
    if ('value' in outcome.element) expect(outcome.element.value).toBe('{{SECRET}}');
  });

  it('withholds the whole element rather than forwarding a non-finite bbox', async () => {
    const outcome = await engine.redactElement({
      ...baseCandidate,
      bbox: [0, 0, Number.NaN, 20],
    });
    expect(outcome.outcome).toBe('withheld');
  });

  it('withholds the whole element rather than forwarding a missing id or role', async () => {
    const outcome = await engine.redactElement({ ...baseCandidate, id: '' });
    expect(outcome.outcome).toBe('withheld');
  });

  it('throws on a caller contract violation rather than silently forwarding raw content', async () => {
    await expect(
      engine.redactElement({ ...displayCandidate, role: 'textbox', hasValue: true })
    ).rejects.toBeInstanceOf(InvalidPiiInputError);
  });

  it('drops withheld text_context entries rather than sending an empty string', async () => {
    const result = await engine.redactTextContext(
      ['', 'CANARY-CONTEXT-556', 'plain safe text is still non-empty and gets withheld too'],
      'doc-1'
    );
    expect(result.values).toEqual(['']);
    expect(result.withheldCount).toBe(2);
    expect(result.values.join(' ')).not.toContain('CANARY-CONTEXT-556');
  });

  it('always withholds crops — D-01 ships no crop pipeline', async () => {
    const outcome = await engine.redactCrop({ docId: 'doc-1', bbox: [0, 0, 64, 64] });
    expect(outcome.outcome).toBe('withheld');
    expect(outcome.finding.decision).toBe('withhold');
    expect(outcome.finding.synthetic).toBe(true);
  });

  it('numbers placeholders per class across calls on the same engine instance', async () => {
    const fresh = createStubPiiEngine();
    const first = await fresh.scanText({
      evidence: 'dom_text',
      text: 'CANARY-A',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
      hints: { inputType: 'email' },
    });
    const second = await fresh.scanText({
      evidence: 'dom_text',
      text: 'CANARY-B',
      location: { kind: 'element_field', elementId: 'e2', field: 'value' },
      hints: { inputType: 'email' },
    });
    expect(first.value).toBe('{{EMAIL_1}}');
    expect(second.value).toBe('{{EMAIL_2}}');
  });
});

describe('emitted elements validate against E-01', () => {
  it('produces a FullScreenState that passes protocol validation, redacted values and all', async () => {
    const engine = createStubPiiEngine();

    const emailOutcome = await engine.redactElement({
      id: 'e1',
      role: 'textbox',
      rawName: 'Email',
      bbox: [20, 40, 200, 32],
      src: 'dom',
      conf: 1,
      inputType: 'email',
      hasValue: true,
      rawValue: 'CANARY-SCREENSTATE-EMAIL-1',
    });
    const passwordOutcome = await engine.redactElement({
      id: 'e2',
      role: 'textbox',
      rawName: 'Password',
      bbox: [20, 80, 200, 32],
      src: 'dom',
      conf: 1,
      inputType: 'password',
      hasValue: true,
      rawValue: 'CANARY-SCREENSTATE-SECRET-2',
    });
    const linkOutcome = await engine.redactElement({
      id: 'e3',
      role: 'link',
      rawName: 'Forgot password?',
      bbox: [20, 120, 120, 20],
      src: 'dom',
      conf: 1,
      hasValue: false,
    });
    expect(emailOutcome.outcome).toBe('ok');
    expect(passwordOutcome.outcome).toBe('ok');
    expect(linkOutcome.outcome).toBe('ok');
    if (
      emailOutcome.outcome !== 'ok' ||
      passwordOutcome.outcome !== 'ok' ||
      linkOutcome.outcome !== 'ok'
    ) {
      throw new Error('unreachable');
    }

    const textContext = await engine.redactTextContext(
      ['Sign in to continue', 'CANARY-SCREENSTATE-CONTEXT-3'],
      'd_demo'
    );

    const screenState = {
      protocol: '1.0',
      session_id: 's_demo',
      task_id: 't_demo',
      task_version: 1,
      seq: 1,
      doc_id: 'd_demo',
      observation_id: 1,
      step: 0,
      page: {
        url: 'https://example.test/login',
        title: 'Sign in',
        viewport: { w: 1280, h: 720, scroll_y: 0, page_h: 720 },
      },
      redaction_scheme: 'v1',
      mode: 'agent',
      kind: 'full',
      elements: [emailOutcome.element, passwordOutcome.element, linkOutcome.element],
      text_context: textContext.values,
      suspicious: false,
    };

    expect(isMessage('ScreenState', screenState)).toBe(true);
    const serialized = JSON.stringify(screenState);
    expect(serialized).not.toContain('CANARY-SCREENSTATE');
  });
});

describe('registry', () => {
  it('defaults to the stub and can be swapped and reset', () => {
    expect(getPiiEngineApi().engine).toBe('stub');

    const custom = createStubPiiEngine();
    setPiiEngineApi(custom);
    expect(getPiiEngineApi()).toBe(custom);

    resetPiiEngineApi();
    expect(getPiiEngineApi().engine).toBe('stub');
    expect(getPiiEngineApi()).not.toBe(custom);
  });
});
