import { z } from 'zod';

import type { LedgerRepository } from '../ledger/repository.js';
import { TaskStepOutputArtifactSchema } from '../temporal/task-step-output.js';
import { OperatorActivityEntrySchema, type OperatorActivityResponse } from './m1-contracts.js';

const ArtifactPointerSchema = z.object({ artifactId: z.string().min(1) }).strict();

const JenkinsEvidenceSchema = z
  .object({
    build: z
      .object({
        url: z.httpUrl(),
      })
      .loose(),
  })
  .loose();

const jenkinsEvidenceFrom = (details: unknown): z.infer<typeof JenkinsEvidenceSchema> | null => {
  const direct = JenkinsEvidenceSchema.safeParse(details);
  if (direct.success) return direct.data;
  const wrapped = z.object({ output: JenkinsEvidenceSchema }).loose().safeParse(details);
  if (wrapped.success) return wrapped.data.output;
  const blocked = z.object({ details: JenkinsEvidenceSchema }).loose().safeParse(details);
  return blocked.success ? blocked.data.details : null;
};

export interface ExecutionActivityReader {
  readActivity(taskReference: string): OperatorActivityResponse['entries'];
}

export class LedgerExecutionActivityReader implements ExecutionActivityReader {
  public constructor(private readonly ledger: LedgerRepository) {}

  public readActivity(taskReference: string): OperatorActivityResponse['entries'] {
    const prefix = `task-step-output:tasker:${taskReference}:`;
    return this.ledger
      .listEvents()
      .filter(
        (event) =>
          event.eventType === 'TaskStepOutputRecorded' && event.aggregateId.startsWith(prefix),
      )
      .flatMap((event) => {
        const pointer = ArtifactPointerSchema.safeParse(event.payload);
        const artifact = pointer.success ? this.ledger.readArtifact(pointer.data.artifactId) : null;
        const output =
          artifact === null ? null : TaskStepOutputArtifactSchema.safeParse(artifact.payload);
        if (output === null || !output.success || output.data.stepReference !== 'ci.observe@1') {
          return [];
        }
        const evidence = jenkinsEvidenceFrom(output.data.details);
        return [
          OperatorActivityEntrySchema.parse({
            sequence: event.sequence,
            occurredAt: event.occurredAt,
            source: 'tool',
            level: output.data.status === 'completed' ? 'info' : 'warning',
            title: output.data.result?.summary ?? 'Jenkins observation recorded',
            detail:
              output.data.status === 'completed'
                ? 'Jenkins verified the exact commit prepared by this task.'
                : 'The task is paused with its completed work preserved. Resume it after the CI condition is resolved.',
            ...(evidence === null ? {} : { externalUrl: evidence.build.url }),
          }),
        ];
      });
  }
}
