# A-04 Cross-Browser ML Host Lifecycle

This module implements the cross-browser machine learning host lifecycle manager (feature A-04) for `privacAgent`.

## Architecture

The ML host manages the lifecycle of the on-device inference Web Worker across browser engines:

- **Chrome (MV3)**: Launches an offscreen document (`src/host/offscreen.html`) with reason `WORKERS` and justification `'ML inference worker host'`. The offscreen document creates the dedicated Web Worker and bridges messaging via `HostRelay`.
- **Firefox (MV3)**: The background event page retains DOM capabilities and directly instantiates the Web Worker without Chrome-specific offscreen calls.

## Lifecycle State Machine

The host transitions through an explicit state machine:

```
           ACQUIRE
  [idle] ----------> [starting]
    ^                   |
    |                   | WORKER_READY
    | IDLE_TIMEOUT      v
[releasing] <------- [ready]
    |       RELEASE     |
    |                   | ACQUIRE
    +-----> [active] <--+
            (Leases > 0)
```

- `idle`: No worker or offscreen document running. 0% CPU, 0 MB memory overhead.
- `starting`: Worker/document creation in progress; concurrent acquire requests queue onto the same startup promise.
- `ready`: Worker initialized and confirmed responsive via handshake.
- `active`: One or more consumer leases are held. Idle timers are cleared.
- `releasing`: Last lease released. 10-minute idle alarm (`privacagent:host:idle`) armed via `chrome.alarms` / `browser.alarms`.
- `disposed`: Terminal state on extension unload or teardown.

## Task Leases & Idle Cleanup

1. **Acquiring a Lease**:
   Consumers (e.g. Vision capture in A-07, Interaction loop in A-13, Sidepanel chat in F-09) acquire a lease before dispatching inference operations:
   ```ts
   const { leaseId, generation } = await bus.send(
     'host:acquire',
     { consumer: 'A-07:vision' },
     { context: 'background' }
   );
   ```
2. **Generations**:
   Every worker host instantiation increments a monotonic `generation` counter. Responses from terminated or timed-out workers with stale generation tags are rejected, preventing late inferences from polluting new tasks.
3. **Releasing a Lease**:
   Once the task or inference pipeline completes:
   ```ts
   await bus.send('host:release', { leaseId }, { context: 'background' });
   ```
   When the active lease count drops to zero, a 10-minute alarm is registered. If no new lease is acquired before the alarm triggers, the host is torn down (worker terminated, offscreen document closed, transports disposed).
4. **Re-acquisition during Releasing**:
   If a new task requests a lease while in `releasing` state, the idle alarm is cancelled immediately and the host returns to `active` without re-creating the worker.

## Consumer Sharing Examples

### A-07 Vision Pipeline

```ts
async function runPerceptionPass(image: InferenceImage) {
  const { leaseId } = await bus.send(
    'host:acquire',
    { consumer: 'vision-perception' },
    { context: 'background' }
  );
  try {
    return await bus.send('inference:runDetector', image, { context: 'worker' });
  } finally {
    await bus.send('host:release', { leaseId }, { context: 'background' });
  }
}
```

### A-13 Interaction Engine

Runs continuous perception across interactive page states. A single lease is held for the duration of the multi-step interaction session, ensuring the ONNX weights stay warm in memory without tearing down between steps.

### F-09 Side Panel Agent Chat

The user-facing chat panel acquires a lease when the user starts a session or asks a question that requires inspecting the DOM and screenshot. When the user closes the panel or goes idle, the lease is released.
