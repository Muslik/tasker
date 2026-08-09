import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { z } from 'zod';

import { BlockDefinitionSchema } from '../blocks/index.js';
import {
  HarnessCompanyManifestSchema,
  HarnessPolicyManifestSchema,
  HarnessProjectManifestSchema,
  HarnessStepManifestSchema,
  parseVersionedReference,
  type LoadedHarnessPack,
  type LoadedPrompt,
} from './contracts.js';
import { stepDefinitionFromManifest, TWIKET_HARNESS_STEPS } from './step-definitions.js';
import { toContractReference } from '../workflow/index.js';
import { validateExecutionProfileConfiguration } from './execution-profiles.js';

const DEFAULT_HARNESS_ROOT = fileURLToPath(new URL('../../harness/', import.meta.url));

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Cannot read harness JSON ${path}`, { cause: error });
  }
};

const formatIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
    .join('; ');

const parseFile = <Output, Input>(schema: z.ZodType<Output, Input>, path: string): Output => {
  const parsed = schema.safeParse(readJson(path));
  if (!parsed.success) {
    throw new Error(`Invalid harness file ${path}: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
};

const insideRoot = (root: string, path: string): boolean => {
  const difference = relative(root, path);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..');
};

const resolvePackPath = (root: string, relativePath: string, expected: 'file' | 'directory') => {
  if (isAbsolute(relativePath)) {
    throw new Error(`Harness path must be relative: ${relativePath}`);
  }
  const candidate = resolve(root, relativePath);
  if (!insideRoot(root, candidate) || !existsSync(candidate)) {
    throw new Error(`Harness path does not exist inside the pack: ${relativePath}`);
  }
  const realCandidate = realpathSync(candidate);
  if (!insideRoot(root, realCandidate)) {
    throw new Error(`Harness path escapes the pack through a symlink: ${relativePath}`);
  }
  const actual = statSync(realCandidate).isDirectory() ? 'directory' : 'file';
  if (actual !== expected) {
    throw new Error(`Harness path ${relativePath} must be a ${expected}`);
  }
  return realCandidate;
};

const loadPrompt = (root: string, relativePath: string): LoadedPrompt => {
  const path = resolvePackPath(root, relativePath, 'file');
  const content = readFileSync(path, 'utf8');
  return Object.freeze({
    content,
    contentSha256: createHash('sha256').update(content).digest('hex'),
    relativePath,
  });
};

const loadProjects = (root: string) => {
  const projectsRoot = join(root, 'projects');
  if (!existsSync(projectsRoot)) return [];

  return readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const manifestPath = join(projectsRoot, entry.name, 'project.json');
      const project = parseFile(HarnessProjectManifestSchema, manifestPath);
      return Object.freeze({
        ...project,
        guidance:
          project.workflowGuidance === undefined
            ? null
            : loadPrompt(root, project.workflowGuidance),
      });
    });
};

const loadStepManifests = (root: string) => {
  const stepsRoot = join(root, 'steps');
  if (!existsSync(stepsRoot)) return [];

  return readdirSync(stepsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) =>
      stepDefinitionFromManifest(parseFile(HarnessStepManifestSchema, join(stepsRoot, entry.name))),
    );
};

const loadPolicies = (root: string) => {
  const policiesRoot = join(root, 'policies');
  if (!existsSync(policiesRoot)) return [];

  const policies = readdirSync(policiesRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => parseFile(HarnessPolicyManifestSchema, join(policiesRoot, entry.name)))
    .filter((policy) => policy.enabled);
  const duplicate = policies.find(
    (policy, index) => policies.findIndex((candidate) => candidate.id === policy.id) !== index,
  );
  if (duplicate !== undefined) throw new Error(`Duplicate harness policy ${duplicate.id}`);
  return policies;
};

export const resolveHarnessRoot = (configuredPath = process.env.TASKER_HARNESS_PATH): string => {
  const root = realpathSync(configuredPath ?? DEFAULT_HARNESS_ROOT);
  if (!statSync(root).isDirectory()) {
    throw new Error(`Harness root is not a directory: ${root}`);
  }
  return root;
};

export const loadHarnessPack = (configuredPath?: string): LoadedHarnessPack => {
  const rootPath = resolveHarnessRoot(configuredPath);
  const company = parseFile(HarnessCompanyManifestSchema, join(rootPath, 'company.json'));
  const projects = loadProjects(rootPath);
  const policies = loadPolicies(rootPath);
  const enabledPolicies = new Set(policies.map(({ id }) => id));
  const seenRepositories = new Set<string>();
  for (const project of projects) {
    if (seenRepositories.has(project.repository)) {
      throw new Error(`Duplicate harness project profile for ${project.repository}`);
    }
    seenRepositories.add(project.repository);
  }

  const seenSteps = new Set<string>();
  const steps = [
    ...TWIKET_HARNESS_STEPS,
    ...loadStepManifests(rootPath).filter(
      (step) => step.policy === undefined || enabledPolicies.has(step.policy),
    ),
  ].map((step) => {
    parseVersionedReference(step.reference);
    if (step.reference !== toContractReference(step.contract)) {
      throw new Error(
        `Harness step reference ${step.reference} does not match its contract ${toContractReference(step.contract)}`,
      );
    }
    if (seenSteps.has(step.reference)) {
      throw new Error(`Duplicate harness step definition for ${step.reference}`);
    }
    seenSteps.add(step.reference);
    if (step.executor.kind === 'process') {
      parseVersionedReference(step.executor.executor);
    }
    if (step.executor.kind === 'integration') {
      parseVersionedReference(step.executor.adapter);
    }
    const prompt =
      step.executor.kind === 'agent' ? loadPrompt(rootPath, step.executor.prompt) : null;
    const executor =
      step.executor.kind === 'agent'
        ? {
            kind: 'agent' as const,
            profile: step.executor.profile,
            prompt: prompt?.content ?? '',
            skills: [...step.executor.skills],
          }
        : step.executor.kind === 'process'
          ? { kind: 'process' as const, executor: step.executor.executor }
          : { kind: 'effect' as const, adapter: step.executor.adapter };
    return Object.freeze({
      reference: step.reference,
      ...(step.policy === undefined ? {} : { policy: step.policy }),
      contract: step.contract,
      block: BlockDefinitionSchema.parse({
        schemaVersion: 2,
        reference: step.reference,
        description: step.description,
        stage: step.stage,
        availableDuring: step.availableDuring,
        inputContract: step.inputContract,
        outputContract: step.outputContract,
        executor,
        allowedCapabilities: step.contract.requiredCapabilities,
        allowedEffects: step.contract.allowedEffects,
        outcomes: step.outcomes,
        completion: step.completion,
        requiredArtifacts: step.contract.requiredArtifactContracts,
        producedArtifacts: step.contract.artifactContracts,
      }),
      prompt,
    });
  });

  validateExecutionProfileConfiguration(
    company,
    projects,
    steps.flatMap((step) =>
      step.block.executor.kind === 'agent' ? [step.block.executor.profile] : [],
    ),
  );

  for (const policy of policies) {
    for (const obligation of policy.obligations) {
      for (const marker of [obligation.trigger, ...obligation.ordered]) {
        if (marker.kind === 'step' && !seenSteps.has(marker.reference)) {
          throw new Error(
            `Harness policy ${policy.id}@${policy.version} references unavailable step ${marker.reference}`,
          );
        }
      }
    }
  }

  return Object.freeze({
    rootPath,
    company,
    steps: Object.freeze(steps),
    policies: Object.freeze(policies),
    projects: Object.freeze(projects),
    prompts: Object.freeze({
      implementationPlanner: loadPrompt(rootPath, company.systemPrompts.implementationPlanner),
      workflowAnalyzer: loadPrompt(rootPath, company.systemPrompts.workflowAnalyzer),
    }),
  });
};

let defaultPack: LoadedHarnessPack | undefined;

export const getHarnessPack = (): LoadedHarnessPack => {
  defaultPack ??= loadHarnessPack();
  return defaultPack;
};
