import { JsonValueSchema, toContractReference, type JsonValue } from '../workflow/index.js';
import { z } from 'zod';
import { getHarnessPack, harnessPolicyAppliesToTask } from '../harness/index.js';
import { M1_AVAILABLE_CAPABILITIES } from './proposal.js';
import { getHarnessStepDefinition, M1_WORKFLOW_CONTRACTS } from './contracts.js';
import type { TaskFixture } from './fixtures.js';
import {
  resolvePackagePublicationPolicy,
  resolveProjectWorkflowProfile,
} from './project-policies.js';
import { WORKFLOW_OBLIGATIONS } from './obligations.js';
import { resolveWorkspaceRuntimePolicy } from '../workspaces/runtime-policy.js';

export interface WorkflowAnalyzerContext {
  readonly taskSnapshot: JsonValue;
  readonly plannerContext: JsonValue;
}

const inputContract = (schema: z.ZodType): JsonValue =>
  JsonValueSchema.parse(
    z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
    }),
  );

const stepHarnessMetadata = (reference: string) => {
  const source = getHarnessStepDefinition(reference);
  if (source === undefined) return {};

  return {
    description: source.block.description,
    stage: source.block.stage,
    completion: source.block.completion,
    executor:
      source.block.executor.kind === 'agent'
        ? {
            kind: source.block.executor.kind,
            profile: source.block.executor.profile,
            prompt: source.prompt?.relativePath,
            promptSha256: source.prompt?.contentSha256,
            skills: source.block.executor.skills,
          }
        : source.block.executor,
  };
};

export const createWorkflowAnalyzerContext = (
  fixture: TaskFixture,
  taskSnapshot: JsonValue = JsonValueSchema.parse(fixture),
): WorkflowAnalyzerContext => {
  const targetRepository =
    fixture.family === 'shared_component' ? fixture.componentRepository : fixture.repository;
  const publication =
    fixture.family === 'shared_component'
      ? resolvePackagePublicationPolicy(fixture.componentRepository, fixture.componentPath)
      : { kind: 'none' as const };

  const pack = getHarnessPack();
  const policies = pack.policies.filter((policy) => harnessPolicyAppliesToTask(policy, fixture));
  const availableSteps = new Set(
    pack.steps
      .filter((step) => {
        if (step.policy === undefined) return true;
        const owner = pack.policies.find((policy) => policy.id === step.policy);
        return owner !== undefined && harnessPolicyAppliesToTask(owner, fixture);
      })
      .map(({ reference }) => reference),
  );
  const harnessProject = pack.projects.find(
    (candidate) => candidate.repository === targetRepository,
  );
  const workspaceRuntime = resolveWorkspaceRuntimePolicy(pack.company, harnessProject ?? null);

  return {
    taskSnapshot,
    plannerContext: JsonValueSchema.parse({
      availableCapabilities: M1_AVAILABLE_CAPABILITIES,
      harness: {
        companyId: pack.company.id,
        companyVersion: pack.company.version,
        policies: policies.map((policy) => ({
          id: policy.id,
          version: policy.version,
          description: policy.description,
        })),
        rootPath: pack.rootPath,
      },
      policies: {
        workspaceRuntime,
        project: resolveProjectWorkflowProfile(targetRepository),
        projectGuidance:
          harnessProject?.guidance === null || harnessProject?.guidance === undefined
            ? null
            : {
                content: harnessProject.guidance.content,
                path: harnessProject.guidance.relativePath,
                sha256: harnessProject.guidance.contentSha256,
              },
        projectHarnessVersion: harnessProject?.version ?? null,
        publication,
      },
      obligations: [
        ...WORKFLOW_OBLIGATIONS,
        ...policies.flatMap((policy) =>
          policy.obligations.map((obligation) => ({
            ...obligation,
            source: `policy:${policy.id}@${policy.version}`,
          })),
        ),
      ],
      buildingBlocks: {
        nodeKinds: ['sequence', 'step', 'branch', 'bounded_loop', 'wait', 'gate', 'finalize'],
        predicates: M1_WORKFLOW_CONTRACTS.predicates.entries.map((contract) => ({
          reference: toContractReference(contract),
          inputSchema: inputContract(contract.inputSchema),
          ...(contract.description === undefined ? {} : { description: contract.description }),
        })),
        steps: M1_WORKFLOW_CONTRACTS.stepTypes.entries
          .filter((contract) => availableSteps.has(toContractReference(contract)))
          .map((contract) => ({
            reference: toContractReference(contract),
            inputSchema: inputContract(contract.inputSchema),
            outputSchema: inputContract(contract.outputSchema),
            allowedEffects: contract.allowedEffects,
            artifactContracts: contract.artifactContracts,
            requiredArtifactContracts: contract.requiredArtifactContracts,
            requiredCapabilities: contract.requiredCapabilities,
            workflowChanges: contract.workflowChanges,
            ...stepHarnessMetadata(toContractReference(contract)),
          })),
        waits: M1_WORKFLOW_CONTRACTS.waits.entries.map((contract) => ({
          reference: toContractReference(contract),
          artifactContracts: contract.artifactContracts ?? [],
          ...(contract.resolutionSchema === undefined
            ? {}
            : { resolutionSchema: inputContract(contract.resolutionSchema) }),
          ...(contract.resolutionMapping === undefined
            ? {}
            : { resolutionMapping: contract.resolutionMapping }),
          ...(contract.description === undefined ? {} : { description: contract.description }),
        })),
      },
    }),
  };
};
