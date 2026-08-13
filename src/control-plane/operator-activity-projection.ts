import {
  OperatorActivityEntrySchema,
  type OperatorActivityResponse,
} from './operator-contracts.js';

type OperatorActivityEntry = OperatorActivityResponse['entries'][number];

export type OperatorActivitySources = {
  readonly jira: readonly OperatorActivityEntry[];
  readonly workflow: readonly OperatorActivityEntry[];
  readonly implementationPlanning: readonly OperatorActivityEntry[];
  readonly continuation: readonly OperatorActivityEntry[];
  readonly execution: readonly OperatorActivityEntry[];
};

const IMPLEMENTATION_CANDIDATE_TITLES = new Set([
  'Workflow candidate corrected',
  'Workflow candidate rejected',
]);

const WORKFLOW_CANDIDATE_TITLES = new Set(['Workflow candidate corrected', 'Workflow rejected']);

export const projectOperatorActivity = (
  sources: OperatorActivitySources,
): readonly OperatorActivityEntry[] => {
  const implementationPlanningOwnsCandidateValidation = sources.implementationPlanning.some(
    (entry) => IMPLEMENTATION_CANDIDATE_TITLES.has(entry.title),
  );
  const workflow = implementationPlanningOwnsCandidateValidation
    ? sources.workflow.filter((entry) => !WORKFLOW_CANDIDATE_TITLES.has(entry.title))
    : sources.workflow;
  const deduplicated = new Map<string, OperatorActivityEntry>();

  for (const entry of [
    ...sources.jira,
    ...workflow,
    ...sources.implementationPlanning,
    ...sources.continuation,
    ...sources.execution,
  ]) {
    const key = JSON.stringify([
      entry.occurredAt,
      entry.source,
      entry.level,
      entry.title,
      entry.detail,
      entry.externalUrl ?? null,
    ]);
    if (!deduplicated.has(key)) deduplicated.set(key, entry);
  }

  return [...deduplicated.values()]
    .sort((left, right) => {
      const occurred = left.occurredAt.localeCompare(right.occurredAt);
      if (occurred !== 0) return occurred;
      if (left.sequence !== right.sequence) return left.sequence - right.sequence;
      const source = left.source.localeCompare(right.source);
      if (source !== 0) return source;
      const title = left.title.localeCompare(right.title);
      if (title !== 0) return title;
      return left.detail.localeCompare(right.detail);
    })
    .map((entry, index) => OperatorActivityEntrySchema.parse({ ...entry, sequence: index + 1 }));
};
