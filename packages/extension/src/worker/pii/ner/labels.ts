import type { PiiClass } from '@privacagent/protocol';

export type NerEntityType = 'NAME' | 'ADDRESS' | 'ORG' | 'LOCATION' | 'DOB';

const ENTITY_TO_PII_CLASS: Readonly<Record<NerEntityType, PiiClass>> = {
  NAME: 'name',
  ADDRESS: 'address',
  ORG: 'organization',
  LOCATION: 'location',
  DOB: 'dob',
};

export function entityTypeToPiiClass(entityType: string): PiiClass {
  return ENTITY_TO_PII_CLASS[entityType as NerEntityType] ?? 'other';
}

export interface LabelMap {
  readonly idToLabel: ReadonlyMap<number, string>;
}

export function parseLabelMap(labelToId: Readonly<Record<string, number>>): LabelMap {
  const idToLabel = new Map<number, string>();
  for (const [label, id] of Object.entries(labelToId)) idToLabel.set(id, label);
  return { idToLabel };
}

export interface DecodedSpan {
  readonly start: number;
  readonly end: number;
  readonly entityType: string;
}

export function decodeBioSpans(
  tokens: readonly { readonly start: number; readonly end: number }[],
  labelIds: readonly number[],
  labelMap: LabelMap
): DecodedSpan[] {
  const spans: DecodedSpan[] = [];
  let open: { start: number; end: number; entityType: string } | undefined;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const labelId = labelIds[i];

    if (token.start === token.end || labelId === undefined) {
      if (open) {
        spans.push(open);
        open = undefined;
      }
      continue;
    }

    const label = labelMap.idToLabel.get(labelId);
    if (label === undefined || label === 'O') {
      if (open) {
        spans.push(open);
        open = undefined;
      }
      continue;
    }

    const [prefix, entityType] = label.split('-', 2) as [string, string | undefined];
    if (entityType === undefined) {
      if (open) {
        spans.push(open);
        open = undefined;
      }
      continue;
    }

    if (prefix === 'B' || !open || open.entityType !== entityType) {
      if (open) spans.push(open);
      open = { start: token.start, end: token.end, entityType };
    } else {
      open = { ...open, end: token.end };
    }
  }

  if (open) spans.push(open);
  return spans;
}
