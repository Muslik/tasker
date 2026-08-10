import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadHarnessPack } from '../../../src/harness/index.js';
import {
  createHarnessWorkflowContracts,
  getHarnessStepDefinition,
} from '../../../src/planning/index.js';
import {
  compileWorkflow,
  defineWorkflow,
  finalize,
  sequence,
  step,
  type StepTypeContract,
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
    const baseStep = getHarnessStepDefinition('code.implement@1');
    if (baseStep === undefined) throw new Error('Expected implementation definition');
    const customStep: { readonly reference: string; readonly contract: StepTypeContract } = {
      reference: 'company.custom@1',
      contract: {
        id: 'company.custom',
        version: '1',
        inputSchema: baseStep.contract.inputSchema,
        outputSchema: baseStep.contract.outputSchema,
        allowedEffects: [],
        requiredCapabilities: ['repository.read'],
        resumeBoundary: 'attempt',
        idempotency: 'none',
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
        graph: { metadata: { references: { stepTypes: ['company.custom@1'] } } },
      },
    });
  });

  it('rejects a block output mapping to an unregistered workflow predicate', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const baseStep = getHarnessStepDefinition('review.agent@1');
    if (baseStep === undefined) throw new Error('Expected review definition');

    expect(() =>
      createHarnessWorkflowContracts([
        ...pack.steps,
        {
          reference: 'company.invalid-output@1',
          contract: {
            ...baseStep.contract,
            id: 'company.invalid-output',
            outputPredicates: {
              discriminator: 'decision',
              cases: { accepted: { 'company.unknown@1': true } },
            },
          },
        },
      ]),
    ).toThrow(
      'Harness step company.invalid-output@1 maps output to unknown predicate company.unknown@1',
    );
  });

  it('loads readable prompts with content hashes and exposes fill-test-ops-plan', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const stepDefinition = pack.steps.find(
      (candidate) => candidate.reference === 'fill-test-ops-plan@1',
    );

    expect(stepDefinition).toMatchObject({
      block: {
        executor: { kind: 'agent', profile: 'verification', skills: ['test-ops-planning'] },
      },
      prompt: { relativePath: 'prompts/steps/fill-test-ops-plan.md' },
    });
    expect(stepDefinition?.prompt?.content).toContain('test-operations plan');
    expect(stepDefinition?.prompt?.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('teaches the implementation planner the authoritative workflow source grammar', () => {
    const prompt = loadHarnessPack(join(process.cwd(), 'harness')).prompts.implementationPlanner;

    expect(prompt.content).toContain(
      '{"kind":"branch","id":"...","when":"registered.predicate@version","then":node,"otherwise":node}',
    );
    expect(prompt.content).toContain(
      '{"kind":"bounded_loop","id":"...","maxAttempts":3,"until":"registered.predicate@version","checkBefore":true,"exhaustedWait":"registered.wait@version","body":node}',
    );
    expect(prompt.content).toContain(
      '{"kind":"wait","id":"...","for":"registered.wait@version","resumeAt":"node-id"}',
    );
    expect(prompt.content).toContain(
      '{"kind":"gate","id":"...","reason":"...","resumeWhen":"registered.predicate@version","with":{}}',
    );
    expect(prompt.content).toContain('{"kind":"finalize","id":"...","outcome":"accepted"}');
    expect(prompt.content).toContain('Every acceptance criterion must have a unique kebab-case');
    expect(prompt.content).toContain('"workflowStepIds":["..."]');
    expect(prompt.content).toContain('do not add a generic test-materialization step');
    expect(prompt.content).not.toContain('"maxIterations"');
    expect(prompt.content).not.toContain('"onExhausted"');
    expect(prompt.content).not.toContain('"cases"');
    expect(prompt.content).not.toContain('"predicate"');
  });

  it('rejects obsolete step manifests instead of upcasting them', async () => {
    const root = await createTemporaryPack();
    const manifestPath = join(root, 'steps/ci-observe.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      schemaVersion: number;
    };
    manifest.schemaVersion = 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    expect(() => loadHarnessPack(root)).toThrow();
  });

  it('rejects obsolete company manifests instead of inferring execution profiles', async () => {
    const root = await createTemporaryPack();
    const manifestPath = join(root, 'company.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      schemaVersion: number;
    };
    manifest.schemaVersion = 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    expect(() => loadHarnessPack(root)).toThrow();
  });

  it('rejects a missing execution profile instead of selecting a fallback provider', async () => {
    const root = await createTemporaryPack();
    const manifestPath = join(root, 'company.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      executionProfileRouting: { workflowAnalyzer: string };
    };
    manifest.executionProfileRouting.workflowAnalyzer = 'missing-profile';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    expect(() => loadHarnessPack(root)).toThrow('Unknown execution profile missing-profile');
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
    expect(pack.policies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'ai-assistance',
          version: '1',
          obligations: [expect.objectContaining({ id: 'pr-requires-ai-assistance' })],
        }),
        expect.objectContaining({
          id: 'review-feedback',
          version: '1',
          obligations: [
            expect.objectContaining({
              id: 'publish-and-acknowledge-review-revision',
              direction: 'after',
            }),
          ],
        }),
      ]),
    );
  });

  it('keeps mise configuration inside the writable workspace home volume', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));

    expect(pack.company.workspaceRuntime.environment).toMatchObject({
      HOME: '/tasker/home',
      MISE_CONFIG_DIR: '/tasker/home/.config/mise',
      PNPM_HOME: '/tasker/home/.local/share/pnpm',
      PATH: '/tasker/home/.local/share/pnpm:/tasker/home/.local/share/pnpm/bin:/tasker/cache/mise/data/shims:/usr/local/bin:/usr/bin:/bin',
    });
    expect(pack.company.workspaceRuntime.cacheVolumes).toContainEqual({
      id: 'home',
      mountPath: '/tasker/home',
    });
  });

  it('declares Activity redelivery at the step contract boundary', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const deliveryFor = (reference: string) =>
      pack.steps.find((stepDefinition) => stepDefinition.reference === reference)?.contract
        .activityDelivery;

    expect(deliveryFor('code.implement@1')).toEqual({ kind: 'workspace_reconciled' });
    expect(deliveryFor('validate.full@1')).toEqual({ kind: 'single_attempt' });
    expect(deliveryFor('review.agent@1')).toEqual({ kind: 'read_only' });
    expect(deliveryFor('translations.extract@1')).toEqual({ kind: 'single_attempt' });
    expect(deliveryFor('ci.observe@1')).toEqual({ kind: 'read_only' });
    expect(deliveryFor('pr.prepare@1')).toEqual({ kind: 'remote_reconciled' });
    expect(deliveryFor('review.acknowledge@1')).toEqual({ kind: 'remote_reconciled' });
    expect(deliveryFor('jira.start-work@1')).toEqual({ kind: 'remote_reconciled' });
    expect(deliveryFor('jira.review-ready@1')).toEqual({ kind: 'remote_reconciled' });
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
    expect(describe?.block.executor).toMatchObject({
      kind: 'agent',
      profile: 'documentation',
      skills: [],
    });
  });

  it('removes policy-owned blocks from future packs when the policy is disabled', async () => {
    const root = await createTemporaryPack();
    const policyPath = join(root, 'policies/ai-assistance.json');
    const policy = JSON.parse(await readFile(policyPath, 'utf8')) as { enabled: boolean };
    policy.enabled = false;
    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');

    const pack = loadHarnessPack(root);
    const references = pack.steps.map(({ reference }) => reference);

    expect(pack.policies.map(({ id }) => id)).toEqual(['jira-lifecycle', 'review-feedback']);
    expect(references).not.toContain('ai.assistance.initialize@1');
    expect(references).not.toContain('ai.assistance.validate@1');
    expect(references).toContain('pr.describe@1');
    expect(references).toContain('pr.prepare@1');
    expect(references).toContain('review.acknowledge@1');
  });

  it('removes the Bitbucket acknowledgement block when review feedback policy is disabled', async () => {
    const root = await createTemporaryPack();
    const policyPath = join(root, 'policies/review-feedback.json');
    const policy = JSON.parse(await readFile(policyPath, 'utf8')) as { enabled: boolean };
    policy.enabled = false;
    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');

    const pack = loadHarnessPack(root);

    expect(pack.policies.map(({ id }) => id)).not.toContain('review-feedback');
    expect(pack.steps.map(({ reference }) => reference)).not.toContain('review.acknowledge@1');
  });

  it('removes every Jira lifecycle block when its origin policy is disabled', async () => {
    const root = await createTemporaryPack();
    const policyPath = join(root, 'policies/jira-lifecycle.json');
    const policy = JSON.parse(await readFile(policyPath, 'utf8')) as { enabled: boolean };
    policy.enabled = false;
    await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');

    const pack = loadHarnessPack(root);
    const references = pack.steps.map(({ reference }) => reference);

    expect(pack.policies.map(({ id }) => id)).not.toContain('jira-lifecycle');
    expect(references).not.toContain('jira.start-work@1');
    expect(references).not.toContain('jira.review-ready@1');
  });

  it('binds visual evidence guidance to final bug validation while commands stay deterministic', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const skillsFor = (reference: string): readonly string[] => {
      const definition = pack.steps.find((candidate) => candidate.reference === reference);
      if (definition?.block.executor.kind !== 'agent') {
        throw new Error(`Expected agent ${reference}`);
      }
      return definition.block.executor.skills;
    };

    expect(skillsFor('bug.validate_fix@1')).toContain('playwright-demo');
    expect(
      pack.steps.find(({ reference }) => reference === 'validate.visual@1')?.block.executor,
    ).toEqual({ kind: 'process', executor: 'validation.visual@1' });
  });

  it('requires typed post-fix evidence for successful reproduction', () => {
    const reproduction = getHarnessStepDefinition('bug.validate_fix@1');
    if (reproduction === undefined) throw new Error('Expected reproduction block');

    expect(
      reproduction.contract.outputSchema.safeParse({
        summary: 'Visible bug fixed',
        phase: 'after',
        outcome: 'verified_fixed',
        evidence: [{ kind: 'video', path: 'evidence/after.mp4', mimeType: 'video/mp4' }],
      }).success,
    ).toBe(true);
    expect(
      reproduction.contract.outputSchema.safeParse({
        summary: 'Claimed success without proof',
        phase: 'after',
        outcome: 'verified_fixed',
        evidence: [],
      }).success,
    ).toBe(false);
    expect(
      reproduction.contract.outputSchema.safeParse({
        summary: 'Mismatched media metadata',
        phase: 'after',
        outcome: 'verified_fixed',
        evidence: [{ kind: 'video', path: 'evidence/after.png', mimeType: 'image/png' }],
      }).success,
    ).toBe(false);
  });

  it('registers declared validation commands and typed local review', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const references = pack.steps.map(({ reference }) => reference);
    const project = pack.projects.find(({ repository }) => repository === 'onetwotrip/front-avia');
    const review = getHarnessStepDefinition('review.agent@1');

    expect(references).toEqual(
      expect.arrayContaining([
        'bug.validate_fix@1',
        'code.repair@1',
        'validate.targeted@1',
        'review.agent@1',
      ]),
    );
    expect(project?.processCommands).toMatchObject({
      'validation.targeted@1': 'pnpm typecheck',
      'validation.full@1': 'pnpm test --runInBand',
      'validation.build@1': 'pnpm build',
      'validation.visual@1': 'pnpm test:ui',
    });
    expect(
      review?.contract.outputSchema.safeParse({
        decision: 'changes_requested',
        summary: 'One blocking issue remains',
        findings: [
          {
            title: 'Incorrect fallback',
            description: 'The new branch drops the existing fallback.',
            severity: 'blocking',
            files: ['src/example.ts'],
          },
        ],
      }).success,
    ).toBe(true);
    expect(review?.contract.outputPredicates).toEqual({
      discriminator: 'decision',
      cases: {
        accepted: {
          'agent_review.accepted@1': true,
          'agent_review.changes_requested@1': false,
        },
        changes_requested: {
          'agent_review.accepted@1': false,
          'agent_review.changes_requested@1': true,
        },
      },
    });
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
