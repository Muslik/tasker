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
    await rm(join(root, 'steps/bug-validate-fix'), { recursive: true });

    const pack = loadHarnessPack(root);

    expect(pack.steps.map(({ reference }) => reference)).not.toContain('bug.validate_fix@1');
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

  it('registers predicates declared by a block output mapping', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const baseStep = getHarnessStepDefinition('review.agent@1');
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
        executor: { kind: 'agent', profile: 'verification', skills: ['test-ops-planning'] },
      },
      prompt: { relativePath: 'steps/fill-test-ops-plan/prompt.md' },
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
      '{"kind":"bounded_loop","id":"...","maxAttempts":3,"until":"registered.predicate@version","checkBefore":true,"exhaustedWait":null,"body":node}',
    );
    expect(prompt.content).toContain(
      '{"kind":"wait","id":"...","for":"registered.wait@version","resumeAt":null}',
    );
    expect(prompt.content).toContain(
      '{"kind":"gate","id":"...","reason":"...","resumeWhen":"registered.predicate@version","with":null}',
    );
    expect(prompt.content).toContain('{"kind":"finalize","id":"...","outcome":"accepted"}');
    expect(prompt.content).toContain('Every acceptance criterion must have a unique kebab-case');
    expect(prompt.content).toContain('"workflowStepIds":["..."]');
    expect(prompt.content).toContain('do not add a generic test-materialization step');
    expect(prompt.content).toContain('typed JSON values, not');
    expect(prompt.content).not.toContain('decisionJson');
    expect(prompt.content).not.toContain('evidenceRequestsJson');
    expect(prompt.content).not.toContain('"maxIterations"');
    expect(prompt.content).not.toContain('"onExhausted"');
    expect(prompt.content).not.toContain('"cases"');
    expect(prompt.content).not.toContain('"predicate"');
  });

  it('rejects obsolete step manifests instead of upcasting them', async () => {
    const root = await createTemporaryPack();
    const manifestPath = join(root, 'steps/ci-observe/step.json');
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

    expect(pack.steps.map(({ reference }) => reference)).toContain('pr.describe@1');
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
          id: 'ai-assistance',
          version: '1',
          obligations: [],
          agentSkills: [expect.objectContaining({ skill: 'ai-assistance' })],
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

    expect(deliveryFor('code.implement@1')).toEqual({ kind: 'workspace_reconciled' });
    expect(deliveryFor('validate.full@1')).toEqual({ kind: 'single_attempt' });
    expect(deliveryFor('review.agent@1')).toEqual({ kind: 'read_only' });
    expect(deliveryFor('translations.extract@1')).toEqual({ kind: 'single_attempt' });
    expect(deliveryFor('ci.observe@1')).toEqual({ kind: 'read_only' });
    expect(deliveryFor('pr.prepare@1')).toEqual({ kind: 'remote_reconciled' });
    expect(deliveryFor('review.acknowledge@1')).toEqual({ kind: 'remote_reconciled' });
    expect(deliveryFor('jira.start-work@1')).toEqual({ kind: 'remote_reconciled' });
    expect(deliveryFor('jira.review-ready@1')).toEqual({ kind: 'remote_reconciled' });
    expect(deliveryFor('ai.assistance.initialize@1')).toBeUndefined();
  });

  it('keeps Jira admission inside the semantic implementation stage', () => {
    const pack = loadHarnessPack(join(process.cwd(), 'harness'));
    const admission = pack.steps.find(({ reference }) => reference === 'jira.start-work@1');

    expect(admission?.block.stage).toEqual({ id: 'implementation', label: 'Implement' });
  });

  it('binds company AI guidance to agent work without adding workflow blocks', () => {
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
    expect(describe?.block.completion).toEqual({
      kind: 'structured_evidence',
      source: 'workspace_files',
      requiredArtifactKinds: ['pull-request-draft'],
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
    const implementation = pack.steps.find(({ reference }) => reference === 'code.implement@1');
    const describe = pack.steps.find(({ reference }) => reference === 'pr.describe@1');
    expect(implementation?.block.executor.kind).toBe('agent');
    expect(describe?.block.executor.kind).toBe('agent');
    if (implementation?.block.executor.kind !== 'agent') throw new Error('Expected agent block');
    if (describe?.block.executor.kind !== 'agent') throw new Error('Expected agent block');
    expect(implementation.block.executor.skills).not.toContain('ai-assistance');
    expect(describe.block.executor.skills).not.toContain('ai-assistance');
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
    const ciObservation = getHarnessStepDefinition('ci.observe@1');

    expect(references).toEqual(
      expect.arrayContaining([
        'bug.validate_fix@1',
        'ci.repair@1',
        'code.repair@1',
        'validate.targeted@1',
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
        commands: [{ command: 'pnpm', args: ['run', 'test:unit', '--runInBand'] }],
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
    expect(ciObservation?.contract.outputPredicates).toEqual({
      discriminator: 'status',
      cases: {
        passed: {
          'ci.passed@1': true,
          'ci.change_failure@1': false,
          'ci.flaky@1': false,
          'ci.infrastructure@1': false,
          'ci.unknown@1': false,
        },
        likely_caused_by_change: {
          'ci.passed@1': false,
          'ci.change_failure@1': true,
          'ci.flaky@1': false,
          'ci.infrastructure@1': false,
          'ci.unknown@1': false,
        },
        likely_flaky: {
          'ci.passed@1': false,
          'ci.change_failure@1': false,
          'ci.flaky@1': true,
          'ci.infrastructure@1': false,
          'ci.unknown@1': false,
        },
        infrastructure: {
          'ci.passed@1': false,
          'ci.change_failure@1': false,
          'ci.flaky@1': false,
          'ci.infrastructure@1': true,
          'ci.unknown@1': false,
        },
        unknown: {
          'ci.passed@1': false,
          'ci.change_failure@1': false,
          'ci.flaky@1': false,
          'ci.infrastructure@1': false,
          'ci.unknown@1': true,
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
