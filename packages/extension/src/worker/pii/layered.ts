import type { PiiClass } from '@privacagent/protocol';

import { buildPiiEngine } from './engineBase.js';
import { scanText as l2ScanText } from './l2/scan.js';
import type { L2Match } from './l2/types.js';
import {
  composeSpanRedaction,
  createLocalPlaceholderMinter,
  createVaultPlaceholderMinter,
  mergeOverlappingSpans,
  type PlaceholderMinter,
  type RawSpanMatch,
  type SpanSegment,
} from './redact.js';
import { classifySemanticEvidence } from './semantic/l1.js';
import { SECRET_PLACEHOLDER, TEXT_WITHHELD } from './stub.js';
import type { PiiEngineApi } from './api.js';
import type {
  FindingLocation,
  PiiFinding,
  PiiTextInput,
  PiiTextResult,
  TextSpan,
} from './types.js';

const L2_RECOGNIZED_CLASSES: readonly PiiClass[] = [
  'email',
  'phone',
  'card',
  'aadhaar',
  'pan',
  'ifsc',
  'upi',
  'iban',
  'jwt',
  'api_key',
  'secret',
];

function withSpan(location: FindingLocation, span: TextSpan): FindingLocation {
  switch (location.kind) {
    case 'element_field':
    case 'page_field':
    case 'text_context_entry':
    case 'user_task_text':
      return { ...location, span };
    default:
      return location;
  }
}

function toRawSpanMatch(match: L2Match): RawSpanMatch {
  return {
    span: match.span,
    piiClass: match.piiClass,
    detector: 'l2_pattern',
    rule: match.ruleId,
    synthetic: false,
  };
}

export function createLayeredPiiEngine(): PiiEngineApi {
  const localMinter = createLocalPlaceholderMinter();

  function minterFor(vaultContext: PiiTextInput['vaultContext']): PlaceholderMinter {
    return vaultContext ? createVaultPlaceholderMinter(vaultContext) : localMinter;
  }

  async function scanText(input: PiiTextInput): Promise<PiiTextResult> {
    const { text, location, evidence, hints, vaultContext } = input;

    if (text === '') {
      return { outcome: 'clear', value: '' };
    }

    const isValueField = location.kind === 'element_field' && location.field === 'value';
    const isPasswordValue = isValueField && hints?.inputType === 'password';

    if (isPasswordValue) {
      const finding: PiiFinding = {
        evidence,
        location,
        piiClass: 'secret',
        detector: 'l1_semantic',
        confidence: 1,
        decision: 'mask',
        synthetic: true,
        rule: 'input_type:password',
      };
      return {
        outcome: 'redacted',
        value: SECRET_PLACEHOLDER,
        piiClass: 'secret',
        finding,
        findings: [finding],
      };
    }

    const l2Result = l2ScanText(text, evidence);
    const l2Ran = l2Result.status === 'ok';
    const rawMatches: RawSpanMatch[] = l2Ran ? l2Result.matches.map(toRawSpanMatch) : [];

    if (rawMatches.length === 0) {
      if (isValueField) {
        const classification = classifySemanticEvidence(hints);
        if (classification.matched) {
          const { piiClass, confidence, rule } = classification;
          const minter = minterFor(vaultContext);
          const minted = minter.mint(piiClass, text);
          const finding: PiiFinding = {
            evidence,
            location,
            piiClass,
            detector: 'l1_semantic',
            confidence,
            decision: minted.available ? 'mask' : 'withhold',
            synthetic: true,
            rule,
          };
          return minted.available
            ? {
                outcome: 'redacted',
                value: minted.placeholder,
                piiClass,
                finding,
                findings: [finding],
              }
            : { outcome: 'withheld', value: TEXT_WITHHELD, piiClass, finding, findings: [finding] };
        }
        const finding: PiiFinding = {
          evidence,
          location,
          piiClass: classification.piiClass,
          detector: 'stub',
          confidence: 1,
          decision: 'withhold',
          synthetic: true,
          rule: classification.rule,
        };
        return {
          outcome: 'withheld',
          value: TEXT_WITHHELD,
          piiClass: classification.piiClass,
          finding,
          findings: [finding],
        };
      }

      const finding: PiiFinding = {
        evidence,
        location,
        piiClass: 'other',
        detector: l2Ran ? 'l2_pattern' : 'stub',
        confidence: 1,
        decision: 'withhold',
        synthetic: !l2Ran,
      };
      return {
        outcome: 'withheld',
        value: TEXT_WITHHELD,
        piiClass: 'other',
        finding,
        findings: [finding],
      };
    }

    const merged = mergeOverlappingSpans(rawMatches);

    if (isValueField) {
      const [sole] = merged;
      const isSoleFullMatch =
        merged.length === 1 &&
        !sole!.ambiguous &&
        sole!.span.start === 0 &&
        sole!.span.end === text.length;

      if (!isSoleFullMatch) {
        const finding: PiiFinding = {
          evidence,
          location,
          piiClass: 'other',
          detector: 'l2_pattern',
          confidence: 1,
          decision: 'withhold',
          synthetic: false,
        };
        return {
          outcome: 'withheld',
          value: TEXT_WITHHELD,
          piiClass: 'other',
          finding,
          findings: [finding],
        };
      }
    }

    const minter = minterFor(vaultContext);
    const segments: SpanSegment[] = [];
    const findings: PiiFinding[] = [];
    const maskedClasses = new Set<PiiClass>();
    let anyMasked = false;

    for (const match of merged) {
      const spanLocation = withSpan(location, match.span);

      if (match.ambiguous) {
        segments.push({ span: match.span, outputText: TEXT_WITHHELD, masked: false });
        findings.push({
          evidence,
          location: spanLocation,
          piiClass: 'other',
          detector: match.detector,
          confidence: 0.5,
          decision: 'withhold',
          synthetic: match.synthetic,
          ...(match.rule && { rule: match.rule }),
        });
        continue;
      }

      const spanText = text.slice(match.span.start, match.span.end);
      const minted = minter.mint(match.piiClass, spanText);

      if (!minted.available) {
        segments.push({ span: match.span, outputText: TEXT_WITHHELD, masked: false });
        findings.push({
          evidence,
          location: spanLocation,
          piiClass: match.piiClass,
          detector: match.detector,
          confidence: 1,
          decision: 'withhold',
          synthetic: match.synthetic,
          ...(match.rule && { rule: match.rule }),
        });
        continue;
      }

      segments.push({ span: match.span, outputText: minted.placeholder, masked: true });
      anyMasked = true;
      maskedClasses.add(match.piiClass);
      findings.push({
        evidence,
        location: spanLocation,
        piiClass: match.piiClass,
        detector: match.detector,
        confidence: 1,
        decision: 'mask',
        synthetic: match.synthetic,
        ...(match.rule && { rule: match.rule }),
      });
    }

    const composed = composeSpanRedaction(text, segments);

    if (composed.withheldResidual) {
      findings.push({
        evidence,
        location,
        piiClass: 'other',
        detector: l2Ran ? 'l2_pattern' : 'stub',
        confidence: 1,
        decision: 'withhold',
        synthetic: !l2Ran,
      });
    }

    if (!anyMasked) {
      return {
        outcome: 'withheld',
        value: composed.value,
        piiClass: 'other',
        finding: findings[0]!,
        findings,
      };
    }

    const piiClass: PiiClass = maskedClasses.size === 1 ? [...maskedClasses][0]! : 'other';
    return {
      outcome: 'redacted',
      value: composed.value,
      piiClass,
      finding: findings[0]!,
      findings,
    };
  }

  return buildPiiEngine({
    engine: 'layered',
    synthetic: false,
    recognizedClasses: L2_RECOGNIZED_CLASSES,
    scanText,
  });
}
