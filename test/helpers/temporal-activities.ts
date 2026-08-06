import type {
  EvaluatePredicateInput,
  ExecuteTaskStepInput,
  ExecuteTaskStepResult,
  PrepareTaskWorkspaceInput,
  PrepareTaskWorkspaceResult,
  TaskWorkflowActivities,
} from '../../src/temporal/contracts.js';
import { ok } from '../../src/shared/outcome.js';
import type {
  DockerWorkspaceRuntimeReceipt,
  ResolvedWorkspaceRuntimePolicy,
  WorkspaceLocator,
} from '../../src/workspaces/index.js';

const TEST_PROMPT_HASH = '0'.repeat(64);

export const testDockerRuntimeReceipt = (
  workspace: WorkspaceLocator,
): DockerWorkspaceRuntimeReceipt => ({
  schemaVersion: 1,
  workspaceId: workspace.workspaceId,
  workspacePath: workspace.path,
  repositorySourcePath: workspace.repository.sourcePath,
  policyHash: TEST_PROMPT_HASH,
  policy: {
    engine: 'docker',
    image: { kind: 'prebuilt', reference: 'tasker/workspace:test' },
    workspaceMountPath: '/workspace',
    environment: {},
    bootstrap: [],
    cacheVolumes: [],
    services: [],
  },
  image: 'tasker/workspace:test',
  imageId: 'sha256:test',
  networkName: `tasker-network-${workspace.workspaceId}`,
  volumes: [],
  services: [],
  environment: {},
  initializedVolumes: [],
  completedBootstrap: [],
  status: 'ready',
  preparedAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
});

export const testDockerRuntimes = {
  prepare: (workspace: WorkspaceLocator) =>
    Promise.resolve(ok(testDockerRuntimeReceipt(workspace))),
};

export const testDockerRuntimePolicies = {
  resolve: (): ResolvedWorkspaceRuntimePolicy => ({
    engine: 'docker',
    image: { kind: 'prebuilt', reference: 'tasker/workspace:test' },
    workspaceMountPath: '/workspace',
    environment: {},
    bootstrap: [],
    cacheVolumes: [],
    services: [],
    policyHash: TEST_PROMPT_HASH,
  }),
};

const prepareTaskWorkspace = (
  input: PrepareTaskWorkspaceInput,
): Promise<PrepareTaskWorkspaceResult> =>
  Promise.resolve({
    workspace: {
      schemaVersion: 1,
      workspaceId: '0'.repeat(24),
      taskReference: input.taskReference,
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      workflowHash: input.workflowHash,
      repository: {
        reference: 'fixture/repository',
        sourcePath: '/tasker/repositories/fixture',
        baseCommit: '0'.repeat(40),
      },
      runnerId: 'temporal-test',
      path: '/tasker/worktrees/fixture',
      branch: `tasker/${input.taskReference}`,
      preparedAt: '2026-08-03T00:00:00.000Z',
    },
    bootstrap: {
      schemaVersion: 1,
      operationId: `workspace:${'0'.repeat(24)}:bootstrap@1`,
      workspaceId: '0'.repeat(24),
      adapterId: 'temporal-test',
      adapterVersion: '1',
      profile: 'fixture',
      files: [],
      completedAt: '2026-08-03T00:00:00.000Z',
    },
    runtime: testDockerRuntimeReceipt({
      schemaVersion: 1,
      workspaceId: '0'.repeat(24),
      taskReference: input.taskReference,
      workflowId: input.workflowId,
      workflowRunId: input.workflowRunId,
      workflowHash: input.workflowHash,
      repository: {
        reference: 'fixture/repository',
        sourcePath: '/tasker/repositories/fixture',
        baseCommit: '0'.repeat(40),
      },
      runnerId: 'temporal-test',
      path: '/tasker/worktrees/fixture',
      branch: `tasker/${input.taskReference}`,
      preparedAt: '2026-08-03T00:00:00.000Z',
    }),
    planningSnapshot: {
      artifactId: `planning-snapshot:${input.taskReference}:${input.workflowHash}`,
      checksum: TEST_PROMPT_HASH,
    },
  });

const prepareTaskDockerRuntime: TaskWorkflowActivities['prepareTaskDockerRuntime'] = ({
  workspace,
}) => Promise.resolve(testDockerRuntimeReceipt(workspace));

const executeStep = (input: ExecuteTaskStepInput): Promise<ExecuteTaskStepResult> =>
  Promise.resolve({
    status: 'completed',
    summary: `${input.uses} completed by the Temporal test Activity`,
    predicateResults: {
      'attempt.succeeded@1': true,
    },
    artifactIds: [],
    transcriptId: null,
  });

const evaluatePredicate = (input: EvaluatePredicateInput): Promise<boolean> =>
  Promise.resolve(input.facts[input.reference] ?? false);

const planTaskImplementation: TaskWorkflowActivities['planTaskImplementation'] = (input) =>
  Promise.resolve({
    status: 'ready',
    commandId: input.commandId,
    transcriptId: `planning-transcript:${input.commandId}`,
    attempt: 1,
    artifactId: `test-plan:${input.taskReference}`,
    evidenceBundle: {
      artifactId: `evidence-bundle:${input.taskReference}:r1:test`,
      checksum: TEST_PROMPT_HASH,
      revision: 1,
    },
    requestedStrategy: input.requestedStrategy,
    selectedStrategy: input.requestedStrategy === 'ralplan' ? 'ralplan' : 'fast',
    receipt: {
      status: 'completed',
      provider: 'deterministic',
      plannerVersion: 'implementation-planner@1',
      cliVersion: 'temporal-test@1',
      model: 'deterministic',
      serviceTier: 'fast',
      strategy: input.requestedStrategy === 'ralplan' ? 'ralplan' : 'fast',
      sessionId: `temporal-test:${input.commandId}`,
      promptHash: TEST_PROMPT_HASH,
      durationMs: 0,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      hypotheticalApiCostUsd: 0,
    },
  });

const linkWorkflowContinuation: TaskWorkflowActivities['linkWorkflowContinuation'] = () =>
  Promise.resolve({ linked: true });

const reviseTaskWorkflowDraft: TaskWorkflowActivities['reviseTaskWorkflowDraft'] = () =>
  Promise.reject(new Error('Unexpected workflow draft revision'));

const freezeTaskWorkflow: TaskWorkflowActivities['freezeTaskWorkflow'] = (input) =>
  Promise.resolve({
    ...input,
    schemaVersion: 1,
    receiptId: `workflow-freeze:${input.workflowId}:${input.workflowRunId}`,
    frozenAt: '2026-08-05T00:00:00.000Z',
  });

export const testTaskWorkflowActivities = {
  prepareTaskWorkspace,
  prepareTaskDockerRuntime,
  executeStep,
  executeReadOnlyStep: executeStep,
  executeWorkspaceReconciledStep: executeStep,
  executeRemoteReconciledStep: executeStep,
  evaluatePredicate,
  planTaskImplementation,
  reviseTaskWorkflowDraft,
  freezeTaskWorkflow,
  linkWorkflowContinuation,
} satisfies TaskWorkflowActivities;
