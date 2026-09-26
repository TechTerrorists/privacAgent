/** Local bridge; the worker channel is dedicated to this trusted host. */
import type { Transport } from './transport-types.js';
import { assertValidEnvelope, matchesEndpoint } from './validation.js';
import { MessageBusError } from './errors.js';
import {
  MessageErrorCode,
  type ContextType,
  type MessageEnvelope,
  type EndpointAddress,
} from './types.js';

export class HostRelay {
  private readonly cleanupExtension: () => void;
  private readonly cleanupWorker: () => void;
  private disposed = false;

  constructor(
    private readonly extensionTransport: Transport,
    private readonly workerTransport: Transport,
    private readonly allowedSources: readonly ContextType[] = [
      'background',
      'content',
      'offscreen',
      'ui',
    ]
  ) {
    this.cleanupExtension = extensionTransport.onMessage((envelope, sender) => {
      if (!this.valid(envelope) || !sender || !matchesEndpoint(sender, envelope.source)) return;
      if (envelope.destination.context !== 'worker') return;
      if (!this.allowedSources.includes(sender.context)) {
        void this.fail(envelope, sender, MessageErrorCode.UNAUTHORIZED);
        return;
      }
      // Only an authenticated source is copied onto the trusted host/worker channel.
      void this.workerTransport
        .send({ ...envelope, source: sender })
        .catch(() => this.fail(envelope, sender, MessageErrorCode.DISCONNECTED));
    });
    this.cleanupWorker = workerTransport.onMessage((envelope) => {
      if (!this.valid(envelope) || !matchesEndpoint(envelope.source, { context: 'worker' })) return;
      if (envelope.destination.context === 'worker') return;
      // There is no reachable requester when delivery of a reply fails. Consume the
      // failure; the caller retains its finite timeout. Never retry side effects.
      void this.extensionTransport.send(envelope).catch(() => {});
    });
  }

  private valid(envelope: MessageEnvelope): boolean {
    if (this.disposed) return false;
    try {
      assertValidEnvelope(envelope);
      return true;
    } catch {
      return false;
    }
  }

  private async fail(
    envelope: MessageEnvelope,
    destination: EndpointAddress,
    code: MessageErrorCode
  ): Promise<void> {
    if (this.disposed || envelope.type !== 'request') return;
    await this.extensionTransport
      .send({
        id: envelope.id,
        operation: envelope.operation,
        type: 'error',
        source: { context: 'worker' },
        destination,
        timestamp: Date.now(),
        error: { code, message: new MessageBusError(code).message },
      })
      .catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cleanupExtension();
    this.cleanupWorker();
  }
}
