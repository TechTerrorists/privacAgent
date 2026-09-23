export type * from './generated/types.js';
export { MESSAGE_NAMES, PROTOCOL_VERSION } from './generated/messages.js';
export type { MessageMap } from './generated/messages.js';

import type { MessageMap } from './generated/messages.js';
import * as validators from './generated/validators.js';

export type MessageName = keyof MessageMap;
type StandaloneValidator = ((value: unknown) => boolean) & { errors?: unknown };

/** Structural validation only. Never treat this as Egress Guard approval. */
export function isMessage<N extends MessageName>(name: N, value: unknown): value is MessageMap[N] {
  if (!Object.hasOwn(validators, name)) return false;
  const validate: StandaloneValidator = validators[name];
  const valid = validate(value);
  // Ajv errors can contain unexpected property names. Keep those details
  // private and clear the entry point's error reference after validation.
  validate.errors = null;
  return Boolean(valid);
}

export class ProtocolValidationError extends Error {
  constructor() {
    // Deliberately excludes input, paths, validator details and message contents.
    super('Invalid protocol message');
    this.name = 'ProtocolValidationError';
  }
}

export function parseMessage<N extends MessageName>(name: N, value: unknown): MessageMap[N] {
  if (!isMessage(name, value)) throw new ProtocolValidationError();
  return value;
}
