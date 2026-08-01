import { z } from 'zod';

import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema, type JsonValue } from '../workflow/index.js';
import { WorkflowTemplateIdSchema, type WorkflowTemplateId } from './templates.js';

const DiffPathSchema = z.array(z.union([z.string(), z.number()]));

const AddedDiffEntrySchema = z
  .object({
    after: JsonValueSchema,
    kind: z.literal('added'),
    path: DiffPathSchema,
  })
  .strict();

const RemovedDiffEntrySchema = z
  .object({
    before: JsonValueSchema,
    kind: z.literal('removed'),
    path: DiffPathSchema,
  })
  .strict();

const ChangedDiffEntrySchema = z
  .object({
    after: JsonValueSchema,
    before: JsonValueSchema,
    kind: z.literal('changed'),
    path: DiffPathSchema,
  })
  .strict();

export const GraphDiffEntrySchema = z.discriminatedUnion('kind', [
  AddedDiffEntrySchema,
  ChangedDiffEntrySchema,
  RemovedDiffEntrySchema,
]);

export const GraphDiffArtifactSchema = z
  .object({
    entries: z.array(GraphDiffEntrySchema),
    templateId: WorkflowTemplateIdSchema,
  })
  .strict();

export type GraphDiffEntry = z.infer<typeof GraphDiffEntrySchema>;
export type GraphDiffArtifact = z.infer<typeof GraphDiffArtifactSchema>;

export const GraphDiffFailureSchema = z
  .object({
    code: z.literal('non_json_graph'),
    side: z.enum(['task', 'template']),
  })
  .strict();

export type GraphDiffFailure = z.infer<typeof GraphDiffFailureSchema>;

const isJsonRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const pathOrder = (
  left: readonly (number | string)[],
  right: readonly (number | string)[],
): number => left.map(String).join('/').localeCompare(right.map(String).join('/'));

const compareJson = (
  before: JsonValue,
  after: JsonValue,
  path: readonly (number | string)[],
  entries: GraphDiffEntry[],
): void => {
  if (Object.is(before, after)) {
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const maxLength = Math.max(before.length, after.length);

    for (let index = 0; index < maxLength; index += 1) {
      const hasBefore = index < before.length;
      const hasAfter = index < after.length;

      if (!hasBefore) {
        const value = after[index];
        if (value !== undefined) {
          entries.push({ after: value, kind: 'added', path: [...path, index] });
        }
        continue;
      }

      if (!hasAfter) {
        const value = before[index];
        if (value !== undefined) {
          entries.push({ before: value, kind: 'removed', path: [...path, index] });
        }
        continue;
      }

      const beforeValue = before[index];
      const afterValue = after[index];
      if (beforeValue !== undefined && afterValue !== undefined) {
        compareJson(beforeValue, afterValue, [...path, index], entries);
      }
    }

    return;
  }

  if (isJsonRecord(before) && isJsonRecord(after)) {
    const keys = sortedKeys(before, after);

    for (const key of keys) {
      const hasBefore = Object.hasOwn(before, key);
      const hasAfter = Object.hasOwn(after, key);

      if (!hasBefore) {
        const value = after[key];
        if (value !== undefined) {
          entries.push({ after: value, kind: 'added', path: [...path, key] });
        }
        continue;
      }

      if (!hasAfter) {
        const value = before[key];
        if (value !== undefined) {
          entries.push({ before: value, kind: 'removed', path: [...path, key] });
        }
        continue;
      }

      const beforeValue = before[key];
      const afterValue = after[key];
      if (beforeValue !== undefined && afterValue !== undefined) {
        compareJson(beforeValue, afterValue, [...path, key], entries);
      }
    }

    return;
  }

  entries.push({ after, before, kind: 'changed', path: [...path] });
};

const sortedKeys = (
  left: { readonly [key: string]: JsonValue },
  right: { readonly [key: string]: JsonValue },
): string[] =>
  [...new Set([...Object.keys(left), ...Object.keys(right)])].sort((first, second) =>
    first.localeCompare(second),
  );

export const createWorkflowDiff = (options: {
  readonly task: unknown;
  readonly template: unknown;
  readonly templateId: WorkflowTemplateId;
}): Outcome<GraphDiffArtifact, GraphDiffFailure> => {
  const template = JsonValueSchema.safeParse(options.template);
  if (!template.success) {
    return err({ code: 'non_json_graph', side: 'template' });
  }

  const task = JsonValueSchema.safeParse(options.task);
  if (!task.success) {
    return err({ code: 'non_json_graph', side: 'task' });
  }

  const entries: GraphDiffEntry[] = [];
  compareJson(template.data, task.data, [], entries);
  entries.sort((left, right) => {
    const byPath = pathOrder(left.path, right.path);
    return byPath === 0 ? left.kind.localeCompare(right.kind) : byPath;
  });

  return ok(GraphDiffArtifactSchema.parse({ entries, templateId: options.templateId }));
};
