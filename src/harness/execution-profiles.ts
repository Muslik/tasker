import { createHash } from 'node:crypto';

import {
  ExecutionProfileNameSchema,
  ResolvedExecutionProfileSchema,
  type ExecutionProfile,
  type ExecutionProfileRouting,
  type ProjectExecutionProfileOverrides,
  type ResolvedExecutionProfile,
} from './execution-profile-contracts.js';

export interface ExecutionProfileConfiguration {
  readonly executionProfiles: Readonly<Record<string, ExecutionProfile>>;
  readonly executionProfileRouting: ExecutionProfileRouting;
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
};

const resolveNamedProfile = (
  company: ExecutionProfileConfiguration,
  name: string,
): ResolvedExecutionProfile => {
  const parsedName = ExecutionProfileNameSchema.parse(name);
  const profile = company.executionProfiles[parsedName];
  if (profile === undefined) throw new Error(`Unknown execution profile ${parsedName}`);
  const configurationSha256 = createHash('sha256')
    .update(canonicalJson({ name: parsedName, ...profile }))
    .digest('hex');
  return ResolvedExecutionProfileSchema.parse({
    name: parsedName,
    ...profile,
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
  for (const profile of new Set(agentProfiles))
    resolveAgentExecutionProfile(company, null, profile);
  for (const project of projects) {
    const overrides = project.executionProfileOverrides ?? null;
    resolveWorkflowAnalyzerProfile(company, overrides);
    resolveImplementationPlannerProfile(company, overrides, 'fast');
    resolveImplementationPlannerProfile(company, overrides, 'ralplan');
    for (const profile of Object.values(overrides?.agents ?? {})) {
      resolveAgentExecutionProfile(company, null, profile);
    }
    for (const profile of new Set(agentProfiles)) {
      resolveAgentExecutionProfile(company, overrides, profile);
    }
  }
};
