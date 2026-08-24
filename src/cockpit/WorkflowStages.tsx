import { Bot, ChevronRight, GitBranch, Pause, Terminal } from 'lucide-react';
import { useState } from 'react';

import type {
  OperatorWorkflowStage,
  OperatorWorkflowStep,
  OperatorWorkflowContinuation,
  WorkflowNodeStatus,
} from '../control-plane/operator-contracts.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip.js';

const statusTone: Readonly<Record<WorkflowNodeStatus, string>> = {
  planned: 'bg-muted-foreground/50',
  running: 'bg-cyan-400',
  waiting: 'bg-amber-400',
  succeeded: 'bg-emerald-400',
  skipped: 'bg-muted-foreground/40',
  failed: 'bg-destructive',
};

const usageFor = (steps: readonly OperatorWorkflowStep[]) => {
  const usage = steps.flatMap((step) =>
    step.kind === 'wait' ? [] : step.receipts.flatMap((receipt) => receipt.usage ?? []),
  );
  return {
    tokens: usage.reduce((total, item) => total + item.inputTokens + item.outputTokens, 0),
    durationMs: usage.reduce((total, item) => total + item.durationMs, 0),
    costUsd: usage.reduce(
      (total, item) => total + (item.apiCost.source === 'unrated' ? 0 : item.apiCost.amountUsd),
      0,
    ),
    rated: usage.some((item) => item.apiCost.source !== 'unrated'),
  };
};

const compactTokens = (tokens: number): string =>
  tokens < 1_000 ? String(tokens) : `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;

const compactDuration = (durationMs: number): string =>
  durationMs < 60_000
    ? `${String(Math.round(durationMs / 1_000))}s`
    : `${String(Math.round(durationMs / 60_000))}m`;

const WorkflowStep = ({
  step,
  onSelectAttempt,
}: {
  readonly step: OperatorWorkflowStep;
  readonly onSelectAttempt: ((step: OperatorWorkflowStep, blockRun: number) => void) | undefined;
}) => {
  const Icon = step.kind === 'agent' ? Bot : step.kind === 'process' ? Terminal : Pause;
  const usage = usageFor([step]);
  const selectable = step.kind !== 'wait' && step.attempts > 0 && onSelectAttempt !== undefined;
  return (
    <li>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              className="group flex min-h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-muted/60 disabled:cursor-default"
              type="button"
              disabled={!selectable}
              onClick={() => {
                if (selectable) onSelectAttempt(step, step.attempts);
              }}
            />
          }
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground group-hover:text-foreground">
            {step.label}
          </span>
          {step.kind !== 'wait' && step.attempts > 1 ? (
            <span className="text-[10px] text-muted-foreground">attempt {step.attempts}</span>
          ) : null}
          {usage.tokens > 0 ? (
            <span className="text-[10px] text-muted-foreground">
              {compactTokens(usage.tokens)} tok
            </span>
          ) : null}
          <span
            className={`size-1.5 shrink-0 rounded-full ${statusTone[step.status]}`}
            aria-label={step.status}
          />
        </TooltipTrigger>
        <TooltipContent side="left" align="center">
          <span className="font-mono">{step.reference}</span>
          {step.kind === 'agent' ? (
            <span className="opacity-60">
              {' '}
              · {step.profile}
              {step.skills.length === 0 ? '' : ` · ${step.skills.join(', ')}`}
            </span>
          ) : step.kind === 'process' ? (
            <span className="opacity-60"> · {step.executor}</span>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </li>
  );
};

const StageHeader = ({
  stage,
  expandable,
}: {
  readonly stage: OperatorWorkflowStage;
  readonly expandable: boolean;
}) => {
  const actionRequired = stage.status === 'waiting';
  return (
    <>
      {expandable ? (
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/stage:rotate-90" />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <span
        className={
          actionRequired
            ? 'min-w-0 flex-1 truncate font-semibold text-amber-800 dark:text-amber-200'
            : 'min-w-0 flex-1 truncate font-medium text-foreground'
        }
      >
        {stage.label}
      </span>
      {actionRequired ? (
        <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-800 dark:text-amber-200">
          Action
        </span>
      ) : null}
      <span
        className={`size-2 shrink-0 rounded-full ${statusTone[stage.status]}`}
        aria-label={`stage ${stage.status}`}
      />
    </>
  );
};

const Stage = ({
  stage,
  onSelectAttempt,
}: {
  readonly stage: OperatorWorkflowStage;
  readonly onSelectAttempt: ((step: OperatorWorkflowStep, blockRun: number) => void) | undefined;
}) => {
  const [open, setOpen] = useState(true);
  const headerClass =
    stage.status === 'waiting'
      ? 'flex min-h-11 items-center gap-2 border-l-2 border-amber-500 bg-amber-500/10 px-2 text-sm'
      : 'flex min-h-10 items-center gap-2 px-2 text-sm';

  if (stage.steps.length === 0) {
    return (
      <section
        className="border-b border-border/70 last:border-b-0"
        data-testid={`workflow-stage-${stage.key}`}
      >
        <div className={headerClass}>
          <StageHeader stage={stage} expandable={false} />
        </div>
      </section>
    );
  }

  return (
    <details
      className="group/stage border-b border-border/70 last:border-b-0"
      data-testid={`workflow-stage-${stage.key}`}
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary
        className={`${headerClass} cursor-pointer list-none hover:bg-muted/40 [&::-webkit-details-marker]:hidden`}
      >
        <StageHeader stage={stage} expandable />
      </summary>
      <ol className="mb-2 ml-4 border-l border-border/70 pl-1.5" data-testid="workflow-stage-steps">
        {stage.steps.map((step) => (
          <WorkflowStep key={step.id} step={step} onSelectAttempt={onSelectAttempt} />
        ))}
      </ol>
    </details>
  );
};

export const WorkflowStages = ({
  stages,
  continuation = null,
  onSelectAttempt,
}: {
  readonly stages: readonly OperatorWorkflowStage[];
  readonly continuation?: OperatorWorkflowContinuation | null;
  readonly onSelectAttempt?: (step: OperatorWorkflowStep, blockRun: number) => void;
}) => {
  const usage = usageFor(stages.flatMap((stage) => stage.steps));
  const journeyById = new Map<string, OperatorWorkflowStage>();
  const journeyOrder: string[] = [];
  for (const stage of stages) {
    if (!journeyById.has(stage.id)) journeyOrder.push(stage.id);
    journeyById.set(stage.id, stage);
  }
  const journeyStages = journeyOrder
    .filter((id) => id !== 'complete')
    .flatMap((id) => journeyById.get(id) ?? []);
  const complete = journeyById.get('complete');
  if (complete !== undefined) journeyStages.push(complete);
  const continuationLabel =
    continuation?.status === 'awaiting_review'
      ? 'Additional work proposed'
      : continuation?.status === 'running'
        ? 'Additional work in progress'
        : continuation?.status === 'completed'
          ? 'Additional work completed'
          : 'Additional work';
  return (
    <div className="border-y border-border/70" data-testid="workflow-stages">
      {usage.tokens > 0 ? (
        <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2 text-[10px] text-muted-foreground">
          <span>{compactTokens(usage.tokens)} tokens</span>
          <span>·</span>
          <span>{compactDuration(usage.durationMs)} agent time</span>
          {usage.rated ? (
            <>
              <span>·</span>
              <span>~${usage.costUsd.toFixed(2)} API</span>
            </>
          ) : null}
        </div>
      ) : null}
      {continuation === null || continuation.status === 'completed' ? null : (
        <div
          className="border-b border-primary/25 bg-primary/5 px-3 py-2.5"
          data-testid="workflow-continuation-summary"
        >
          <div className="flex items-center gap-2">
            <GitBranch className="size-3.5 text-primary" />
            <strong className="text-xs">{continuationLabel}</strong>
            <span className="ml-auto text-[10px] text-muted-foreground">
              attempt {continuation.attempt}
            </span>
          </div>
          <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{continuation.reason}</p>
        </div>
      )}
      {journeyStages.map((stage) => (
        <Stage key={stage.key} stage={stage} onSelectAttempt={onSelectAttempt} />
      ))}
    </div>
  );
};
