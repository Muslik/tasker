import { JsonValueSchema, toContractReference, type JsonValue } from '../workflow/index.js';
import { z } from 'zod';
import { getHarnessPack } from '../harness/index.js';
import { M1_AVAILABLE_CAPABILITIES } from './proposal.js';
import { getHarnessStepDefinition, M1_WORKFLOW_CONTRACTS } from './contracts.js';
import type { TaskFixture } from './fixtures.js';
import {
  resolvePackagePublicationPolicy,
  resolveProjectWorkflowProfile,
} from './project-policies.js';
import { WORKFLOW_OBLIGATIONS } from './obligations.js';

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
    description: source.description,
    execution:
      source.execution.kind === 'agent'
        ? {
            kind: source.execution.kind,
            prompt: source.prompt?.relativePath,
            promptSha256: source.prompt?.contentSha256,
            skills: source.execution.skills,
          }
        : source.execution,
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
  const harnessProject = pack.projects.find(
    (candidate) => candidate.repository === targetRepository,
  );

  return {
    taskSnapshot,
    plannerContext: JsonValueSchema.parse({
      availableCapabilities: M1_AVAILABLE_CAPABILITIES,
      harness: {
        companyId: pack.company.id,
        companyVersion: pack.company.version,
        rootPath: pack.rootPath,
      },
      policies: {
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
      obligations: WORKFLOW_OBLIGATIONS,
      buildingBlocks: {
        nodeKinds: ['sequence', 'step', 'branch', 'bounded_loop', 'wait', 'gate', 'finalize'],
        predicates: M1_WORKFLOW_CONTRACTS.predicates.entries.map((contract) => ({
          reference: toContractReference(contract),
          inputSchema: inputContract(contract.inputSchema),
          ...(contract.description === undefined ? {} : { description: contract.description }),
        })),
        steps: M1_WORKFLOW_CONTRACTS.stepTypes.entries.map((contract) => ({
          reference: toContractReference(contract),
          inputSchema: inputContract(contract.inputSchema),
          outputSchema: inputContract(contract.outputSchema),
          allowedEffects: contract.allowedEffects,
          artifactContracts: contract.artifactContracts,
          requiredCapabilities: contract.requiredCapabilities,
          workflowChanges: contract.workflowChanges,
          ...stepHarnessMetadata(toContractReference(contract)),
        })),
        waits: M1_WORKFLOW_CONTRACTS.waits.entries.map((contract) => ({
          reference: toContractReference(contract),
          ...(contract.resolutionSchema === undefined
            ? {}
            : { resolutionSchema: inputContract(contract.resolutionSchema) }),
          ...(contract.description === undefined ? {} : { description: contract.description }),
          ...(contract.slotPolicy === undefined ? {} : { slotPolicy: contract.slotPolicy }),
        })),
      },
    }),
  };
};
