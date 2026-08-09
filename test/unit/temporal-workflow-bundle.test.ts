import { resolve } from 'node:path';

import { bundleWorkflowCode } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

describe('Temporal workflow bundle', () => {
  it('bundles the workflow module without leaking non-deterministic dependencies', async () => {
    const bundle = await bundleWorkflowCode({
      workflowsPath: resolve('src/temporal/workflows/index.ts'),
    });

    expect(bundle.code.length).toBeGreaterThan(0);
    expect(bundle.code).toContain('bootstrapWorkflowV3');
    expect(bundle.code).toContain('executionWorkflowV2');
    expect(bundle.code).not.toContain('taskWorkflow');
  });
});
