# Typed Cross-Context Message Bus (`A-03`)

The `messaging/` module provides a strongly-typed local request/response layer connecting all contexts in the extension:

- **Background Context** (Service Worker in Chrome / Event Page in Firefox)
- **Content Scripts** (Page isolated world, addressed by `tabId` and `frameId`)
- **Offscreen Document / Background Host** (Hosts ML runtime)
- **Web Worker** (Dedicated worker running on-device inference)
- **UI Panels** (Sidepanel in Chrome / Sidebar in Firefox)

---

## 🚀 Quick Start for Contributors

### 1. In Extension Contexts (Background, Content, Offscreen, UI)

```ts
import { MessageBus, ExtensionTransport } from './messaging/index.js';

// Initialize the bus in your extension context
const transport = new ExtensionTransport({ context: 'background' });
const bus = new MessageBus({ context: 'background' }, transport);

// Dispatch a typed request with automatic timeout handling
const response = await bus.send(
  'dom:walk',
  { docId: 'doc_123' },
  { context: 'content', tabId: 42, frameId: 0 },
  { timeoutMs: 3000 }
);

console.log('Walked elements:', response.elementCount);
```

### 2. In Dedicated Web Workers (Decoupled, Zero-Extension Dependencies)

Web Workers cannot access `chrome.*` or extension APIs. Use the dedicated worker entry point:

```ts
import { MessageBus, WorkerTransport } from './messaging/worker.js';

// Dedicated Worker entry point has ZERO extension polyfill dependencies
const transport = new WorkerTransport(self);
const bus = new MessageBus({ context: 'worker' }, transport);

bus.registerHandler('inference:runDetector', async (req) => {
  return {
    status: 'ok',
    synthetic: true,
    itemCount: req.width,
    durationMs: 12,
  };
});
```

---

## 🧩 Architectural Guarantees

### 1. Decoupled Worker Transport (`P1`)

- `WorkerTransport` is completely separated from `ExtensionTransport`.
- Dedicated Web Workers import from `./messaging/worker.js` or `./messaging/worker-transport.js`.
- It executes in pure standard worker environments without requiring or loading `webextension-polyfill`.

### 2. Runtime Schema & Payload Validation (`P2`)

- Every request and response payload is validated at runtime before dispatching or resolving.
- Malformed payloads (such as invalid `ping` timestamps or malformed inference requests) are rejected with `MALFORMED_MESSAGE` before reaching handlers.

### 3. Frame ID Normalization (`P2`)

- Content script endpoints normalize omitted `frameId` values to `0` (main frame).
- Routing always supplies `{ frameId: destination.frameId ?? 0 }` to `tabs.sendMessage`, preventing unintended broadcasting to all subframes.
- Reply correlation matches frames strictly so a subframe response cannot satisfy a main frame request.

### 4. Privacy & Sanitized Diagnostics (`P2`)

- Diagnostic error messages are mapped to fixed, bounded strings per `MessageErrorCode`.
- Raw exception strings, email addresses, page-derived tokens, and arbitrary URLs are **never** echoed in error messages.

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
