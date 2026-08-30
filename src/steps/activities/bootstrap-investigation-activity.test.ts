import { describe, expect, it } from 'vitest';

import { toBootstrapInvestigationResult } from './bootstrap-investigation-activity.js';

const evidenceBundle = {
  artifactId: 'evidence-bundle:jira:AVIA-12045:r2:investigation',
  checksum: 'a'.repeat(64),
  revision: 2,
};

describe('bootstrap investigation activity', () => {
  it('turns an accepted execution receipt into a completed bootstrap result', () => {
    expect(
      toBootstrapInvestigationResult(
        {
          status: 'completed',
          summary: 'Reproduced the reported 16px spacing defect',
          predicateFacts: { 'bug.reproduced@1': true },
          receiptReference: 'block-receipt:investigation:run-1',
        },
        evidenceBundle,
      ),
    ).toEqual({
      status: 'completed',
      summary: 'Reproduced the reported 16px spacing defect',
      evidenceBundle,
    });
  });

  it('preserves a continuation request without leaking the execution receipt', () => {
    expect(
      toBootstrapInvestigationResult(
        {
          status: 'continuation_required',
          summary: 'The defect belongs to a shared component repository',
          waitKind: 'runtime.observe@1.continuation-required@1',
          requestReference: 'task-step-output:investigation:artifact',
          receiptReference: 'block-receipt:investigation:run-1',
        },
        evidenceBundle,
      ),
    ).toEqual({
      status: 'continuation_required',
      summary: 'The defect belongs to a shared component repository',
      waitKind: 'runtime.observe@1.continuation-required@1',
      requestReference: 'task-step-output:investigation:artifact',
      evidenceBundle,
    });
  });
});
