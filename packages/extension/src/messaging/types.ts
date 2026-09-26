/**
 * Typed cross-context message bus types and contract (feature A-03).
 *
 * Defines explicit endpoint addressing, request/response/error envelopes,
 * bounded error codes, and the operation map binding request types to response types.
 */

export type ContextType = 'background' | 'content' | 'offscreen' | 'worker' | 'ui';

/**
 * Explicit addressing for local message bus endpoints.
 */
export interface EndpointAddress {
  /** Execution context of the endpoint */
  readonly context: ContextType;
  /** Tab ID (required when addressing a content script) */
  readonly tabId?: number | undefined;
  /** Frame ID within the tab (optional, defaults to 0 / main frame) */
  readonly frameId?: number | undefined;
}

/**
 * Bounded error codes for transport and handler failures.
 * Never includes raw exception dumps or page content.
 */
export const MessageErrorCode = {
  TIMEOUT: 'TIMEOUT',
  HANDLER_ERROR: 'HANDLER_ERROR',
  UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
  MALFORMED_MESSAGE: 'MALFORMED_MESSAGE',
  WRONG_ENDPOINT: 'WRONG_ENDPOINT',
  DISCONNECTED: 'DISCONNECTED',
  RECEIVER_NOT_FOUND: 'RECEIVER_NOT_FOUND',
  UNSUPPORTED_PAYLOAD: 'UNSUPPORTED_PAYLOAD',
  UNAUTHORIZED: 'UNAUTHORIZED',
} as const;

export type MessageErrorCode = (typeof MessageErrorCode)[keyof typeof MessageErrorCode];

/**
 * Base envelope fields present on all messages.
 */
export interface BaseEnvelope {
  /** Unique correlation ID for request/response matching */
  readonly id: string;
  /** Operation identifier */
  readonly operation: string;
  /** Address of the sender */
  readonly source: EndpointAddress;
  /** Address of the intended recipient */
  readonly destination: EndpointAddress;
  /** Timestamp (epoch ms) when the envelope was created */
  readonly timestamp: number;
}

/**
 * Request envelope carrying an operation request.
 */
export interface RequestEnvelope<O extends string = string, TReq = unknown> extends BaseEnvelope {
  readonly type: 'request';
  readonly operation: O;
  readonly payload: TReq;
}

/**
 * Response envelope carrying a successful operation result.
 */
export interface ResponseEnvelope<O extends string = string, TRes = unknown> extends BaseEnvelope {
  readonly type: 'response';
  readonly operation: O;
  readonly payload: TRes;
}

/**
 * Error envelope carrying a bounded failure code and message.
 */
export interface ErrorEnvelope<O extends string = string> extends BaseEnvelope {
  readonly type: 'error';
  readonly operation: O;
  readonly error: {
    readonly code: MessageErrorCode;
    readonly message: string;
  };
}

/**
 * Union of all valid transport envelopes.
 */
export type MessageEnvelope = RequestEnvelope | ResponseEnvelope | ErrorEnvelope;

/**
 * Options for dispatching a request.
 */
export interface SendOptions {
  /** Timeout in milliseconds (defaults to DEFAULT_TIMEOUT_MS) */
  timeoutMs?: number | undefined;
  /** Transferable objects for transports that support transfer lists (e.g. Worker/MessagePort) */
  transfer?: Transferable[] | undefined;
}

/**
 * Handler function for an operation.
 * May return a value synchronously or via Promise.
 */
export type MessageHandler<TReq = unknown, TRes = unknown> = (
  payload: TReq,
  source: EndpointAddress
) => TRes | Promise<TRes>;

/**
 * Built-in standard operations supported across hops.
 * Coordinated with C-01 (Inference), B-02/B-05 (DOM), and UI lanes.
 */
export interface PingRequest {
  timestamp: number;
  echo?: string | undefined;
}

export interface PingResponse {
  timestamp: number;
  echo?: string | undefined;
  context: ContextType;
}

export interface InferenceStubRequest {
  width: number;
  height: number;
  frame: 'image' | 'crop';
  region?: [number, number, number, number] | undefined;
}

export interface InferenceStubResponse {
  status: 'ok' | 'empty' | 'unavailable';
  synthetic: true;
  itemCount: number;
  durationMs: number;
}

export interface DomWalkStubRequest {
  docId?: string | undefined;
}

export interface DomWalkStubResponse {
  docId: string;
  elementCount: number;
  timestamp: number;
}

export interface DomProbeStubRequest {
  probe: boolean;
}

export interface DomProbeStubResponse {
  active: boolean;
  docId?: string | undefined;
}

export interface TaskStatusStubRequest {
  taskId: string;
}

export interface TaskStatusStubResponse {
  taskId: string;
  state: 'idle' | 'running' | 'paused' | 'done' | 'failed';
}

/**
 * Central OperationMap binding operation names to their request and response types.
 * Downstream modules can extend this interface via declaration merging.
 */
export interface OperationMap {
  ping: { request: PingRequest; response: PingResponse };
  'inference:runDetector': { request: InferenceStubRequest; response: InferenceStubResponse };
  'inference:runOCR': { request: InferenceStubRequest; response: InferenceStubResponse };
  'inference:runFaces': { request: InferenceStubRequest; response: InferenceStubResponse };
  'inference:runIcons': { request: InferenceStubRequest; response: InferenceStubResponse };
  'dom:walk': { request: DomWalkStubRequest; response: DomWalkStubResponse };
  'dom:probe': { request: DomProbeStubRequest; response: DomProbeStubResponse };
  'task:status': { request: TaskStatusStubRequest; response: TaskStatusStubResponse };
}

export type OperationName = keyof OperationMap;
