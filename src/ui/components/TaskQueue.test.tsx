import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { OperatorTaskSummarySchema } from '../../control-plane/operator-contracts.js';
import { formatElapsed } from '../lib/format.js';
import { TaskQueue, buildTaskQueueItems } from './TaskQueue.js';

const task = (
  id: string,
  status: 'running' | 'waiting' | 'needs_attention',
  attention: 'none' | 'operator',
  updatedAt: string | null,
) =>
  OperatorTaskSummarySchema.parse({
    id,
    taskId: id.toUpperCase(),
    title: `Task ${id}`,
    origin: {
      kind: 'jira',
      issueKey: id.toUpperCase(),
      issueType: 'Story',
      browseUrl: null,
      syncStatus: 'current',
      repositoryBinding: {
        status: 'missing',
        issueKey: id.toUpperCase(),
        recordedAt: '2026-08-30T08:00:00.000Z',
      },
    },
    planning: { status: 'available' },
    status,
    attention,
    currentStage:
      status === 'running'
        ? 'Temporal workflow running'
        : status === 'waiting'
          ? 'Waiting for dependency'
          : 'Operator review required',
    updatedAt,
  });

describe('TaskQueue', () => {
  it('renders a dense task rail with elapsed time and selected node details', () => {
    const now = Date.parse('2026-08-30T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const html = renderToStaticMarkup(
      createElement(TaskQueue, {
        tasks: [
          task('fc-101', 'running', 'none', '2026-08-30T09:55:00.000Z'),
          task('fc-102', 'waiting', 'none', '2026-08-30T09:00:00.000Z'),
          task('fc-103', 'needs_attention', 'operator', null),
        ],
        selectedTaskReference: 'fc-102',
        selectedNodeId: 'await-shared-package',
        onSelect: vi.fn(),
      }),
    );

    vi.useRealTimers();

    expect(html).toContain('Task queue');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Current node: <code>await-shared-package</code>');
    expect(html).toContain('Waiting');
    expect(html).toContain('No updates');
  });

  it('exposes a presentational selection seam', () => {
    const onSelect = vi.fn();
    const items = buildTaskQueueItems(
      {
        tasks: [task('fc-201', 'running', 'none', '2026-08-30T09:40:00.000Z')],
        selectedTaskReference: null,
        selectedNodeId: null,
        onSelect,
      },
      Date.parse('2026-08-30T10:00:00.000Z'),
    );

    expect(items[0]?.elapsed).toBe(
      formatElapsed('2026-08-30T09:40:00.000Z', Date.parse('2026-08-30T10:00:00.000Z')),
    );
    items[0]?.select();
    expect(onSelect).toHaveBeenCalledWith('fc-201');
  });
});
