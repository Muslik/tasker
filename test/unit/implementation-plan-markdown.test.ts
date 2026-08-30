import { describe, expect, it } from 'vitest';

import { implementationPlanMarkdownFrom } from '../../src/ui/lib/implementation-plan-markdown.js';
import { ImplementationPlanSchema } from '../../src/planning/implementation-plan.js';

describe('implementation plan Markdown', () => {
  it('renders the typed plan as one canonical review document', () => {
    const plan = ImplementationPlanSchema.parse({
      schemaVersion: 2,
      title: 'Repair payment spacing',
      summary: 'Keep the **payment flow** unchanged.',
      steps: [
        {
          id: 'repair-spacing',
          title: 'Repair spacing',
          objective: 'Change the bounded payment page style.',
          repository: 'front-avia',
          files: ['src/pages/FlightsPay/ui/Pay/Pay.scss'],
          verification: ['Run the targeted payment-page check.'],
        },
      ],
      assumptions: ['The reported scenario remains reproducible.'],
      risks: [{ risk: 'Shared selector', mitigation: 'Keep the diff local.' }],
      acceptanceCriteria: [
        {
          id: 'spacing-restored',
          expected: 'The button has the intended gap.',
          verification: [
            {
              kind: 'runtime_evidence',
              scenario: 'Repeat the payment scenario.',
              evidence: ['image', 'structured_output'],
              workflowStepIds: ['validate-payment'],
            },
            {
              kind: 'automated_test',
              source: 'existing',
              level: 'visual',
              scenario: 'Run the payment screenshot test.',
              workflowStepIds: ['validate-payment'],
            },
            {
              kind: 'inspection',
              target: 'pull request',
              expectation: 'The PR contains only the payment spacing change.',
              workflowStepIds: ['prepare-pr'],
            },
            {
              kind: 'process',
              profile: 'full',
              scenario: 'Complete the repository validation profile.',
              workflowStepIds: ['run-validation'],
            },
          ],
        },
      ],
    });

    const markdown = implementationPlanMarkdownFrom({
      plan,
      strategy: 'fast',
      selectionReason: 'One repository.',
    });

    expect(markdown).toContain(
      'Keep the **payment flow** unchanged.\n\n## Execution steps\n\n### 1. Repair spacing',
    );
    expect(markdown).not.toContain('# Repair payment spacing');
    expect(markdown).toContain('## Acceptance');
    expect(markdown).toContain('**Runtime evidence:** Repeat the payment scenario.');
    expect(markdown).toContain('Artifacts: screenshot and structured result.');
    expect(markdown).toContain('**Existing visual test:** Run the payment screenshot test.');
    expect(markdown).toContain(
      '**Inspect pull request:** The PR contains only the payment spacing change.',
    );
    expect(markdown).toContain(
      '**Full verification:** Complete the repository validation profile.',
    );
    expect(markdown).not.toMatch(/\[(runtime_evidence|process|inspection|automated_test)\]/u);
    expect(markdown).not.toContain('full_with_visual');
  });
});
