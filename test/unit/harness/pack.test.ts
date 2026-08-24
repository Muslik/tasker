import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadHarnessPack } from '../../../src/harness/index.js';
import { JiraLifecyclePolicyConfigurationSchema } from '../../../src/integrations/jira/lifecycle.js';
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
  it('derives the production step catalog exclusively from step manifests', async () => {
    const root = await createTemporaryPack();
    await rm(join(root, 'steps/fill-test-ops-plan'), { recursive: true });
    await rm(join(root, 'policies/quality-boundaries.json'));

    const pack = loadHarnessPack(root);

    expect(pack.steps.map(({ reference }) => reference)).not.toContain('fill-test-ops-plan@1');
  });

  it('rejects flat step manifests outside an atomic step package', async () => {
    const root = await createTemporaryPack();
    await writeFile(join(root, 'steps/legacy.json'), '{}', 'utf8');

    expect(() => loadHarnessPack(root)).toThrow(
      'Harness step manifests must use steps/<step>/step.json packages',
    );
  });

  it('registers a typed company step without changing the workflow compiler', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const baseStep = getHarnessStepDefinition('implement.change@1');
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

  it('registers predicates declared by a block output mapping', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const baseStep = getHarnessStepDefinition('review.change@1');
    if (baseStep === undefined) throw new Error('Expected review definition');

    const contracts = createHarnessWorkflowContracts([
      ...pack.steps,
      {
        reference: 'company.custom-output@1',
        contract: {
          ...baseStep.contract,
          id: 'company.custom-output',
          outputPredicates: {
            discriminator: 'decision',
            cases: { accepted: { 'company.accepted@1': true } },
          },
        },
      },
    ]);

    expect(contracts.predicates.has('company.accepted@1')).toBe(true);
  });

  it('loads readable prompts with content hashes and exposes fill-test-ops-plan', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const stepDefinition = pack.steps.find(
      (candidate) => candidate.reference === 'fill-test-ops-plan@1',
    );

    expect(stepDefinition).toMatchObject({
      block: {
        executor: { kind: 'agent', profile: 'verification', skills: [] },
      },
      prompt: { relativePath: 'steps/fill-test-ops-plan/prompt.md' },
    });
    expect(stepDefinition?.prompt?.content).toContain('test-operations plan');
    expect(stepDefinition?.prompt?.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('teaches the implementation planner the authoritative workflow source grammar', () => {
    const prompt = loadHarnessPack(join(process.cwd(), 'harness')).prompts.implementationPlanner;

    expect(prompt.content).toContain('{"kind":"sequence","id":"...","children":[node,...]}');
    expect(prompt.content).toContain(
      '{"kind":"bounded_loop","id":"...","maxAttempts":3,"until":"registered.predicate@version","body":sequence}',
    );
    expect(prompt.content).toContain(
      '{"kind":"step","id":"...","uses":"registered.step@version","with":{}}',
    );
    expect(prompt.content).toContain('Never emit branch, wait, gate, finalize');
    expect(prompt.content).toContain('`code.implement`, `code.repair`, `ci.repair`');
    expect(prompt.content).toContain('Every acceptance criterion has a unique kebab-case');
    expect(prompt.content).toContain('`workflowStepIds`');
    expect(prompt.content).toContain('do not add a generic test-materialization step');
    expect(prompt.content).toContain('typed JSON values, not');
    expect(prompt.content).not.toContain('decisionJson');
    expect(prompt.content).not.toContain('evidenceRequestsJson');
    expect(prompt.content).not.toContain('"checkBefore"');
    expect(prompt.content).not.toContain('"exhaustedWait"');
  });

  it('rejects obsolete step manifests instead of upcasting them', async () => {
    const root = await createTemporaryPack();
    const manifestPath = join(root, 'steps/deliver-pull-request/step.json');
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

    expect(pack.steps.map(({ reference }) => reference)).toContain('deliver.pull-request@1');
    expect(pack.steps.map(({ reference }) => reference)).not.toEqual(
      expect.arrayContaining([
        'ai.assistance.initialize@1',
        'ai.assistance.record_plan@1',
        'ai.assistance.finalize@1',
        'ai.assistance.validate@1',
      ]),
    );
    expect(pack.policies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'quality-boundaries',
          version: '2',
        }),
        expect.objectContaining({
          id: 'review-feedback',
          version: '1',
          obligations: [],
        }),
      ]),
    );
    const quality = pack.policies.find(({ id }) => id === 'quality-boundaries');
    expect(quality?.obligations.map(({ id }) => id)).toEqual([
      'local-ready-before-delivery',
      'delivery-feedback-is-frozen',
    ]);
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
      serviceIds: [],
    });
    expect(pack.company.workspaceRuntime.environment).toMatchObject({
      DOCKER_HOST: 'tcp://tasker-docker:2375',
    });
    expect(pack.company.workspaceRuntime.services).toContainEqual(
      expect.objectContaining({
        id: 'tasker-docker',
        image: { kind: 'prebuilt', reference: 'docker:29-dind' },
        privileged: true,
      }),
    );
  });

  it('ships source-faithful Jira attachment access with the workspace harness', async () => {
    const skill = await readFile(
      join(process.cwd(), 'harness/workspace/integration-skills/jira/SKILL.md'),
      'utf8',
    );
    const script = await readFile(
      join(process.cwd(), 'harness/workspace/integration-skills/jira/scripts/jira_get_issue.py'),
      'utf8',
    );

    expect(skill).toContain('--download-attachment ID --output PATH');
    expect(skill).toContain('${TASKER_SKILLS_ROOT}/jira/scripts/jira_get_issue.py');
    expect(script).toContain('def download_attachment(');
    expect(script).toContain('Attachment size mismatch');
  });

  it('requires bug verification to preserve the investigated Jira scenario', async () => {
    const prompt = await readFile(
      join(process.cwd(), 'harness/steps/verify-acceptance/prompt.md'),
      'utf8',
    );
    const normalized = prompt.replace(/\s+/gu, ' ');

    expect(normalized).toContain(
      'download the relevant attachment by its exact issue key and attachment ID',
    );
    expect(normalized).toContain('preserve the visible route/state, card kind, viewport, and');
    expect(normalized).toContain('block instead of accepting a different screenshot');
    expect(normalized).toContain('must close its browser in `finally`');
    expect(normalized).toContain(
      'reuse the accepted runtime evidence and verify only the repair delta',
    );
  });

  it('exposes only the reviewed validation surface for the six frontend repositories', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));

    expect(pack.projects.map(({ repository }) => repository).sort()).toEqual([
      'onetwotrip/front-avia',
      'onetwotrip/front-backoffice',
      'onetwotrip/front-bus',
      'onetwotrip/front-components',
      'onetwotrip/front-core-packages',
      'onetwotrip/front-railways',
    ]);
    for (const project of pack.projects) {
      expect(project.workspaceRuntime).toBeDefined();
      expect(project.workspaceRuntime?.bootstrap).toContain(
        'pnpm exec playwright install chromium',
      );
      expect(project.processCommands['validation.visual@1']).toBeUndefined();
      expect(
        Object.values(project.processCommands).flatMap(({ commands }) =>
          commands.flatMap(({ command, args }) => [command, ...args]),
        ),
      ).not.toContain('test:ui');
    }
    const backoffice = pack.projects.find(
      ({ repository }) => repository === 'onetwotrip/front-backoffice',
    );
    const avia = pack.projects.find(({ repository }) => repository === 'onetwotrip/front-avia');
    expect(avia?.workspaceRuntime?.commandNetworkService).toBe('front-avia-app');
    expect(backoffice?.processCommands['validation.targeted@1']).toBeUndefined();
    expect(backoffice?.processCommands['validation.build@1']).toBeDefined();
  });

  it('admits the company Jira issue types used for frontend work', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const policy = pack.policies.find(({ id }) => id === 'jira-lifecycle');
    const configuration = JiraLifecyclePolicyConfigurationSchema.parse(policy?.configuration);

    expect(configuration.admission.allowedIssueTypes).toEqual(
      expect.arrayContaining(['Bug', 'Task', 'Story', 'Frontend Story']),
    );
  });

  it('declares Activity redelivery at the step contract boundary', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const deliveryFor = (reference: string) =>
      pack.steps.find((stepDefinition) => stepDefinition.reference === reference)?.contract
        .activityDelivery;

    expect(deliveryFor('implement.change@1')).toEqual({ kind: 'workspace_reconciled' });
    expect(deliveryFor('verify.acceptance@1')).toEqual({ kind: 'read_only' });
    expect(deliveryFor('review.change@1')).toEqual({ kind: 'read_only' });
    expect(deliveryFor('translations.extract@1')).toEqual({ kind: 'single_attempt' });
    expect(deliveryFor('deliver.pull-request@1')).toEqual({ kind: 'remote_reconciled' });
    expect(deliveryFor('ai.assistance.initialize@1')).toBeUndefined();
  });

  it('owns PR, CI, Jira, and human review inside one semantic Delivery block', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const delivery = pack.steps.find(({ reference }) => reference === 'deliver.pull-request@1');

    expect(delivery?.block.stage).toEqual({ id: 'delivery', label: 'Delivery' });
    expect(delivery?.contract.waitKinds).toEqual([
      'ci_retry@1',
      'ci_infrastructure@1',
      'ci_unknown@1',
      'code_review@1',
    ]);
    expect(delivery?.contract.workflowChanges).toEqual([]);
    expect(delivery?.block.outputPredicates).toMatchObject({
      discriminator: 'outcome',
      cases: {
        accepted: { 'delivery.accepted@1': true },
        repair_required: { 'delivery.accepted@1': false },
      },
    });
  });

  it('keeps company AI assistance out of workflow and kernel policies', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const implementation = pack.steps.find(({ reference }) => reference === 'implement.change@1');
    const aiPolicy = pack.policies.find(({ id }) => id === 'ai-assistance');

    expect(implementation?.block.executor.kind).toBe('agent');
    expect(aiPolicy).toBeUndefined();
    expect(pack.steps.map(({ reference }) => reference)).not.toEqual(
      expect.arrayContaining([
        'ai.assistance.initialize@1',
        'ai.assistance.finalize@1',
        'pr.describe@1',
        'pr.prepare@1',
      ]),
    );
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

  it('binds project checks and visual evidence to one semantic Verify block', () => {
    const verify = getHarnessStepDefinition('verify.acceptance@1');
    if (verify === undefined) throw new Error('Expected semantic Verify block');

    expect(
      verify.contract.outputSchema.safeParse({
        decision: 'accepted',
        summary: 'All acceptance evidence passed',
        findings: [],
      }).success,
    ).toBe(true);
    expect(
      verify.contract.outputSchema.safeParse({
        decision: 'accepted',
        summary: 'The agent tried to publish a model-authored path',
        findings: [],
        evidence: [{ path: '/tmp/after.mp4' }],
      }).success,
    ).toBe(false);
    expect(verify.block.executor).toMatchObject({
      kind: 'agent',
      skills: ['jira', 'playwright-demo', 'test-design'],
    });
    expect(verify.block.completion).toMatchObject({
      kind: 'structured_evidence',
      requiredArtifactKinds: ['acceptance-verification'],
    });
  });

  it('registers the compact semantic catalog and project-owned verification commands', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const references = pack.steps.map(({ reference }) => reference);
    const project = pack.projects.find(({ repository }) => repository === 'onetwotrip/front-avia');
    const review = getHarnessStepDefinition('review.change@1');

    expect(references).toEqual(
      expect.arrayContaining([
        'bug.investigate@1',
        'implement.change@1',
        'verify.acceptance@1',
        'review.change@1',
        'prepare.delivery@1',
        'deliver.pull-request@1',
      ]),
    );
    expect(references).not.toEqual(
      expect.arrayContaining([
        'code.implement@1',
        'code.repair@1',
        'ci.repair@1',
        'pr.prepare@1',
        'review.agent@1',
      ]),
    );
    expect(project?.processCommands).toMatchObject({
      'validation.targeted@1': {
        commands: [
          { command: 'pnpm', args: ['run', 'typecheck'] },
          { command: 'pnpm', args: ['run', 'lint:eslint'] },
          { command: 'pnpm', args: ['run', 'lint:stylelint'] },
          { command: 'pnpm', args: ['run', 'lint:circular'] },
        ],
      },
      'validation.full@1': {
        commands: [
          { command: 'pnpm', args: ['run', 'typecheck'] },
          { command: 'pnpm', args: ['run', 'lint:eslint'] },
          { command: 'pnpm', args: ['run', 'lint:stylelint'] },
          { command: 'pnpm', args: ['run', 'lint:circular'] },
          { command: 'pnpm', args: ['run', 'test:unit', '--runInBand'] },
          { command: 'pnpm', args: ['run', 'build'] },
        ],
      },
      'validation.build@1': {
        commands: [{ command: 'pnpm', args: ['run', 'build'] }],
      },
    });
    expect(project?.processCommands).not.toHaveProperty('validation.visual@1');
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
