import { describe, expect, it } from 'vitest';

import { collectBlockCompletionEvidence } from './block-completion-evidence.js';

describe('block completion evidence', () => {
  it('uses pageId as the reconciled external identity when integration output has no externalId', async () => {
    const result = await collectBlockCompletionEvidence(
      {
        operationId: 'tasker:test:research:publish',
        block: {
          schemaVersion: 3,
          reference: 'research.publish@1',
          description: 'Publish research page',
          stage: { id: 'delivery', label: 'Delivery' },
          availableDuring: ['execution'],
          inputContract: 'research_publish_input',
          outputContract: 'research_publish_output',
          executor: { kind: 'effect', adapter: 'research.publish@1' },
          allowedCapabilities: [],
          allowedEffects: ['confluence.page.publish'],
          outcomes: ['completed', 'blocked'],
          completion: { kind: 'reconciled_effect' },
          requiredArtifacts: [],
          producedArtifacts: [],
        },
        workspace: {
          schemaVersion: 1,
          workspaceId: 'a'.repeat(24),
          taskReference: 'jira:AVIA-14001',
          workflowId: 'tasker:jira:AVIA-14001',
          workflowRunId: 'run-1',
          repository: {
            reference: 'front-avia',
            sourcePath: '/workspace/front-avia',
            baseBranch: 'master',
            baseCommit: 'c'.repeat(40),
          },
          runnerId: 'test',
          path: '/worktrees/front-avia',
          branch: 'tasker/avia-14001/run-1',
          preparedAt: '2026-08-30T00:00:00.000Z',
        },
        outputArtifact: {
          schemaVersion: 4,
          operationId: 'tasker:test:research:publish',
          workflowId: 'tasker:jira:AVIA-14001',
          workflowRunId: 'run-1',
          nodeId: 'publish-research',
          stepReference: 'research.publish@1',
          stepAttempt: 1,
          runner: 'integration',
          command: 'research.publish@1',
          args: [],
          cwd: '/worktrees/front-avia',
          exitCode: 0,
          status: 'completed',
          stdout: '',
          stderr: '',
          details: {
            output: {
              pageId: '301',
              pageUrl: 'https://confluence.example/pages/viewpage.action?pageId=301',
            },
          },
          result: {
            status: 'completed',
            summary: 'Published',
            artifactIds: [],
            transcriptId: null,
          },
          usage: null,
          recordedAt: '2026-08-30T00:00:00.000Z',
        },
      },
      {
        mutationRecovery: {
          inspectCompletion: () => {
            throw new Error('not used');
          },
        },
      },
    );

    expect(result).toEqual({
      evidence: [
        {
          kind: 'effect',
          reference: 'task-step-output:tasker:test:research:publish:artifact',
          reconciled: true,
          remoteIdentity: '301',
        },
      ],
      issues: [],
    });
  });
});
