import { normalizeBert } from './normalize.js';
import { preTokenizeBert } from './pretokenize.js';
import type { WordPieceVocab } from './vocab.js';
import { wordpieceTokenize } from './wordpiece.js';

export interface Token {
  readonly id: number;
  readonly start: number;
  readonly end: number;
}

export interface TokenizerOptions {
  readonly vocab: WordPieceVocab;
  readonly clsToken?: string;
  readonly sepToken?: string;
  readonly unkToken?: string;
  readonly maxWindowTokens?: number;
  readonly stride?: number;
}

const DEFAULTS = {
  clsToken: '[CLS]',
  sepToken: '[SEP]',
  unkToken: '[UNK]',
  maxWindowTokens: 64,
  stride: 16,
};

function requireId(vocab: WordPieceVocab, token: string): number {
  const id = vocab.tokenToId.get(token);
  if (id === undefined) throw new Error(`missing special token in vocab: ${token}`);
  return id;
}

export function tokenizeWindows(text: string, options: TokenizerOptions): Token[][] {
  const { vocab } = options;
  const clsToken = options.clsToken ?? DEFAULTS.clsToken;
  const sepToken = options.sepToken ?? DEFAULTS.sepToken;
  const unkToken = options.unkToken ?? DEFAULTS.unkToken;
  const maxWindowTokens = options.maxWindowTokens ?? DEFAULTS.maxWindowTokens;
  const stride = options.stride ?? DEFAULTS.stride;

  const clsId = requireId(vocab, clsToken);
  const sepId = requireId(vocab, sepToken);
  const unkId = requireId(vocab, unkToken);

  const { text: normalized, toOriginal } = normalizeBert(text);
  const preTokens = preTokenizeBert(normalized);

  const contentTokens: Token[] = [];
  for (const preToken of preTokens) {
    const subTokens = wordpieceTokenize(preToken.text, vocab, unkToken);
    for (const sub of subTokens) {
      const normStart = preToken.start + sub.start;
      const normEnd = preToken.start + sub.end;
      const originalStart = toOriginal[normStart]?.[0] ?? preToken.start;
      const originalEnd = toOriginal[Math.max(normEnd - 1, normStart)]?.[1] ?? preToken.end;
      const id = vocab.tokenToId.get(sub.token) ?? unkId;
      contentTokens.push({ id, start: originalStart, end: originalEnd });
    }
  }

  const capacity = Math.max(1, maxWindowTokens - 2);
  if (contentTokens.length === 0) {
    return [
      [
        { id: clsId, start: 0, end: 0 },
        { id: sepId, start: 0, end: 0 },
      ],
    ];
  }

  const windows: Token[][] = [];
  const step = Math.max(1, capacity - stride);
  for (let offset = 0; offset < contentTokens.length; offset += step) {
    const slice = contentTokens.slice(offset, offset + capacity);
    windows.push([{ id: clsId, start: 0, end: 0 }, ...slice, { id: sepId, start: 0, end: 0 }]);
    if (offset + capacity >= contentTokens.length) break;
  }

  return windows;
}
