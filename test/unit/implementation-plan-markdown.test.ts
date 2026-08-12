import { describe, expect, it } from 'vitest';

import { implementationPlanMarkdownFrom } from '../../src/cockpit/implementation-plan-markdown.js';
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
              evidence: ['image'],
              workflowStepIds: ['validate-payment'],
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
  });
});
