import { describe, expect, it } from 'vitest';

import {
  composeSpanRedaction,
  createLocalPlaceholderMinter,
  createVaultPlaceholderMinter,
  mergeOverlappingSpans,
  type RawSpanMatch,
  type SpanSegment,
} from './redact.js';
import type { UseBinding, VaultScopeId } from '../vault/index.js';

function match(start: number, end: number, piiClass: 'email' | 'phone' | 'card'): RawSpanMatch {
  return {
    span: { start, end },
    piiClass,
    detector: 'l2_pattern',
    rule: piiClass,
    synthetic: false,
  };
}

describe('mergeOverlappingSpans', () => {
  it('keeps non-overlapping matches separate and in order', () => {
    const merged = mergeOverlappingSpans([match(10, 15, 'phone'), match(0, 5, 'email')]);
    expect(merged.map((m) => [m.span.start, m.span.end])).toEqual([
      [0, 5],
      [10, 15],
    ]);
    expect(merged.every((m) => !m.ambiguous)).toBe(true);
  });

  it('merges two same-class overlapping matches into their union span, not ambiguous', () => {
    const merged = mergeOverlappingSpans([match(0, 10, 'email'), match(5, 15, 'email')]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      span: { start: 0, end: 15 },
      piiClass: 'email',
      ambiguous: false,
    });
  });

  it('merges two different-class overlapping matches to "other", flagged ambiguous, without dropping coverage', () => {
    const merged = mergeOverlappingSpans([match(0, 10, 'card'), match(5, 15, 'phone')]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      span: { start: 0, end: 15 },
      piiClass: 'other',
      ambiguous: true,
    });
  });

  it('chains a three-way overlap into one widened span', () => {
    const merged = mergeOverlappingSpans([
      match(0, 5, 'email'),
      match(4, 9, 'email'),
      match(8, 12, 'email'),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.span).toEqual({ start: 0, end: 12 });
  });
});

describe('composeSpanRedaction', () => {
  function seg(start: number, end: number, outputText: string, masked = true): SpanSegment {
    return { span: { start, end }, outputText, masked };
  }

  it('preserves a whitespace-only gap around a masked span', () => {
    const text = '  5551234567  ';
    const result = composeSpanRedaction(text, [seg(2, 12, '{{PHONE_1}}')]);
    expect(result.value).toBe('  {{PHONE_1}}  ');
    expect(result.maskedAny).toBe(true);
    expect(result.withheldResidual).toBe(false);
  });

  it('withholds a word-bearing gap while a masked span sits inside a sentence', () => {
    const text = 'Call 5551234567 now';
    const result = composeSpanRedaction(text, [seg(5, 15, '{{PHONE_1}}')]);
    expect(result.value).toBe('{{TEXT_WITHHELD}}{{PHONE_1}}{{TEXT_WITHHELD}}');
    expect(result.maskedAny).toBe(true);
    expect(result.withheldResidual).toBe(true);
  });

  it('withholds a word-bearing gap instead of leaking unchecked text', () => {
    const text = 'Contact me here';
    const result = composeSpanRedaction(text, [seg(8, 10, '{{OTHER_1}}')]);
    expect(result.value).toBe('{{TEXT_WITHHELD}}{{OTHER_1}}{{TEXT_WITHHELD}}');
    expect(result.withheldResidual).toBe(true);
  });

  it('produces exactly one placeholder when a match spans the whole text', () => {
    const text = 'someone@example.test';
    const result = composeSpanRedaction(text, [seg(0, text.length, '{{EMAIL_1}}')]);
    expect(result.value).toBe('{{EMAIL_1}}');
    expect(result.withheldResidual).toBe(false);
  });

  it('never leaks the original substring for an unmasked (withheld) segment', () => {
    const text = 'CANARY-AMBIGUOUS-1234567890123456';
    const result = composeSpanRedaction(text, [seg(0, text.length, '{{TEXT_WITHHELD}}', false)]);
    expect(result.value).not.toContain('CANARY-AMBIGUOUS');
    expect(result.maskedAny).toBe(false);
  });

  it('handles multiple distinct matches with punctuation-only separators preserved', () => {
    const text = 'a@x.test, b@y.test';
    const result = composeSpanRedaction(text, [
      seg(0, 8, '{{EMAIL_1}}'),
      seg(10, 18, '{{EMAIL_2}}'),
    ]);
    expect(result.value).toBe('{{EMAIL_1}}, {{EMAIL_2}}');
    expect(result.withheldResidual).toBe(false);
  });

  it('handles Hindi and emoji surrounding text by withholding the unchecked words, keeping punctuation/whitespace', () => {
    const text = 'संपर्क करें a@x.test 🙂 धन्यवाद';
    const emailStart = text.indexOf('a@x.test');
    const result = composeSpanRedaction(text, [
      seg(emailStart, emailStart + 'a@x.test'.length, '{{EMAIL_1}}'),
    ]);
    expect(result.value).not.toContain('संपर्क');
    expect(result.value).not.toContain('धन्यवाद');
    expect(result.value).toContain('{{EMAIL_1}}');
    expect(result.value.startsWith('{{TEXT_WITHHELD}}')).toBe(true);
  });
});

describe('placeholder minters', () => {
  it('local minter is stable for repeated equal values and monotonic across distinct ones', () => {
    const minter = createLocalPlaceholderMinter();
    const a1 = minter.mint('email', 'a@x.test');
    const b1 = minter.mint('email', 'b@x.test');
    const a2 = minter.mint('email', 'a@x.test');
    expect(a1.placeholder).toBe(a2.placeholder);
    expect(a1.placeholder).not.toBe(b1.placeholder);
    expect(a1.available).toBe(true);
  });

  it('local minter never mints a resolvable placeholder for a secret', () => {
    const minter = createLocalPlaceholderMinter();
    const result = minter.mint('secret', 'hunter2');
    expect(result.placeholder).toBe('{{SECRET}}');
  });

  it('vault minter interns non-secret classes and reports unavailable explicitly on capacity failure', () => {
    let calls = 0;
    const scopeId = 's1' as VaultScopeId;
    const binding: UseBinding = {
      taskId: 't1' as never,
      origin: 'https://a.test',
      docId: 'd1' as never,
      allowedTargets: [],
      operations: [],
    };
    const minter = createVaultPlaceholderMinter({
      vault: {
        intern() {
          calls += 1;
          return calls === 1
            ? { outcome: 'ok', placeholder: '{{EMAIL_1}}' as never }
            : { outcome: 'unavailable', reason: 'capacity_exceeded' };
        },
      },
      scopeId,
      binding,
    });
    const first = minter.mint('email', 'a@x.test');
    const second = minter.mint('email', 'b@x.test');
    expect(first).toEqual({ placeholder: '{{EMAIL_1}}', available: true });
    expect(second).toEqual({ placeholder: '{{TEXT_WITHHELD}}', available: false });
  });

  it('vault minter never calls intern for a secret class', () => {
    let called = false;
    const minter = createVaultPlaceholderMinter({
      vault: {
        intern() {
          called = true;
          return { outcome: 'ok', placeholder: '{{SECRET}}' as never };
        },
      },
      scopeId: 's1' as VaultScopeId,
      binding: {
        taskId: 't1' as never,
        origin: 'https://a.test',
        docId: 'd1' as never,
        allowedTargets: [],
        operations: [],
      },
    });
    const result = minter.mint('secret', 'hunter2');
    expect(result.placeholder).toBe('{{SECRET}}');
    expect(called).toBe(false);
  });
});
