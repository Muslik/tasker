import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { z } from 'zod';

import { BlockDefinitionSchema } from '../steps/index.js';
import {
  HarnessCompanyManifestSchema,
  HarnessPolicyManifestSchema,
  HarnessProjectManifestSchema,
  HarnessStepManifestSchema,
  parseVersionedReference,
  type LoadedHarnessPack,
  type LoadedPrompt,
} from './contracts.js';
import { stepDefinitionFromManifest } from './step-contracts.js';
import { toContractReference } from '../graph/index.js';
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

const frontmatter = (content: string): Map<string, string> => {
  const body = /^---\r?\n(?<body>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.groups?.body;
  if (body === undefined) return new Map();
  return new Map(
    body.split(/\r?\n/u).flatMap((line) => {
      const separator = line.indexOf(':');
      return separator < 1 ? [] : [[line.slice(0, separator), line.slice(separator + 1).trim()]];
    }),
  );
};

const validateSubagentDefinitions = (
  root: string,
  profiles: Readonly<Record<string, { readonly claude: string; readonly codex: string }>>,
): void => {
  const agentsRoot = resolvePackPath(root, 'workspace/agents', 'directory');
  const files = readdirSync(agentsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.slice(0, -3));
  const profileRoles = Object.keys(profiles).sort();
  if (files.sort().join('\0') !== profileRoles.join('\0')) {
    throw new Error('Harness subagent profiles must match workspace/agents/*.md');
  }
  for (const role of profileRoles) {
    const metadata = frontmatter(readFileSync(join(agentsRoot, `${role}.md`), 'utf8'));
    if (metadata.get('name') !== role || metadata.get('model') !== profiles[role]?.claude) {
      throw new Error(`Subagent ${role} Claude frontmatter model does not match company.json`);
    }
  }
  const modelsPath = join(agentsRoot, 'models.env');
  const models = new Map<string, string>();
  for (const line of readFileSync(modelsPath, 'utf8').split(/\r?\n/u)) {
    const match = /^TASKER_SUBAGENT_MODEL_(?<role>[A-Z0-9_]+)=(?<model>\S+)$/u.exec(line);
    const role = match?.groups?.role;
    const model = match?.groups?.model;
    if (role !== undefined && model !== undefined) {
      models.set(role.toLowerCase().replaceAll('_', '-'), model);
    }
  }
  for (const role of profileRoles) {
    if (models.get(role) !== profiles[role]?.codex) {
      throw new Error(`Subagent ${role} Codex model does not match company.json`);
    }
  }
};

const loadProjects = (root: string) => {
  const projectsRoot = join(root, 'projects');
  if (!existsSync(projectsRoot)) return [];

  return readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const manifestPath = join(projectsRoot, entry.name, 'project.json');
      return Object.freeze(parseFile(HarnessProjectManifestSchema, manifestPath));
    });
};

const loadStepPackages = (root: string) => {
  const stepsRoot = join(root, 'steps');
  if (!existsSync(stepsRoot)) return [];

  const entries = readdirSync(stepsRoot, { withFileTypes: true });
  const flatManifest = entries.find((entry) => entry.isFile() && entry.name.endsWith('.json'));
  if (flatManifest !== undefined) {
    throw new Error(
      `Harness step manifests must use steps/<step>/step.json packages: steps/${flatManifest.name}`,
    );
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const packageRoot = join(stepsRoot, entry.name);
      const manifestPath = join(packageRoot, 'step.json');
      if (!existsSync(manifestPath)) {
        throw new Error(`Harness step package steps/${entry.name} is missing step.json`);
      }
      return Object.freeze({
        packageRoot,
        step: stepDefinitionFromManifest(parseFile(HarnessStepManifestSchema, manifestPath)),
      });
    });
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
  validateSubagentDefinitions(rootPath, company.subagentProfiles);
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
  const steps = loadStepPackages(rootPath)
    .filter(({ step }) => step.policy === undefined || enabledPolicies.has(step.policy))
    .map(({ packageRoot, step }) => {
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
        step.executor.kind === 'agent'
          ? loadPrompt(
              rootPath,
              relative(rootPath, resolvePackPath(packageRoot, step.executor.prompt, 'file'))
                .split(sep)
                .join('/'),
            )
          : null;
      const executor =
        step.executor.kind === 'agent'
          ? {
              kind: 'agent' as const,
              profile: step.executor.profile,
              strategyRole: step.executor.strategyRole,
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
          schemaVersion: 3,
          reference: step.reference,
          description: step.description,
          stage: step.stage,
          availableDuring: step.availableDuring,
          inputContract: step.inputContract,
          outputContract: step.outputContract,
          ...(step.contract.outputPredicates === undefined
            ? {}
            : { outputPredicates: step.contract.outputPredicates }),
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
  const seenPredicates = new Set(
    steps.flatMap((step) =>
      Object.values(step.block.outputPredicates?.cases ?? {}).flatMap((facts) =>
        Object.keys(facts),
      ),
    ),
  );

  for (const policy of policies) {
    for (const binding of policy.agentSkills) {
      for (const reference of binding.steps) {
        const step = steps.find((candidate) => candidate.reference === reference);
        if (step === undefined) {
          throw new Error(
            `Harness policy ${policy.id}@${policy.version} binds skill ${binding.skill} to unavailable step ${reference}`,
          );
        }
        if (step.block.executor.kind !== 'agent') {
          throw new Error(
            `Harness policy ${policy.id}@${policy.version} binds skill ${binding.skill} to non-agent step ${reference}`,
          );
        }
      }
    }
    for (const obligation of policy.obligations) {
      const markers =
        obligation.kind === 'path_sequence'
          ? [obligation.trigger, ...obligation.ordered]
          : [
              obligation.trigger,
              ...obligation.loops.flatMap(({ requiredSteps }) =>
                requiredSteps.map((reference) => ({ kind: 'step' as const, reference })),
              ),
            ];
      for (const marker of markers) {
        if (marker.kind === 'step' && !seenSteps.has(marker.reference)) {
          throw new Error(
            `Harness policy ${policy.id}@${policy.version} references unavailable step ${marker.reference}`,
          );
        }
      }
      if (obligation.kind === 'feedback_loops') {
        for (const loop of obligation.loops) {
          if (!seenPredicates.has(loop.until)) {
            throw new Error(
              `Harness policy ${policy.id}@${policy.version} references unavailable predicate ${loop.until}`,
            );
          }
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
