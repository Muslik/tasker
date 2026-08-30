import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/activity', () => ({
  Context: {
    current: () => ({
      heartbeat: vi.fn(),
    }),
  },
}));

import {
  DependencyDeclarationStore,
  dependencyDeclarationIdFor,
} from '../../src/control-plane/dependency-declaration.js';
import { ImplementationPlanningStore } from '../../src/control-plane/implementation-planning.js';
import { loadHarnessPack, resolveImplementationPlannerProfile } from '../../src/harness/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import type { EvidenceBundle } from '../../src/planning/evidence-bundle.js';
import type { WorkflowAnalyzerOutput } from '../../src/planning/index.js';
import type { WorkflowAnalyzerReceipt } from '../../src/providers/contracts.js';
import { ok } from '../../src/shared/outcome.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { createExecutionContinuationActivity } from '../../src/temporal/activities/execution-continuation-activity.js';
import type { WorkflowAnalyzer } from '../../src/control-plane/workflow-generator.js';

const baseTask = {
  schemaVersion: 1 as const,
  origin: 'jira',
  reference: 'jira:AVIA-12045',
  taskId: 'AVIA-12045',
  title: 'Consume the published shared package',
  description: 'Wait for the shared package publication and continue in the consumer repository.',
  repository: 'onetwotrip/front-avia',
  kind: 'feature' as const,
  labels: ['frontend'],
};

const baseRequest = {
  schemaVersion: 1 as const,
  discoveredAtNodeId: 'implement-shared-change',
  summary: 'A shared package must be published before consumer work can continue.',
  evidenceArtifactIds: ['evidence:request:1'],
  changes: [
    {
      kind: 'cross_repository_dependency' as const,
      repository: 'front-core-packages',
      requestedOutcome:
        'Publish the updated shared fare-card package and continue with the exact version.',
      componentPath: 'packages/@ott/fare-card',
    },
  ],
};

const evidenceBundle: EvidenceBundle = {
  schemaVersion: 2,
  scopeId: 'continuation-scope',
  taskReference: baseTask.reference,
  revision: 1,
  inputFingerprint: '1'.repeat(64),
  parent: null,
  entries: [
    {
      evidenceId: `evidence:${'2'.repeat(64)}`,
      evidenceType: 'task_snapshot',
      title: 'Continuation task snapshot',
      provenance: {
        source: { kind: 'task_system', locator: baseTask.reference },
        capturedAt: '2026-08-25T10:00:00.000Z',
        observedVersion: '1',
        contentSha256: '3'.repeat(64),
        mediaType: 'application/json',
        introducedBy: { phase: 'continuation', operationId: 'continuation:context' },
      },
      content: { taskReference: baseTask.reference },
    },
  ],
  createdAt: '2026-08-25T10:00:00.000Z',
};

const evidenceReference = {
  artifactId: 'evidence-bundle:continuation-scope:r1',
  checksum: '4'.repeat(64),
  revision: 1,
} as const;

const snapshottedStep = (reference: string) => {
  const pack = loadHarnessPack();
  const step = pack.steps.find((candidate) => candidate.reference === reference);
  if (step === undefined) {
    throw new Error(`Expected harness step ${reference} to exist`);
  }
  return {
    reference: step.reference,
    block: step.block,
    activityDelivery: step.contract.activityDelivery,
    resolvedProcess: null,
    executionProfile: null,
  };
};

const analyzerReceipt = {
  status: 'completed' as const,
  provider: 'codex_cli' as const,
  analyzerVersion: 'workflow-analyzer@2' as const,
  profile: 'test-workflow-analyzer',
  profileSha256: '5'.repeat(64),
  cliVersion: 'codex-test@1',
  model: 'test-model',
  effort: 'low' as const,
  serviceTier: 'fast' as const,
  sessionId: 'session-continuation',
  promptHash: '6'.repeat(64),
  durationMs: 12,
  usage: {
    inputTokens: 120,
    cachedInputTokens: 0,
    outputTokens: 40,
    reasoningOutputTokens: 0,
  },
  apiCost: { source: 'unrated' as const },
} satisfies WorkflowAnalyzerReceipt;

const persistRequestArtifact = (
  ledger: SqliteLedger,
  requestReference: string,
  request = baseRequest,
): void => {
  const result = ledger.repository.transact({
    artifacts: [
      {
        artifactId: requestReference,
        artifactKind: 'task_step_output',
        storageUri: `ledger://artifacts/${requestReference}`,
        payload: {
          schemaVersion: 4,
          operationId: 'tasker:execution:workflow-change:1',
          workflowId: 'workflow-1',
          workflowRunId: 'run-1',
          nodeId: request.discoveredAtNodeId,
          stepReference: 'implement.change@1',
          stepAttempt: 1,
          runner: 'agent',
          command: 'codex',
          args: [],
          cwd: '/workspace/front-avia',
          exitCode: 0,
          status: 'workflow_change_required',
          stdout: '',
          stderr: '',
          details: { request },
          usage: null,
          result: {
            status: 'workflow_change_required',
            summary: request.summary,
            artifactIds: [],
            transcriptId: null,
            request,
          },
          recordedAt: '2026-08-25T10:00:00.000Z',
        },
        metadata: {},
        createdAt: '2026-08-25T10:00:00.000Z',
      },
    ],
    timestamp: '2026-08-25T10:00:00.000Z',
  });
  if (!result.ok) {
    throw new Error(`Expected request artifact to persist: ${result.error.kind}`);
  }
};

const persistExecutionSnapshot = (ledger: SqliteLedger) => {
  const clock = makeAdjustableClock('2026-08-25T10:00:00.000Z');
  const pack = loadHarnessPack();
  const planning = new ImplementationPlanningStore(ledger.repository, clock);
  const project =
    pack.projects.find((candidate) => candidate.repository === baseTask.repository) ?? null;
  const executionProfileOverrides = project?.executionProfileOverrides ?? null;
  const snapshot = planning.persistRunSnapshot({
    schemaVersion: 11,
    kind: 'execution',
    taskReference: baseTask.reference,
    workflowRunId: 'execution-run-1',
    task: baseTask,
    taskSnapshot: { issue: { issueKey: baseTask.taskId } },
    repository: {
      workspaceId: 'a'.repeat(24),
      reference: baseTask.repository,
      path: '/workspace/front-avia',
    },
    harness: {
      company: pack.company,
      project,
      implementationPlanner: {
        prompt: pack.prompts.implementationPlanner,
        skills: ['jira'],
        profiles: {
          fast: resolveImplementationPlannerProfile(
            pack.company,
            executionProfileOverrides,
            'fast',
          ),
          ralplan: resolveImplementationPlannerProfile(
            pack.company,
            executionProfileOverrides,
            'ralplan',
          ),
        },
      },
      policies: [],
      steps: [snapshottedStep('dependency.await_packages@1')],
    },
    harnessHash: '7'.repeat(64),
    createdAt: '2026-08-25T10:00:00.000Z',
    executionStrategy: 'simple',
    semanticHash: '8'.repeat(64),
    semanticSource: {
      schemaVersion: 1,
      id: 'frozen-parent-workflow',
      version: 1,
      root: {
        kind: 'sequence',
        id: 'parent-work',
        children: [
          {
            kind: 'step',
            id: 'await-dependency',
            uses: 'dependency.await_packages@1',
            with: {
              objective: 'Wait for the shared package publication.',
              repository: baseTask.repository,
              taskId: baseTask.taskId,
              declarationId: 'dependency-declaration:test',
              declarationRevision: 1,
              channel: 'final',
              packages: ['@ott/fare-card'],
            },
          },
        ],
      },
    },
    compilerVersion: 'semantic-workflow-v1',
    workflowHash: '9'.repeat(64),
    workflow: {},
    acceptedPlan: null,
    evidenceBundle: {
      artifactId: 'evidence-bundle:parent:r1',
      checksum: 'b'.repeat(64),
      revision: 1,
    },
  });
  if (!snapshot.ok) {
    throw new Error(`Expected execution snapshot to persist: ${snapshot.error.kind}`);
  }
  return { planning, reference: snapshot.value };
};

const continuationInput = (planningSnapshot: { artifactId: string; checksum: string }) => ({
  taskReference: baseTask.reference,
  workflowId: 'tasker:execution:v2:jira:AVIA-12045',
  workflowRunId: 'execution-run-1',
  parentNodeId: 'implement-shared-change',
  attempt: 1,
  requestReference: 'artifact:workflow-change-request:1',
  planningSnapshot,
  guidance: 'Continue only inside the prepared consumer repository.',
});

const analyzerOutput = (
  declarationId: string,
  declarationRevision: number,
  packages: readonly string[],
): WorkflowAnalyzerOutput => ({
  assemblyDecisions: [
    {
      id: 'declared-cross-repository-dependency',
      title: 'Wait for the declared dependency publication',
      source: 'taskSnapshot.dependencyDiscovery',
      reason: 'The operator already mapped the cross-repository request to exact packages.',
      effect: 'Continue in the consumer repository with a dependency wait step.',
    },
  ],
  source: {
    schemaVersion: 1,
    id: 'cross-repository-continuation',
    version: 1,
    root: {
      kind: 'sequence',
      id: 'continuation',
      children: [
        {
          kind: 'step',
          id: 'await-packages',
          uses: 'dependency.await_packages@1',
          with: {
            objective: 'Wait for the exact shared package publication.',
            repository: baseTask.repository,
            taskId: baseTask.taskId,
            declarationId,
            declarationRevision,
            channel: 'final',
            packages: [...packages],
          },
        },
      ],
    },
  },
  verificationPlan: {
    checks: ['Wait for the exact dependency publication receipt.'],
    profile: 'targeted',
    validationProfile: 'targeted',
    rationale: 'The continuation only waits for the declared package publication.',
  },
});

describe('execution continuation activity', () => {
  let ledger: SqliteLedger | null = null;

  afterEach(() => {
    ledger?.close();
    ledger = null;
  });

  const contextDiscovery = (discover: ReturnType<typeof vi.fn>) =>
    ({ discover }) as unknown as Parameters<typeof createExecutionContinuationActivity>[4];

  it('waits for dependency discovery when no runtime declaration exists yet', async () => {
    const clock = makeAdjustableClock('2026-08-25T10:00:00.000Z');
    ledger = openSqliteLedger({ filename: ':memory:', clock });
    persistRequestArtifact(ledger, 'artifact:workflow-change-request:1');
    const { planning, reference } = persistExecutionSnapshot(ledger);
    const analyze = vi.fn<WorkflowAnalyzer['analyze']>();
    const discover = vi.fn();

    const activity = createExecutionContinuationActivity(
      ledger.repository,
      clock,
      planning,
      { analyze },
      contextDiscovery(discover),
      new DependencyDeclarationStore(ledger.repository, clock),
    );

    const result = await activity.planExecutionContinuation(continuationInput(reference));
    if (result.status !== 'needs_input') {
      throw new Error(`Expected dependency discovery wait, received ${result.status}`);
    }

    expect(result).toMatchObject({
      status: 'needs_input',
      waitKind: 'dependency.discovery@1',
    });
    expect(result.summary).toContain('artifact:workflow-change-request:1');
    expect(result.summary).toContain(baseTask.reference);
    expect(result.summary).toContain('front-core-packages');
    expect(analyze).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  it('waits for dependency discovery when the declaration does not cover the requested package boundary', async () => {
    const clock = makeAdjustableClock('2026-08-25T10:00:00.000Z');
    ledger = openSqliteLedger({ filename: ':memory:', clock });
    persistRequestArtifact(ledger, 'artifact:workflow-change-request:1');
    const { planning, reference } = persistExecutionSnapshot(ledger);
    const declarations = new DependencyDeclarationStore(ledger.repository, clock);
    const declared = declarations.declare({
      consumerTaskReference: baseTask.reference,
      producerTaskReference: 'jira:AVIA-11999',
      producerRepository: 'front-core-packages',
      packages: ['@ott/core-button'],
      mode: 'final_only',
      source: {
        kind: 'runtime_discovery',
        workflowRunId: 'execution-run-1',
        requestArtifactId: 'artifact:workflow-change-request:1',
      },
    });
    if (!declared.ok) throw new Error(JSON.stringify(declared.error));
    const analyze = vi.fn<WorkflowAnalyzer['analyze']>();
    const discover = vi.fn();

    const activity = createExecutionContinuationActivity(
      ledger.repository,
      clock,
      planning,
      { analyze },
      contextDiscovery(discover),
      declarations,
    );

    const result = await activity.planExecutionContinuation(continuationInput(reference));
    if (result.status !== 'needs_input') {
      throw new Error(`Expected dependency discovery wait, received ${result.status}`);
    }

    expect(result).toMatchObject({
      status: 'needs_input',
      waitKind: 'dependency.discovery@1',
    });
    expect(result.summary).toContain('@ott/fare-card');
    expect(result.summary).toContain('@ott/core-button');
    expect(analyze).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  });

  it('passes the resolved declaration into analyzer context and keeps the parent repository fixed', async () => {
    const clock = makeAdjustableClock('2026-08-25T10:00:00.000Z');
    ledger = openSqliteLedger({ filename: ':memory:', clock });
    persistRequestArtifact(ledger, 'artifact:workflow-change-request:1');
    const { planning, reference } = persistExecutionSnapshot(ledger);
    const declarations = new DependencyDeclarationStore(ledger.repository, clock);
    const declared = declarations.declare({
      consumerTaskReference: baseTask.reference,
      producerTaskReference: 'jira:AVIA-12046',
      producerRepository: 'front-core-packages',
      packages: ['@ott/fare-card'],
      mode: 'validate_dev_then_final',
      source: {
        kind: 'runtime_discovery',
        workflowRunId: 'execution-run-1',
        requestArtifactId: 'artifact:workflow-change-request:1',
      },
    });
    if (!declared.ok) throw new Error(JSON.stringify(declared.error));

    const discover = vi.fn<Parameters<typeof createExecutionContinuationActivity>[4]['discover']>(
      () =>
        Promise.resolve(
          ok({
            bundle: evidenceBundle,
            reference: evidenceReference,
          }),
        ),
    );
    const analyze = vi.fn<WorkflowAnalyzer['analyze']>(() =>
      Promise.resolve(
        ok({
          output: analyzerOutput(
            declared.value.declarationId,
            declared.value.revision,
            declared.value.packages,
          ),
          receipt: analyzerReceipt,
        }),
      ),
    );

    const activity = createExecutionContinuationActivity(
      ledger.repository,
      clock,
      planning,
      { analyze },
      contextDiscovery(discover),
      declarations,
    );

    const result = await activity.planExecutionContinuation(continuationInput(reference));

    expect(result).toMatchObject({
      status: 'ready',
      continuationId: 'execution-run-1:continuation-1',
      graph: {
        metadata: {
          references: {
            stepTypes: ['dependency.await_packages@1'],
          },
        },
      },
    });
    expect(discover).toHaveBeenCalledOnce();
    expect(discover.mock.calls[0]?.[0]).toMatchObject({
      repositoryReference: baseTask.repository,
      repositoryPath: '/workspace/front-avia',
    });
    const requestedChange = baseRequest.changes[0];
    if (requestedChange === undefined) throw new Error('Expected cross-repository change');
    expect(analyze).toHaveBeenCalledOnce();
    expect(analyze.mock.calls[0]?.[0]).toMatchObject({
      repositoryReference: baseTask.repository,
      repositoryPath: '/workspace/front-avia',
      taskSnapshot: {
        dependencyDiscovery: {
          requestArtifactId: 'artifact:workflow-change-request:1',
          consumerTaskReference: baseTask.reference,
          requestedRepository: 'front-core-packages',
          requestedOutcome: requestedChange.requestedOutcome,
          componentPath: 'packages/@ott/fare-card',
          declarationId: declared.value.declarationId,
          declarationRevision: declared.value.revision,
          declarationHash: declared.value.hash,
          producerTaskReference: declared.value.producerTaskReference,
          producerRepository: declared.value.producerRepository,
          packages: declared.value.packages,
          mode: declared.value.mode,
        },
      },
    });
    expect(
      dependencyDeclarationIdFor(baseTask.reference, {
        kind: 'runtime_discovery',
        workflowRunId: 'execution-run-1',
        requestArtifactId: 'artifact:workflow-change-request:1',
      }),
    ).toBe(declared.value.declarationId);
  });
});
