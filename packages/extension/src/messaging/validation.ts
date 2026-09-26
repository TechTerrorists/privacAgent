/**
 * Runtime envelope and payload validation (feature A-03).
 *
 * Implements MV3-CSP compatible functional validation.
 * Verifies envelope structure, endpoint addresses, and rejects untransportable
 * data such as DOM nodes, functions, and symbols before dispatch.
 * Enforces runtime schema validation on operation request and response payloads.
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

const TASK_STATES: ReadonlySet<string> = new Set(['idle', 'running', 'paused', 'done', 'failed']);

const INFERENCE_STATUSES: ReadonlySet<string> = new Set(['ok', 'empty', 'unavailable']);

/**
 * Checks if a value looks like a DOM node or window reference.
 * DOM nodes cannot cross extension message boundaries or workers.
 */
export function isDOMNode(val: unknown): boolean {
  if (val === null || typeof val !== 'object') return false;
  try {
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
      'Cannot transport functions or symbols across message boundaries'
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

    const proto = Object.getPrototypeOf(val);
    if (proto !== null && proto !== Object.prototype) {
      if (typeof File !== 'undefined' && val instanceof File) return;
      if (typeof Blob !== 'undefined' && val instanceof Blob) return;
      if (ArrayBuffer.isView(val)) return;
      throw new MessageBusError(
        MessageErrorCode.UNSUPPORTED_PAYLOAD,
        'Cannot transport non-plain object or class instance'
      );
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
  if (
    addr.tabId !== undefined &&
    (!Number.isSafeInteger(addr.tabId) || (addr.tabId as number) < 0)
  ) {
    return false;
  }
  if (
    addr.frameId !== undefined &&
    (!Number.isSafeInteger(addr.frameId) || (addr.frameId as number) < 0)
  ) {
    return false;
  }
  return true;
}

/**
 * Normalizes an endpoint address.
 * For content scripts, an omitted frameId defaults to 0 (the main frame).
 */
export function normalizeEndpoint(address: EndpointAddress): EndpointAddress {
  if (address.context === 'content') {
    return {
      ...address,
      frameId: address.frameId ?? 0,
    };
  }
  return address;
}

/**
 * Validates whether two endpoint addresses refer to the same logical endpoint.
 * Content scripts with omitted frameId normalize to 0 to prevent cross-frame confusion.
 */
export function matchesEndpoint(actual: EndpointAddress, expected: EndpointAddress): boolean {
  const normActual = normalizeEndpoint(actual);
  const normExpected = normalizeEndpoint(expected);

  if (normActual.context !== normExpected.context) return false;
  if (normActual.tabId !== normExpected.tabId) return false;
  if (normActual.frameId !== normExpected.frameId) return false;
  return true;
}

/**
 * Validates operation payload shapes at runtime.
 * Guarantees that invalid or unverified payloads never reach typed handlers or callers.
 */
export function isValidOperationPayload(
  operation: string,
  direction: 'request' | 'response',
  payload: unknown
): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const p = payload as Record<string, unknown>;

  switch (operation) {
    case 'ping': {
      if (typeof p.timestamp !== 'number' || !Number.isFinite(p.timestamp)) {
        return false;
      }
      if (p.echo !== undefined && typeof p.echo !== 'string') {
        return false;
      }
      if (direction === 'response') {
        if (typeof p.context !== 'string' || !VALID_CONTEXTS.has(p.context)) {
          return false;
        }
      }
      return true;
    }

    case 'inference:runDetector':
    case 'inference:runOCR':
    case 'inference:runFaces':
    case 'inference:runIcons': {
      if (direction === 'request') {
        if (typeof p.width !== 'number' || !Number.isFinite(p.width) || p.width <= 0) return false;
        if (typeof p.height !== 'number' || !Number.isFinite(p.height) || p.height <= 0)
          return false;
        if (p.frame !== 'image' && p.frame !== 'crop') return false;
        if (p.region !== undefined) {
          if (!Array.isArray(p.region) || p.region.length !== 4) return false;
          if (!p.region.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
        }
        return true;
      } else {
        if (typeof p.status !== 'string' || !INFERENCE_STATUSES.has(p.status)) return false;
        if (p.synthetic !== true) return false;
        if (typeof p.itemCount !== 'number' || !Number.isFinite(p.itemCount) || p.itemCount < 0)
          return false;
        if (typeof p.durationMs !== 'number' || !Number.isFinite(p.durationMs) || p.durationMs < 0)
          return false;
        return true;
      }
    }

    case 'dom:walk': {
      if (direction === 'request') {
        if (p.docId !== undefined && typeof p.docId !== 'string') return false;
        return true;
      } else {
        if (typeof p.docId !== 'string') return false;
        if (
          typeof p.elementCount !== 'number' ||
          !Number.isFinite(p.elementCount) ||
          p.elementCount < 0
        )
          return false;
        if (typeof p.timestamp !== 'number' || !Number.isFinite(p.timestamp)) return false;
        return true;
      }
    }

    case 'dom:probe': {
      if (direction === 'request') {
        if (typeof p.probe !== 'boolean') return false;
        return true;
      } else {
        if (typeof p.active !== 'boolean') return false;
        if (p.docId !== undefined && typeof p.docId !== 'string') return false;
        return true;
      }
    }

    case 'task:status': {
      if (direction === 'request') {
        if (typeof p.taskId !== 'string' || p.taskId.trim() === '') return false;
        return true;
      } else {
        if (typeof p.taskId !== 'string' || p.taskId.trim() === '') return false;
        if (typeof p.state !== 'string' || !TASK_STATES.has(p.state)) return false;
        return true;
      }
    }

    default:
      // For extensible operations without registered schemas, require non-null plain object
      return true;
  }
}

/**
 * Asserts that an operation payload is valid, throwing a bounded MessageBusError if invalid.
 */
export function assertValidPayload(
  operation: string,
  direction: 'request' | 'response',
  payload: unknown
): void {
  assertTransportable(payload);
  if (!isValidOperationPayload(operation, direction, payload)) {
    throw new MessageBusError(
      MessageErrorCode.MALFORMED_MESSAGE,
      'Envelope or payload failed runtime schema validation'
    );
  }
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
    if (
      !Object.values(MessageErrorCode).includes(err.code as MessageErrorCode) ||
      typeof err.message !== 'string'
    )
      return false;
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
      'Envelope or payload failed runtime schema validation'
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
