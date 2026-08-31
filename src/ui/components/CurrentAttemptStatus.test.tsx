import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { OperatorWorkflowProjection } from '../../server/operator-contracts.js';
import {
  buildCurrentAttemptStatusView,
  CurrentAttemptStatus,
  triggerCurrentAttemptOpen,
} from './CurrentAttemptStatus.js';

const projection: OperatorWorkflowProjection = {
  schemaVersion: 9,
  taskReference: 'jira:AVIA-42',
  status: 'waiting',
  activeRuntime: 'execution',
  activeRunId: 'run-42',
  graphHash: null,
  current: {
    runtime: 'execution',
    nodeId: 'verify-runtime',
    reference: 'runtime.verify@1',
    blockRun: 3,
    transcript: null,
    status: 'waiting',
    waitKind: 'external.result@1',
    reason: 'The canary must remain healthy for the full observation window.',
    intervention: { kind: 'external_prerequisite' },
  },
  currentAttempt: {
    latestInvocationId: 'invocation-42',
    nodeId: 'verify-runtime',
    blockRun: 3,
    startedAt: '2026-08-30T09:40:00.000Z',
    waitingSince: '2026-08-30T09:45:00.000Z',
  },
  dependencies: [],
  stages: [],
  continuations: [],
};

describe('CurrentAttemptStatus', () => {
  it('shows the bootstrap stage and stage elapsed before an invocation exists', () => {
    const bootstrap = {
      ...projection,
      status: 'running' as const,
      activeRuntime: 'bootstrap' as const,
      currentAttempt: null,
      current: {
        runtime: 'bootstrap' as const,
        nodeId: 'workspace',
        reference: null,
        blockRun: null,
        startedAt: '2026-08-30T09:56:00.000Z',
        status: 'running' as const,
        waitKind: null,
        reason: null,
        intervention: null,
        transcript: null,
      },
      stages: [
        {
          key: 'bootstrap:workspace:1',
          id: 'workspace',
          label: 'Workspace',
          status: 'running' as const,
          steps: [],
        },
      ],
    };
    const view = buildCurrentAttemptStatusView(bootstrap, Date.parse('2026-08-30T10:00:00.000Z'));

    expect(view.node).toBe('Workspace — preparing');
    expect(view.elapsed).toBe('4m');
  });

  it('renders current attempt timing and waiting copy in SSR', () => {
    const html = renderToStaticMarkup(createElement(CurrentAttemptStatus, { projection }));

    expect(html).toContain('Current node');
    expect(html).toContain('verify-runtime');
    expect(html).toContain('Block run');
    expect(html).toContain('Open invocation');
    expect(html).toContain(
      'waiting for external.result@1 / The canary must remain healthy for the full observation window.',
    );
  });

  it('builds prompt-opening selections from the current attempt', () => {
    const onOpenInvocation = vi.fn();
    const view = buildCurrentAttemptStatusView(projection, Date.parse('2026-08-30T10:00:00.000Z'));

    expect(view.elapsed).toBe('20m');
    expect(view.selection).toEqual({
      nodeId: 'verify-runtime',
      blockRun: 3,
      invocationId: 'invocation-42',
    });
    expect(triggerCurrentAttemptOpen(view.selection, onOpenInvocation)).toEqual(view.selection);
    expect(onOpenInvocation).toHaveBeenCalledWith(view.selection);
  });
});
