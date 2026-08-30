import { describe, expect, it } from 'vitest';

import type { TaskRunEvidence } from '../../integrations/index.js';
import { resolveResearchFileTasksApproval } from './research-file-tasks-approval.js';

const evidence: TaskRunEvidence = {
  acceptedPlan: null,
  completedSteps: [
    {
      operationId: 'research:publish:attempt-1',
      nodeId: 'publish-research',
      stepReference: 'research.publish@1',
      status: 'completed',
      summary: 'Published',
      artifactIds: [],
      details: {
        output: {
          pageId: '42',
          pageUrl: 'https://confluence.example/pages/viewpage.action?pageId=42',
        },
      },
      recordedAt: '2026-08-30T12:00:00.000Z',
    },
  ],
  reviewInputs: [],
};

describe('research task filing approval', () => {
  it('waits with the published page URL until the operator approves filing', () => {
    expect(resolveResearchFileTasksApproval('research.file-tasks@1', null, evidence)).toEqual({
      status: 'waiting',
      pageUrl: 'https://confluence.example/pages/viewpage.action?pageId=42',
      reason:
        'https://confluence.example/pages/viewpage.action?pageId=42 — прочитайте СА и подтвердите заведение задач',
    });
  });

  it('allows task filing only after the typed approval resolution', () => {
    expect(
      resolveResearchFileTasksApproval(
        'research.file-tasks@1',
        { decision: 'approve', guidance: 'Split the backend task' },
        evidence,
      ),
    ).toEqual({ status: 'approved' });
  });
});
