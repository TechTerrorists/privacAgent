import { platform } from '../platform/index.js';
import {
  MessageBus,
  ExtensionTransport,
  WorkerTransport,
  HostRelay,
  MessageBusError,
  MessageErrorCode,
} from '../messaging/index.js';
import { transition, canAcceptWork, isTerminal } from './state-machine.js';
import type { HostState, HostEvent, Lease, HostInfo } from './types.js';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const ALARM_NAME = 'privacagent:host:idle';
const STARTUP_TIMEOUT_MS = 30000;
const HOST_DOCUMENT_PATH = 'src/host/offscreen.html';
const WORKER_SCRIPT_PATH = 'src/host/ml-worker.js';

export class HostManager {
  private state: HostState = 'idle';
  private generation = 0;
  private leases = new Map<string, Lease>();
  private worker: Worker | null = null;
  private relay: HostRelay | null = null;
  private workerTransport: WorkerTransport | null = null;
  private extensionTransport: ExtensionTransport | null = null;
  private bgBus: MessageBus;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private startupPromise: Promise<void> | null = null;
  private resolveStartup?: () => void;
  private rejectStartup?: (e: Error) => void;

  constructor(bgBus: MessageBus) {
    this.bgBus = bgBus;
    this.registerHandlers();
    this.setupAlarmListener();
  }

  private registerHandlers(): void {
    this.bgBus.registerHandler(
      'host:acquire',
      async (request, _sender) => {
        const resp = await this.acquire(request.consumer);
        return resp;
      },
      { allowedSources: ['background', 'ui', 'content'] }
    );

    this.bgBus.registerHandler(
      'host:release',
      async (request, _sender) => {
        const resp = await this.release(request.leaseId);
        return resp;
      },
      { allowedSources: ['background', 'ui', 'content'] }
    );

    this.bgBus.registerHandler('host:status', async (_request, _sender) => {
      return this.getInfo();
    });

    // Listen for host:ready from offscreen document (Chrome) or directly
    if (platform.browser.runtime && platform.browser.runtime.onMessage) {
      platform.browser.runtime.onMessage.addListener((msg: unknown) => {
        if (msg && typeof msg === 'object' && 'type' in msg) {
          if (msg.type === 'privacagent:host:ready') {
            this.handleWorkerReady();
          } else if (msg.type === 'privacagent:host:error') {
            this.handleWorkerError();
          }
        }
      });
    }
  }

  private triggerEvent(event: HostEvent): HostState {
    const nextState = transition(this.state, event);
    if (!nextState) {
      throw new Error(`Invalid host state transition from ${this.state} on event ${event}`);
    }
    this.state = nextState;
    return this.state;
  }

  async acquire(consumer: string): Promise<{ leaseId: string; generation: number }> {
    if (this.disposed || isTerminal(this.state)) {
      throw new MessageBusError(MessageErrorCode.DISCONNECTED, 'HostManager is disposed');
    }

    if (this.state === 'idle') {
      this.triggerEvent('ACQUIRE');
      this.generation++;
      this.startupPromise = this.createHost();
    } else if (this.state === 'releasing') {
      this.cancelIdleAlarm();
      this.triggerEvent('ACQUIRE');
    }

    if (this.state === 'starting') {
      try {
        await this.startupPromise;
      } catch {
        throw new MessageBusError(MessageErrorCode.HANDLER_ERROR, 'Host startup failed');
      }
    }

    if (canAcceptWork(this.state)) {
      if (this.state === 'ready') {
        this.triggerEvent('ACQUIRE');
      }
      const leaseId = crypto.randomUUID();
      this.leases.set(leaseId, {
        id: leaseId,
        consumer,
        acquiredAt: Date.now(),
      });
      return { leaseId, generation: this.generation };
    }

    throw new MessageBusError(
      MessageErrorCode.HANDLER_ERROR,
      `Cannot acquire in state ${this.state}`
    );
  }

  async release(leaseId: string): Promise<{ released: boolean; remainingLeases: number }> {
    if (!this.leases.has(leaseId)) {
      return { released: false, remainingLeases: this.leases.size };
    }

    this.leases.delete(leaseId);

    if (this.leases.size === 0 && this.state === 'active') {
      this.triggerEvent('RELEASE');
      this.startIdleAlarm();
    }

    return { released: true, remainingLeases: this.leases.size };
  }

  private async createHost(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resolveStartup = resolve;
      this.rejectStartup = reject;

      this.startupTimer = setTimeout(() => {
        this.handleWorkerError();
        reject(new Error('Startup timeout'));
      }, STARTUP_TIMEOUT_MS);

      if (platform.name === 'chrome') {
        platform
          .createOffscreenDocument({
            url: HOST_DOCUMENT_PATH,
            reasons: ['WORKERS'],
            justification: 'ML inference worker host',
          })
          .catch((err) => {
            this.handleWorkerError();
            reject(err);
          });
      } else {
        try {
          const workerUrl = platform.browser.runtime.getURL(WORKER_SCRIPT_PATH);
          this.worker = new Worker(workerUrl);
          this.workerTransport = new WorkerTransport(this.worker);
          this.extensionTransport = new ExtensionTransport({ context: 'background' });
          this.relay = new HostRelay(this.extensionTransport, this.workerTransport, [
            'background',
            'content',
            'ui',
          ]);

          // Verify worker is responding
          const bus = new MessageBus({ context: 'background' }, this.extensionTransport);

          const pingWorker = async () => {
            let success = false;
            for (let i = 0; i < 10; i++) {
              if (this.state !== 'starting') break;
              try {
                await bus.send(
                  'ping',
                  { timestamp: Date.now() },
                  { context: 'worker' },
                  { timeoutMs: 3000 }
                );
                success = true;
                break;
              } catch {
                await new Promise((r) => setTimeout(r, 500));
              }
            }
            if (success) {
              this.handleWorkerReady();
            } else {
              this.handleWorkerError();
            }
            bus.dispose();
          };
          void pingWorker();
        } catch (err) {
          this.handleWorkerError();
          reject(err);
        }
      }
    });
  }

  private handleWorkerReady(): void {
    if (this.state === 'starting') {
      if (this.startupTimer) {
        clearTimeout(this.startupTimer);
        this.startupTimer = null;
      }
      this.triggerEvent('WORKER_READY');
      if (this.resolveStartup) this.resolveStartup();
    }
  }

  private handleWorkerError(): void {
    if (this.state === 'starting') {
      if (this.startupTimer) {
        clearTimeout(this.startupTimer);
        this.startupTimer = null;
      }
      this.triggerEvent('ERROR');
      if (this.rejectStartup) this.rejectStartup(new Error('Worker error'));
    }
  }

  private async destroyHost(): Promise<void> {
    this.cancelIdleAlarm();
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }

    this.relay?.dispose();
    this.relay = null;

    this.workerTransport?.dispose();
    this.workerTransport = null;

    this.extensionTransport?.dispose();
    this.extensionTransport = null;

    this.worker?.terminate();
    this.worker = null;

    if (platform.name === 'chrome') {
      await platform.closeOffscreenDocument().catch(() => {});
    }

    if (this.state !== 'idle' && this.state !== 'disposed') {
      this.triggerEvent('ERROR');
    }
  }

  private startIdleAlarm(): void {
    platform.browser.alarms.create(ALARM_NAME, {
      delayInMinutes: IDLE_TIMEOUT_MS / (60 * 1000),
    });
  }

  private cancelIdleAlarm(): void {
    platform.browser.alarms.clear(ALARM_NAME);
  }

  private setupAlarmListener(): void {
    if (platform.browser.alarms && platform.browser.alarms.onAlarm) {
      platform.browser.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === ALARM_NAME) {
          void this.handleIdleTimeout();
        }
      });
    }
  }

  private async handleIdleTimeout(): Promise<void> {
    if (this.state !== 'releasing') return;
    this.triggerEvent('IDLE_TIMEOUT');
    await this.destroyHost();
  }

  getInfo(): HostInfo {
    return {
      state: this.state,
      generation: this.generation,
      activeLeases: this.leases.size,
      browser: platform.name,
    };
  }

  dispose(): void {
    if (this.disposed || isTerminal(this.state)) return;
    this.disposed = true;
    void this.destroyHost();
    this.triggerEvent('DISPOSE');
  }
}
