import { JsonValueSchema, toContractReference, type JsonValue } from '../workflow/index.js';
import { M1_AVAILABLE_CAPABILITIES } from './proposal.js';
import { M1_WORKFLOW_CONTRACTS } from './contracts.js';
import type { TaskFixture } from './fixtures.js';
import {
  resolvePackagePublicationPolicy,
  resolveProjectWorkflowProfile,
} from './project-policies.js';
import { getBaseWorkflowTemplate, selectWorkflowTemplate } from './templates.js';

export interface WorkflowAnalyzerContext {
  readonly taskSnapshot: JsonValue;
  readonly plannerContext: JsonValue;
}

export const createWorkflowAnalyzerContext = (fixture: TaskFixture): WorkflowAnalyzerContext => {
  const targetRepository =
    fixture.family === 'shared_component' ? fixture.componentRepository : fixture.repository;
  const publication =
    fixture.family === 'shared_component'
      ? resolvePackagePublicationPolicy(fixture.componentRepository, fixture.componentPath)
      : { kind: 'none' as const };

  return {
    taskSnapshot: JsonValueSchema.parse(fixture),
    plannerContext: JsonValueSchema.parse({
      availableCapabilities: M1_AVAILABLE_CAPABILITIES,
      baseTemplate: getBaseWorkflowTemplate(selectWorkflowTemplate(fixture)),
      policies: {
        project: resolveProjectWorkflowProfile(targetRepository),
        publication,
      },
      contracts: {
        predicates: M1_WORKFLOW_CONTRACTS.predicates.entries.map((contract) => ({
          reference: toContractReference(contract),
          ...(contract.description === undefined ? {} : { description: contract.description }),
        })),
        steps: M1_WORKFLOW_CONTRACTS.stepTypes.entries.map((contract) => ({
          reference: toContractReference(contract),
          allowedEffects: contract.allowedEffects,
          artifactContracts: contract.artifactContracts,
          requiredCapabilities: contract.requiredCapabilities,
          workflowChanges: contract.workflowChanges,
        })),
        waits: M1_WORKFLOW_CONTRACTS.waits.entries.map((contract) => ({
          reference: toContractReference(contract),
          ...(contract.description === undefined ? {} : { description: contract.description }),
          ...(contract.slotPolicy === undefined ? {} : { slotPolicy: contract.slotPolicy }),
        })),
      },
    }),
  };
};
