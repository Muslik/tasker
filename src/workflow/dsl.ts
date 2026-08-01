import type { JsonValue, WorkflowSource, WorkflowNodeSource } from './schema.js';

import { WorkflowSourceSchema } from './schema.js';

export const predicate = <Reference extends string>(reference: Reference): Reference => reference;

export const sequence = (
  id: string,
  children: readonly WorkflowNodeSource[],
): WorkflowNodeSource => ({
  kind: 'sequence',
  id,
  children: [...children],
});

export const step = (
  id: string,
  definition: { readonly uses: string; readonly with: JsonValue },
) => ({
  kind: 'step' as const,
  id,
  uses: definition.uses,
  with: definition.with,
});

export const branch = (
  id: string,
  definition: {
    readonly when: string;
    readonly then: WorkflowNodeSource;
    readonly otherwise: WorkflowNodeSource;
  },
): WorkflowNodeSource => ({
  kind: 'branch',
  id,
  when: definition.when,
  then: definition.then,
  otherwise: definition.otherwise,
});

export const bounded_loop = (
  id: string,
  definition: {
    readonly maxAttempts: number;
    readonly until: string;
    readonly body: WorkflowNodeSource;
  },
): WorkflowNodeSource => ({
  kind: 'bounded_loop',
  id,
  maxAttempts: definition.maxAttempts,
  until: definition.until,
  body: definition.body,
});

export const wait = (
  id: string,
  definition: {
    readonly for: string;
    readonly slotPolicy?: 'release' | 'retain';
    readonly resumeAt?: string;
  },
): WorkflowNodeSource => ({
  kind: 'wait',
  id,
  for: definition.for,
  ...(definition.slotPolicy === undefined ? {} : { slotPolicy: definition.slotPolicy }),
  ...(definition.resumeAt === undefined ? {} : { resumeAt: definition.resumeAt }),
});

export const gate = (
  id: string,
  definition: {
    readonly reason: string;
    readonly resumeWhen: string;
    readonly with?: JsonValue;
  },
): WorkflowNodeSource => ({
  kind: 'gate',
  id,
  reason: definition.reason,
  resumeWhen: definition.resumeWhen,
  ...(definition.with === undefined ? {} : { with: definition.with }),
});

export const finalize = (
  id: string,
  definition: { readonly outcome: string },
): WorkflowNodeSource => ({
  kind: 'finalize',
  id,
  outcome: definition.outcome,
});

export const defineWorkflow = <Source extends WorkflowSource>(workflow: Source): Source => {
  WorkflowSourceSchema.parse(workflow);

  return workflow;
};
