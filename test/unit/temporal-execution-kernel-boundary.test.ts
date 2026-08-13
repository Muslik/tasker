import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExecutionWorkflowInputSchema } from '../../src/temporal/execution-kernel/contracts.js';

const graph = {
  metadata: {
    compilerVersion: 4,
    irVersion: 'workflow-ir-v1',
    references: { predicates: [], stepTypes: [], waits: [] },
    workflowId: 'boundary-fixture',
    workflowVersion: 1,
  },
  root: { kind: 'finalize', id: 'done', outcome: 'accepted' },
} as const;

describe('Execution Workflow v2 boundary', () => {
  it('accepts only a frozen graph and opaque context references', () => {
    const parsed = ExecutionWorkflowInputSchema.safeParse({
      schemaVersion: 2,
      taskReference: 'fixture:boundary',
      workflowHash: 'a'.repeat(64),
      graph,
      contextReferences: [{ kind: 'workspace', reference: 'workspace:fixture' }],
      workspace: { path: '/tmp/worktree' },
    });

    expect(parsed.success).toBe(false);
  });

  it('keeps bootstrap, vendor, provider, and project concepts outside the kernel source', () => {
    const source = [
      'src/temporal/workflows/execution-workflow-v2.ts',
      'src/temporal/execution-kernel/contracts.ts',
      'src/temporal/execution-kernel/graph-state.ts',
    ]
      .map((path) => readFileSync(resolve(path), 'utf8'))
      .join('\n');
    const forbidden = [
      'task.analyze@1',
      'plan.approved@1',
      'Docker',
      'Jira',
      'Bitbucket',
      'Jenkins',
      'Codex',
      'Claude',
      'workspace-activity',
      'planning-activity',
    ];

    expect(forbidden.filter((concept) => source.includes(concept))).toEqual([]);
  });
});
