import { describe, expect, it } from 'vitest';

import type { OperatorTaskSummary } from '../../src/server/operator-contracts.js';
import { orderOperatorTasks } from '../../src/server/operator-task-order.js';

const task = (
  taskId: string,
  status: OperatorTaskSummary['status'],
  attention: OperatorTaskSummary['attention'],
): OperatorTaskSummary => ({
  id: `jira:${taskId}`,
  taskId,
  title: taskId,
  origin: {
    kind: 'jira',
    issueKey: taskId,
    issueType: 'Task',
    browseUrl: null,
    syncStatus: 'current',
    repositoryBinding: {
      issueKey: taskId,
      recordedAt: '2026-08-26T00:00:00.000Z',
      status: 'missing',
    },
  },
  planning: { status: 'available' },
  status,
  attention,
  currentStage: status,
  updatedAt: '2026-08-26T00:00:00.000Z',
});

describe('operator task order', () => {
  it('puts operator attention first and completed work last', () => {
    const tasks = [
      task('DONE-1', 'done', 'none'),
      task('REVIEW-1', 'plan_review', 'operator'),
      task('RUN-1', 'running', 'none'),
      task('REVIEW-2', 'code_review', 'operator'),
    ];

    expect(orderOperatorTasks(tasks).map(({ taskId }) => taskId)).toEqual([
      'REVIEW-1',
      'REVIEW-2',
      'RUN-1',
      'DONE-1',
    ]);
    expect(tasks.map(({ taskId }) => taskId)).toEqual(['DONE-1', 'REVIEW-1', 'RUN-1', 'REVIEW-2']);
  });
});
