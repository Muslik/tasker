import type { RetrospectiveStore } from '../../server/index.js';
import type { WorkspaceStore } from '../../workspace/store.js';
import type { LoadedHarnessStep } from '../../harness/index.js';
import type { RetrospectiveAnalyzerResult } from '../../agents/retrospective-analyzer.js';
import type { Outcome } from '../../shared/outcome.js';
import type {
  ExecutionWorkflowActivities,
  RunExecutionRetrospectiveInput,
} from '../../kernel/execution-kernel/contracts.js';

export interface ExecutionRetrospectiveActivityOptions {
  readonly retrospectives: RetrospectiveStore;
  readonly workspaces?: Pick<WorkspaceStore, 'listByTaskReference'>;
  readonly analyzer?: {
    analyze(input: {
      readonly operationId: string;
      readonly taskReference: string;
      readonly repositoryPath: string;
      readonly digest: string;
      readonly promptTemplate: string;
    }): Promise<Outcome<RetrospectiveAnalyzerResult, unknown>>;
  };
  readonly analyzerSteps?: readonly LoadedHarnessStep[];
}

export const createExecutionRetrospectiveActivity = (
  inputOrStore: RetrospectiveStore | ExecutionRetrospectiveActivityOptions,
): Pick<ExecutionWorkflowActivities, 'runExecutionRetrospective'> => {
  const options: ExecutionRetrospectiveActivityOptions =
    'generate' in inputOrStore ? { retrospectives: inputOrStore } : inputOrStore;
  return {
    runExecutionRetrospective: async (input: RunExecutionRetrospectiveInput) => {
      let analyzerOutput: RetrospectiveAnalyzerResult | undefined;
      const step = options.analyzerSteps?.find(
        (candidate) => candidate.reference === 'retrospective.analyze@1',
      );
      const workspace = options.workspaces?.listByTaskReference(input.taskReference);
      const locator =
        workspace?.ok === true
          ? (workspace.value.find((candidate) => candidate.workflowRunId === input.workflowRunId) ??
            workspace.value.reduce<(typeof workspace.value)[number] | undefined>(
              (latest, candidate) =>
                latest === undefined || candidate.preparedAt > latest.preparedAt
                  ? candidate
                  : latest,
              undefined,
            ))
          : undefined;
      if (
        options.analyzer !== undefined &&
        step?.block.executor.kind === 'agent' &&
        locator !== undefined
      ) {
        const digest = options.retrospectives.buildAnalyzerDigest(
          input,
          (options.analyzerSteps ?? []).map((candidate) => ({
            reference: candidate.reference,
            promptFile: candidate.prompt?.relativePath ?? null,
          })),
        );
        try {
          const analyzed = await options.analyzer.analyze({
            operationId: `retrospective:${input.workflowId}:${input.workflowRunId}`,
            taskReference: input.taskReference,
            repositoryPath: locator.path,
            digest,
            promptTemplate: step.prompt?.content ?? '',
          });
          if (analyzed.ok) analyzerOutput = analyzed.value;
        } catch {
          analyzerOutput = undefined;
        }
      }
      const generated = options.retrospectives.generate(input, analyzerOutput?.output);
      return Promise.resolve(
        generated.ok
          ? {
              status: 'ready' as const,
              artifactId: `retrospective:${input.workflowId}:${input.workflowRunId}`,
            }
          : { status: 'failed' as const, reason: generated.error.kind },
      );
    },
  };
};
