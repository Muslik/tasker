import { createHash } from 'node:crypto';

import type {
  HarnessCompanyManifest,
  HarnessProjectManifest,
  WorkspaceRuntime,
} from '../harness/index.js';

export interface ResolvedWorkspaceRuntimePolicy extends WorkspaceRuntime {
  readonly policyHash: string;
}

const mergeById = <Value extends { readonly id: string }>(
  defaults: readonly Value[],
  overrides: readonly Value[],
): readonly Value[] => {
  const values = new Map(defaults.map((value) => [value.id, value]));
  for (const value of overrides) values.set(value.id, value);
  return [...values.values()];
};

export const resolveWorkspaceRuntimePolicy = (
  company: HarnessCompanyManifest,
  project: HarnessProjectManifest | null,
): ResolvedWorkspaceRuntimePolicy => {
  const defaults = company.workspaceRuntime;
  const overrides = project?.workspaceRuntime;
  const policy: WorkspaceRuntime = {
    engine: 'docker',
    image: overrides?.image ?? defaults.image,
    workspaceMountPath: overrides?.workspaceMountPath ?? defaults.workspaceMountPath,
    environment: { ...defaults.environment, ...overrides?.environment },
    bootstrap: [...defaults.bootstrap, ...(overrides?.bootstrap ?? [])],
    cacheVolumes: [...mergeById(defaults.cacheVolumes, overrides?.cacheVolumes ?? [])],
    services: [...mergeById(defaults.services, overrides?.services ?? [])],
  };
  return {
    ...policy,
    policyHash: createHash('sha256').update(JSON.stringify(policy)).digest('hex'),
  };
};
