import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  ResearchDocumentReviewResolutionSchema,
  ResearchDocumentReviewWaitDetailsSchema,
} from '../../shared/research-document-review.js';
import type {
  ExecutionRunView,
  OperatorExecutionAttempt,
  OperatorTaskSummary,
  OperatorWorkflowProjection,
  ResearchDocumentReviewCommand,
} from '../../server/operator-contracts.js';
import {
  invalidateTaskQueries,
  reviewResearchDocument,
  taskExecutionAttemptQueryOptions,
} from '../api/index.js';
import {
  clearResearchDocumentReviewDraft,
  researchDocumentReviewDraftKey,
} from '../lib/research-document-review-storage.js';
import { ResearchDocumentReviewEditor } from './ResearchDocumentReviewEditor.js';
import { ActionAlert } from './ActionAlert.js';
import { Button } from './ui/button.js';

type ResearchDocumentReviewWait = Extract<
  NonNullable<OperatorWorkflowProjection['current']>,
  { status: 'waiting' }
> & {
  readonly waitKind: 'research.document-review@1';
  readonly blockRun: number;
};

type ResearchDocumentReviewRun = Extract<ExecutionRunView, { status: 'waiting' }> & {
  readonly wait: Extract<
    Extract<ExecutionRunView, { status: 'waiting' }>['wait'],
    { waitKind: 'research.document-review@1' }
  >;
};

export const ResearchDocumentReviewSurface = ({
  task,
  projection,
  currentRun,
}: {
  readonly task: OperatorTaskSummary;
  readonly projection: OperatorWorkflowProjection;
  readonly currentRun: ExecutionRunView | null;
}) => {
  const reviewWait = isResearchDocumentReviewWait(projection.current) ? projection.current : null;
  const reviewRun = isResearchDocumentReviewRun(currentRun) ? currentRun : null;
  const attempt = useQuery({
    ...(reviewWait === null
      ? taskExecutionAttemptQueryOptions(task.id, { nodeId: 'unselected', blockRun: 1 })
      : taskExecutionAttemptQueryOptions(task.id, {
          nodeId: reviewWait.nodeId,
          blockRun: reviewWait.blockRun,
        })),
    enabled: reviewWait !== null,
  });
  if (reviewWait === null || reviewRun === null) return null;
  return (
    <LoadedSurface
      attempt={attempt.data ?? null}
      error={attempt.error}
      run={reviewRun}
      task={task}
      wait={reviewWait}
      onRetry={() => {
        void attempt.refetch();
      }}
    />
  );
};

const LoadedSurface = ({
  task,
  run,
  wait,
  attempt,
  error,
  onRetry,
}: {
  readonly task: OperatorTaskSummary;
  readonly run: ResearchDocumentReviewRun;
  readonly wait: ResearchDocumentReviewWait;
  readonly attempt: OperatorExecutionAttempt | null;
  readonly error: unknown;
  readonly onRetry: () => void;
}) => {
  const queryClient = useQueryClient();
  const details =
    attempt?.output === null || attempt?.output === undefined
      ? null
      : ResearchDocumentReviewWaitDetailsSchema.safeParse(attempt.output.details);
  const draftKey =
    details !== null && details.success
      ? researchDocumentReviewDraftKey({
          taskReference: task.id,
          runId: run.runId,
          blockRun: wait.blockRun,
          documentArtifactId: details.data.documentArtifactId,
        })
      : null;
  const mutation = useMutation({
    mutationFn: (input: ResearchDocumentReviewCommand) => reviewResearchDocument(task.id, input),
    onSuccess: () => {
      if (draftKey !== null) clearResearchDocumentReviewDraft(draftKey);
    },
    onSettled: () => {
      invalidateTaskQueries(queryClient, task.id, { includeAttempts: true, includeRunLog: true });
    },
  });

  if (error !== null && error !== undefined) {
    return <SurfaceError error={error} onRetry={onRetry} />;
  }
  if (attempt === null) return <SurfaceLoading />;
  if (attempt.output === null)
    return (
      <SurfaceError error={new Error('The review document is unavailable.')} onRetry={onRetry} />
    );
  if (!details?.success)
    return (
      <SurfaceError
        error={new Error('The review document payload is invalid.')}
        onRetry={onRetry}
      />
    );
  if (draftKey === null)
    return (
      <SurfaceError
        error={new Error('The review draft could not be initialized.')}
        onRetry={onRetry}
      />
    );

  return (
    <ResearchDocumentReviewEditor
      key={draftKey}
      draftKey={draftKey}
      details={details.data}
      pending={mutation.isPending}
      error={mutation.error}
      onSubmit={(input) => {
        const resolution = ResearchDocumentReviewResolutionSchema.parse(input);
        mutation.mutate({
          ...resolution,
          expectedRunId: run.runId,
          blockRun: wait.blockRun,
          documentArtifactId: details.data.documentArtifactId,
        });
      }}
    />
  );
};

const SurfaceLoading = () => (
  <section
    aria-label="Research document review"
    className="rounded-xl border border-amber-400/50 bg-card p-4"
  >
    <p className="text-sm text-muted-foreground">Loading the research document…</p>
  </section>
);

const SurfaceError = ({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) => (
  <section
    aria-label="Research document review"
    className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4"
  >
    <ActionAlert error={error} />
    <Button type="button" variant="outline" onClick={onRetry}>
      Retry document
    </Button>
  </section>
);

const isResearchDocumentReviewWait = (
  current: OperatorWorkflowProjection['current'] | null | undefined,
): current is ResearchDocumentReviewWait =>
  current?.status === 'waiting' &&
  current.waitKind === 'research.document-review@1' &&
  current.blockRun !== null;

const isResearchDocumentReviewRun = (
  run: ExecutionRunView | null,
): run is ResearchDocumentReviewRun =>
  run !== null && run.status === 'waiting' && run.wait.waitKind === 'research.document-review@1';
