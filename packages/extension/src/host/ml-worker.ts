import { MessageBus, WorkerTransport, installStubHandlers } from '../messaging/worker.js';
import type { WorkerMessageTarget } from '../messaging/worker-transport.js';

const transport = new WorkerTransport(self as unknown as WorkerMessageTarget);
const bus = new MessageBus({ context: 'worker' }, transport);

installStubHandlers(bus);

// The bus is now ready to handle requests routed through the HostRelay
