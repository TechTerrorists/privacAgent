// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import type { PiiFinding } from '../types.js';
import {
  isNeverSendOrigin,
  matchAlwaysRedactSelectors,
  mergeDetectorAndPolicy,
} from './evaluate.js';
import { emptyPolicy, MAX_MATCHED_ELEMENTS_PER_SELECTOR, type SitePolicy } from './types.js';
import { isExactOrigin, validatePolicy, validateSelector } from './validate.js';

function detectorFinding(elementId: string, field: 'name' | 'value' = 'value'): PiiFinding {
  return {
    evidence: 'dom_text',
    location: { kind: 'element_field', elementId, field },
    piiClass: 'email',
    detector: 'l2_pattern',
    confidence: 1,
    decision: 'mask',
    synthetic: false,
  };
}

describe('origin validation', () => {
  it('accepts an exact origin with no path or trailing slash', () => {
    expect(isExactOrigin('https://example.test')).toBe(true);
  });

  it('rejects an origin with a path, query, or trailing slash', () => {
    expect(isExactOrigin('https://example.test/')).toBe(false);
    expect(isExactOrigin('https://example.test/path')).toBe(false);
    expect(isExactOrigin('https://example.test?x=1')).toBe(false);
  });

  it('rejects a malformed origin string', () => {
    expect(isExactOrigin('not a url')).toBe(false);
  });
});

describe('selector validation', () => {
  it('accepts a syntactically valid selector', () => {
    expect(validateSelector('input[type="email"]', document)).toEqual({ ok: true });
  });

  it('rejects an empty selector', () => {
    expect(validateSelector('', document)).toEqual({ ok: false, reason: 'selector_empty' });
  });

  it('rejects an overlong selector', () => {
    const huge = 'div '.repeat(200);
    expect(validateSelector(huge, document).ok).toBe(false);
  });

  it('rejects invalid selector syntax without throwing', () => {
    let result: ReturnType<typeof validateSelector> | undefined;
    expect(() => {
      result = validateSelector(':::not-a-selector', document);
    }).not.toThrow();
    expect(result).toEqual({ ok: false, reason: 'selector_invalid_syntax' });
  });
});

describe('policy validation', () => {
  it('accepts a well-formed policy', () => {
    const policy: SitePolicy = {
      origin: 'https://example.test',
      alwaysRedactSelectors: ['.sensitive'],
      neverSend: false,
      userMarkedRegions: [{ id: 'r1', selector: '#marked' }],
    };
    expect(validatePolicy(policy, document)).toEqual({ ok: true });
  });

  it('rejects a policy with a non-exact origin', () => {
    const policy = { ...emptyPolicy('https://example.test/path') };
    expect(validatePolicy(policy, document)).toEqual({ ok: false, reason: 'origin_not_exact' });
  });

  it('rejects a policy with an invalid selector inside it', () => {
    const policy: SitePolicy = {
      ...emptyPolicy('https://example.test'),
      alwaysRedactSelectors: ['div', ':::bad'],
    };
    expect(validatePolicy(policy, document).ok).toBe(false);
  });

  it('rejects a policy with too many selectors', () => {
    const policy: SitePolicy = {
      ...emptyPolicy('https://example.test'),
      alwaysRedactSelectors: Array.from({ length: 51 }, (_, i) => `.s${i}`),
    };
    expect(validatePolicy(policy, document)).toEqual({ ok: false, reason: 'too_many_selectors' });
  });
});

describe('matchAlwaysRedactSelectors', () => {
  it('matches a visible element covered by a selector', () => {
    document.body.innerHTML = '<div class="sensitive" data-el="e1">secret</div>';
    const resolve = (el: Element) => el.getAttribute('data-el') ?? undefined;
    const findings = matchAlwaysRedactSelectors(document, ['.sensitive'], 'd1', resolve);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      evidence: 'dom_structure',
      location: { kind: 'element_scope', elementId: 'e1', docId: 'd1' },
      detector: 'l5_policy',
      decision: 'withhold',
      synthetic: false,
      rule: 'always_redact_selector',
    });
  });

  it('matches a hidden element the same as a visible one', () => {
    document.body.innerHTML = '<input type="hidden" class="sensitive" data-el="e2" value="secret">';
    const resolve = (el: Element) => el.getAttribute('data-el') ?? undefined;
    const findings = matchAlwaysRedactSelectors(document, ['.sensitive'], 'd1', resolve);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location).toEqual({ kind: 'element_scope', elementId: 'e2', docId: 'd1' });
  });

  it('skips an invalid selector without throwing and still applies the valid ones', () => {
    document.body.innerHTML = '<div class="sensitive" data-el="e1"></div>';
    const resolve = (el: Element) => el.getAttribute('data-el') ?? undefined;
    let findings: ReturnType<typeof matchAlwaysRedactSelectors> | undefined;
    expect(() => {
      findings = matchAlwaysRedactSelectors(document, [':::also-bad', '.sensitive'], 'd1', resolve);
    }).not.toThrow();
    expect(findings).toHaveLength(1);
  });

  it('deduplicates one element matched by two different selectors', () => {
    document.body.innerHTML = '<div class="a b" data-el="e1"></div>';
    const resolve = (el: Element) => el.getAttribute('data-el') ?? undefined;
    const findings = matchAlwaysRedactSelectors(document, ['.a', '.b'], 'd1', resolve);
    expect(findings).toHaveLength(1);
  });

  it('bounds the number of matched elements per selector', () => {
    const many = Array.from(
      { length: MAX_MATCHED_ELEMENTS_PER_SELECTOR + 20 },
      (_, i) => `<div class="s" data-el="e${i}"></div>`
    ).join('');
    document.body.innerHTML = many;
    const resolve = (el: Element) => el.getAttribute('data-el') ?? undefined;
    const findings = matchAlwaysRedactSelectors(document, ['.s'], 'd1', resolve);
    expect(findings.length).toBe(MAX_MATCHED_ELEMENTS_PER_SELECTOR);
  });

  it('skips elements the caller cannot resolve to a known element id', () => {
    document.body.innerHTML = '<div class="sensitive"></div>';
    const findings = matchAlwaysRedactSelectors(document, ['.sensitive'], 'd1', () => undefined);
    expect(findings).toHaveLength(0);
  });
});

describe('isNeverSendOrigin', () => {
  it('is false for an undefined policy', () => {
    expect(isNeverSendOrigin(undefined)).toBe(false);
  });

  it('reflects the stored neverSend flag', () => {
    expect(isNeverSendOrigin({ ...emptyPolicy('https://example.test'), neverSend: true })).toBe(
      true
    );
  });
});

describe('mergeDetectorAndPolicy', () => {
  it('keeps every detector finding unchanged', () => {
    const detector = [detectorFinding('e1')];
    const merged = mergeDetectorAndPolicy(detector, []);
    expect(merged).toEqual(detector);
  });

  it('adds a policy finding for an element the detector never covered', () => {
    const detector = [detectorFinding('e1')];
    const policy: PiiFinding = {
      evidence: 'dom_structure',
      location: { kind: 'element_scope', elementId: 'e2', docId: 'd1' },
      piiClass: 'other',
      detector: 'l5_policy',
      confidence: 1,
      decision: 'withhold',
      synthetic: false,
      rule: 'always_redact_selector',
    };
    const merged = mergeDetectorAndPolicy(detector, [policy]);
    expect(merged).toHaveLength(2);
    expect(merged).toContainEqual(detector[0]);
    expect(merged).toContainEqual(policy);
  });

  it('never removes or downgrades a detector finding, even when policy also covers it', () => {
    const detector = [detectorFinding('e1', 'value')];
    const policyForSameElement: PiiFinding = {
      evidence: 'dom_structure',
      location: { kind: 'element_scope', elementId: 'e1', docId: 'd1' },
      piiClass: 'other',
      detector: 'l5_policy',
      confidence: 1,
      decision: 'withhold',
      synthetic: false,
      rule: 'always_redact_selector',
    };
    const merged = mergeDetectorAndPolicy(detector, [policyForSameElement]);
    expect(merged).toContainEqual(detector[0]);
    expect(merged.some((f) => f.decision === 'mask' && f.piiClass === 'email')).toBe(true);
  });

  it('deduplicates an identical policy finding rather than adding it twice', () => {
    const policy: PiiFinding = {
      evidence: 'dom_structure',
      location: { kind: 'element_scope', elementId: 'e1', docId: 'd1' },
      piiClass: 'other',
      detector: 'l5_policy',
      confidence: 1,
      decision: 'withhold',
      synthetic: false,
      rule: 'always_redact_selector',
    };
    const merged = mergeDetectorAndPolicy([], [policy, policy]);
    expect(merged).toHaveLength(1);
  });
});
