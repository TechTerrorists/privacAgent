/**
 * Message bus error classes and helpers (feature A-03).
 *
 * Privacy boundary guarantee:
 * Error messages use fixed diagnostic strings mapped from bounded error codes.
 * Raw exceptions, arbitrary stack traces, URLs, email addresses, and page-derived
 * payload contents are NEVER echoed or retained in error messages.
 */

import { MessageErrorCode } from './types.js';

export const FIXED_ERROR_MESSAGES: Record<MessageErrorCode, string> = {
  TIMEOUT: 'Operation timed out waiting for peer response',
  HANDLER_ERROR: 'Message handler threw an exception during execution',
  UNSUPPORTED_OPERATION: 'The requested operation is not supported by the target endpoint',
  MALFORMED_MESSAGE: 'Envelope or payload failed runtime schema validation',
  WRONG_ENDPOINT: 'Received message addressed to a different endpoint or context',
  DISCONNECTED: 'Transport is closed or disconnected',
  RECEIVER_NOT_FOUND: 'Target receiver endpoint was not found or unreachable',
  UNSUPPORTED_PAYLOAD: 'Payload contains non-serializable or prohibited data',
  UNAUTHORIZED: 'Sender identity or origin is not authorized for this operation',
};

/**
 * Standard error emitted or rejected by the MessageBus.
 * Carries a bounded error code and sanitized diagnostic message.
 * Never includes raw payloads, secret values, URLs, or DOM text.
 */
export class MessageBusError extends Error {
  constructor(
    public readonly code: MessageErrorCode,
    _customDiagnostic?: string
  ) {
    code = Object.values(MessageErrorCode).includes(code) ? code : MessageErrorCode.HANDLER_ERROR;
    const message = FIXED_ERROR_MESSAGES[code] ?? 'Internal messaging error';
    super(`[${code}] ${message}`);
    this.code = code;
    this.name = 'MessageBusError';
  }
}

/**
 * Sanitizes any caught error into a safe MessageBusError with a fixed message.
 * Discards arbitrary exception text (e.g. emails, page content, tokens) entirely.
 */
export function toMessageBusError(err: unknown, defaultCode: MessageErrorCode): MessageBusError {
  if (err instanceof MessageBusError) {
    return new MessageBusError(err.code);
  }
  return new MessageBusError(defaultCode);
}
