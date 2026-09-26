/**
 * Web Worker and MessagePort transport for cross-context messaging (feature A-03).
 *
 * Implements Transport for dedicated Web Workers and MessagePort channels.
 * Completely decoupled from browser extension APIs and webextension-polyfill,
 * ensuring it executes cleanly inside standard Web Workers without crashes.
 */

import { MessageBusError } from './errors.js';
import { assertValidEnvelope } from './validation.js';
import {
  MessageErrorCode,
  type EndpointAddress,
  type MessageEnvelope,
  type SendOptions,
} from './types.js';
import type { Transport } from './transport-types.js';

export interface WorkerMessageTarget {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener?(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener?(type: 'message', listener: (event: MessageEvent) => void): void;
  onmessage?: ((event: MessageEvent) => void) | null;
}

/**
 * Transport for dedicated Web Workers and MessagePorts.
 * Supports explicit zero-copy transfer lists.
 */
export class WorkerTransport implements Transport {
  private readonly listeners = new Set<
    (envelope: MessageEnvelope, senderAddress?: EndpointAddress) => void
  >();
  private readonly messageHandler: (event: MessageEvent) => void;
  private disposed = false;

  constructor(private readonly target: WorkerMessageTarget) {
    this.messageHandler = (event: MessageEvent) => {
      if (this.disposed) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      const envelope = data as MessageEnvelope;

      for (const listener of this.listeners) {
        try {
          listener(envelope, envelope.source);
        } catch {
          // Listeners handle their own errors
        }
      }
    };

    if (typeof this.target.addEventListener === 'function') {
      this.target.addEventListener('message', this.messageHandler);
      if (typeof (this.target as MessagePort).start === 'function') {
        (this.target as MessagePort).start();
      }
    } else {
      this.target.onmessage = this.messageHandler;
    }
  }

  async send(envelope: MessageEnvelope, options?: SendOptions): Promise<void> {
    if (this.disposed) {
      throw new MessageBusError(MessageErrorCode.DISCONNECTED);
    }
    assertValidEnvelope(envelope);

    try {
      if (options?.transfer && options.transfer.length > 0) {
        this.target.postMessage(envelope, options.transfer);
      } else {
        this.target.postMessage(envelope);
      }
    } catch {
      throw new MessageBusError(
        MessageErrorCode.UNSUPPORTED_PAYLOAD,
        'Payload contains non-serializable or prohibited data'
      );
    }
  }

  onMessage(
    listener: (envelope: MessageEnvelope, senderAddress?: EndpointAddress) => void
  ): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();

    if (typeof this.target.removeEventListener === 'function') {
      this.target.removeEventListener('message', this.messageHandler);
    } else {
      this.target.onmessage = null;
    }
  }
}
