import { JsonValueSchema, toContractReference, type JsonValue } from '../workflow/index.js';
import { z } from 'zod';
import {
  applyHarnessPolicySkills,
  getHarnessPack,
  harnessPolicyAppliesToTask,
  type HarnessPolicyManifest,
} from '../harness/index.js';
import { HARNESS_AVAILABLE_CAPABILITIES } from './proposal.js';
import { getHarnessStepDefinition, HARNESS_WORKFLOW_CONTRACTS } from './contracts.js';
import type { PlanningTaskSnapshot } from './task-snapshot.js';
import { resolveProjectWorkflowProfile } from './project-policies.js';
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

const stepHarnessMetadata = (reference: string, policies: readonly HarnessPolicyManifest[]) => {
  const source = getHarnessStepDefinition(reference);
  if (source === undefined) return {};
  const block = applyHarnessPolicySkills(source.block, reference, policies);

  return {
    availableDuring: block.availableDuring,
    description: block.description,
    stage: block.stage,
    completion: block.completion,
    executor:
      block.executor.kind === 'agent'
        ? {
            kind: block.executor.kind,
            profile: block.executor.profile,
            prompt: source.prompt?.relativePath,
            promptSha256: source.prompt?.contentSha256,
            skills: block.executor.skills,
          }
        : block.executor,
  };
};

export const createWorkflowAnalyzerContext = (
  task: PlanningTaskSnapshot,
  taskSnapshot: JsonValue = JsonValueSchema.parse(task),
): WorkflowAnalyzerContext => {
  const targetRepository = task.repository;
  const publication = { kind: 'none' as const };

  const pack = getHarnessPack();
  const policies = pack.policies.filter((policy) => harnessPolicyAppliesToTask(policy, task));
  const harnessProject = pack.projects.find(
    (candidate) => candidate.repository === targetRepository,
  );
  const availableSteps = new Set(
    pack.steps
      .filter((step) => {
        if (step.policy !== undefined) {
          const owner = pack.policies.find((policy) => policy.id === step.policy);
          if (owner === undefined || !harnessPolicyAppliesToTask(owner, task)) return false;
        }
        if (step.block.executor.kind !== 'process') return true;
        return (
          harnessProject?.processCommands[step.block.executor.executor] !== undefined ||
          pack.company.processCommands[step.block.executor.executor] !== undefined
        );
      })
      .map(({ reference }) => reference),
  );
  const workspaceRuntime = resolveWorkspaceRuntimePolicy(pack.company, harnessProject ?? null);

  return {
    taskSnapshot,
    plannerContext: JsonValueSchema.parse({
      availableCapabilities: HARNESS_AVAILABLE_CAPABILITIES,
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
        projectHarnessVersion: harnessProject?.version ?? null,
        publication,
      },
      obligations: policies.flatMap((policy) =>
        policy.obligations.map((obligation) => ({
          ...obligation,
          source: `policy:${policy.id}@${policy.version}`,
        })),
      ),
      buildingBlocks: {
        nodeKinds: ['sequence', 'step', 'branch', 'bounded_loop', 'wait', 'gate', 'finalize'],
        predicates: HARNESS_WORKFLOW_CONTRACTS.predicates.entries.map((contract) => ({
          reference: toContractReference(contract),
          inputSchema: inputContract(contract.inputSchema),
          ...(contract.description === undefined ? {} : { description: contract.description }),
        })),
        steps: HARNESS_WORKFLOW_CONTRACTS.stepTypes.entries
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
            ...(contract.outputPredicates === undefined
              ? {}
              : { outputPredicates: contract.outputPredicates }),
            ...stepHarnessMetadata(toContractReference(contract), policies),
          })),
        waits: HARNESS_WORKFLOW_CONTRACTS.waits.entries.map((contract) => ({
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
