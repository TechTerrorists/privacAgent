/**
 * Extension transport using A-02 platform adapter (feature A-03).
 *
 * Implements Transport for background, content scripts (by tab and frame),
 * offscreen documents, and UI panels.
 *
 * Normalizes omitted content script frame IDs to 0 (main frame) for routing
 * and response correlation to prevent cross-frame message pollution.
 */

import { platform } from '../platform/index.js';
import { MessageBusError } from './errors.js';
import { assertValidEnvelope, normalizeEndpoint, matchesEndpoint } from './validation.js';
import {
  MessageErrorCode,
  type EndpointAddress,
  type MessageEnvelope,
  type SendOptions,
} from './types.js';
import type { Transport } from './transport-types.js';

/**
 * Transport implementation leveraging browser runtime and tab messaging.
 */
export interface ExtensionTransportOptions {
  /** Exact runtime.getURL(...) URLs owned by this extension and their roles. */
  extensionPeers?: Readonly<Record<string, EndpointAddress>>;
  /** Exact host URLs permitted to return worker-originated messages. */
  workerRelayUrls?: readonly string[];
}

export class ExtensionTransport implements Transport {
  private readonly listeners = new Set<
    (envelope: MessageEnvelope, senderAddress?: EndpointAddress) => void
  >();
  private readonly runtimeListener: (
    message: unknown,
    sender: { id?: string; url?: string; tab?: { id?: number }; frameId?: number }
  ) => void;
  private disposed = false;

  constructor(_endpoint: EndpointAddress, options: ExtensionTransportOptions = {}) {
    this.runtimeListener = (message: unknown, sender) => {
      if (this.disposed) return;
      try {
        assertValidEnvelope(message);
      } catch {
        return;
      }
      const envelope = message;
      if (sender.id !== platform.browser.runtime.id) return;

      // Extension documents can also have sender.tab (e.g. UI opened in a tab).
      // Authenticate their exact configured URL before classifying content scripts.
      let verifiedSender: EndpointAddress | undefined;
      const ownUrl = sender.url?.startsWith(platform.browser.runtime.getURL(''));
      if (ownUrl && sender.url) {
        const canonicalSenderUrl = sender.url.replace(/[?#].*$/, '');
        verifiedSender =
          options.extensionPeers?.[sender.url] ?? options.extensionPeers?.[canonicalSenderUrl];
        if (
          envelope.source.context === 'worker' &&
          (options.workerRelayUrls?.includes(sender.url) ||
            options.workerRelayUrls?.includes(canonicalSenderUrl))
        ) {
          verifiedSender = { context: 'worker' };
        }
      } else if (sender.tab?.id !== undefined) {
        verifiedSender = { context: 'content', tabId: sender.tab.id, frameId: sender.frameId ?? 0 };
      }
      if (!verifiedSender || !matchesEndpoint(verifiedSender, envelope.source)) return;

      for (const listener of this.listeners) {
        try {
          listener(envelope, verifiedSender);
        } catch {
          // Listeners handle their own errors
        }
      }
    };

    if (platform?.browser?.runtime?.onMessage) {
      platform.browser.runtime.onMessage.addListener(this.runtimeListener);
    }
  }

  async send(envelope: MessageEnvelope, _options?: SendOptions): Promise<void> {
    if (this.disposed) {
      throw new MessageBusError(MessageErrorCode.DISCONNECTED);
    }
    assertValidEnvelope(envelope);

    const dest = normalizeEndpoint(envelope.destination);

    if (dest.context === 'content') {
      if (dest.tabId === undefined) {
        throw new MessageBusError(
          MessageErrorCode.MALFORMED_MESSAGE,
          'Cannot send message to content context without a valid tabId'
        );
      }
      try {
        const frameId = dest.frameId ?? 0;
        await platform.browser.tabs.sendMessage(dest.tabId, envelope, { frameId });
      } catch {
        throw new MessageBusError(MessageErrorCode.RECEIVER_NOT_FOUND);
      }
      return;
    }

    // Sending to background, offscreen, or UI contexts
    try {
      await platform.browser.runtime.sendMessage(envelope);
    } catch {
      throw new MessageBusError(MessageErrorCode.RECEIVER_NOT_FOUND);
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

    if (platform?.browser?.runtime?.onMessage) {
      try {
        platform.browser.runtime.onMessage.removeListener(this.runtimeListener);
      } catch {
        // Safe disposal
      }
    }
  }
}
