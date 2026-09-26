/**
 * Host Relay between Extension Messaging and Web Worker (feature A-03).
 *
 * Web Workers in MV3 do not expose browser runtime extension APIs.
 * The HostRelay runs in the host context (Chrome offscreen document or
 * Firefox background page) to bridge messages between the extension bus
 * and the worker transport.
 */

import { type Transport } from './transport.js';
import { isMessageEnvelope } from './validation.js';

export class HostRelay {
  private cleanupExtension: () => void;
  private cleanupWorker: () => void;
  private disposed = false;

  constructor(
    private readonly extensionTransport: Transport,
    private readonly workerTransport: Transport
  ) {
    // 1. Extension -> Worker: Forward messages destined for the worker
    this.cleanupExtension = this.extensionTransport.onMessage((envelope) => {
      if (this.disposed) return;
      if (!isMessageEnvelope(envelope)) return;

      if (envelope.destination.context === 'worker') {
        void this.workerTransport.send(envelope);
      }
    });

    // 2. Worker -> Extension: Forward messages from the worker back out
    this.cleanupWorker = this.workerTransport.onMessage((envelope) => {
      if (this.disposed) return;
      if (!isMessageEnvelope(envelope)) return;

      if (envelope.destination.context !== 'worker') {
        void this.extensionTransport.send(envelope);
      }
    });
  }

  /**
   * Disposes the relay hooks.
   * Invoked by A-04 when worker hosts stop or idle out.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cleanupExtension();
    this.cleanupWorker();
  }
}
