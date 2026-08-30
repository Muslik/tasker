import { z } from 'zod';

import { HarnessProductManifestSchema } from '../../shared/product.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';
import type { JsonValue } from '../schema.js';
import type { SemanticStepSource, SemanticWorkflowSource } from '../semantic-schema.js';

export const ResearchArchetypeSchema = z.literal('research');
export const ResearchSegmentsSchema = z.tuple([]);

export const RESEARCH_NODE_IDS = Object.freeze({
  root: 'task-work',
  reviewLoop: 'review-feedback',
  reviewAttempt: 'review-attempt',
  investigate: 'investigate-research',
  draft: 'draft-research',
  review: 'review-research',
  publish: 'publish-research',
  fileTasks: 'file-research-tasks',
});

export const RESEARCH_STEP_REFERENCES = Object.freeze({
  investigate: 'research.investigate@1',
  draft: 'research.draft@1',
  review: 'research.review@1',
  publish: 'research.publish@1',
  fileTasks: 'research.file-tasks@1',
});

export const RESEARCH_REVIEW_ACCEPTED_PREDICATE = 'research.review_accepted@1';

const ResearchTaskSchema = z
  .object({
    reference: z.string().min(1),
    taskId: z.string().min(1),
    repository: z.string().min(1),
  })
  .loose();

export const ResearchProductConfigSchema = HarnessProductManifestSchema;

const ResearchQuestionSchema = z.string().trim().min(1).max(2_000);

const ResearchScaffoldInputSchema = z
  .object({
    task: ResearchTaskSchema,
    objective: z.string().min(1),
    questions: z.array(ResearchQuestionSchema).min(1).max(10),
    product: ResearchProductConfigSchema,
    repositoryReference: z.string().min(1),
    segments: ResearchSegmentsSchema,
    operatorBrief: z.string().max(10_000).nullable().default(null),
  })
  .strict();

export interface ResearchScaffoldFailure {
  readonly kind: 'slot_error';
  readonly issues: readonly string[];
}

const slotFailure = (issues: readonly string[]): Outcome<never, ResearchScaffoldFailure> =>
  err({ kind: 'slot_error', issues });

const step = (
  id: string,
  uses: string,
  withInput: Readonly<Record<string, JsonValue>>,
): SemanticStepSource => ({
  kind: 'step' as const,
  id,
  uses,
  with: withInput,
});

const repositoryAlias = (repositoryReference: string): string =>
  repositoryReference.split('/').at(-1) ?? repositoryReference;

export const scaffoldResearch = (
  inputValue: unknown,
): Outcome<SemanticWorkflowSource, ResearchScaffoldFailure> => {
  const input = ResearchScaffoldInputSchema.safeParse(inputValue);
  if (!input.success) {
    return slotFailure(
      input.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`),
    );
  }

  const task = input.data.task;
  const preparedRepositoryAlias = repositoryAlias(input.data.repositoryReference);
  const primaryRepositoryAlias = repositoryAlias(input.data.product.repositories.primary);
  if (primaryRepositoryAlias !== preparedRepositoryAlias) {
    return slotFailure([
      `Research product primary repository alias ${primaryRepositoryAlias} does not match prepared repository alias ${preparedRepositoryAlias}.`,
    ]);
  }

  const stepInput = {
    objective: input.data.objective,
    questions: input.data.questions,
    product: input.data.product,
    repository: task.repository,
    repositoryReference: input.data.repositoryReference,
    taskId: task.taskId,
    operatorBrief: input.data.operatorBrief,
  } as const;

  return ok({
    schemaVersion: 1,
    id: `research-${task.reference}`,
    version: 1,
    root: {
      kind: 'sequence',
      id: RESEARCH_NODE_IDS.root,
      children: [
        {
          kind: 'bounded_loop',
          id: RESEARCH_NODE_IDS.reviewLoop,
          maxAttempts: 3,
          until: RESEARCH_REVIEW_ACCEPTED_PREDICATE,
          body: {
            kind: 'sequence',
            id: RESEARCH_NODE_IDS.reviewAttempt,
            children: [
              step(RESEARCH_NODE_IDS.investigate, RESEARCH_STEP_REFERENCES.investigate, stepInput),
              step(RESEARCH_NODE_IDS.draft, RESEARCH_STEP_REFERENCES.draft, stepInput),
              step(RESEARCH_NODE_IDS.review, RESEARCH_STEP_REFERENCES.review, stepInput),
            ],
          },
        },
        step(RESEARCH_NODE_IDS.publish, RESEARCH_STEP_REFERENCES.publish, stepInput),
        step(RESEARCH_NODE_IDS.fileTasks, RESEARCH_STEP_REFERENCES.fileTasks, stepInput),
      ],
    },
  });
};
