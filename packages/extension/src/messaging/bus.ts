/**
 * Core Typed Message Bus (feature A-03).
 *
 * Provides strongly-typed local request/response messaging with finite timeouts,
 * peer correlation, duplicate/late response protection, and complete disposal cleanup.
 */

import { MessageBusError, toMessageBusError } from './errors.js';
import { type Transport } from './transport.js';
import {
  assertTransportable,
  assertValidEnvelope,
  isErrorEnvelope,
  isRequestEnvelope,
  isResponseEnvelope,
  matchesEndpoint,
} from './validation.js';
import {
  MessageErrorCode,
  type EndpointAddress,
  type ErrorEnvelope,
  type MessageEnvelope,
  type MessageHandler,
  type OperationMap,
  type RequestEnvelope,
  type ResponseEnvelope,
  type SendOptions,
} from './types.js';

export const DEFAULT_TIMEOUT_MS = 5000;

interface PendingRequest {
  readonly id: string;
  readonly operation: string;
  readonly expectedDestination: EndpointAddress;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class MessageBus {
  private readonly handlers = new Map<string, MessageHandler>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly cleanupTransport: () => void;
  private disposed = false;
  private idCounter = 0;

  constructor(
    public readonly localAddress: EndpointAddress,
    private readonly transport: Transport
  ) {
    this.cleanupTransport = this.transport.onMessage((envelope, senderAddress) => {
      this.handleIncoming(envelope, senderAddress);
    });
  }

  /**
   * Registers a typed handler for an operation.
   * Returns an unregister function.
   */
  registerHandler<O extends keyof OperationMap>(
    operation: O,
    handler: MessageHandler<OperationMap[O]['request'], OperationMap[O]['response']>
  ): () => void {
    if (this.disposed) {
      throw new MessageBusError(MessageErrorCode.DISCONNECTED, 'MessageBus is disposed');
    }
    this.handlers.set(operation as string, handler as MessageHandler);
    return () => {
      this.unregisterHandler(operation);
    };
  }

  /**
   * Unregisters a handler for an operation.
   */
  unregisterHandler<O extends keyof OperationMap>(operation: O): void {
    this.handlers.delete(operation as string);
  }

  /**
   * Sends a typed request to a target endpoint and awaits the correlated reply.
   */
  async send<O extends keyof OperationMap>(
    operation: O,
    payload: OperationMap[O]['request'],
    destination: EndpointAddress,
    options?: SendOptions
  ): Promise<OperationMap[O]['response']> {
    if (this.disposed) {
      throw new MessageBusError(MessageErrorCode.DISCONNECTED, 'MessageBus is disposed');
    }

    assertTransportable(payload);

    const id = this.generateId();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const requestEnvelope: RequestEnvelope<string, unknown> = {
      id,
      type: 'request',
      operation: operation as string,
      payload,
      source: this.localAddress,
      destination,
      timestamp: Date.now(),
    };

    assertValidEnvelope(requestEnvelope);

    return new Promise<OperationMap[O]['response']>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new MessageBusError(
            MessageErrorCode.TIMEOUT,
            `Request "${String(operation)}" timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);

      this.pending.set(id, {
        id,
        operation: operation as string,
        expectedDestination: destination,
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
      });

      this.transport.send(requestEnvelope, options).catch((err) => {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          reject(toMessageBusError(err, MessageErrorCode.RECEIVER_NOT_FOUND));
        }
      });
    });
  }

  /**
   * Internal processor for incoming envelopes.
   */
  private handleIncoming(envelope: MessageEnvelope, senderAddress?: EndpointAddress): void {
    if (this.disposed) return;

    // 1. Correlate Response or Error to our pending requests
    if (isResponseEnvelope(envelope) || isErrorEnvelope(envelope)) {
      const pending = this.pending.get(envelope.id);
      if (!pending) {
        // Late, duplicate, or unrequested response — safe to drop without leaking
        return;
      }

      // Correlate peer: verify source matches expected destination
      const actualSource = senderAddress ?? envelope.source;
      if (!matchesEndpoint(actualSource, pending.expectedDestination)) {
        // Drop replies from unexpected frames or wrong peers
        return;
      }

      clearTimeout(pending.timer);
      this.pending.delete(envelope.id);

      if (isResponseEnvelope(envelope)) {
        pending.resolve(envelope.payload);
      } else {
        pending.reject(new MessageBusError(envelope.error.code, envelope.error.message));
      }
      return;
    }

    // 2. Incoming Request for this endpoint
    if (isRequestEnvelope(envelope)) {
      if (!matchesEndpoint(this.localAddress, envelope.destination)) {
        // Message was not intended for this endpoint
        return;
      }

      const handler = this.handlers.get(envelope.operation);
      if (!handler) {
        // Send back an explicit error envelope rather than hanging the caller
        const errorEnv: ErrorEnvelope = {
          id: envelope.id,
          type: 'error',
          operation: envelope.operation,
          error: {
            code: MessageErrorCode.UNSUPPORTED_OPERATION,
            message: `Unsupported operation: ${envelope.operation}`,
          },
          source: this.localAddress,
          destination: envelope.source,
          timestamp: Date.now(),
        };
        void this.transport.send(errorEnv).catch(() => {});
        return;
      }

      // Execute handler and reply
      Promise.resolve()
        .then(() => handler(envelope.payload, senderAddress ?? envelope.source))
        .then(
          (result) => {
            if (this.disposed) return;
            assertTransportable(result);
            const responseEnv: ResponseEnvelope = {
              id: envelope.id,
              type: 'response',
              operation: envelope.operation,
              payload: result,
              source: this.localAddress,
              destination: envelope.source,
              timestamp: Date.now(),
            };
            return this.transport.send(responseEnv);
          },
          (err) => {
            if (this.disposed) return;
            const busErr = toMessageBusError(err, MessageErrorCode.HANDLER_ERROR);
            const errorEnv: ErrorEnvelope = {
              id: envelope.id,
              type: 'error',
              operation: envelope.operation,
              error: {
                code: busErr.code,
                message: busErr.message,
              },
              source: this.localAddress,
              destination: envelope.source,
              timestamp: Date.now(),
            };
            return this.transport.send(errorEnv);
          }
        )
        .catch(() => {
          // Swallow dispatch failure during reply send
        });
    }
  }

  /**
   * Shuts down the message bus and cleans up all listeners, pending timers, and requests.
   * Invoked by A-04 on worker/host termination.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Fail all pending requests with DISCONNECTED
    for (const [id, req] of this.pending.entries()) {
      clearTimeout(req.timer);
      req.reject(new MessageBusError(MessageErrorCode.DISCONNECTED, 'MessageBus was disposed'));
      this.pending.delete(id);
    }

    this.handlers.clear();
    this.cleanupTransport();
  }

  private generateId(): string {
    this.idCounter = (this.idCounter + 1) % 1_000_000;
    return `${this.localAddress.context}-${Date.now()}-${this.idCounter}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
