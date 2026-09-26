/**
 * Message bus error classes and helpers (feature A-03).
 */

import { type MessageErrorCode } from './types.js';

/**
 * Standard error emitted or rejected by the MessageBus.
 * Carries a bounded error code and sanitized diagnostic message.
 * Never includes raw payloads, secret values, or DOM text.
 */
export class MessageBusError extends Error {
  constructor(
    public readonly code: MessageErrorCode,
    message: string
  ) {
    super(`[${code}] ${message}`);
    this.name = 'MessageBusError';
  }
}

/**
 * Sanitizes any unknown caught error into a safe MessageBusError.
 */
export function toMessageBusError(err: unknown, defaultCode: MessageErrorCode): MessageBusError {
  if (err instanceof MessageBusError) {
    return err;
  }
  const rawMsg = err instanceof Error ? err.message : String(err);
  // Strip potential URL/payload leaks, keeping only safe description
  const safeMsg = rawMsg.slice(0, 150).replace(/https?:\/\/[^\s]+/g, '[REDACTED_URL]');
  return new MessageBusError(defaultCode, safeMsg || 'An internal error occurred');
}
