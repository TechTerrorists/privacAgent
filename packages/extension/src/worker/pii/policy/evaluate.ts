import type { DocumentId, ElementId } from '@privacagent/protocol';

import type { PiiFinding } from '../types.js';
import { validateSelector } from './validate.js';
import { MAX_MATCHED_ELEMENTS_PER_SELECTOR, type SitePolicy } from './types.js';

export function isNeverSendOrigin(policy: SitePolicy | undefined): boolean {
  return policy?.neverSend ?? false;
}

export function matchAlwaysRedactSelectors(
  root: ParentNode,
  selectors: readonly string[],
  docId: DocumentId,
  resolveElementId: (element: Element) => ElementId | undefined
): PiiFinding[] {
  const findings: PiiFinding[] = [];
  const seenElementIds = new Set<ElementId>();

  for (const selector of selectors) {
    if (!validateSelector(selector, root).ok) continue;

    let matched: NodeListOf<Element>;
    try {
      matched = root.querySelectorAll(selector);
    } catch {
      continue;
    }

    const bounded = Array.from(matched).slice(0, MAX_MATCHED_ELEMENTS_PER_SELECTOR);
    for (const element of bounded) {
      const elementId = resolveElementId(element);
      if (!elementId || seenElementIds.has(elementId)) continue;
      seenElementIds.add(elementId);
      findings.push({
        evidence: 'dom_structure',
        location: { kind: 'element_scope', elementId, docId },
        piiClass: 'other',
        detector: 'l5_policy',
        confidence: 1,
        decision: 'withhold',
        synthetic: false,
        rule: 'always_redact_selector',
      });
    }
  }

  return findings;
}

function findingKey(finding: PiiFinding): string {
  const location = finding.location;
  switch (location.kind) {
    case 'element_field':
      return `element_field:${location.elementId}:${location.field}`;
    case 'element_scope':
      return `element_scope:${location.elementId}`;
    case 'page_field':
      return `page_field:${location.field}`;
    case 'text_context_entry':
      return `text_context_entry:${location.index}`;
    case 'user_task_text':
      return `user_task_text:${location.source}`;
    case 'region':
      return `region:${location.docId}:${location.bbox.join(',')}`;
  }
}

export function mergeDetectorAndPolicy(
  detectorFindings: readonly PiiFinding[],
  policyFindings: readonly PiiFinding[]
): PiiFinding[] {
  const covered = new Set(detectorFindings.map(findingKey));
  const merged = [...detectorFindings];
  for (const policyFinding of policyFindings) {
    const key = findingKey(policyFinding);
    if (covered.has(key)) continue;
    covered.add(key);
    merged.push(policyFinding);
  }
  return merged;
}
