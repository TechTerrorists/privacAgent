import type { CandidateReason } from './types.js';

const CONTROLS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
const CONTEXT = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'output']);
const IGNORED = new Set(['script', 'style', 'template', 'noscript']);

export function ignoresContent(element: Element): boolean {
  return IGNORED.has(element.localName);
}

/** Discovery only: B-03/B-04 decide semantic roles, visibility and occlusion. */
export function candidateReasons(element: Element): CandidateReason[] {
  if (ignoresContent(element)) return [];
  const reasons: CandidateReason[] = [];
  const tag = element.localName;
  if (CONTROLS.has(tag)) reasons.push('native-control');
  if (element.hasAttribute('role')) reasons.push('role');
  const editable = element.getAttribute('contenteditable');
  if (editable !== null && /^(?:true|plaintext-only)?$/i.test(editable)) reasons.push('editable');
  if (element.hasAttribute('tabindex')) reasons.push('tabindex');
  const live = element.getAttribute('aria-live');
  if (
    CONTEXT.has(tag) ||
    element.getAttribute('role') === 'alert' ||
    element.getAttribute('role') === 'status' ||
    (live !== null && live !== 'off')
  )
    reasons.push('context');
  if (tag === 'iframe') reasons.push('frame');
  // Avoid layout/style work for nodes already known to be candidates.
  if (
    reasons.length === 0 &&
    element.ownerDocument.defaultView?.getComputedStyle(element).cursor === 'pointer'
  ) {
    reasons.push('pointer');
  }
  return reasons;
}
