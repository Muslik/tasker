import { createHash } from 'node:crypto';

import {
  ExecutionProfileNameSchema,
  ResolvedExecutionProfileSchema,
  type ExecutionProfile,
  type ApiPricingTable,
  type ExecutionProfileRouting,
  type ProjectExecutionProfileOverrides,
  type ResolvedExecutionProfile,
  type TaskExecutionRole,
  type TaskExecutionStrategy,
} from './execution-profile-contracts.js';
import { canonicalJson } from '../shared/json.js';

export interface ExecutionProfileConfiguration {
  readonly executionProfiles: Readonly<Record<string, ExecutionProfile>>;
  readonly executionProfileRouting: ExecutionProfileRouting;
  readonly apiPricing: ApiPricingTable;
}

const resolveNamedProfile = (
  company: ExecutionProfileConfiguration,
  name: string,
): ResolvedExecutionProfile => {
  const parsedName = ExecutionProfileNameSchema.parse(name);
  const profile = company.executionProfiles[parsedName];
  if (profile === undefined) throw new Error(`Unknown execution profile ${parsedName}`);
  const modelPricing = company.apiPricing.models[profile.model];
  const apiPricing =
    modelPricing === undefined
      ? null
      : {
          version: company.apiPricing.version,
          ...modelPricing,
        };
  const configurationSha256 = createHash('sha256')
    .update(canonicalJson({ name: parsedName, ...profile, apiPricing }))
    .digest('hex');
  return ResolvedExecutionProfileSchema.parse({
    name: parsedName,
    ...profile,
    apiPricing,
    configurationSha256,
  });
};

export const resolveWorkflowAnalyzerProfile = (
  company: ExecutionProfileConfiguration,
  project: ProjectExecutionProfileOverrides | null,
  override?: string,
): ResolvedExecutionProfile =>
  resolveNamedProfile(
    company,
    override ?? project?.workflowAnalyzer ?? company.executionProfileRouting.workflowAnalyzer,
  );

export const resolveImplementationPlannerProfile = (
  company: ExecutionProfileConfiguration,
  project: ProjectExecutionProfileOverrides | null,
  strategy: 'fast' | 'ralplan',
  override?: string,
): ResolvedExecutionProfile =>
  resolveNamedProfile(
    company,
    override ??
      project?.implementationPlanner?.[strategy] ??
      company.executionProfileRouting.implementationPlanner[strategy],
  );

export const resolveAgentExecutionProfile = (
  company: ExecutionProfileConfiguration,
  project: ProjectExecutionProfileOverrides | null,
  requestedProfile: string,
  override?: string,
): ResolvedExecutionProfile =>
  resolveNamedProfile(company, override ?? project?.agents?.[requestedProfile] ?? requestedProfile);

export const resolveTaskExecutionProfile = (
  company: ExecutionProfileConfiguration,
  project: ProjectExecutionProfileOverrides | null,
  strategy: TaskExecutionStrategy,
  role: TaskExecutionRole,
): ResolvedExecutionProfile =>
  resolveNamedProfile(
    company,
    project?.taskStrategies?.[strategy]?.[role] ??
      company.executionProfileRouting.taskStrategies[strategy][role],
  );

export const validateExecutionProfileConfiguration = (
  company: ExecutionProfileConfiguration,
  projects: readonly {
    readonly executionProfileOverrides?: ProjectExecutionProfileOverrides | undefined;
  }[],
  agentProfiles: readonly string[],
): void => {
  resolveWorkflowAnalyzerProfile(company, null);
  resolveImplementationPlannerProfile(company, null, 'fast');
  resolveImplementationPlannerProfile(company, null, 'ralplan');
  for (const strategy of ['simple', 'standard', 'complex'] as const) {
    for (const role of ['context', 'implementation', 'verification', 'review'] as const) {
      resolveTaskExecutionProfile(company, null, strategy, role);
    }
  }
  for (const profile of new Set(agentProfiles))
    resolveAgentExecutionProfile(company, null, profile);
  for (const project of projects) {
    const overrides = project.executionProfileOverrides ?? null;
    resolveWorkflowAnalyzerProfile(company, overrides);
    resolveImplementationPlannerProfile(company, overrides, 'fast');
    resolveImplementationPlannerProfile(company, overrides, 'ralplan');
    for (const strategy of ['simple', 'standard', 'complex'] as const) {
      for (const role of ['context', 'implementation', 'verification', 'review'] as const) {
        resolveTaskExecutionProfile(company, overrides, strategy, role);
      }
    }
    for (const profile of Object.values(overrides?.agents ?? {})) {
      resolveAgentExecutionProfile(company, null, profile);
    }
    for (const profile of new Set(agentProfiles)) {
      resolveAgentExecutionProfile(company, overrides, profile);
    }
  }
};
