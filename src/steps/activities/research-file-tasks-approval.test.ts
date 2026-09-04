import { describe, expect, it } from 'vitest';

import type { TaskRunEvidence } from '../../integrations/index.js';
import { authorizeResearchFileTasksExecution } from './research-file-tasks-approval.js';

const evidence: TaskRunEvidence = {
  acceptedPlan: null,
  completedSteps: [
    {
      operationId: 'research:document-review:attempt-1',
      nodeId: 'document-review-research',
      stepReference: 'research.document-review@1',
      status: 'completed',
      summary: 'Changes requested',
      artifactIds: [],
      predicateFacts: { 'research.document_approved@1': false },
      details: {
        output: {
          decision: 'changes_requested',
          documentArtifactId: 'task-step-output:research:draft:1:artifact',
        },
      },
      recordedAt: '2026-08-30T12:00:00.000Z',
    },
    {
      operationId: 'research:document-review:attempt-2',
      nodeId: 'document-review-research',
      stepReference: 'research.document-review@1',
      status: 'completed',
      summary: 'Approved',
      artifactIds: [],
      predicateFacts: { 'research.document_approved@1': true },
      details: {
        output: {
          decision: 'approved',
          documentArtifactId: 'task-step-output:research:draft:2:artifact',
        },
      },
      recordedAt: '2026-08-30T12:05:00.000Z',
    },
  ],
  reviewInputs: [],
};

describe('research task filing authorization', () => {
  it('requires the latest document approval predicate for research task filing', () => {
    expect(authorizeResearchFileTasksExecution('research.file-tasks@1', evidence)).toEqual({
      status: 'authorized',
    });
  });

  it('fails closed when the research document approval predicate is absent', () => {
    expect(
      authorizeResearchFileTasksExecution('research.file-tasks@1', {
        ...evidence,
        completedSteps: evidence.completedSteps.map((step) => ({ ...step, predicateFacts: {} })),
      }),
    ).toEqual({
      status: 'missing_document_approval',
    });
  });
});
