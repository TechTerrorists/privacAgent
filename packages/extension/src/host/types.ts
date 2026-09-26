export type HostState = 'idle' | 'starting' | 'ready' | 'active' | 'releasing' | 'disposed';

export type HostEvent =
  'ACQUIRE' | 'WORKER_READY' | 'RELEASE' | 'IDLE_TIMEOUT' | 'ERROR' | 'DISPOSE';

export interface HostStateTransition {
  from: HostState;
  event: HostEvent;
  to: HostState;
}

export interface Lease {
  id: string;
  consumer: string;
  acquiredAt: number;
}

export interface HostInfo {
  state: HostState;
  generation: number;
  activeLeases: number;
  browser: 'chrome' | 'firefox';
}

export interface HostAcquireRequest {
  consumer: string;
}

export interface HostAcquireResponse {
  leaseId: string;
  generation: number;
}

export interface HostReleaseRequest {
  leaseId: string;
}

export interface HostReleaseResponse {
  released: boolean;
  remainingLeases: number;
}

export type HostStatusRequest = Record<string, unknown>;

export type HostStatusResponse = HostInfo;

declare module '../messaging/types.js' {
  interface OperationMap {
    'host:acquire': {
      request: HostAcquireRequest;
      response: HostAcquireResponse;
    };
    'host:release': {
      request: HostReleaseRequest;
      response: HostReleaseResponse;
    };
    'host:status': {
      request: HostStatusRequest;
      response: HostStatusResponse;
    };
  }
}
