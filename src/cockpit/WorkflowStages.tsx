import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  GitBranch,
  ListTree,
  Pause,
  Repeat2,
  ShieldCheck,
} from 'lucide-react';
import { useState, type ComponentType } from 'react';

import type {
  OperatorWorkflowStage,
  WorkflowNodeStatus,
  WorkflowTechnicalNode,
} from '../control-plane/m1-contracts.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip.js';

const nodeIcons: Readonly<Record<string, ComponentType<{ className?: string }>>> = {
  sequence: ListTree,
  step: CircleDot,
  branch: GitBranch,
  bounded_loop: Repeat2,
  wait: Pause,
  gate: ShieldCheck,
  finalize: Check,
  bootstrap: CircleDot,
};

const statusTone: Readonly<Record<WorkflowNodeStatus, string>> = {
  planned: 'bg-muted-foreground/50',
  running: 'bg-cyan-400',
  waiting: 'bg-amber-400',
  succeeded: 'bg-emerald-400',
  skipped: 'bg-muted-foreground/40',
  failed: 'bg-destructive',
};

const technicalReference = (node: WorkflowTechnicalNode): string => {
  if (node.details.kind === 'block') return node.details.blockReference;
  if (node.details.kind === 'loop') return `until ${node.details.until}`;
  if (node.waitKind !== undefined) return node.waitKind;
  return node.kind;
};

const evidenceLabel = (
  evidence: Extract<
    WorkflowTechnicalNode['details'],
    { readonly kind: 'block' }
  >['receipts'][number]['evidence'][number],
): string => {
  switch (evidence.kind) {
    case 'artifact':
      return `artifact · ${evidence.artifactKind}`;
    case 'process':
      return `process · exit ${String(evidence.exitCode)}`;
    case 'workspace_mutation':
      return evidence.changed ? 'workspace · changed' : 'workspace · unchanged';
    case 'effect':
      return `effect · ${evidence.remoteIdentity}${evidence.reconciled ? ' · reconciled' : ''}`;
  }
};

const NodeRow = ({ node }: { readonly node: WorkflowTechnicalNode }) => {
  const Icon = nodeIcons[node.kind] ?? Braces;
  const attempts =
    node.details.kind === 'block' || node.details.kind === 'bootstrap' ? node.details.attempts : 0;
  const loop = node.details.kind === 'loop' ? node.details : null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={
              loop === null
                ? 'group flex min-h-7 w-full items-center gap-2 rounded px-1.5 text-left hover:bg-muted/60'
                : 'group flex min-h-8 w-full items-center gap-2 rounded border-l-2 border-primary/60 bg-primary/5 px-1.5 text-left hover:bg-primary/10'
            }
          />
        }
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          <Icon className="size-3" />
        </span>
        <span
          className={
            loop === null
              ? 'min-w-0 flex-1 truncate text-xs text-muted-foreground group-hover:text-foreground'
              : 'min-w-0 flex-1 truncate text-xs font-medium text-foreground'
          }
        >
          {node.label}
        </span>
        {attempts === 0 ? null : (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {attempts} {attempts === 1 ? 'attempt' : 'attempts'}
          </span>
        )}
        {loop === null ? null : (
          <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
            {loop.completedIterations}/{loop.maxAttempts} attempts
          </span>
        )}
        {node.waitKind === undefined ? null : (
          <Pause
            className="size-3 shrink-0 text-amber-600 dark:text-amber-400"
            aria-label="durable wait"
          />
        )}
        <span
          className={`size-1.5 shrink-0 rounded-full ${statusTone[node.status]}`}
          aria-label={node.status}
        />
      </TooltipTrigger>
      <TooltipContent side="left" align="center">
        <span className="font-mono">{node.id}</span>
        <span className="opacity-60"> · {technicalReference(node)}</span>
      </TooltipContent>
    </Tooltip>
  );
};

const TechnicalNode = ({ node }: { readonly node: WorkflowTechnicalNode }) => {
  const receipts = node.details.kind === 'block' ? node.details.receipts : [];

  return (
    <li>
      {receipts.length === 0 ? (
        <NodeRow node={node} />
      ) : (
        <details className="group/node">
          <summary className="flex cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 flex-1">
              <NodeRow node={node} />
            </span>
            <ChevronDown className="mr-1 size-3 shrink-0 text-muted-foreground transition-transform group-open/node:rotate-180" />
          </summary>
          <ol className="mb-1 ml-6 space-y-2 border-l border-border/60 py-1 pl-2">
            {receipts.map((receipt) => (
              <li className="text-[11px] leading-4 text-muted-foreground" key={receipt.receiptId}>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">Attempt {receipt.blockRun}</span>
                  <span>{receipt.verdict}</span>
                  <span>{receipt.claimStatus.replaceAll('_', ' ')}</span>
                </div>
                <p className="mt-0.5">{receipt.summary}</p>
                {receipt.evidence.length === 0 ? null : (
                  <ul className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10px]">
                    {receipt.evidence.map((evidence) => (
                      <li key={`${evidence.kind}:${evidence.reference}`}>
                        {evidenceLabel(evidence)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
      {node.children.length === 0 ? null : (
        <ol className="ml-3 border-l border-border/60 pl-1.5">
          {node.children.map((child) => (
            <TechnicalNode key={child.id} node={child} />
          ))}
        </ol>
      )}
    </li>
  );
};

const Stage = ({ stage }: { readonly stage: OperatorWorkflowStage }) => {
  const loop = stage.presentation.kind === 'loop' ? stage.presentation : null;
  const actionRequired = stage.status === 'waiting';
  const [open, setOpen] = useState(true);
  const visibleNodes =
    loop !== null && stage.nodes.length === 1 && stage.nodes[0]?.details.kind === 'loop'
      ? stage.nodes[0].children
      : stage.nodes;

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
        className={
          actionRequired
            ? 'flex min-h-11 cursor-pointer list-none items-center gap-2 border-l-2 border-amber-500 bg-amber-500/10 px-2 text-sm hover:bg-amber-500/15 [&::-webkit-details-marker]:hidden'
            : loop === null
              ? 'flex min-h-10 cursor-pointer list-none items-center gap-2 px-2 text-sm hover:bg-muted/40 [&::-webkit-details-marker]:hidden'
              : 'flex min-h-11 cursor-pointer list-none items-center gap-2 border-l-2 border-primary/60 bg-primary/5 px-2 text-sm hover:bg-primary/8 [&::-webkit-details-marker]:hidden'
        }
      >
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/stage:rotate-90" />
        {loop === null ? null : <Repeat2 className="size-3.5 shrink-0 text-primary" />}
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
        {loop === null ? (
          <span className="text-[10px] text-muted-foreground">{stage.nodes.length}</span>
        ) : (
          <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
            {loop.completedIterations}/{loop.maxAttempts} attempts
          </span>
        )}
        <span
          className={`size-2 shrink-0 rounded-full ${statusTone[stage.status]}`}
          aria-label={`stage ${stage.status}`}
        />
      </summary>
      <ol
        className={
          loop === null
            ? 'mb-2 ml-4 border-l border-border/70 pl-1.5'
            : 'mb-2 ml-4 border-l-2 border-primary/30 bg-primary/[0.025] py-1 pl-1.5'
        }
        data-testid="workflow-stage-blocks"
      >
        {visibleNodes.map((node) => (
          <TechnicalNode key={node.id} node={node} />
        ))}
      </ol>
    </details>
  );
};

export const WorkflowStages = ({
  stages,
}: {
  readonly stages: readonly OperatorWorkflowStage[];
}) => (
  <div className="border-y border-border/70" data-testid="workflow-stages">
    {stages.map((stage) => (
      <Stage key={stage.key} stage={stage} />
    ))}
  </div>
);
