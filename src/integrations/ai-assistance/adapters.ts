import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { ImplementationPlanSchema } from '../../planning/implementation-plan.js';
import { JsonValueSchema, type JsonValue } from '../../workflow/schema.js';
import type {
  IntegrationStepAdapter,
  IntegrationStepExecutionRequest,
  IntegrationStepExecutionResult,
} from '../execution.js';
import type { ExternalEffectStore, ExternalEffectStoreError } from '../effects.js';
import { PullRequestDraftSchema } from '../pull-request-draft.js';

const AiAssistanceLevelSchema = z.enum([
  'None',
  'Minor Assistance (<25%)',
  'Co-Pilot (25-50%)',
  'Major Contributor (50-80%)',
  'Full Generation (>80%)',
]);

const AiAssistanceConfigurationSchema = z
  .object({
    artifactsRoot: z.string().min(1),
    draftPath: z.string().min(1),
    sectionPath: z.string().min(1),
    defaultLevel: AiAssistanceLevelSchema,
    author: z.string().min(1),
    tools: z.array(z.string().min(1)).min(1),
  })
  .strict();

const AcceptedPlanEvidenceSchema = z
  .object({
    artifactId: z.string().min(1),
    attempt: z.number().int().positive(),
    selectedStrategy: z.enum(['fast', 'ralplan']),
    plan: ImplementationPlanSchema,
  })
  .strict();

const PullRequestInputSchema = z
  .object({
    objective: z.string().min(1),
    repository: z.string().min(1),
    taskId: z.string().min(1),
    draftPath: z.string().min(1),
  })
  .strict();

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex');

const insideWorkspace = (workspacePath: string, relativePath: string): string | null => {
  const path = resolve(workspacePath, relativePath);
  const difference = relative(workspacePath, path);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..')
    ? path
    : null;
};

const readText = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
};

const effectFailure = (
  error: ExternalEffectStoreError,
  artifactIds: readonly string[],
): IntegrationStepExecutionResult => ({
  status: 'blocked',
  kind: 'unknown_outcome',
  summary: `AI-assistance effect journal is unavailable: ${error.kind}`,
  details: JsonValueSchema.parse(error),
  artifactIds,
});

const configurationFor = (
  request: IntegrationStepExecutionRequest,
):
  | { readonly status: 'ready'; readonly value: z.infer<typeof AiAssistanceConfigurationSchema> }
  | { readonly status: 'blocked'; readonly result: IntegrationStepExecutionResult } => {
  const policy = request.policies.find((candidate) => candidate.id === 'ai-assistance');
  if (policy === undefined) {
    return {
      status: 'blocked',
      result: {
        status: 'blocked',
        kind: 'configuration',
        summary: 'The snapshotted ai-assistance policy is unavailable',
        details: { policyId: 'ai-assistance' },
        artifactIds: [],
      },
    };
  }
  const parsed = AiAssistanceConfigurationSchema.safeParse(policy.configuration);
  return parsed.success
    ? { status: 'ready', value: parsed.data }
    : {
        status: 'blocked',
        result: {
          status: 'blocked',
          kind: 'configuration',
          summary: 'The snapshotted ai-assistance policy configuration is invalid',
          details: {
            issues: parsed.error.issues.map(
              (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
            ),
          },
          artifactIds: [],
        },
      };
};

abstract class AiAssistanceAdapterBase implements IntegrationStepAdapter {
  public abstract readonly id: string;

  public constructor(protected readonly effects: ExternalEffectStore) {}

  public abstract execute(
    request: IntegrationStepExecutionRequest,
  ): Promise<IntegrationStepExecutionResult>;

  protected async writeReconciled(
    request: IntegrationStepExecutionRequest,
    effectId: string,
    relativePath: string,
    content: string,
  ): Promise<IntegrationStepExecutionResult> {
    const path = insideWorkspace(request.workspace.path, relativePath);
    if (path === null) {
      return {
        status: 'blocked',
        kind: 'invalid_request',
        summary: 'AI-assistance artifact path escapes the managed worktree',
        details: { relativePath },
        artifactIds: [],
      };
    }
    const contentSha256 = sha256(content);
    const intent = this.effects.prepare({
      operationId: request.operationId,
      effectId,
      effectKind: 'workspace.file.write',
      identity: { relativePath, contentSha256 },
    });
    const intentArtifactId = this.effects.intentArtifactId(request.operationId, effectId);
    if (!intent.ok) return effectFailure(intent.error, []);
    const receiptArtifactId = this.effects.receiptArtifactId(request.operationId, effectId);
    const receipt = this.effects.readReceipt(request.operationId, effectId);
    if (!receipt.ok) return effectFailure(receipt.error, [intentArtifactId]);

    const current = await readText(path);
    if (receipt.value !== null) {
      return current !== null && sha256(current) === contentSha256
        ? {
            status: 'completed',
            summary: `Reconciled ${relativePath}`,
            output: { externalId: relativePath, status: 'ready' },
            artifactIds: [intentArtifactId, receiptArtifactId],
          }
        : {
            status: 'blocked',
            kind: 'remote_conflict',
            summary: `Previously written AI-assistance artifact changed: ${relativePath}`,
            details: { relativePath, expectedSha256: contentSha256 },
            artifactIds: [intentArtifactId, receiptArtifactId],
          };
    }
    if (current !== null && sha256(current) !== contentSha256) {
      return {
        status: 'blocked',
        kind: 'remote_conflict',
        summary: `AI-assistance artifact already exists with different content: ${relativePath}`,
        details: { relativePath, expectedSha256: contentSha256, actualSha256: sha256(current) },
        artifactIds: [intentArtifactId],
      };
    }
    if (current === null) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${sha256(request.operationId).slice(0, 12)}.tmp`;
      await writeFile(temporary, content, 'utf8');
      await rename(temporary, path);
    }
    const applied = this.effects.recordApplied({
      operationId: request.operationId,
      effectId,
      effectKind: 'workspace.file.write',
      result: { relativePath, contentSha256 },
    });
    return applied.ok
      ? {
          status: 'completed',
          summary: `Wrote ${relativePath}`,
          output: { externalId: relativePath, status: 'ready' },
          artifactIds: [intentArtifactId, receiptArtifactId],
        }
      : effectFailure(applied.error, [intentArtifactId]);
  }
}

const renderReadme = (
  request: IntegrationStepExecutionRequest,
  configuration: z.infer<typeof AiAssistanceConfigurationSchema>,
  started: string,
): string => `# ${request.task.taskId}

- Jira: ${request.task.taskId}
- Epic: none
- AI assistance: ${configuration.defaultLevel}
- Tools: ${configuration.tools.join(', ')}
- Author: ${configuration.author}
- Started: ${started.slice(0, 10)}

## Agent contribution

Tasker анализирует задачу, формирует план, выполняет изменения и собирает проверяемые результаты.

## Human contribution

Автор проверяет решения агента, отвечает на блокирующие вопросы и проводит code review.
`;

const renderPlan = (evidence: z.infer<typeof AcceptedPlanEvidenceSchema>): string => {
  const plan = evidence.plan;
  const sections = [
    `# ${plan.title}`,
    '',
    plan.summary,
    '',
    `- Planning strategy: ${evidence.selectedStrategy}`,
    `- Planning attempt: ${String(evidence.attempt)}`,
    `- Source artifact: ${evidence.artifactId}`,
    '',
    '## Steps',
    '',
    ...plan.steps.flatMap((step, index) => [
      `${String(index + 1)}. **${step.title}** — ${step.objective}`,
      `   - Repository: ${step.repository}`,
      `   - Files/search targets: ${step.files.length === 0 ? 'none' : step.files.join(', ')}`,
      `   - Verification: ${step.verification.join('; ')}`,
    ]),
    '',
    '## Assumptions',
    '',
    ...(plan.assumptions.length === 0
      ? ['- none']
      : plan.assumptions.map((assumption) => `- ${assumption}`)),
    '',
    '## Risks',
    '',
    ...(plan.risks.length === 0
      ? ['- none']
      : plan.risks.map((risk) => `- ${risk.risk} — ${risk.mitigation}`)),
    '',
    '## Acceptance criteria',
    '',
    ...plan.acceptanceCriteria.flatMap((criterion) => [
      `- **${criterion.id}** — ${criterion.expected}`,
      ...criterion.verification.map((verification) => {
        const description =
          verification.kind === 'inspection'
            ? `${verification.target}: ${verification.expectation}`
            : verification.scenario;
        return `  - ${verification.kind}: ${description} (${verification.workflowStepIds.join(', ')})`;
      }),
    ]),
    '',
  ];
  return `${sections.join('\n')}\n`;
};

export class AiAssistanceInitializeAdapter extends AiAssistanceAdapterBase {
  public readonly id = 'ai-assistance.initialize@1';

  public async execute(
    request: IntegrationStepExecutionRequest,
  ): Promise<IntegrationStepExecutionResult> {
    const configuration = configurationFor(request);
    if (configuration.status === 'blocked') return configuration.result;
    const path = `${configuration.value.artifactsRoot}/${request.task.taskId}/README.md`;
    return this.writeReconciled(
      request,
      'initialize-readme',
      path,
      renderReadme(request, configuration.value, request.workspace.preparedAt),
    );
  }
}

export class AiAssistanceRecordPlanAdapter extends AiAssistanceAdapterBase {
  public readonly id = 'ai-assistance.record-plan@1';

  public async execute(
    request: IntegrationStepExecutionRequest,
  ): Promise<IntegrationStepExecutionResult> {
    const configuration = configurationFor(request);
    if (configuration.status === 'blocked') return configuration.result;
    const plan = AcceptedPlanEvidenceSchema.safeParse(request.evidence.acceptedPlan);
    if (!plan.success) {
      return {
        status: 'blocked',
        kind: 'invalid_request',
        summary: 'The accepted implementation plan is unavailable for policy recording',
        details: {
          issues: plan.error.issues.map(
            (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
          ),
        },
        artifactIds: [],
      };
    }
    const path = `${configuration.value.artifactsRoot}/${request.task.taskId}/plan.md`;
    return this.writeReconciled(request, 'record-plan', path, renderPlan(plan.data));
  }
}

const missingOrPlaceholder = (content: string | null): boolean =>
  content === null || content.trim().length < 20 || /\b(?:TODO|TBD)\b/iu.test(content);

const levelFrom = (content: string): z.infer<typeof AiAssistanceLevelSchema> | null => {
  const match = /^- AI assistance:\s*(.+)$/mu.exec(content)?.[1]?.trim();
  const parsed = AiAssistanceLevelSchema.safeParse(match);
  return parsed.success ? parsed.data : null;
};

export class AiAssistanceValidateAdapter implements IntegrationStepAdapter {
  public readonly id = 'ai-assistance.validate@1';

  public async execute(
    request: IntegrationStepExecutionRequest,
  ): Promise<IntegrationStepExecutionResult> {
    const configuration = configurationFor(request);
    if (configuration.status === 'blocked') return configuration.result;
    const stepInput = PullRequestInputSchema.safeParse(request.stepInput);
    if (!stepInput.success || stepInput.data.draftPath !== configuration.value.draftPath) {
      return {
        status: 'blocked',
        kind: 'invalid_request',
        summary: 'The pull-request draft path does not match the snapshotted policy',
        details: {
          expectedDraftPath: configuration.value.draftPath,
          receivedDraftPath: stepInput.success ? stepInput.data.draftPath : null,
        },
        artifactIds: [],
      };
    }
    const taskRoot = `${configuration.value.artifactsRoot}/${request.task.taskId}`;
    const paths = {
      readme: `${taskRoot}/README.md`,
      plan: `${taskRoot}/plan.md`,
      result: `${taskRoot}/result.md`,
      verification: `${taskRoot}/verification.md`,
      section: configuration.value.sectionPath,
      draft: configuration.value.draftPath,
    } as const;
    const contents = await Promise.all(
      Object.values(paths).map(async (relativePath) => {
        const path = insideWorkspace(request.workspace.path, relativePath);
        return path === null ? null : readText(path);
      }),
    );
    const byName = Object.fromEntries(
      Object.keys(paths).map((key, index) => [key, contents[index] ?? null]),
    ) as Record<keyof typeof paths, string | null>;
    const issues: string[] = [];
    for (const name of ['readme', 'plan', 'result', 'verification', 'section'] as const) {
      if (missingOrPlaceholder(byName[name]))
        issues.push(`${paths[name]} is missing or incomplete`);
    }
    const readmeLevel = byName.readme === null ? null : levelFrom(byName.readme);
    const sectionLevel = byName.section === null ? null : levelFrom(byName.section);
    if (readmeLevel === null) issues.push('README.md has no valid AI-assistance level');
    if (sectionLevel === null) issues.push('The PR section has no valid AI-assistance level');
    if (readmeLevel !== null && sectionLevel !== null && readmeLevel !== sectionLevel) {
      issues.push('README.md and the PR section declare different AI-assistance levels');
    }
    let draft: z.infer<typeof PullRequestDraftSchema> | null = null;
    if (byName.draft !== null) {
      try {
        const parsed = PullRequestDraftSchema.safeParse(JSON.parse(byName.draft) as unknown);
        if (parsed.success) draft = parsed.data;
      } catch {
        draft = null;
      }
    }
    if (draft === null) issues.push(`${paths.draft} is missing or invalid`);
    if (
      draft !== null &&
      byName.section !== null &&
      !draft.description.includes(byName.section.trim())
    ) {
      issues.push('The pull-request description does not contain the finalized AI section');
    }
    if (draft !== null) {
      const requiredBranchArtifacts = [paths.readme, paths.plan, paths.result, paths.verification];
      const missingBranchArtifacts = requiredBranchArtifacts.filter(
        (path) => !draft.branchArtifacts.includes(path),
      );
      if (missingBranchArtifacts.length > 0) {
        issues.push(
          `The pull-request draft omits required branch artifacts: ${missingBranchArtifacts.join(', ')}`,
        );
      }
    }
    if (issues.length > 0) {
      return {
        status: 'blocked',
        kind: 'invalid_request',
        summary: 'AI-assistance validation failed',
        details: { issues },
        artifactIds: [],
      };
    }
    const output: JsonValue = {
      externalId: `${request.task.taskId}:ai-assistance`,
      status: 'valid',
    };
    return {
      status: 'completed',
      summary: 'AI-assistance artifacts and pull-request section are valid',
      output,
      artifactIds: [],
    };
  }
}
