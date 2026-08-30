import { z } from 'zod';

import { err, ok, type Outcome } from '../shared/outcome.js';

const nonEmptyString = z.string().min(1);

export const WorkflowChangeKindSchema = z.enum([
  'cross_repository_dependency',
  'external_process_required',
  'task_scope_changed',
  'verification_scope_changed',
]);

export type WorkflowChangeKind = z.infer<typeof WorkflowChangeKindSchema>;

export const WorkflowScopeChangeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('cross_repository_dependency'),
      repository: nonEmptyString,
      requestedOutcome: nonEmptyString,
      componentPath: nonEmptyString.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('external_process_required'),
      process: nonEmptyString,
      expectedResult: nonEmptyString,
    })
    .strict(),
  z
    .object({
      kind: z.literal('task_scope_changed'),
      objective: nonEmptyString,
    })
    .strict(),
  z
    .object({
      kind: z.literal('verification_scope_changed'),
      rationale: nonEmptyString,
      requiredProfile: z.enum([
        'build_only',
        'targeted_tests',
        'full_suite',
        'visual_compare',
        'snapshot_update',
        'composed',
      ]),
    })
    .strict(),
]);

export const WorkflowChangeRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    discoveredAtNodeId: nonEmptyString,
    summary: nonEmptyString,
    evidenceArtifactIds: z.array(nonEmptyString).min(1),
    changes: z.array(WorkflowScopeChangeSchema).min(1),
  })
  .strict();

export type WorkflowScopeChange = z.infer<typeof WorkflowScopeChangeSchema>;
export type WorkflowChangeRequest = z.infer<typeof WorkflowChangeRequestSchema>;

export type WorkflowChangeRequestFailure =
  | {
      readonly kind: 'invalid_request';
      readonly issues: readonly string[];
    }
  | {
      readonly kind: 'change_not_declared';
      readonly changeKind: WorkflowChangeKind;
    };

export const parseDeclaredWorkflowChangeRequest = (
  input: unknown,
  allowedKinds: readonly WorkflowChangeKind[],
): Outcome<WorkflowChangeRequest, WorkflowChangeRequestFailure> => {
  const parsed = WorkflowChangeRequestSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      kind: 'invalid_request',
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
      ),
    });
  }

  const allowed = new Set(allowedKinds);
  const undeclared = parsed.data.changes.find((change) => !allowed.has(change.kind));
  return undeclared === undefined
    ? ok(parsed.data)
    : err({ kind: 'change_not_declared', changeKind: undeclared.kind });
};
