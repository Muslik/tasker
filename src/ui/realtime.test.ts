import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { operatorQueryKeys } from './api/query.js';
import {
  closeOperatorRealtime,
  ensureOperatorRealtime,
  type OperatorRealtimeEventSource,
} from './realtime.js';

class FakeEventSource implements OperatorRealtimeEventSource {
  public onopen: EventSource['onopen'] = null;
  public onerror: EventSource['onerror'] = null;
  public readonly close = vi.fn();
  private readonly listeners = new Map<'ledger', Array<(event: MessageEvent) => void>>();

  public addEventListener(type: 'ledger', listener: (event: MessageEvent) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  public emit(data: string): void {
    for (const listener of this.listeners.get('ledger') ?? []) {
      listener({ data } as MessageEvent);
    }
  }
}

afterEach(() => {
  closeOperatorRealtime();
  vi.restoreAllMocks();
});

describe('operator realtime', () => {
  it('reuses a single EventSource and invalidates task-scoped queries by event kind', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockImplementation(() => Promise.resolve(undefined));
    const source = new FakeEventSource();
    const factory = vi.fn<(url: string) => OperatorRealtimeEventSource>().mockReturnValue(source);

    const first = ensureOperatorRealtime(queryClient, {
      initialSequence: 10,
      eventSourceFactory: factory,
    });
    const second = ensureOperatorRealtime(queryClient, {
      initialSequence: 12,
      eventSourceFactory: factory,
    });

    source.emit(
      JSON.stringify({
        sequence: 11,
        taskReference: 'jira:AVIA-1',
        eventType: 'PlanningClarificationAnswered',
      }),
    );
    source.emit(
      JSON.stringify({
        sequence: 13,
        taskReference: 'jira:AVIA-1',
        eventType: 'TaskStepOutputRecorded',
      }),
    );

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith('/api/events');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: operatorQueryKeys.taskList() });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: operatorQueryKeys.projection('jira:AVIA-1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: operatorQueryKeys.activity('jira:AVIA-1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: operatorQueryKeys.currentRun('jira:AVIA-1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: operatorQueryKeys.runLog('jira:AVIA-1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: operatorQueryKeys.attempts('jira:AVIA-1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: operatorQueryKeys.invocations('jira:AVIA-1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: operatorQueryKeys.implementationPlan('jira:AVIA-1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: operatorQueryKeys.planReviews('jira:AVIA-1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: operatorQueryKeys.planningTranscript('jira:AVIA-1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: operatorQueryKeys.retrospective('jira:AVIA-1'),
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(11);
  });

  it('reports malformed ledger payloads without invalidating queries', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockImplementation(() => Promise.resolve(undefined));
    const source = new FakeEventSource();
    const onError = vi.fn<(message: string) => void>();

    ensureOperatorRealtime(queryClient, {
      eventSourceFactory: () => source,
      onError,
    });

    source.emit('not json');
    source.emit(JSON.stringify({ sequence: 1, taskReference: 'jira:AVIA-1' }));

    expect(onError).toHaveBeenNthCalledWith(
      1,
      'The operator event stream payload was not valid JSON',
    );
    expect(onError).toHaveBeenNthCalledWith(
      2,
      'The operator event stream payload did not match the contract',
    );
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
