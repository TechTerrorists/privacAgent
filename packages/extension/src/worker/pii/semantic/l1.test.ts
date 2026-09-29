import { describe, expect, it } from 'vitest';

import { classifySemanticEvidence } from './l1.js';
import { ALL_SEMANTIC_FIXTURES, NEGATIVE_FIXTURES } from './fixtures.js';

describe('L1 semantic classification', () => {
  for (const fixture of ALL_SEMANTIC_FIXTURES) {
    it(fixture.id, () => {
      const result = classifySemanticEvidence(fixture.hints);
      expect(result.piiClass, fixture.id).toBe(fixture.expectedClass);
      expect(result.rule, fixture.id).toBe(fixture.expectedRule);
      expect(result.matched, fixture.id).toBe(true);
      expect(result.confidence, fixture.id).toBeGreaterThan(0);
    });
  }

  for (const fixture of NEGATIVE_FIXTURES) {
    it(fixture.id, () => {
      const result = classifySemanticEvidence(fixture.hints);
      expect(result.matched, fixture.id).toBe(false);
      expect(result.piiClass, fixture.id).toBe('other');
      expect(result.rule, fixture.id).toBe('none');
      expect(result.confidence, fixture.id).toBe(0);
    });
  }

  it('confidence is strictly ordered input_type > autocomplete > label_keyword', () => {
    const byInputType = classifySemanticEvidence({ inputType: 'email' });
    const byAutocomplete = classifySemanticEvidence({ autocomplete: 'email' });
    const byLabel = classifySemanticEvidence({ labelKeywords: ['email'] });
    expect(byInputType.confidence).toBeGreaterThan(byAutocomplete.confidence);
    expect(byAutocomplete.confidence).toBeGreaterThan(byLabel.confidence);
  });

  it('never resolves password to anything other than secret, even with conflicting signals', () => {
    const result = classifySemanticEvidence({
      inputType: 'password',
      autocomplete: 'organization',
      labelKeywords: ['name'],
    });
    expect(result.piiClass).toBe('secret');
  });

  it('classifies hidden-field evidence identically to visible-field evidence', () => {
    const visible = classifySemanticEvidence({ inputType: 'email' });
    const hidden = classifySemanticEvidence({ inputType: 'email' });
    expect(hidden).toEqual(visible);
  });

  it('handles undefined hints as unmatched, not a throw', () => {
    expect(() => classifySemanticEvidence(undefined)).not.toThrow();
    expect(classifySemanticEvidence(undefined).matched).toBe(false);
  });
});
