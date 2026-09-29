import {
  MAX_SELECTORS_PER_ORIGIN,
  MAX_SELECTOR_LENGTH,
  MAX_USER_MARKED_REGIONS,
  type SitePolicy,
} from './types.js';

export type ValidationResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function normalizeOrigin(input: string): string | undefined {
  try {
    const url = new URL(input);
    return url.origin;
  } catch {
    return undefined;
  }
}

export function isExactOrigin(candidate: string): boolean {
  return normalizeOrigin(candidate) === candidate;
}

export function validateSelectorShape(selector: string): ValidationResult {
  if (typeof selector !== 'string' || selector.trim().length === 0) {
    return { ok: false, reason: 'selector_empty' };
  }
  if (selector.length > MAX_SELECTOR_LENGTH) {
    return { ok: false, reason: 'selector_too_long' };
  }
  return { ok: true };
}

export function validateSelectorSyntax(selector: string, probe: ParentNode): ValidationResult {
  try {
    probe.querySelector(selector);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'selector_invalid_syntax' };
  }
}

export function validateSelector(selector: string, probe?: ParentNode): ValidationResult {
  const shape = validateSelectorShape(selector);
  if (!shape.ok) return shape;
  if (!probe) return { ok: true };
  return validateSelectorSyntax(selector, probe);
}

export function validatePolicy(policy: SitePolicy, probe?: ParentNode): ValidationResult {
  if (!isExactOrigin(policy.origin)) {
    return { ok: false, reason: 'origin_not_exact' };
  }
  if (policy.alwaysRedactSelectors.length > MAX_SELECTORS_PER_ORIGIN) {
    return { ok: false, reason: 'too_many_selectors' };
  }
  if (policy.userMarkedRegions.length > MAX_USER_MARKED_REGIONS) {
    return { ok: false, reason: 'too_many_user_marked_regions' };
  }
  for (const selector of policy.alwaysRedactSelectors) {
    const result = validateSelector(selector, probe);
    if (!result.ok) return result;
  }
  for (const region of policy.userMarkedRegions) {
    const result = validateSelector(region.selector, probe);
    if (!result.ok) return result;
  }
  return { ok: true };
}
