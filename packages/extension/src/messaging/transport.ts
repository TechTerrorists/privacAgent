/**
 * Transports for cross-context messaging (feature A-03).
 *
 * Implements:
 * 1. ExtensionTransport: handles background, content scripts (by tab and frame),
 *    offscreen documents, and UI panels using the A-02 platform adapter.
 * 2. WorkerTransport: handles dedicated Web Worker and MessagePort communication.
 */

import { platform } from '../platform/index.js';
import { MessageBusError } from './errors.js';
import { assertValidEnvelope, isMessageEnvelope } from './validation.js';
import {
  MessageErrorCode,
  type EndpointAddress,
  type MessageEnvelope,
  type SendOptions,
} from './types.js';

export interface Transport {
  /** Sends an envelope across this transport */
  send(envelope: MessageEnvelope, options?: SendOptions): Promise<void>;
  /** Subscribes to incoming envelopes from this transport */
  onMessage(
    listener: (envelope: MessageEnvelope, senderAddress?: EndpointAddress) => void
  ): () => void;
  /** Disposes listeners and resources */
  dispose(): void;
}

/**
 * Extension-context transport using the A-02 platform adapter and browser APIs.
 */
export class ExtensionTransport implements Transport {
  private listeners = new Set<
    (envelope: MessageEnvelope, senderAddress?: EndpointAddress) => void
  >();
  private messageListener: (message: unknown, sender: unknown) => void;
  private disposed = false;

  constructor() {
    this.messageListener = (message: unknown, sender: unknown) => {
      if (this.disposed) return;
      if (!isMessageEnvelope(message)) return;

      const browserSender = sender as
        | {
            tab?: { id?: number };
            frameId?: number;
            url?: string;
          }
        | undefined;

      // Authenticate sender using browser metadata instead of trusting envelope claim
      let validatedSource = message.source;
      if (browserSender?.tab?.id !== undefined) {
        validatedSource = {
          context: 'content',
          tabId: browserSender.tab.id,
          frameId: browserSender.frameId ?? 0,
        };
      }

      for (const listener of this.listeners) {
        try {
          listener(message, validatedSource);
        } catch {
          // Swallow listener errors so one listener failure cannot block others
        }
      }
    };

    try {
      if (typeof platform !== 'undefined' && platform.browser?.runtime?.onMessage) {
        platform.browser.runtime.onMessage.addListener(this.messageListener);
      }
    } catch {
      // Environments without extension runtime (e.g. unit test runner)
    }
  }

  async send(envelope: MessageEnvelope, _options?: SendOptions): Promise<void> {
    if (this.disposed) {
      throw new MessageBusError(MessageErrorCode.DISCONNECTED, 'Transport is disposed');
    }
    assertValidEnvelope(envelope);

    const dest = envelope.destination;

    if (dest.context === 'content') {
      if (dest.tabId === undefined) {
        throw new MessageBusError(
          MessageErrorCode.MALFORMED_MESSAGE,
          'Cannot send message to content context without a valid tabId'
        );
      }
      try {
        const sendOptions: { frameId?: number } = {};
        if (dest.frameId !== undefined) {
          sendOptions.frameId = dest.frameId;
        }
        await platform.browser.tabs.sendMessage(dest.tabId, envelope, sendOptions);
      } catch (err) {
        throw new MessageBusError(
          MessageErrorCode.RECEIVER_NOT_FOUND,
          `Failed to reach content script in tab ${dest.tabId}: ${(err as Error)?.message ?? 'unknown'}`
        );
      }
      return;
    }

    // Sending to background, offscreen, or UI contexts
    try {
      await platform.browser.runtime.sendMessage(envelope);
    } catch (err) {
      throw new MessageBusError(
        MessageErrorCode.RECEIVER_NOT_FOUND,
        `Failed to reach destination ${dest.context}: ${(err as Error)?.message ?? 'unknown'}`
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
    try {
      if (typeof platform !== 'undefined' && platform.browser?.runtime?.onMessage) {
        platform.browser.runtime.onMessage.removeListener(this.messageListener);
      }
    } catch {
      // Ignore cleanup error if runtime unavailable
    }
  }
}

/**
 * Worker / MessagePort transport for communicating with dedicated Web Workers.
 * Supports explicit transfer lists for zero-copy transfers (e.g. ArrayBuffers).
 */
export class WorkerTransport implements Transport {
  private listeners = new Set<
    (envelope: MessageEnvelope, senderAddress?: EndpointAddress) => void
  >();
  private messageHandler: (event: MessageEvent) => void;
  private disposed = false;

  constructor(private readonly target: Worker | MessagePort) {
    this.messageHandler = (event: MessageEvent) => {
      if (this.disposed) return;
      const data = event.data;
      if (!isMessageEnvelope(data)) return;

      for (const listener of this.listeners) {
        try {
          listener(data, data.source);
        } catch {
          // Swallow listener errors
        }
      }
    };

    if ('addEventListener' in this.target) {
      this.target.addEventListener('message', this.messageHandler as EventListener);
      if ('start' in this.target && typeof this.target.start === 'function') {
        this.target.start();
      }
    } else {
      (this.target as unknown as { onmessage: unknown }).onmessage = this.messageHandler;
    }
  }

  async send(envelope: MessageEnvelope, options?: SendOptions): Promise<void> {
    if (this.disposed) {
      throw new MessageBusError(MessageErrorCode.DISCONNECTED, 'Worker transport is disposed');
    }
    assertValidEnvelope(envelope);

    try {
      if (options?.transfer && options.transfer.length > 0) {
        this.target.postMessage(envelope, options.transfer);
      } else {
        this.target.postMessage(envelope);
      }
    } catch (err) {
      throw new MessageBusError(
        MessageErrorCode.UNSUPPORTED_PAYLOAD,
        `Failed to post message to worker: ${(err as Error)?.message ?? 'serialization failed'}`
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

    if ('removeEventListener' in this.target) {
      this.target.removeEventListener('message', this.messageHandler as EventListener);
    }
    if ('close' in this.target && typeof this.target.close === 'function') {
      try {
        this.target.close();
      } catch {
        // Ignore close error on port
      }
    }
  }
}
