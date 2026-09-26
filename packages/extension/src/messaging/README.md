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

## Authenticated peers and handler roles

Construct `ExtensionTransport(address, { extensionPeers, workerRelayUrls })` with
exact URLs from `browser.runtime.getURL(...)`. `extensionPeers` maps each trusted
background/UI/offscreen document URL to its endpoint address; `workerRelayUrls`
contains only the host documents allowed to forward worker-originated replies.
Use the actual built background URL (Firefox uses its generated background page).
Unlisted extension pages, foreign extension IDs, and mismatched claimed sources
are dropped. Content tab/frame identities come from browser sender metadata;
extension pages opened in tabs still use their configured role.

For privileged handlers, pass a third registration argument such as
`{ allowedSources: ['background'] }`. The default permits all local roles for
nonprivileged operations such as the synthetic stubs. `HostRelay` also accepts
an allowed-source list as its third argument. The dedicated worker/MessagePort
channel must connect only trusted extension code: it preserves the identity
verified by the host, and is not a page messaging bridge. The relay accepts
worker-originated messages only from the worker role. Register the host URL as a
worker relay at each extension recipient, including content recipients.

Incoming envelopes and error codes are validated before dispatch. Responses must
match ID, operation, source and local destination. Malformed/unrelated messages
are dropped without consuming pending requests; these retain their timeout.
Timeouts must be finite, positive and at most 2,147,483,647 ms. Worker forwarding
failure returns a fixed `DISCONNECTED` error where possible; failed reply delivery
is consumed and the caller times out. No forwarding failure triggers a replay.
Error text is always fixed by code, even for custom `MessageBusError` instances.

`message-bus-extension.spec.ts` builds a test-only extension and exercises actual
runtime messaging, top/child-frame tab messaging, and a host/worker round trip in
Chromium and Firefox. Chromium uses an offscreen document; Firefox hosts the worker
in its background page and loads the fixture using `web-ext`. Run it with
`pnpm exec playwright test packages/extension/tests/message-bus-extension.spec.ts`
after installing Playwright's Chromium and Firefox binaries. Production host
startup remains A-04. Dispose buses, relays and their owned transports when the
host stops. Pending requests do not survive navigation or background restart;
local delivery never authorizes network egress (A-06/D-11).
