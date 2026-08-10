import {
  Braces,
  Check,
  ChevronRight,
  CircleDot,
  GitBranch,
  ListTree,
  Pause,
  Repeat2,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useState, type ComponentType } from 'react';

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
};

const statusTone: Readonly<Record<WorkflowNodeStatus, string>> = {
  planned: 'bg-muted-foreground/50',
  running: 'bg-cyan-400',
  waiting: 'bg-amber-400',
  succeeded: 'bg-emerald-400',
  skipped: 'bg-muted-foreground/40',
  failed: 'bg-destructive',
};

const TechnicalNode = ({ node }: { readonly node: WorkflowTechnicalNode }) => {
  const Icon = nodeIcons[node.kind] ?? Braces;

  return (
    <li>
      <Tooltip>
        <TooltipTrigger className="group flex min-h-7 w-full items-center gap-2 rounded px-1.5 text-left hover:bg-muted/60">
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            <Icon className="size-3" />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground group-hover:text-foreground">
            {node.label}
          </span>
          {node.waitKind === undefined ? null : (
            <Pause className="size-3 shrink-0 text-amber-400" aria-label="durable wait" />
          )}
          <span
            className={`size-1.5 shrink-0 rounded-full ${statusTone[node.status]}`}
            aria-label={node.status}
          />
        </TooltipTrigger>
        <TooltipContent side="left" align="center">
          <span className="font-mono">{node.id}</span>
          <span className="text-background/60"> · {node.kind}</span>
          {node.waitKind === undefined ? null : <span> · {node.waitKind}</span>}
        </TooltipContent>
      </Tooltip>
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

const Stage = ({
  stage,
  defaultOpen,
}: {
  readonly stage: OperatorWorkflowStage;
  readonly defaultOpen: boolean;
}) => {
  const active =
    stage.status === 'running' || stage.status === 'waiting' || stage.status === 'failed';
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  return (
    <details
      className="group/stage border-b border-border/70 last:border-b-0"
      data-testid={`workflow-stage-${stage.key}`}
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-2 text-sm hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/stage:rotate-90" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{stage.label}</span>
        <span className="text-[10px] text-muted-foreground">{stage.nodes.length}</span>
        <span
          className={`size-2 shrink-0 rounded-full ${statusTone[stage.status]}`}
          aria-label={`stage ${stage.status}`}
        />
      </summary>
      <ol
        className="mb-2 ml-4 border-l border-border/70 pl-1.5"
        data-testid="workflow-stage-blocks"
      >
        {stage.nodes.map((node) => (
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
    {stages.map((stage, index) => (
      <Stage
        key={stage.key}
        stage={stage}
        defaultOpen={
          stage.status === 'running' ||
          stage.status === 'waiting' ||
          stage.status === 'failed' ||
          (index === 0 && stages.every(({ status }) => status === 'planned'))
        }
      />
    ))}
  </div>
);
