import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import type { OperatorTaskListResponse } from '../../server/operator-contracts.js';
import {
  captureTaskListSnapshot,
  restoreTaskListSnapshot,
  taskListQueryOptions,
  updateTaskInTaskList,
} from './task-list.js';

const taskListFixture = (): OperatorTaskListResponse => ({
  tasks: [
    {
      id: 'task-summary-1',
      taskId: 'jira:AVIA-1',
      title: 'Task one',
      origin: {
        kind: 'jira',
        issueKey: 'AVIA-1',
        issueType: null,
        browseUrl: null,
        syncStatus: 'current',
        repositoryBinding: {
          status: 'missing',
          issueKey: 'AVIA-1',
          recordedAt: '2026-08-30T00:00:00.000Z',
        },
      },
      planning: { status: 'available' },
      status: 'queued',
      attention: 'none',
      currentStage: 'Planning',
      updatedAt: '2026-08-30T00:00:00.000Z',
    },
  ],
  streamCursor: 12,
});

describe('task-list cache helpers', () => {
  it('updates and restores the task list cache for optimistic mutations', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(taskListQueryOptions().queryKey, taskListFixture());

    const snapshot = updateTaskInTaskList(queryClient, 'task-summary-1', (task) => ({
      ...task,
      status: 'running',
      attention: 'operator',
    }));

    expect(
      queryClient.getQueryData<OperatorTaskListResponse>(taskListQueryOptions().queryKey),
    ).toMatchObject({
      tasks: [{ taskId: 'jira:AVIA-1', status: 'running', attention: 'operator' }],
    });

    restoreTaskListSnapshot(queryClient, snapshot);

    expect(
      queryClient.getQueryData<OperatorTaskListResponse>(taskListQueryOptions().queryKey),
    ).toMatchObject({
      tasks: [{ taskId: 'jira:AVIA-1', status: 'queued', attention: 'none' }],
    });
  });

  it('removes an optimistic query when no previous snapshot existed', () => {
    const queryClient = new QueryClient();
    const snapshot = captureTaskListSnapshot(queryClient);

    queryClient.setQueryData(taskListQueryOptions().queryKey, taskListFixture());
    restoreTaskListSnapshot(queryClient, snapshot);

    expect(queryClient.getQueryData(taskListQueryOptions().queryKey)).toBeUndefined();
  });
});
