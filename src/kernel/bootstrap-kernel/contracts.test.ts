import { describe, expect, it } from 'vitest';

import { BootstrapWorkflowInputSchema } from './contracts.js';

describe('bootstrap run settings', () => {
  it('accepts a verbatim operator brief up to ten thousand characters', () => {
    const brief = `  Keep this spacing\n${'x'.repeat(9_980)}`;
    const parsed = BootstrapWorkflowInputSchema.safeParse({
      schemaVersion: 3,
      taskReference: 'jira:AVIA-1',
      settings: {
        planReview: 'required',
        planningStrategy: 'auto',
        operatorBrief: brief,
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.settings.operatorBrief).toBe(brief);
  });

  it('rejects an operator brief over ten thousand characters', () => {
    const parsed = BootstrapWorkflowInputSchema.safeParse({
      schemaVersion: 3,
      taskReference: 'jira:AVIA-1',
      settings: {
        planReview: 'required',
        planningStrategy: 'auto',
        operatorBrief: 'x'.repeat(10_001),
      },
    });

    expect(parsed.success).toBe(false);
  });
});
