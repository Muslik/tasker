import { type QueryClient } from '@tanstack/react-query';

import {
  OperatorStreamEventSchema,
  type OperatorStreamEvent,
} from '../server/operator-contracts.js';
import { invalidateTaskQueries } from './api/query.js';

export interface OperatorRealtimeEventSource {
  addEventListener(type: 'ledger', listener: (event: MessageEvent) => void): void;
  close(): void;
  onopen: EventSource['onopen'];
  onerror: EventSource['onerror'];
}

export interface EnsureOperatorRealtimeOptions {
  readonly eventSourceFactory?: (url: string) => OperatorRealtimeEventSource;
  readonly initialSequence?: number;
  readonly onOpen?: () => void;
  readonly onError?: (message: string) => void;
}

export interface OperatorRealtimeHandle {
  close(): void;
}

const createEventSource = (url: string): OperatorRealtimeEventSource => new EventSource(url);

const parseStreamEvent = (
  rawEvent: MessageEvent,
  onError?: (message: string) => void,
): OperatorStreamEvent | null => {
  if (typeof rawEvent.data !== 'string') {
    onError?.('The operator event stream emitted an unexpected payload');
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawEvent.data) as unknown;
  } catch {
    onError?.('The operator event stream payload was not valid JSON');
    return null;
  }

  const parsed = OperatorStreamEventSchema.safeParse(payload);
  if (!parsed.success) {
    onError?.('The operator event stream payload did not match the contract');
    return null;
  }

  return parsed.data;
};

class LiveOperatorRealtime implements OperatorRealtimeHandle {
  private lastSequence: number;
  private queryClient: QueryClient;
  private callbacks: Pick<EnsureOperatorRealtimeOptions, 'onOpen' | 'onError'>;

  public constructor(
    queryClient: QueryClient,
    private readonly source: OperatorRealtimeEventSource,
    initialSequence: number,
    callbacks: Pick<EnsureOperatorRealtimeOptions, 'onOpen' | 'onError'>,
    private readonly onClose: () => void,
  ) {
    this.lastSequence = initialSequence;
    this.queryClient = queryClient;
    this.callbacks = callbacks;

    this.source.addEventListener('ledger', this.handleLedgerEvent);
    this.source.onopen = () => {
      this.callbacks.onOpen?.();
    };
    this.source.onerror = () => {
      this.callbacks.onError?.('The operator event stream is reconnecting');
    };
  }

  public update(
    queryClient: QueryClient,
    initialSequence: number,
    callbacks: Pick<EnsureOperatorRealtimeOptions, 'onOpen' | 'onError'>,
  ): void {
    this.queryClient = queryClient;
    this.lastSequence = Math.max(this.lastSequence, initialSequence);
    this.callbacks = callbacks;
  }

  public close(): void {
    this.source.close();
    this.onClose();
  }

  private readonly handleLedgerEvent = (rawEvent: MessageEvent): void => {
    const event = parseStreamEvent(rawEvent, this.callbacks.onError);
    if (event === null || event.sequence <= this.lastSequence) return;

    this.lastSequence = event.sequence;
    invalidateTaskQueries(this.queryClient, event.taskReference, {
      includeRunLog: true,
      includeAttempts: true,
      includeInvocations: true,
    });
  };
}

let activeRealtime: LiveOperatorRealtime | null = null;

export const ensureOperatorRealtime = (
  queryClient: QueryClient,
  options: EnsureOperatorRealtimeOptions = {},
): OperatorRealtimeHandle => {
  const initialSequence = options.initialSequence ?? 0;
  if (activeRealtime !== null) {
    activeRealtime.update(queryClient, initialSequence, options);
    return activeRealtime;
  }

  const source = (options.eventSourceFactory ?? createEventSource)('/api/events');
  activeRealtime = new LiveOperatorRealtime(queryClient, source, initialSequence, options, () => {
    activeRealtime = null;
  });
  return activeRealtime;
};

export const closeOperatorRealtime = (): void => {
  activeRealtime?.close();
};
