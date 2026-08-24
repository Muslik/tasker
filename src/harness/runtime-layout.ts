import { join } from 'node:path';

export const WORKSPACE_HARNESS_DIRECTORY = '.tasker/harness';
export const WORKSPACE_HARNESS_SKILLS_DIRECTORY = `${WORKSPACE_HARNESS_DIRECTORY}/skills`;
export const WORKSPACE_HARNESS_SUPPORT_DIRECTORY = `${WORKSPACE_HARNESS_DIRECTORY}/lib`;
export const WORKSPACE_HARNESS_BIN_DIRECTORY = `${WORKSPACE_HARNESS_DIRECTORY}/bin`;
export const WORKSPACE_HARNESS_MANIFEST_PATH = `${WORKSPACE_HARNESS_DIRECTORY}/manifest.json`;

export const workspaceHarnessSkillsPath = (repositoryPath: string): string =>
  join(repositoryPath, WORKSPACE_HARNESS_SKILLS_DIRECTORY);

export const workspaceHarnessSupportPath = (repositoryPath: string): string =>
  join(repositoryPath, WORKSPACE_HARNESS_SUPPORT_DIRECTORY);

export const workspaceHarnessBinPath = (repositoryPath: string): string =>
  join(repositoryPath, WORKSPACE_HARNESS_BIN_DIRECTORY);
