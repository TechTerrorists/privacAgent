import type { HostState, HostEvent, HostStateTransition } from './types.js';

export const TRANSITIONS: readonly HostStateTransition[] = [
  { from: 'idle', event: 'ACQUIRE', to: 'starting' },
  { from: 'starting', event: 'WORKER_READY', to: 'ready' },
  { from: 'starting', event: 'ERROR', to: 'idle' },
  { from: 'ready', event: 'ACQUIRE', to: 'active' },
  { from: 'active', event: 'RELEASE', to: 'releasing' }, // We'll let HostManager intercept if leases > 0
  { from: 'ready', event: 'RELEASE', to: 'releasing' },
  { from: 'releasing', event: 'IDLE_TIMEOUT', to: 'idle' },
  { from: 'active', event: 'ACQUIRE', to: 'active' },
  { from: 'releasing', event: 'ACQUIRE', to: 'active' },
];

export function transition(current: HostState, event: HostEvent): HostState | null {
  if (event === 'DISPOSE') return 'disposed';
  if (event === 'ERROR' && current !== 'disposed') return 'idle';

  const valid = TRANSITIONS.find((t) => t.from === current && t.event === event);
  return valid ? valid.to : null;
}

export function isTerminal(state: HostState): boolean {
  return state === 'disposed';
}

export function canAcceptWork(state: HostState): boolean {
  return state === 'ready' || state === 'active';
}
