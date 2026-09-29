export interface WordPieceVocab {
  readonly tokenToId: ReadonlyMap<string, number>;
  readonly idToToken: ReadonlyMap<number, string>;
}

export function parseVocabTokens(tokens: readonly string[]): WordPieceVocab {
  const tokenToId = new Map<string, number>();
  const idToToken = new Map<number, string>();

  for (let i = 0; i < tokens.length; i += 1) {
    tokenToId.set(tokens[i]!, i);
    idToToken.set(i, tokens[i]!);
  }

  return { tokenToId, idToToken };
}

export function parseVocab(vocabText: string): WordPieceVocab {
  const lines = vocabText.split('\n');
  const trimmed = lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  return parseVocabTokens(trimmed.map((line) => line.replace(/\r$/, '')));
}
