/**
 * Runtime envelope and payload validation (feature A-03).
 *
 * Implements MV3-CSP compatible functional validation.
 * Verifies envelope structure, endpoint addresses, and rejects untransportable
 * data such as DOM nodes, functions, and symbols before dispatch.
 */

import { MessageBusError } from './errors.js';
import {
  MessageErrorCode,
  type ContextType,
  type EndpointAddress,
  type MessageEnvelope,
  type RequestEnvelope,
  type ResponseEnvelope,
  type ErrorEnvelope,
} from './types.js';

const VALID_CONTEXTS: ReadonlySet<string> = new Set<ContextType>([
  'background',
  'content',
  'offscreen',
  'worker',
  'ui',
]);

const VALID_TYPES: ReadonlySet<string> = new Set(['request', 'response', 'error']);

/**
 * Checks if a value looks like a DOM node or window reference.
 * DOM nodes cannot cross extension message boundaries or workers.
 */
export function isDOMNode(val: unknown): boolean {
  if (val === null || typeof val !== 'object') return false;
  try {
    // Check standard browser Node properties without requiring Node global
    if ('nodeType' in val && typeof (val as { nodeType: unknown }).nodeType === 'number') {
      return true;
    }
    if ('document' in val && 'location' in val) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * Recursively inspects a value for non-serializable objects (DOM nodes, functions, symbols).
 * Throws a bounded MessageBusError if an illegal type is found.
 */
export function assertTransportable(val: unknown, depth = 0): void {
  if (depth > 20) {
    throw new MessageBusError(
      MessageErrorCode.UNSUPPORTED_PAYLOAD,
      'Payload exceeds maximum serialization depth'
    );
  }
  if (val === null || val === undefined) return;

  const t = typeof val;
  if (t === 'function' || t === 'symbol') {
    throw new MessageBusError(
      MessageErrorCode.UNSUPPORTED_PAYLOAD,
      `Cannot transport unsupported data type: ${t}`
    );
  }

  if (isDOMNode(val)) {
    throw new MessageBusError(
      MessageErrorCode.UNSUPPORTED_PAYLOAD,
      'DOM nodes cannot be transported across message bus boundaries'
    );
  }

  if (typeof val === 'object') {
    // Allow Transferables (ArrayBuffer, MessagePort) at the top level
    if (
      val instanceof ArrayBuffer ||
      (typeof MessagePort !== 'undefined' && val instanceof MessagePort)
    ) {
      return;
    }

    if (Array.isArray(val)) {
      for (const item of val) {
        assertTransportable(item, depth + 1);
      }
      return;
    }

    for (const key of Object.keys(val)) {
      assertTransportable((val as Record<string, unknown>)[key], depth + 1);
    }
  }
}

/**
 * Validates an EndpointAddress structure.
 */
export function isEndpointAddress(val: unknown): val is EndpointAddress {
  if (!val || typeof val !== 'object') return false;
  const addr = val as Record<string, unknown>;
  if (typeof addr.context !== 'string' || !VALID_CONTEXTS.has(addr.context)) {
    return false;
  }
  if (addr.tabId !== undefined && typeof addr.tabId !== 'number') {
    return false;
  }
  if (addr.frameId !== undefined && typeof addr.frameId !== 'number') {
    return false;
  }
  return true;
}

/**
 * Validates whether two endpoint addresses refer to the same logical endpoint.
 */
export function matchesEndpoint(actual: EndpointAddress, expected: EndpointAddress): boolean {
  if (actual.context !== expected.context) return false;
  if (expected.tabId !== undefined && actual.tabId !== expected.tabId) return false;
  if (expected.frameId !== undefined && actual.frameId !== expected.frameId) return false;
  return true;
}

/**
 * Validates that an incoming object is a well-formed MessageEnvelope.
 */
export function isMessageEnvelope(val: unknown): val is MessageEnvelope {
  if (!val || typeof val !== 'object') return false;
  const env = val as Record<string, unknown>;

  if (typeof env.id !== 'string' || env.id.trim() === '') return false;
  if (typeof env.operation !== 'string' || env.operation.trim() === '') return false;
  if (typeof env.type !== 'string' || !VALID_TYPES.has(env.type)) return false;
  if (typeof env.timestamp !== 'number' || !Number.isFinite(env.timestamp)) return false;

  if (!isEndpointAddress(env.source) || !isEndpointAddress(env.destination)) {
    return false;
  }

  if (env.type === 'error') {
    const err = env.error as Record<string, unknown> | undefined;
    if (!err || typeof err !== 'object') return false;
    if (typeof err.code !== 'string' || typeof err.message !== 'string') return false;
  }

  return true;
}

/**
 * Asserts that an incoming object is a valid MessageEnvelope, throwing a bounded error if not.
 */
export function assertValidEnvelope(val: unknown): asserts val is MessageEnvelope {
  if (!isMessageEnvelope(val)) {
    throw new MessageBusError(
      MessageErrorCode.MALFORMED_MESSAGE,
      'Received invalid or malformed message envelope'
    );
  }
  assertTransportable(val);
}

/**
 * Typeguards for envelope subtypes.
 */
export function isRequestEnvelope(env: MessageEnvelope): env is RequestEnvelope {
  return env.type === 'request';
}

export function isResponseEnvelope(env: MessageEnvelope): env is ResponseEnvelope {
  return env.type === 'response';
}

export function isErrorEnvelope(env: MessageEnvelope): env is ErrorEnvelope {
  return env.type === 'error';
}
