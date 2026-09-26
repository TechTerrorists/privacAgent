/**
 * Transport interface for cross-context messaging (feature A-03).
 */

import type { EndpointAddress, MessageEnvelope, SendOptions } from './types.js';

export interface Transport {
  /** Sends an envelope across this transport */
  send(envelope: MessageEnvelope, options?: SendOptions): Promise<void>;

  /**
   * Registers a listener for incoming envelopes.
   * Returns an unregister function.
   */
  onMessage(
    listener: (envelope: MessageEnvelope, senderAddress?: EndpointAddress) => void
  ): () => void;

  /** Closes and cleans up the transport */
  dispose(): void;
}
