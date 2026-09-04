import { createHash } from 'node:crypto';

import { z } from 'zod';

import { researchInputSchema } from '../../harness/step-contracts.js';
import { JsonValueSchema, type JsonValue } from '../../graph/schema.js';
import type {
  IntegrationStepAdapter,
  IntegrationStepExecutionRequest,
  IntegrationStepExecutionResult,
  TaskRunStepEvidence,
} from '../execution.js';
import type { ExternalEffectStore, ExternalEffectStoreError } from '../effects.js';
import type { ConfluenceContentPort, ConfluencePage, ConfluencePublishProblem } from './client.js';

const PublishedResearchPageSchema = z
  .object({
    pageId: z.string().min(1),
    pageUrl: z.url(),
  })
  .strict();

const confluencePageIdFrom = (value: string): string | null => {
  if (/^\d+$/u.test(value)) return value;
  const match = /(?:pageId=|\/pages\/)(\d+)/u.exec(value);
  return match?.[1] ?? null;
};

const asJson = (value: unknown): JsonValue => JsonValueSchema.parse(value);

const blocked = (
  kind: Extract<IntegrationStepExecutionResult, { readonly status: 'blocked' }>['kind'],
  summary: string,
  details: unknown,
  artifactIds: readonly string[] = [],
  retryable?: boolean,
): Extract<IntegrationStepExecutionResult, { readonly status: 'blocked' }> => ({
  status: 'blocked',
  kind,
  summary,
  details: asJson(details),
  ...(retryable === undefined ? {} : { retryable }),
  artifactIds,
});

const journalFailure = (
  error: ExternalEffectStoreError,
  artifactIds: readonly string[],
): Extract<IntegrationStepExecutionResult, { readonly status: 'blocked' }> =>
  blocked(
    'unknown_outcome',
    `Confluence publish journal is unavailable: ${error.kind}`,
    error,
    artifactIds,
  );

const problemResult = (
  problem: ConfluencePublishProblem,
  artifactIds: readonly string[],
): Extract<IntegrationStepExecutionResult, { readonly status: 'blocked' }> =>
  blocked(
    problem.kind === 'not_configured' || problem.kind === 'auth_failed'
      ? 'configuration'
      : problem.kind === 'access_blocked' || problem.kind === 'unavailable'
        ? 'infrastructure'
        : problem.kind === 'conflict'
          ? 'remote_conflict'
          : 'invalid_request',
    problem.message,
    problem,
    artifactIds,
    problem.retryable,
  );

const duplicateResult = (
  title: string,
  pages: readonly ConfluencePage[],
  artifactIds: readonly string[],
): Extract<IntegrationStepExecutionResult, { readonly status: 'blocked' }> =>
  blocked(
    'remote_conflict',
    `Multiple Confluence child pages already use the title "${title}"`,
    {
      title,
      pageIds: pages.map(({ pageId }) => pageId),
      pageUrls: pages.map(({ pageUrl }) => pageUrl),
    },
    artifactIds,
    false,
  );

const outputFor = (page: ConfluencePage) =>
  PublishedResearchPageSchema.parse({
    pageId: page.pageId,
    pageUrl: page.pageUrl,
  });

const draftBodyFrom = (details: TaskRunStepEvidence['details']): string | null => {
  if (details === null || Array.isArray(details) || typeof details !== 'object') return null;
  const output = 'output' in details ? details.output : undefined;
  if (output === null || Array.isArray(output) || typeof output !== 'object') return null;
  const record = output as Readonly<Record<string, unknown>>;
  return typeof record.documentStorageHtml === 'string' &&
    record.documentStorageHtml.trim().length > 0
    ? record.documentStorageHtml
    : null;
};

const latestResearchDraftStep = (
  steps: readonly TaskRunStepEvidence[],
): TaskRunStepEvidence | null => {
  let latest: TaskRunStepEvidence | null = null;
  for (const step of steps) {
    if (step.status !== 'completed' || step.stepReference !== 'research.draft@1') continue;
    if (latest === null || step.recordedAt >= latest.recordedAt) {
      latest = step;
    }
  }
  return latest;
};

export class ConfluenceResearchPublishAdapter implements IntegrationStepAdapter {
  public readonly id = 'research.publish@1';

  public constructor(
    private readonly confluence: ConfluenceContentPort,
    private readonly effects: ExternalEffectStore,
  ) {}

  public async execute(
    request: IntegrationStepExecutionRequest,
  ): Promise<IntegrationStepExecutionResult> {
    const parsedInput = researchInputSchema.safeParse(request.stepInput);
    if (!parsedInput.success) {
      return blocked('invalid_request', 'Research publish input is invalid', {
        issues: parsedInput.error.issues.map(
          (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      });
    }

    const rootPageId = confluencePageIdFrom(parsedInput.data.product.confluence.researchRootPageId);
    if (rootPageId === null) {
      return blocked('invalid_request', 'Research publish requires a Confluence root page ID', {
        researchRootPageId: parsedInput.data.product.confluence.researchRootPageId,
      });
    }

    const draftStep = latestResearchDraftStep(request.evidence.completedSteps);
    if (draftStep === null) {
      return blocked(
        'invalid_request',
        'Research publish requires a completed research.draft@1 step',
        {
          completedSteps: request.evidence.completedSteps.map(({ stepReference }) => stepReference),
        },
      );
    }
    const bodyStorage = draftBodyFrom(draftStep.details);
    if (bodyStorage === null) {
      return blocked(
        'invalid_request',
        'Research draft output does not contain a Confluence document body',
        { operationId: draftStep.operationId, stepReference: draftStep.stepReference },
      );
    }

    const title = request.task.title;
    const effectId = 'publish-page';
    const intent = this.effects.prepare({
      operationId: request.operationId,
      effectId,
      effectKind: 'confluence.page.publish',
      identity: {
        rootPageId,
        spaceKey: parsedInput.data.product.confluence.spaceKey,
        title,
        bodySha256: createHash('sha256').update(bodyStorage).digest('hex'),
      },
    });
    const intentArtifactId = this.effects.intentArtifactId(request.operationId, effectId);
    if (!intent.ok) return journalFailure(intent.error, []);
    const artifactIds = [intentArtifactId];

    const priorReceipt = this.effects.readReceipt(request.operationId, effectId);
    if (!priorReceipt.ok) return journalFailure(priorReceipt.error, artifactIds);
    if (priorReceipt.value !== null) {
      const parsed = PublishedResearchPageSchema.safeParse(priorReceipt.value.result);
      if (!parsed.success) {
        return blocked(
          'unknown_outcome',
          'The persisted Confluence publish receipt is invalid',
          { issues: parsed.error.issues.map((issue) => issue.message) },
          artifactIds,
        );
      }
      const reconciled = await this.reconcilePublishedPage({
        artifactIds,
        bodyStorage,
        expectedPageId: parsed.data.pageId,
        rootPageId,
        title,
      });
      if (reconciled.status === 'blocked') return reconciled.result;
      return {
        status: 'completed',
        summary: `Confluence page ${reconciled.page.pageId} is already published`,
        output: outputFor(reconciled.page),
        artifactIds: [
          ...artifactIds,
          this.effects.receiptArtifactId(request.operationId, effectId),
        ],
      };
    }

    request.runtime.heartbeat({ phase: 'confluence', operation: 'probe_child_pages' });
    const before = await this.confluence.findExactChildPages(rootPageId, title);
    if (!before.ok) return problemResult(before.error, artifactIds);
    if (before.value.length > 1) {
      return duplicateResult(title, before.value, artifactIds);
    }

    let writeProblem: ConfluencePublishProblem | null = null;
    if (before.value.length === 0) {
      request.runtime.heartbeat({ phase: 'confluence', operation: 'create_page' });
      const created = await this.confluence.createPage({
        parentPageId: rootPageId,
        title,
        bodyStorage,
        spaceKey: parsedInput.data.product.confluence.spaceKey,
      });
      if (!created.ok) writeProblem = created.error;
    } else {
      const existing = before.value[0];
      if (existing === undefined) {
        return blocked(
          'unknown_outcome',
          'Confluence page probe returned an empty result unexpectedly',
          { rootPageId, title },
          artifactIds,
        );
      }
      if (existing.bodyStorage === bodyStorage) {
        const reconciled = await this.reconcilePublishedPage({
          artifactIds,
          bodyStorage,
          rootPageId,
          title,
        });
        if (reconciled.status === 'blocked') return reconciled.result;
        const receipt = this.effects.recordApplied({
          operationId: request.operationId,
          effectId,
          effectKind: 'confluence.page.publish',
          result: outputFor(reconciled.page),
        });
        if (!receipt.ok) return journalFailure(receipt.error, artifactIds);
        return {
          status: 'completed',
          summary: `Confluence page ${reconciled.page.pageId} published for ${request.task.taskId}`,
          output: outputFor(reconciled.page),
          artifactIds: [
            ...artifactIds,
            this.effects.receiptArtifactId(request.operationId, effectId),
          ],
        };
      }
      request.runtime.heartbeat({ phase: 'confluence', operation: 'update_page' });
      const updated = await this.confluence.updatePage({
        pageId: existing.pageId,
        title,
        bodyStorage,
        spaceKey: existing.spaceKey,
        version: existing.version,
      });
      if (!updated.ok) writeProblem = updated.error;
    }

    const reconciled = await this.reconcilePublishedPage({
      artifactIds,
      bodyStorage,
      rootPageId,
      title,
      writeProblem,
    });
    if (reconciled.status === 'blocked') return reconciled.result;

    const receipt = this.effects.recordApplied({
      operationId: request.operationId,
      effectId,
      effectKind: 'confluence.page.publish',
      result: outputFor(reconciled.page),
    });
    if (!receipt.ok) return journalFailure(receipt.error, artifactIds);

    return {
      status: 'completed',
      summary: `Confluence page ${reconciled.page.pageId} published for ${request.task.taskId}`,
      output: outputFor(reconciled.page),
      artifactIds: [...artifactIds, this.effects.receiptArtifactId(request.operationId, effectId)],
    };
  }

  private async reconcilePublishedPage(input: {
    readonly artifactIds: readonly string[];
    readonly bodyStorage: string;
    readonly expectedPageId?: string;
    readonly rootPageId: string;
    readonly title: string;
    readonly writeProblem?: ConfluencePublishProblem | null;
  }): Promise<
    | { readonly status: 'ready'; readonly page: ConfluencePage }
    | {
        readonly status: 'blocked';
        readonly result: Extract<IntegrationStepExecutionResult, { readonly status: 'blocked' }>;
      }
  > {
    const reconciled = await this.confluence.findExactChildPages(input.rootPageId, input.title);
    if (!reconciled.ok) {
      return {
        status: 'blocked',
        result:
          input.writeProblem === undefined || input.writeProblem === null
            ? problemResult(reconciled.error, input.artifactIds)
            : problemResult(input.writeProblem, input.artifactIds),
      };
    }
    if (reconciled.value.length > 1) {
      return {
        status: 'blocked',
        result: duplicateResult(input.title, reconciled.value, input.artifactIds),
      };
    }

    const page = reconciled.value[0] ?? null;
    if (page === null) {
      return {
        status: 'blocked',
        result:
          input.writeProblem === undefined || input.writeProblem === null
            ? blocked(
                'unknown_outcome',
                'Confluence did not preserve the published page after reconciliation',
                { rootPageId: input.rootPageId, title: input.title },
                input.artifactIds,
              )
            : problemResult(input.writeProblem, input.artifactIds),
      };
    }
    if (input.expectedPageId !== undefined && page.pageId !== input.expectedPageId) {
      return {
        status: 'blocked',
        result: blocked(
          'remote_conflict',
          'The reconciled Confluence page no longer matches the persisted receipt',
          { expectedPageId: input.expectedPageId, actualPageId: page.pageId, title: input.title },
          input.artifactIds,
          false,
        ),
      };
    }
    if (page.bodyStorage !== input.bodyStorage) {
      return {
        status: 'blocked',
        result:
          input.writeProblem === undefined || input.writeProblem === null
            ? blocked(
                'remote_conflict',
                'Confluence page body no longer matches the latest research draft',
                { pageId: page.pageId, title: input.title },
                input.artifactIds,
                false,
              )
            : problemResult(input.writeProblem, input.artifactIds),
      };
    }
    return { status: 'ready', page };
  }
}
