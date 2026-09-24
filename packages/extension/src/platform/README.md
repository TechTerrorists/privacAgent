# Platform Adapter (`A-02`)

The `platform/` module provides a single, unified interface for cross-browser integration in privacAgent across Chrome and Firefox Manifest V3.

## Overview

Chrome and Firefox have diverging capabilities under Manifest V3:

- **Background & ML Hosting**: Chrome uses service workers and offscreen documents (`chrome.offscreen`) to host DOM/WASM workers. Firefox uses an event page with direct DOM access and Web Worker capabilities.
- **Side Panel UI**: Chrome uses `chrome.sidePanel`. Firefox uses `browser.sidebarAction`.
- **Standard WebExtension APIs**: Common APIs (`tabs`, `runtime`, `storage`, `scripting`, `alarms`) are exposed through `webextension-polyfill`.

The Platform Adapter encapsulates these browser-specific APIs and capability differences behind a single typed interface.

## Usage

### 1. Standard Import (Preferred)

Import the singleton `platform` object directly from the platform module:

```ts
import { platform } from '../platform/index.js';

// Access cross-browser webextension-polyfill APIs:
const currentTab = await platform.browser.tabs.query({ active: true, currentWindow: true });

// Check capabilities:
if (platform.capabilities.offscreen) {
  await platform.createOffscreenDocument({
    url: 'src/offscreen/index.html',
    reasons: ['WORKERS'],
    justification: 'Run local ONNX perception models',
  });
}

// Open the side panel / sidebar:
await platform.openSidePanel();
```

### 2. Browser Capabilities

Check `platform.capabilities` before calling optional browser features:

```ts
if (platform.capabilities.offscreen) {
  // Safe to call Chrome offscreen document APIs
}
```

Attempting to call an unsupported API (e.g. `platform.createOffscreenDocument()` on Firefox) explicitly rejects with `UnsupportedPlatformCapabilityError` instead of silently succeeding.

### 3. Handling Unsupported Capabilities

Always handle capability errors when working with platform-specific operations:

```ts
import { platform, UnsupportedPlatformCapabilityError } from '../platform/index.js';

try {
  await platform.createOffscreenDocument({ ... });
} catch (err) {
  if (err instanceof UnsupportedPlatformCapabilityError) {
    // Expected on Firefox: fallback to hosting worker in background page
  } else {
    throw err;
  }
}
```

## Structure

- [`types.ts`](./types.ts): Shared TypeScript interfaces (`PlatformAdapter`, `PlatformCapabilities`).
- [`errors.ts`](./errors.ts): Custom error definitions (`UnsupportedPlatformCapabilityError`).
- [`chrome.ts`](./chrome.ts): Chrome implementation (wires `chrome.offscreen` and `chrome.sidePanel`).
- [`firefox.ts`](./firefox.ts): Firefox implementation (wires `browser.sidebarAction`, rejects `offscreen`).
- [`index.ts`](./index.ts): Shared entry point selecting the adapter via Vite's `__BROWSER__` build constant.
- [`platform.test.ts`](./platform.test.ts): Unit tests covering adapter selection and error behavior.
