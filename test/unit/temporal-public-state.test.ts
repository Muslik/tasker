import { describe, expect, it } from 'vitest';

import { parseTaskWorkflowPublicState } from '../../src/temporal/index.js';
import { testTaskWorkflowActivities } from '../helpers/temporal-activities.js';

const historicalWaitingState = async () => {
  const prepared = await testTaskWorkflowActivities.prepareTaskWorkspace({
    taskReference: 'jira:AVIA-12045',
    workflowId: 'tasker:jira:AVIA-12045',
    workflowRunId: 'run-before-docker-cutover',
    workflowHash: '0'.repeat(64),
  });
  const historicalContext = Object.fromEntries(
    Object.entries(prepared).filter(([key]) => key !== 'runtime'),
  );

  return {
    schemaVersion: 1,
    taskReference: 'jira:AVIA-12045',
    workflowId: 'tasker:jira:AVIA-12045',
    runId: 'run-before-docker-cutover',
    workflowHash: '0'.repeat(64),
    settings: { planApproval: 'required', planningStrategy: 'auto' },
    executionContext: { status: 'ready', ...historicalContext },
    planning: null,
    workflowChange: null,
    nodeStates: { reproduce_before: 'waiting' },
    attempts: { reproduce_before: 1 },
    status: 'waiting',
    lifecycle: { phase: 'draft' },
    currentNodeId: 'reproduce_before',
    wait: {
      nodeId: 'reproduce_before',
      waitKind: 'bug.reproduce.1.blocked@1',
      reason: 'Node.js was unavailable before Docker cutover',
    },
    outcome: null,
  };
};

describe('Temporal public state boundary', () => {
  it('exposes a pre-Docker execution context as requiring runtime preparation', async () => {
    const historicalState = await historicalWaitingState();

    const parsed = parseTaskWorkflowPublicState(historicalState);

    expect(parsed.executionContext).toMatchObject({
      status: 'runtime_preparation_required',
      workspace: { workspaceId: '0'.repeat(24) },
    });
  });

  it('rejects a malformed runtime receipt instead of treating it as historical state', async () => {
    const historicalState = await historicalWaitingState();

    const parse = () =>
      parseTaskWorkflowPublicState({
        ...historicalState,
        executionContext: { ...historicalState.executionContext, runtime: { status: 'ready' } },
      });

    expect(parse).toThrow();
  });
});
