import type { z } from 'zod';

import { err, ok, type Outcome } from '../../shared/outcome.js';

import { agentStepOutcomeSchema, type AgentStepOutcome } from './block-execution-contracts.js';

export const decodeAgentStepOutcome = (
  envelope: unknown,
  outputSchema: z.ZodType,
): Outcome<
  AgentStepOutcome,
  { readonly kind: 'invalid_agent_outcome'; readonly issues: readonly string[] }
> => {
  const outcome = agentStepOutcomeSchema(outputSchema).safeParse(envelope);
  return outcome.success
    ? ok(outcome.data)
    : err({
        kind: 'invalid_agent_outcome',
        issues: outcome.error.issues.map(
          (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      });
};
