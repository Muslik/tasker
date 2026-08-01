import {
  Braces,
  Check,
  CircleDot,
  GitBranch,
  ListTree,
  Pause,
  Repeat2,
  ShieldCheck,
} from 'lucide-react';
import type { ComponentType } from 'react';

import type { WorkflowTreeNode } from '../control-plane/m1-contracts.js';
import { Badge } from './components/ui/badge.js';
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

const Node = ({ node }: { readonly node: WorkflowTreeNode }) => {
  const Icon = nodeIcons[node.kind] ?? Braces;

  return (
    <li>
      <Tooltip>
        <TooltipTrigger className="group flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-muted/60">
          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
            <Icon className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{node.label}</span>
          {node.retryBudget === null ? null : (
            <Badge variant="ghost" className="h-4 px-1 text-[10px] text-muted-foreground">
              ×{node.retryBudget}
            </Badge>
          )}
          {node.waitKind === undefined ? null : (
            <Pause className="size-3 shrink-0 text-amber-400" aria-label="durable wait" />
          )}
          <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" aria-label="planned" />
        </TooltipTrigger>
        <TooltipContent side="left" align="center">
          <span className="font-mono">{node.id}</span>
          <span className="text-background/60">· {node.kind}</span>
          {node.waitKind === undefined ? null : (
            <span>
              · {node.waitKind} / {node.slotPolicy}
            </span>
          )}
        </TooltipContent>
      </Tooltip>
      {node.children.length === 0 ? null : (
        <ol className="ml-4 border-l border-border/60 pl-2">
          {node.children.map((child) => (
            <Node key={child.id} node={child} />
          ))}
        </ol>
      )}
    </li>
  );
};

export const WorkflowTree = ({ root }: { readonly root: WorkflowTreeNode }) => (
  <ol className="space-y-0.5 py-1" data-testid="workflow-tree">
    <Node node={root} />
  </ol>
);
