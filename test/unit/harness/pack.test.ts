import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadHarnessPack, type HarnessStepDefinition } from '../../../src/harness/index.js';
import {
  createHarnessWorkflowContracts,
  getHarnessStepDefinition,
} from '../../../src/planning/index.js';
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
  it('registers a typed company step without changing the workflow compiler', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const analyzerStep = getHarnessStepDefinition('task.analyze@1');
    if (analyzerStep === undefined) throw new Error('Expected task analyzer definition');
    const customStep: HarnessStepDefinition = {
      reference: 'company.custom@1',
      description: 'Produce a company-specific read-only report.',
      retryBudget: 1,
      execution: {
        kind: 'agent',
        prompt: 'prompts/steps/fill-test-ops-plan.md',
        skills: ['company-custom@1'],
      },
      contract: {
        id: 'company.custom',
        version: '1',
        inputSchema: analyzerStep.contract.inputSchema,
        outputSchema: analyzerStep.contract.outputSchema,
        allowedEffects: [],
        requiredCapabilities: ['repository.read'],
        resumeBoundary: 'attempt',
        idempotency: 'none',
        retryPolicy: 'bounded:1',
        activityDelivery: { kind: 'single_attempt' },
        waitKinds: [],
        artifactContracts: ['custom-report'],
        requiredArtifactContracts: [],
        workflowChanges: [],
      },
    };

    const contracts = createHarnessWorkflowContracts([...pack.steps, customStep]);
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
      execution: { kind: 'agent', skills: ['test-ops-planning'] },
      prompt: { relativePath: 'prompts/steps/fill-test-ops-plan.md' },
    });
    expect(stepDefinition?.prompt?.content).toContain('test-operations plan');
    expect(stepDefinition?.prompt?.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('loads company policy blocks and path obligations from files', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));

    expect(pack.steps.map(({ reference }) => reference)).toEqual(
      expect.arrayContaining([
        'ai.assistance.initialize@1',
        'ai.assistance.record_plan@1',
        'ai.assistance.finalize@1',
        'ai.assistance.validate@1',
        'pr.describe@1',
      ]),
    );
    expect(pack.policies).toMatchObject([
      {
        id: 'ai-assistance',
        version: '1',
        obligations: [{ id: 'pr-requires-ai-assistance', kind: 'path_sequence' }],
      },
    ]);
  });

  it('declares Activity redelivery at the step contract boundary', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const deliveryFor = (reference: string) =>
      pack.steps.find((stepDefinition) => stepDefinition.reference === reference)?.contract
        .activityDelivery;

    expect(deliveryFor('code.implement@1')).toEqual({ kind: 'workspace_reconciled' });
    expect(deliveryFor('verify.full@1')).toEqual({ kind: 'workspace_reconciled' });
    expect(deliveryFor('translations.extract@1')).toEqual({ kind: 'single_attempt' });
    expect(deliveryFor('ci.observe@1')).toEqual({ kind: 'read_only' });
    expect(deliveryFor('pr.prepare@1')).toEqual({ kind: 'remote_reconciled' });
    expect(deliveryFor('ai.assistance.initialize@1')).toEqual({
      kind: 'workspace_reconciled',
    });
  });

  it('keeps generic pull-request blocks independent from company AI policy', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const prepare = pack.steps.find(({ reference }) => reference === 'pr.prepare@1');
    const describe = pack.steps.find(({ reference }) => reference === 'pr.describe@1');

    expect(prepare?.contract.requiredArtifactContracts).toEqual(['pull-request-draft']);
    expect(prepare?.contract.requiredArtifactContracts).not.toContain('ai-assistance-compliance');
    expect(describe?.contract.requiredArtifactContracts).toEqual([]);
    expect(describe?.execution).toMatchObject({ kind: 'agent', skills: [] });
  });

  it('removes policy-owned blocks from future packs when the policy is disabled', async () => {
    const root = await createTemporaryPack();
    const policyPath = join(root, 'policies/ai-assistance.json');
    const policy = JSON.parse(await readFile(policyPath, 'utf8')) as { enabled: boolean };
    policy.enabled = false;
    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');

    const pack = loadHarnessPack(root);
    const references = pack.steps.map(({ reference }) => reference);

    expect(pack.policies).toEqual([]);
    expect(references).not.toContain('ai.assistance.initialize@1');
    expect(references).not.toContain('ai.assistance.validate@1');
    expect(references).toContain('pr.describe@1');
    expect(references).toContain('pr.prepare@1');
  });

  it('binds visual evidence guidance only to reproduction and visual verification', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const skillsFor = (reference: string): readonly string[] => {
      const definition = pack.steps.find((candidate) => candidate.reference === reference);
      if (definition?.execution.kind !== 'agent') throw new Error(`Expected agent ${reference}`);
      return definition.execution.skills;
    };

    expect(skillsFor('bug.reproduce@1')).toContain('playwright-demo');
    expect(skillsFor('verify.visual@1')).toContain('playwright-demo');
    expect(skillsFor('verify.targeted@1')).not.toContain('playwright-demo');
    expect(skillsFor('verify.full@1')).not.toContain('playwright-demo');
  });

  it('rejects prompt paths that escape through a symlink or parent traversal', async () => {
    const root = await createTemporaryPack();
    const manifestPath = join(root, 'company.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      systemPrompts: { workflowAnalyzer: string };
    };
    manifest.systemPrompts.workflowAnalyzer = '../outside.md';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    expect(() => loadHarnessPack(root)).toThrow('Expected a path relative to the harness pack');
  });
});
