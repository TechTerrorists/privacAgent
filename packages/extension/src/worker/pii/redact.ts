import type { PiiClass } from '@privacagent/protocol';

import { classPlaceholder, SECRET_PLACEHOLDER, TEXT_WITHHELD } from './stub.js';
import type { DetectorLayer, TextSpan, VaultTextContext } from './types.js';

export interface RawSpanMatch {
  readonly span: TextSpan;
  readonly piiClass: PiiClass;
  readonly detector: DetectorLayer;
  readonly rule?: string;
  readonly synthetic: boolean;
}

export interface MergedSpanMatch extends RawSpanMatch {
  readonly ambiguous: boolean;
}

export function mergeOverlappingSpans(matches: readonly RawSpanMatch[]): MergedSpanMatch[] {
  const sorted = [...matches].sort(
    (a, b) => a.span.start - b.span.start || a.span.end - b.span.end
  );
  const merged: MergedSpanMatch[] = [];

  for (const match of sorted) {
    const last = merged[merged.length - 1];
    if (last && match.span.start < last.span.end) {
      const sameClass = last.piiClass === match.piiClass;
      merged[merged.length - 1] = {
        span: {
          start: Math.min(last.span.start, match.span.start),
          end: Math.max(last.span.end, match.span.end),
        },
        piiClass: sameClass ? last.piiClass : 'other',
        detector: last.detector,
        synthetic: last.synthetic || match.synthetic,
        ambiguous: !sameClass || last.ambiguous,
        ...(sameClass && last.rule !== undefined && { rule: last.rule }),
      };
    } else {
      merged.push({ ...match, ambiguous: false });
    }
  }

  return merged;
}

export interface SpanSegment {
  readonly span: TextSpan;
  readonly outputText: string;
  readonly masked: boolean;
}

const SAFE_GAP_PATTERN = /^[\s\p{P}]*$/u;

export interface ComposedText {
  readonly value: string;
  readonly maskedAny: boolean;
  readonly withheldResidual: boolean;
}

export function composeSpanRedaction(text: string, segments: readonly SpanSegment[]): ComposedText {
  const sorted = [...segments].sort((a, b) => a.span.start - b.span.start);
  const parts: string[] = [];
  let cursor = 0;
  let maskedAny = false;
  let withheldResidual = false;

  function pushGap(gap: string): void {
    if (gap.length === 0) return;
    if (SAFE_GAP_PATTERN.test(gap)) {
      parts.push(gap);
    } else {
      parts.push(TEXT_WITHHELD);
      withheldResidual = true;
    }
  }

  for (const segment of sorted) {
    pushGap(text.slice(cursor, segment.span.start));
    parts.push(segment.outputText);
    if (segment.masked) maskedAny = true;
    cursor = segment.span.end;
  }
  pushGap(text.slice(cursor));

  return { value: parts.join(''), maskedAny, withheldResidual };
}

export interface PlaceholderMinter {
  mint(
    piiClass: PiiClass,
    value: string
  ): { readonly placeholder: string; readonly available: boolean };
}

export function createLocalPlaceholderMinter(): PlaceholderMinter {
  const forward = new Map<PiiClass, Map<string, string>>();
  const counters = new Map<PiiClass, number>();

  return {
    mint(piiClass, value) {
      if (piiClass === 'secret') {
        return { placeholder: SECRET_PLACEHOLDER, available: true };
      }
      let classForward = forward.get(piiClass);
      if (!classForward) {
        classForward = new Map();
        forward.set(piiClass, classForward);
      }
      const existing = classForward.get(value);
      if (existing) return { placeholder: existing, available: true };

      const n = (counters.get(piiClass) ?? 0) + 1;
      counters.set(piiClass, n);
      const placeholder = classPlaceholder(piiClass, n);
      classForward.set(value, placeholder);
      return { placeholder, available: true };
    },
  };
}

export function createVaultPlaceholderMinter(context: VaultTextContext): PlaceholderMinter {
  return {
    mint(piiClass, value) {
      if (piiClass === 'secret') {
        return { placeholder: SECRET_PLACEHOLDER, available: true };
      }
      const result = context.vault.intern(context.scopeId, {
        piiClass,
        value,
        binding: context.binding,
      });
      if (result.outcome === 'ok') {
        return { placeholder: result.placeholder, available: true };
      }
      return { placeholder: TEXT_WITHHELD, available: false };
    },
  };
}
