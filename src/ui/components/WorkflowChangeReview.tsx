import { useState } from 'react';

import type {
  ExecutionRunView,
  OperatorWorkflowContinuation,
} from '../../server/operator-contracts.js';
import { Button } from './ui/button.js';
import { ActionAlert } from './ActionAlert.js';
import { Textarea } from './ui/textarea.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js';

export const WorkflowChangeReview = ({
  run,
  continuation,
  pending,
  error,
  onDecision,
}: {
  readonly run: ExecutionRunView;
  readonly continuation: OperatorWorkflowContinuation & { readonly status: 'awaiting_review' };
  readonly pending: boolean;
  readonly error: unknown;
  readonly onDecision: (decision: 'accept' | 'reject' | 'dismiss', guidance?: string) => void;
}) => {
  const [guidance, setGuidance] = useState('');
  if (run.status !== 'waiting' || run.wait.waitKind !== 'workflow_change.review@1') return null;
  return (
    <section
      aria-label="Workflow continuation review"
      data-testid="workflow-continuation-review"
      className="rounded-xl border border-violet-400/50 bg-card p-4"
    >
      <h2 className="text-sm font-semibold">Review proposed workflow change</h2>
      <p className="mt-2 text-sm text-muted-foreground">{continuation.reason}</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs tabular-nums">
        <div>
          <dt className="text-muted-foreground">Attempt</dt>
          <dd>{continuation.attempt}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Tokens</dt>
          <dd>
            {(
              continuation.usage.inputTokens +
              continuation.usage.outputTokens +
              continuation.usage.reasoningOutputTokens
            ).toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Cost</dt>
          <dd>
            {continuation.usage.apiCost.source === 'unrated'
              ? 'Unrated'
              : `$${continuation.usage.apiCost.amountUsd.toFixed(4)}`}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Continuation</dt>
          <dd className="min-w-0">
            <Tooltip>
              <TooltipTrigger className="block max-w-full truncate">
                {continuation.continuationId}
              </TooltipTrigger>
              <TooltipContent>{continuation.continuationId}</TooltipContent>
            </Tooltip>
          </dd>
        </div>
      </dl>
      <Textarea
        className="mt-3 min-h-20 w-full"
        placeholder="What should the planner change in this workflow?"
        value={guidance}
        disabled={pending}
        onChange={(event) => {
          setGuidance(event.target.value);
        }}
      />
      <div className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending || guidance.trim().length === 0}
          onClick={() => {
            onDecision('reject', guidance.trim());
          }}
        >
          {pending ? 'Sending…' : 'Reject with guidance'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            onDecision('dismiss', 'Dismissed by operator');
          }}
        >
          Dismiss
        </Button>
        <Button
          type="button"
          disabled={pending}
          onClick={() => {
            onDecision('accept');
          }}
        >
          {pending ? 'Accepting…' : 'Accept workflow'}
        </Button>
      </div>
      <ActionAlert error={error} />
    </section>
  );
};
