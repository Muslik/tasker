import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { z } from 'zod';

import {
  HarnessCompanyManifestSchema,
  HarnessProjectManifestSchema,
  HarnessStepsManifestSchema,
  HarnessWorkflowTemplateSchema,
  type LoadedHarnessPack,
  type LoadedPrompt,
} from './contracts.js';

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
      if (project.workOverlay !== undefined) {
        resolvePackPath(root, project.workOverlay, 'directory');
      }
      return Object.freeze({
        ...project,
        guidance:
          project.workflowGuidance === undefined
            ? null
            : loadPrompt(root, project.workflowGuidance),
      });
    });
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
  const manifest = parseFile(HarnessStepsManifestSchema, join(rootPath, 'steps.json'));
  const projects = loadProjects(rootPath);
  const seenRepositories = new Set<string>();
  for (const project of projects) {
    if (seenRepositories.has(project.repository)) {
      throw new Error(`Duplicate harness project profile for ${project.repository}`);
    }
    seenRepositories.add(project.repository);
  }

  const seenSteps = new Set<string>();
  const steps = manifest.steps.map((step) => {
    if (seenSteps.has(step.reference)) {
      throw new Error(`Duplicate harness step definition for ${step.reference}`);
    }
    seenSteps.add(step.reference);
    return Object.freeze({
      ...step,
      prompt: step.execution.kind === 'agent' ? loadPrompt(rootPath, step.execution.prompt) : null,
    });
  });

  const workflowTemplates = new Map(
    Object.entries(company.workflowTemplates)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([id, relativePath]) =>
          [
            id,
            parseFile(
              HarnessWorkflowTemplateSchema,
              resolvePackPath(rootPath, relativePath, 'file'),
            ),
          ] as const,
      ),
  );

  if (company.workOverlay !== undefined) {
    resolvePackPath(rootPath, company.workOverlay, 'directory');
  }

  return Object.freeze({
    rootPath,
    company,
    steps: Object.freeze(steps),
    projects: Object.freeze(projects),
    workflowTemplates,
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

export const resolveHarnessOverlayPath = (pack: LoadedHarnessPack, relativePath: string): string =>
  resolvePackPath(pack.rootPath, relativePath, 'directory');
