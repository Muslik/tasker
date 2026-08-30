import { describe, expect, it } from 'vitest';

import { loadHarnessPack } from '../../harness/index.js';
import { ResearchDocumentReviewWaitDetailsSchema } from '../../shared/research-document-review.js';
import { makePlanningTaskSnapshot } from '../../../test/support/planning.js';
import type { IntegrationStepExecutionRequest } from '../execution.js';
import { ResearchDocumentReviewAdapter } from './research-document-review-adapter.js';

const task = makePlanningTaskSnapshot('avia-14001-translation-component', {
  origin: 'jira',
  reference: 'jira:AVIA-14001',
  title: 'Research page title',
});

const requestFor = (
  input: {
    readonly reviewDecision?: 'accepted' | 'changes_requested';
    readonly waitResolution?: IntegrationStepExecutionRequest['waitResolution'];
  } = {},
): IntegrationStepExecutionRequest => ({
  operationId: 'tasker:test:research:document-review',
  nodeId: 'document-review-research',
  stepReference: 'research.document-review@1',
  taskReference: task.reference,
  task,
  taskSnapshot: { origin: 'jira', issue: { issueKey: task.taskId } },
  stepInput: {
    objective: task.title,
    repository: task.repository,
    taskId: task.taskId,
    questions: ['What must the system analysis establish?'],
    product: {
      id: 'avia',
      title: 'Авиа',
      jiraProjects: ['AVIA'],
      confluence: {
        researchRootPageId: '42',
        spaceKey: 'RND',
      },
      repositories: {
        primary: 'front-avia',
        linked: ['front-components'],
      },
    },
    repositoryReference: task.repository,
  },
  workspace: {
    schemaVersion: 1,
    workspaceId: 'a'.repeat(24),
    taskReference: task.reference,
    workflowId: `tasker:${task.reference}`,
    workflowRunId: 'run-1',
    repository: {
      reference: task.repository,
      sourcePath: '/workspace/front-avia',
      baseBranch: 'master',
      baseCommit: 'c'.repeat(40),
    },
    runnerId: 'test',
    path: '/worktrees/front-avia',
    branch: 'tasker/avia-14001/run-1',
    preparedAt: '2026-08-30T00:00:00.000Z',
  },
  operatorGuidance: null,
  waitResolution: input.waitResolution ?? null,
  evidence: {
    acceptedPlan: null,
    completedSteps: [
      {
        operationId: 'workflow:research:draft:2',
        nodeId: 'draft-research',
        stepReference: 'research.draft@1',
        status: 'completed',
        summary: 'Research document updated',
        artifactIds: ['research-draft:2'],
        predicateFacts: {},
        details: {
          output: {
            documentStorageHtml: '<p>latest draft</p>',
            proposedTasks: [{ title: 'Task 1', description: 'Draft follow-up', team: 'FE' }],
            openQuestions: [],
          },
        },
        recordedAt: '2026-08-30T00:20:00.000Z',
      },
      {
        operationId: 'workflow:research:review:2',
        nodeId: 'review-research',
        stepReference: 'research.review@1',
        status: 'completed',
        summary: 'Research review complete',
        artifactIds: ['research-review:2'],
        predicateFacts: {},
        details: {
          output:
            input.reviewDecision === 'changes_requested'
              ? {
                  decision: 'changes_requested',
                  concreteEdits: [{ section: 'Как сейчас', change: 'Добавить source.' }],
                }
              : { decision: 'accepted', concreteEdits: [] },
        },
        recordedAt: '2026-08-30T00:21:00.000Z',
      },
    ],
    reviewInputs: [],
  },
  policies: loadHarnessPack().policies,
  project: null,
  trackerStatusUpdates: 'enabled',
  runtime: {
    attempt: 1,
    cancellationSignal: new AbortController().signal,
    heartbeat: () => {},
  },
});

describe('research document review adapter', () => {
  const adapter = new ResearchDocumentReviewAdapter();

  it('opens an operator review wait only after the agent review accepts the draft', async () => {
    const result = await adapter.execute(requestFor());

    expect(result).toMatchObject({
      status: 'waiting',
      waitKind: 'research.document-review@1',
      category: 'authorization',
      retryable: false,
      artifactIds: ['task-step-output:workflow:research:draft:2:artifact'],
    });
    if (result.status !== 'waiting') return;
    expect(ResearchDocumentReviewWaitDetailsSchema.parse(result.details)).toEqual({
      kind: 'research_document_review',
      documentArtifactId: 'task-step-output:workflow:research:draft:2:artifact',
      documentStorageHtml: '<p>latest draft</p>',
    });
  });

  it('skips the operator wait when the agent review already requested changes', async () => {
    const result = await adapter.execute(requestFor({ reviewDecision: 'changes_requested' }));

    expect(result).toMatchObject({
      status: 'completed',
      artifactIds: ['task-step-output:workflow:research:draft:2:artifact'],
      output: {
        decision: 'changes_requested',
        documentArtifactId: 'task-step-output:workflow:research:draft:2:artifact',
      },
    });
  });

  it('completes with approval after the operator approves the draft', async () => {
    const result = await adapter.execute(requestFor({ waitResolution: { decision: 'approve' } }));

    expect(result).toMatchObject({
      status: 'completed',
      artifactIds: ['task-step-output:workflow:research:draft:2:artifact'],
      output: {
        decision: 'approved',
        documentArtifactId: 'task-step-output:workflow:research:draft:2:artifact',
      },
    });
  });

  it('completes with changes requested after the operator requests revisions', async () => {
    const result = await adapter.execute(
      requestFor({
        waitResolution: {
          decision: 'request_changes',
          guidance: 'Уточнить ограничения',
          annotations: [{ quote: 'latest draft', note: 'Нужна конкретика.' }],
        },
      }),
    );

    expect(result).toMatchObject({
      status: 'completed',
      artifactIds: ['task-step-output:workflow:research:draft:2:artifact'],
      output: {
        decision: 'changes_requested',
        documentArtifactId: 'task-step-output:workflow:research:draft:2:artifact',
      },
    });
  });
});
