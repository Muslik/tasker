import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadHarnessPack, materializeHarnessOverlay } from '../../../src/harness/index.js';
import { createHarnessWorkflowContracts } from '../../../src/planning/index.js';
import {
  compileWorkflow,
  defineWorkflow,
  finalize,
  gate,
  sequence,
  step,
} from '../../../src/workflow/index.js';

const temporaryDirectories: string[] = [];

const createTemporaryPack = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'tasker-harness-pack-'));
  temporaryDirectories.push(root);
  await cp(join(process.cwd(), 'harness'), root, { recursive: true });
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('file-backed harness pack', () => {
  it('registers a new versioned step without changing the workflow compiler', async () => {
    const root = await createTemporaryPack();
    const manifestPath = join(root, 'steps.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      steps: Record<string, unknown>[];
    };
    manifest.steps.push({
      reference: 'company.custom@1',
      description: 'Produce a company-specific read-only report.',
      inputKind: 'task',
      allowedEffects: [],
      requiredCapabilities: ['repository.read'],
      resumeBoundary: 'attempt',
      idempotency: 'none',
      retryBudget: 1,
      waitKinds: [],
      artifactContracts: ['custom-report'],
      workflowChanges: [],
      execution: {
        kind: 'agent',
        prompt: 'prompts/steps/fill-test-ops-plan.md',
        skills: ['company-custom@1'],
      },
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const contracts = createHarnessWorkflowContracts(loadHarnessPack(root));
    const result = compileWorkflow({
      source: defineWorkflow({
        id: 'custom-step-workflow',
        version: 1,
        root: sequence('delivery', [
          step('analyze', {
            uses: 'task.analyze@1',
            with: { objective: 'Analyze', repository: 'company/repo', taskId: 'TASK-1' },
          }),
          gate('plan', {
            reason: 'Use the configured plan boundary.',
            resumeWhen: 'plan.approved@1',
            with: { taskId: 'TASK-1' },
          }),
          step('custom', {
            uses: 'company.custom@1',
            with: { objective: 'Produce report', repository: 'company/repo', taskId: 'TASK-1' },
          }),
          finalize('done', { outcome: 'accepted' }),
        ]),
      }),
      contracts,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        graph: { metadata: { references: { stepTypes: ['company.custom@1', 'task.analyze@1'] } } },
      },
    });
  });

  it('loads readable prompts with content hashes and exposes fill-test-ops-plan', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const stepDefinition = pack.steps.find(
      (candidate) => candidate.reference === 'fill-test-ops-plan@1',
    );

    expect(stepDefinition).toMatchObject({
      execution: { kind: 'agent', skills: ['test-ops-planning@1'] },
      prompt: { relativePath: 'prompts/steps/fill-test-ops-plan.md' },
    });
    expect(stepDefinition?.prompt?.content).toContain('test-operations plan');
    expect(stepDefinition?.prompt?.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('materializes company and project overlays idempotently without replacing changed files', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'tasker-worktree-'));
    temporaryDirectories.push(worktree);
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));

    const receipt = await materializeHarnessOverlay(pack, 'twiket/ui-kit', worktree);

    expect(receipt).toMatchObject({
      companyId: 'twiket-frontend',
      companyVersion: '1',
      projectVersion: '1',
      repository: 'twiket/ui-kit',
    });
    expect(receipt.files.map(({ relativePath, source }) => ({ relativePath, source }))).toEqual([
      { relativePath: '.tasker/harness/company.md', source: 'company' },
      { relativePath: '.tasker/harness/project.md', source: 'project' },
    ]);
    await expect(materializeHarnessOverlay(pack, 'twiket/ui-kit', worktree)).resolves.toEqual(
      receipt,
    );
    await writeFile(join(worktree, '.tasker/harness/company.md'), 'operator-owned change\n');
    await expect(materializeHarnessOverlay(pack, 'twiket/ui-kit', worktree)).rejects.toThrow(
      'refuses to replace an existing file',
    );
  });

  it('rejects prompt paths that escape through a symlink or parent traversal', async () => {
    const root = await createTemporaryPack();
    const manifestPath = join(root, 'steps.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      steps: { execution?: { kind?: string; prompt?: string } }[];
    };
    const agentStep = manifest.steps.find((candidate) => candidate.execution?.kind === 'agent');
    if (agentStep?.execution === undefined) throw new Error('Expected an agent step fixture');
    agentStep.execution.prompt = '../outside.md';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    expect(() => loadHarnessPack(root)).toThrow('Expected a path relative to the harness pack');
  });
});
