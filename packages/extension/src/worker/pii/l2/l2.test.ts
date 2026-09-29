import { describe, expect, it } from 'vitest';

import { ibanValid, luhnValid, verhoeffValid } from './checksums.js';
import { L2_FIXTURES } from './fixtures.js';
import { MAX_L2_INPUT_LENGTH, scanText } from './scan.js';
import type { L2RuleId } from './types.js';

interface Span {
  readonly start: number;
  readonly end: number;
}

function key(ruleId: L2RuleId, span: Span): string {
  return `${ruleId}:${span.start}:${span.end}`;
}

describe('fixture count', () => {
  it('has at least 300 labeled fixtures', () => {
    expect(L2_FIXTURES.length).toBeGreaterThanOrEqual(300);
  });

  it('every fixture id is unique', () => {
    const ids = new Set(L2_FIXTURES.map((f) => f.id));
    expect(ids.size).toBe(L2_FIXTURES.length);
  });
});

describe('every fixture matches exactly what is expected', () => {
  for (const fixture of L2_FIXTURES) {
    it(fixture.id, () => {
      const result = scanText(fixture.text, 'dom_text');
      expect(result.status, fixture.id).toBe('ok');
      if (result.status !== 'ok') return;

      const found = new Set(result.matches.map((m) => key(m.ruleId, m.span)));
      const expected = new Set(
        fixture.expected.map((e) => key(e.ruleId, { start: e.start, end: e.end }))
      );

      expect(found, fixture.id).toEqual(expected);

      for (const match of result.matches) {
        expect(match.evidence).toBe('dom_text');
        expect(match.span.end).toBeGreaterThan(match.span.start);
        expect(fixture.text.slice(match.span.start, match.span.end).length).toBeGreaterThan(0);
      }
    });
  }
});

describe('per-class precision/recall report', () => {
  it('computes and prints measured precision/recall per rule', () => {
    const rules = new Set<L2RuleId>();
    for (const f of L2_FIXTURES) for (const e of f.expected) rules.add(e.ruleId);

    const report: Record<string, { tp: number; fp: number; fn: number; fixtures: number }> = {};
    for (const ruleId of rules) report[ruleId] = { tp: 0, fp: 0, fn: 0, fixtures: 0 };

    for (const fixture of L2_FIXTURES) {
      const result = scanText(fixture.text, 'dom_text');
      if (result.status !== 'ok') continue;

      const found = new Set(result.matches.map((m) => key(m.ruleId, m.span)));
      const expected = new Set(fixture.expected.map((e) => key(e.ruleId, e)));
      const involvedRules = new Set<L2RuleId>([
        ...fixture.expected.map((e) => e.ruleId),
        ...result.matches.map((m) => m.ruleId),
      ]);

      for (const ruleId of involvedRules) {
        report[ruleId] ??= { tp: 0, fp: 0, fn: 0, fixtures: 0 };
        report[ruleId]!.fixtures += 1;
      }
      for (const k of found) {
        const ruleId = k.split(':')[0] as L2RuleId;
        if (expected.has(k)) report[ruleId]!.tp += 1;
        else report[ruleId]!.fp += 1;
      }
      for (const k of expected) {
        if (!found.has(k)) {
          const ruleId = k.split(':')[0] as L2RuleId;
          report[ruleId]!.fn += 1;
        }
      }
    }

    const lines = ['rule,fixtures,tp,fp,fn,precision,recall'];
    for (const [ruleId, { tp, fp, fn, fixtures }] of Object.entries(report).sort()) {
      const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
      const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
      lines.push(
        `${ruleId},${fixtures},${tp},${fp},${fn},${precision.toFixed(3)},${recall.toFixed(3)}`
      );
      expect(precision, ruleId).toBe(1);
      expect(recall, ruleId).toBe(1);
    }
    console.log('\n' + lines.join('\n'));
  });
});

describe('unavailable status', () => {
  it('refuses to scan input over the length guard rather than run unbounded', () => {
    const huge = 'a'.repeat(MAX_L2_INPUT_LENGTH + 1);
    expect(scanText(huge, 'dom_text')).toEqual({
      status: 'unavailable',
      reason: 'input_too_large',
    });
  });

  it('runs normally right at the boundary', () => {
    const atLimit = 'a'.repeat(MAX_L2_INPUT_LENGTH);
    expect(scanText(atLimit, 'dom_text').status).toBe('ok');
  });
});

describe('bounded runtime (no catastrophic backtracking)', () => {
  it('scans a reference-sized (~2KB) input within the PRD L2 budget', () => {
    const reference =
      'Please contact canary.user@example.test or call +919812345670 for support. '.repeat(24);
    const iterations = 20;
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) scanText(reference, 'dom_text');
    const elapsedMs = (performance.now() - start) / iterations;
    console.log(
      `measured: ${elapsedMs.toFixed(3)}ms/scan on ${reference.length}-char reference input ` +
        `(PRD L2 budget goal: ~2ms) — ${elapsedMs <= 2 ? 'within' : 'over'} budget on this machine`
    );
    expect(elapsedMs).toBeLessThan(20);
  });

  it('scans a 20,000-char adversarial input without exponential blowup', () => {
    const adversarial =
      'a@'.repeat(3000) +
      '9'.repeat(3000) +
      'OTP code '.repeat(500) +
      'A'.repeat(3000) +
      '@'.repeat(3000);
    const trimmed = adversarial.slice(0, MAX_L2_INPUT_LENGTH);
    const start = performance.now();
    scanText(trimmed, 'dom_text');
    const elapsedMs = performance.now() - start;
    console.log(
      `measured: ${elapsedMs.toFixed(3)}ms on a ${trimmed.length}-char adversarial input`
    );
    expect(elapsedMs).toBeLessThan(200);
  });
});

describe('unicode and index semantics', () => {
  it('returns UTF-16 code-unit offsets that survive a non-BMP character before the match', () => {
    const text = '🔥🔥🔥 canary.person@example.test';
    const result = scanText(text, 'dom_text');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.matches).toHaveLength(1);
    const [match] = result.matches;
    expect(text.slice(match!.span.start, match!.span.end)).toBe('canary.person@example.test');
  });

  it('does not consume or split a combining mark adjacent to a match', () => {
    const text = 'नमस्ते ऄ॑ canary.person@example.test end';
    const result = scanText(text, 'dom_text');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.matches).toHaveLength(1);
    const [match] = result.matches;
    expect(text.slice(match!.span.start, match!.span.end)).toBe('canary.person@example.test');
  });
});

describe('checksum functions (unit-level, independent of regex matching)', () => {
  it('luhnValid', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
  });

  it('verhoeffValid', () => {
    expect(verhoeffValid('234123412346')).toBe(true);
    expect(verhoeffValid('234123412340')).toBe(false);
  });

  it('ibanValid', () => {
    expect(ibanValid('DE89370400440532013000')).toBe(true);
    expect(ibanValid('DE00370400440532013000')).toBe(false);
    expect(ibanValid('XX89370400440532013000')).toBe(false);
  });
});
