import { describe, expect, it } from 'vitest';

import { createLayeredPiiEngine } from './layered.js';
import type { RawElementCandidate } from './api.js';

describe('layered PII engine (D-02 integration)', () => {
  const engine = createLayeredPiiEngine();

  it('masks a value using the L2-detected class, marking a real (non-synthetic) finding', async () => {
    const result = await engine.scanText({
      evidence: 'dom_text',
      text: 'CANARY-EMAIL-1@example.test',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
    });
    expect(result.outcome).toBe('redacted');
    expect(result.piiClass).toBe('email');
    expect(result.value).toMatch(/^\{\{EMAIL_\d+\}\}$/);
    expect(result.finding).toMatchObject({
      detector: 'l2_pattern',
      synthetic: false,
      decision: 'mask',
    });
  });

  it('withholds a value field wholesale when a match only covers part of it, never emitting a non-placeholder string', async () => {
    const result = await engine.scanText({
      evidence: 'dom_text',
      text: 'contact CANARY-PARTIAL@example.test now',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
    });
    expect(result.outcome).toBe('withheld');
    expect(result.value).toBe('{{TEXT_WITHHELD}}');
  });

  it('withholds a value field wholesale when multiple matches are found in it', async () => {
    const result = await engine.scanText({
      evidence: 'dom_text',
      text: 'CANARY-A@example.test CANARY-B@example.test',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
    });
    expect(result.outcome).toBe('withheld');
    expect(result.value).toBe('{{TEXT_WITHHELD}}');
  });

  it('falls back to L1-hint classification when L2 finds nothing', async () => {
    const result = await engine.scanText({
      evidence: 'dom_text',
      text: 'CANARY-PLAIN-NAME',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
      hints: { inputType: 'email' },
    });
    expect(result.outcome).toBe('redacted');
    expect(result.piiClass).toBe('email');
    expect(result.finding?.detector).toBe('l1_semantic');
    expect(result.finding?.synthetic).toBe(true);
  });

  it('withholds an unclassifiable value when L2 finds nothing and no hint exists — never "clear"', async () => {
    const result = await engine.scanText({
      evidence: 'dom_text',
      text: 'CANARY-UNCLASSIFIED-TEXT',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
    });
    expect(result.outcome).toBe('withheld');
    expect(result.value).toBe('{{TEXT_WITHHELD}}');
    expect(result.finding?.synthetic).toBe(true);
  });

  it('never lets L2 override a password field — always the literal {{SECRET}}', async () => {
    const result = await engine.scanText({
      evidence: 'dom_text',
      text: 'CANARY-PASSWORD-1@example.test',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
      hints: { inputType: 'password' },
    });
    expect(result).toMatchObject({ outcome: 'redacted', piiClass: 'secret', value: '{{SECRET}}' });
    expect(result.finding?.detector).toBe('l1_semantic');
  });

  it('masks only the matched span in a name field, withholding the unchecked surrounding words (D-05)', async () => {
    const result = await engine.scanText({
      evidence: 'dom_text',
      text: 'Contact CANARY-NAME-EMAIL@example.test for help',
      location: { kind: 'element_field', elementId: 'e1', field: 'name' },
    });
    expect(result.outcome).toBe('redacted');
    expect(result.value).toMatch(/^\{\{TEXT_WITHHELD\}\}\{\{EMAIL_\d+\}\}\{\{TEXT_WITHHELD\}\}$/);
    expect(result.piiClass).toBe('email');
    expect(result.finding).toMatchObject({
      detector: 'l2_pattern',
      synthetic: false,
      decision: 'mask',
      piiClass: 'email',
    });
    expect(result.findings).toHaveLength(2);
    expect(result.findings?.[1]).toMatchObject({ decision: 'withhold', piiClass: 'other' });
  });

  it('marks a name field finding synthetic:false when L2 ran and simply found nothing — ran-and-clean is still real coverage', async () => {
    const result = await engine.scanText({
      evidence: 'dom_text',
      text: 'Just a plain accessible name',
      location: { kind: 'element_field', elementId: 'e1', field: 'name' },
    });
    expect(result.outcome).toBe('withheld');
    expect(result.finding).toMatchObject({
      detector: 'l2_pattern',
      synthetic: false,
      piiClass: 'other',
    });
  });

  it('marks synthetic:true when L2 is unavailable (oversized input), never claiming real coverage', async () => {
    const oversized = 'a'.repeat(20_001);
    const result = await engine.scanText({
      evidence: 'dom_text',
      text: oversized,
      location: { kind: 'text_context_entry', index: 0 },
    });
    expect(result.outcome).toBe('withheld');
    expect(result.finding).toMatchObject({ detector: 'stub', synthetic: true });
  });

  it('passes an empty value through unmodified, same as the stub', async () => {
    const result = await engine.scanText({
      evidence: 'dom_text',
      text: '',
      location: { kind: 'element_field', elementId: 'e1', field: 'value' },
    });
    expect(result).toEqual({ outcome: 'clear', value: '' });
  });

  it('produces a wire-safe RedactedElement via redactElement, same orchestration as the stub', async () => {
    const candidate: RawElementCandidate = {
      id: 'e1',
      role: 'textbox',
      rawName: 'Email',
      bbox: [0, 0, 100, 20],
      src: 'dom',
      conf: 1,
      hasValue: true,
      rawValue: 'CANARY-ELEMENT-EMAIL@example.test',
    };
    const outcome = await engine.redactElement(candidate);
    expect(outcome.outcome).toBe('ok');
    if (outcome.outcome !== 'ok') throw new Error('unreachable');
    expect(outcome.element).toMatchObject({ value_state: 'redacted', pii_class: 'email' });
    expect(JSON.stringify(outcome)).not.toContain('CANARY-ELEMENT-EMAIL');
  });

  it('reports engine metadata correctly', () => {
    expect(engine.engine).toBe('layered');
    expect(engine.synthetic).toBe(false);
    expect(engine.recognizedClasses).toContain('email');
  });

  it('still always withholds crops — L2 is text-only', async () => {
    const outcome = await engine.redactCrop({ docId: 'd1', bbox: [0, 0, 10, 10] });
    expect(outcome.outcome).toBe('withheld');
  });
});
