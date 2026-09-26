# Typed Cross-Context Message Bus (`A-03`)

The `messaging/` module provides a strongly-typed local request/response layer that connects all parts of the extension:

- **Background Context** (Service Worker in Chrome / Event Page in Firefox)
- **Content Scripts** (Page isolated world, addressed by `tabId` and `frameId`)
- **Offscreen Document / Background Host** (Hosts ML runtime)
- **Web Worker** (Dedicated worker running on-device inference)
- **UI Panels** (Sidepanel in Chrome / Sidebar in Firefox)

---

## 🚀 Quick Start for Contributors

### 1. Sending a Request

```ts
import { MessageBus, ExtensionTransport } from './messaging/index.js';

// Initialize the bus in your context (e.g. background)
const bus = new MessageBus({ context: 'background' }, new ExtensionTransport());

// Dispatch a typed request with automatic timeout handling
const response = await bus.send(
  'dom:walk',
  { docId: 'doc_123' },
  { context: 'content', tabId: 42, frameId: 0 },
  { timeoutMs: 3000 }
);

console.log('Walked elements:', response.elementCount);
```

### 2. Registering a Handler

```ts
// Handlers bind strictly to the request and response types in OperationMap
const unregister = bus.registerHandler('dom:walk', async (req, source) => {
  console.log(`Request from ${source.context}`);
  return {
    docId: req.docId ?? 'default',
    elementCount: 15,
    timestamp: Date.now(),
  };
});

// To unregister when done:
unregister();
```

---

## 🧩 Architectural Concepts

### 1. The Operation Map (`OperationMap`)

Every cross-context operation is registered in `OperationMap` inside `types.ts`.
This ensures at compile-time that callers cannot send incorrect request shapes or cast arbitrary response objects:

```ts
export interface OperationMap {
  ping: { request: PingRequest; response: PingResponse };
  'inference:runDetector': { request: InferenceStubRequest; response: InferenceStubResponse };
  'inference:runOCR': { request: InferenceStubRequest; response: InferenceStubResponse };
  'dom:walk': { request: DomWalkStubRequest; response: DomWalkStubResponse };
  // ... more operations
}
```

### 2. Transports & Host Relay

- **`ExtensionTransport`**: Uses standard browser extension messaging (`runtime.sendMessage` and `tabs.sendMessage`).
- **`WorkerTransport`**: Connects directly to a `Worker` or `MessagePort` via `postMessage`.
- **`HostRelay`**: Bridges the two worlds. Because Web Workers in MV3 cannot access `chrome.runtime`, the Host Relay running in the host document (Chrome Offscreen Document or Firefox Background Page) routes worker-bound messages into the worker and worker replies back out.

```text
[Background / Content / UI]
          │
          │ ExtensionTransport (runtime.sendMessage / tabs.sendMessage)
          ▼
   [Host Document (Offscreen / BG)]
          │
          │ HostRelay (bridges Extension <-> Worker)
          ▼
   [Dedicated Web Worker] (WorkerTransport / postMessage)
```

### 3. Fail-Fast & Bounded Errors

Requests never hang indefinitely. Every request has a configurable timeout (default: 5,000ms).
Errors return clean, bounded error codes (`MessageErrorCode`):

- `TIMEOUT`: Missing receiver or slow operation.
- `UNSUPPORTED_OPERATION`: No handler registered for this operation.
- `HANDLER_ERROR`: Handler threw an exception.
- `MALFORMED_MESSAGE`: Envelope or payload failed validation.
- `UNSUPPORTED_PAYLOAD`: Attempted to send DOM nodes or functions across contexts.
- `DISCONNECTED`: Bus was torn down while requests were pending.

---

## 🧪 Deterministic Stubs (Zero-Backend Integration)

Before ML models, servers, or production workers are finished, other lanes can immediately start testing against deterministic fake stubs:

```ts
import { installStubHandlers } from './messaging/index.js';

// Instantly registers deterministic stubs for ping, inference, dom, and tasks:
const cleanupStubs = installStubHandlers(bus);
```

---

## 🧹 Teardown & Lifecycle (For A-04)

When hosts or workers stop, A-04 simply calls:

```ts
bus.dispose();
relay.dispose();
```

This automatically cancels all pending timers, safely rejects pending calls with `DISCONNECTED`, and removes event listeners to prevent memory leaks.
