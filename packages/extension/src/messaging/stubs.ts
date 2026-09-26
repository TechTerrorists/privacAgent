/**
 * Deterministic synthetic stub handlers for cross-context messaging (feature A-03).
 *
 * Allows C-01 (Inference), D-01 (Redaction), B-02 (DOM), and UI lanes to integrate
 * and test against typed operations before production models and hosts are landed.
 */

import { type MessageBus } from './bus.js';
import {
  type DomProbeStubRequest,
  type DomProbeStubResponse,
  type DomWalkStubRequest,
  type DomWalkStubResponse,
  type InferenceStubRequest,
  type InferenceStubResponse,
  type PingRequest,
  type PingResponse,
  type TaskStatusStubRequest,
  type TaskStatusStubResponse,
} from './types.js';

/**
 * Deterministic FNV-1a hash of input dimensions and region to ensure reproducible results.
 */
function hashInput(req: InferenceStubRequest): number {
  const str = `${req.frame}:${req.width}:${req.height}:${req.region?.join(',') ?? 'full'}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function handlePingStub(req: PingRequest, sourceContext = 'background'): PingResponse {
  return {
    timestamp: Date.now(),
    echo: req.echo,
    context: sourceContext as PingResponse['context'],
  };
}

export function handleInferenceStub(req: InferenceStubRequest): InferenceStubResponse {
  const seed = hashInput(req);
  const itemCount = (seed % 5) + 1; // 1 to 5 deterministic items
  return {
    status: 'ok',
    synthetic: true,
    itemCount,
    durationMs: 15,
  };
}

export function handleDomWalkStub(req: DomWalkStubRequest): DomWalkStubResponse {
  return {
    docId: req.docId ?? 'doc_synth_01',
    elementCount: 42,
    timestamp: Date.now(),
  };
}

export function handleDomProbeStub(_req: DomProbeStubRequest): DomProbeStubResponse {
  return {
    active: true,
    docId: 'doc_synth_01',
  };
}

export function handleTaskStatusStub(req: TaskStatusStubRequest): TaskStatusStubResponse {
  return {
    taskId: req.taskId,
    state: 'idle',
  };
}

/**
 * Registers all standard deterministic stub handlers onto the given MessageBus.
 * Returns an unregister callback for clean teardown.
 */
export function installStubHandlers(bus: MessageBus): () => void {
  const unsubs: Array<() => void> = [
    bus.registerHandler('ping', (req) => handlePingStub(req, bus.localAddress.context)),
    bus.registerHandler('inference:runDetector', handleInferenceStub),
    bus.registerHandler('inference:runOCR', handleInferenceStub),
    bus.registerHandler('inference:runFaces', handleInferenceStub),
    bus.registerHandler('inference:runIcons', handleInferenceStub),
    bus.registerHandler('dom:walk', handleDomWalkStub),
    bus.registerHandler('dom:probe', handleDomProbeStub),
    bus.registerHandler('task:status', handleTaskStatusStub),
  ];

  return () => {
    for (const unsub of unsubs) unsub();
  };
}
