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
import type { HostState, HostEvent, Lease, HostInfo, HostSignalRequest } from './types.js';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const ALARM_NAME = 'privacagent:host:idle';
const STARTUP_TIMEOUT_MS = 30000;
const HOST_DOCUMENT_PATH = 'src/host/offscreen.html';
const WORKER_SCRIPT_PATH = 'src/host/ml-worker.js';
const BACKGROUND_URL_PATHS = [
  'src/background/index.js',
  'service-worker-loader.js',
  '_generated_background_page.html',
] as const;
const SIDEPANEL_PATH = 'src/ui/sidepanel.html';

function buildExtensionPeers(): Record<string, { context: 'background' | 'offscreen' | 'ui' }> {
  const peers: Record<string, { context: 'background' | 'offscreen' | 'ui' }> = {
    [platform.browser.runtime.getURL(HOST_DOCUMENT_PATH)]: { context: 'offscreen' },
    [platform.browser.runtime.getURL(SIDEPANEL_PATH)]: { context: 'ui' },
  };
  for (const path of BACKGROUND_URL_PATHS) {
    peers[platform.browser.runtime.getURL(path)] = { context: 'background' };
  }
  return peers;
}

export class HostManager {
  private state: HostState = 'idle';
  private generation = 0;
  private leases = new Map<string, Lease>();
  private worker: Worker | null = null;
  private relay: HostRelay | null = null;
  private workerTransport: WorkerTransport | null = null;
  private workerBus: MessageBus | null = null;
  private extensionTransport: ExtensionTransport | null = null;
  private bgBus: MessageBus;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private startupPromise: Promise<void> | null = null;
  private resolveStartup: (() => void) | undefined;
  private rejectStartup: ((e: Error) => void) | undefined;
  private startupGeneration = 0;
  private startupToken = '';
  private teardownPromise: Promise<void> | null = null;
  private readonly handlerCleanup: Array<() => void> = [];
  private alarmListener: ((alarm: { name: string }) => void) | undefined;
  private workerErrorListener: (() => void) | undefined;
  private workerMessageErrorListener: (() => void) | undefined;
  private readonly teardownHooks = new Set<() => void | Promise<void>>();

  constructor(bgBus: MessageBus) {
    this.bgBus = bgBus;
    this.registerHandlers();
    this.setupAlarmListener();
  }

  registerTeardownHook(hook: () => void | Promise<void>): () => void {
    this.teardownHooks.add(hook);
    return () => {
      this.teardownHooks.delete(hook);
    };
  }

  private registerHandlers(): void {
    this.handlerCleanup.push(
      this.bgBus.registerHandler(
        'host:acquire',
        async (request, _sender) => {
          const resp = await this.acquire(request.consumer);
          return resp;
        },
        { allowedSources: ['background', 'ui', 'content'] }
      )
    );

    this.handlerCleanup.push(
      this.bgBus.registerHandler(
        'host:release',
        async (request, _sender) => {
          const resp = await this.release(request.leaseId);
          return resp;
        },
        { allowedSources: ['background', 'ui', 'content'] }
      )
    );

    this.handlerCleanup.push(
      this.bgBus.registerHandler('host:status', async (_request, _sender) => {
        return this.getInfo();
      })
    );

    this.handlerCleanup.push(
      this.bgBus.registerHandler(
        'host:signal',
        async (request, sender) => this.handleHostSignal(request, sender),
        { allowedSources: ['offscreen', 'background'] }
      )
    );
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

    if (this.teardownPromise) {
      await this.teardownPromise;
    }

    if (this.state === 'idle') {
      this.startGeneration();
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
      const isHealthy = await this.verifyHostHealth();
      if (!isHealthy) {
        this.handleHostLoss();
        throw new MessageBusError(MessageErrorCode.DISCONNECTED, 'Host is unavailable');
      }

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

  private startGeneration(): void {
    this.triggerEvent('ACQUIRE');
    this.generation++;
    this.startupGeneration = this.generation;
    this.startupToken = crypto.randomUUID();
    this.startupPromise = this.createHost(this.startupGeneration, this.startupToken);
  }

  private async createHost(generation: number, startupToken: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.resolveStartup = resolve;
      this.rejectStartup = reject;

      this.startupTimer = setTimeout(() => {
        this.failStartup('Startup timeout');
      }, STARTUP_TIMEOUT_MS);

      if (platform.name === 'chrome') {
        void (async () => {
          try {
            const hasExistingHost = await platform.hasOffscreenDocument().catch(() => false);
            if (hasExistingHost) {
              await platform.closeOffscreenDocument().catch(() => {});
            }

            await platform.createOffscreenDocument({
              url: `${HOST_DOCUMENT_PATH}?generation=${generation}&startupToken=${encodeURIComponent(startupToken)}`,
              reasons: ['WORKERS'],
              justification: 'ML inference worker host',
            });
          } catch (err) {
            this.failStartup(err instanceof Error ? err.message : 'Worker error');
          }
        })();
      } else {
        try {
          const workerUrl = platform.browser.runtime.getURL(WORKER_SCRIPT_PATH);
          this.worker = new Worker(workerUrl, { type: 'module' });
          this.workerTransport = new WorkerTransport(this.worker);
          this.workerBus = new MessageBus({ context: 'background' }, this.workerTransport);
          this.installFirefoxWorkerLossListeners();

          this.extensionTransport = new ExtensionTransport(
            { context: 'background' },
            {
              extensionPeers: buildExtensionPeers(),
            }
          );
          this.relay = new HostRelay(this.extensionTransport, this.workerTransport, [
            'background',
            'content',
            'ui',
          ]);

          void this.pingLocalWorker(generation, startupToken);
        } catch (err) {
          this.failStartup(err instanceof Error ? err.message : 'Worker error');
        }
      }
    });
  }

  private installFirefoxWorkerLossListeners(): void {
    if (!this.worker) return;

    this.workerErrorListener = () => {
      this.handleHostLoss();
    };
    this.workerMessageErrorListener = () => {
      this.handleHostLoss();
    };

    this.worker.addEventListener('error', this.workerErrorListener);
    this.worker.addEventListener('messageerror', this.workerMessageErrorListener);
  }

  private removeFirefoxWorkerLossListeners(): void {
    if (!this.worker) return;
    if (this.workerErrorListener) {
      this.worker.removeEventListener('error', this.workerErrorListener);
    }
    if (this.workerMessageErrorListener) {
      this.worker.removeEventListener('messageerror', this.workerMessageErrorListener);
    }
    this.workerErrorListener = undefined;
    this.workerMessageErrorListener = undefined;
  }

  private async pingLocalWorker(generation: number, startupToken: string): Promise<void> {
    if (!this.workerBus) {
      this.failStartup('Worker startup failed');
      return;
    }

    let success = false;
    for (let i = 0; i < 10; i++) {
      if (
        this.state !== 'starting' ||
        this.startupGeneration !== generation ||
        this.startupToken !== startupToken
      ) {
        return;
      }
      try {
        await this.workerBus.send(
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

    await this.handleHostSignal(
      {
        event: success ? 'ready' : 'error',
        generation,
        startupToken,
      },
      { context: 'background' }
    );
  }

  private isExpectedSignalSender(senderContext?: string): boolean {
    if (platform.name === 'chrome') {
      return senderContext === 'offscreen';
    }
    return senderContext === 'background';
  }

  private async handleHostSignal(
    request: HostSignalRequest,
    sender?: { context: string }
  ): Promise<{ accepted: boolean }> {
    if (
      this.state !== 'starting' ||
      request.generation !== this.startupGeneration ||
      request.startupToken !== this.startupToken ||
      !this.isExpectedSignalSender(sender?.context)
    ) {
      return { accepted: false };
    }

    if (request.event === 'ready') {
      this.finishStartup();
    } else {
      this.failStartup('Worker error');
    }

    return { accepted: true };
  }

  private finishStartup(): void {
    if (this.state !== 'starting') return;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }

    this.triggerEvent('WORKER_READY');
    this.resolveStartup?.();
    this.clearStartupWaiters();
  }

  private failStartup(reason: string): void {
    if (this.state !== 'starting') return;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }

    this.triggerEvent('ERROR');
    this.rejectStartup?.(new Error(reason));
    this.clearStartupWaiters();
    void this.destroyHostResources();
  }

  private clearStartupWaiters(): void {
    this.startupPromise = null;
    this.resolveStartup = undefined;
    this.rejectStartup = undefined;
    this.startupGeneration = 0;
    this.startupToken = '';
  }

  private async verifyHostHealth(): Promise<boolean> {
    try {
      if (platform.name === 'firefox') {
        if (!this.workerBus) return false;
        await this.workerBus.send(
          'ping',
          { timestamp: Date.now() },
          { context: 'worker' },
          { timeoutMs: 1000 }
        );
      } else {
        await this.bgBus.send(
          'ping',
          { timestamp: Date.now() },
          { context: 'worker' },
          { timeoutMs: 1000 }
        );
      }
      return true;
    } catch {
      return false;
    }
  }

  private handleHostLoss(): void {
    if (this.disposed) return;
    this.leases.clear();

    if (this.state === 'starting') {
      this.failStartup('Worker error');
      return;
    }

    if (this.state === 'idle' || this.state === 'disposed') {
      return;
    }

    if (!this.teardownPromise) {
      const generation = this.generation;
      const teardown = this.destroyHostResources()
        .catch(() => {})
        .then(() => {
          if (
            !this.disposed &&
            this.state !== 'idle' &&
            this.state !== 'disposed' &&
            this.generation === generation
          ) {
            this.triggerEvent('ERROR');
          }
        });
      this.teardownPromise = teardown.finally(() => {
        if (this.teardownPromise === teardown) {
          this.teardownPromise = null;
        }
      });
    }
  }

  private async destroyHostResources(): Promise<void> {
    this.cancelIdleAlarm();
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }

    await Promise.allSettled(Array.from(this.teardownHooks, (hook) => Promise.resolve(hook())));

    this.relay?.dispose();
    this.relay = null;

    this.workerBus?.dispose();
    this.workerBus = null;

    this.workerTransport?.dispose();
    this.workerTransport = null;

    this.extensionTransport?.dispose();
    this.extensionTransport = null;

    this.removeFirefoxWorkerLossListeners();
    this.worker?.terminate();
    this.worker = null;

    if (platform.name === 'chrome') {
      await platform.closeOffscreenDocument().catch(() => {});
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
      this.alarmListener = (alarm) => {
        if (alarm.name === ALARM_NAME) {
          void this.handleIdleTimeout();
        }
      };
      platform.browser.alarms.onAlarm.addListener(this.alarmListener);
    }
  }

  private async handleIdleTimeout(): Promise<void> {
    if (this.state !== 'releasing') return;

    if (this.teardownPromise) {
      await this.teardownPromise;
      return;
    }

    const releasingGeneration = this.generation;
    const teardown = this.destroyHostResources()
      .catch(() => {})
      .then(() => {
        if (
          !this.disposed &&
          this.state === 'releasing' &&
          this.generation === releasingGeneration
        ) {
          this.triggerEvent('IDLE_TIMEOUT');
        }
      });
    this.teardownPromise = teardown.finally(() => {
      if (this.teardownPromise === teardown) {
        this.teardownPromise = null;
      }
    });

    await this.teardownPromise;
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
    for (const unregister of this.handlerCleanup.splice(0)) {
      unregister();
    }

    if (this.alarmListener) {
      platform.browser.alarms.onAlarm.removeListener(this.alarmListener);
      this.alarmListener = undefined;
    }

    this.leases.clear();
    if (this.state === 'starting') {
      this.failStartup('Host manager disposed');
    }

    const inFlightTeardown = this.teardownPromise ?? this.destroyHostResources();
    this.teardownPromise = inFlightTeardown.finally(() => {
      if (this.teardownPromise === inFlightTeardown) {
        this.teardownPromise = null;
      }
    });

    this.triggerEvent('DISPOSE');
  }
}
