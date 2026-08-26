import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createOperatorWorkflowService,
  DependencyDeclarationGenerationSubjectResolver,
  DependencyDeclarationStore,
  OPERATOR_WORKFLOW_OPERATION_PROJECTION,
  PersistedGenerationSubjectResolver,
  PersistedGenerationSubjectRunStore,
} from '../../src/control-plane/index.js';
import { openSqliteLedger } from '../../src/ledger/index.js';
import { WorkflowAnalyzerOutputSchema } from '../../src/planning/index.js';
import { WorkflowGenerationSubjectSource } from '../../src/planning/index.js';
import {
  WorkflowAnalyzerReceiptSchema,
  type WorkflowAnalyzerReceipt,
} from '../../src/providers/contracts.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { makeAnalyzerOutput, makePlanningTaskSnapshot } from '../support/planning.js';

const directories: string[] = [];

const databasePath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'tasker-operator-persistence-'));
  directories.push(directory);
  return join(directory, 'ledger.sqlite');
};

const receipt = (sessionId: string): WorkflowAnalyzerReceipt =>
  WorkflowAnalyzerReceiptSchema.parse({
    status: 'completed',
    provider: 'codex_cli',
    analyzerVersion: 'workflow-analyzer@2',
    profile: 'test-analyzer',
    profileSha256: 'b'.repeat(64),
    cliVersion: 'codex-cli 0.120.0',
    model: 'gpt-5.6-terra',
    effort: 'medium',
    serviceTier: 'fast',
    sessionId,
    promptHash: createHash('sha256').update(sessionId).digest('hex'),
    durationMs: 1_250,
    usage: {
      inputTokens: 1_200,
      cachedInputTokens: 800,
      outputTokens: 240,
      reasoningOutputTokens: 40,
    },
    apiCost: { source: 'unrated' },
  });

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('operation-scoped workflow persistence', () => {
  it('restores only the exact planning operation after process restart', () => {
    const filename = databasePath();
    const clock = makeAdjustableClock('2026-08-01T12:00:00.000Z');
    const task = makePlanningTaskSnapshot();
    const output = makeAnalyzerOutput();
    const operationId = 'tasker:v3:task:run-a:planning:workflow-candidate:1';
    const firstLedger = openSqliteLedger({ filename, clock });
    const generated = createOperatorWorkflowService(
      firstLedger.repository,
      clock,
    ).assembleFromAnalyzerOutputAtOperation(task, output, receipt('session-a'), operationId);
    expect(generated).toMatchObject({ ok: true, value: { status: 'ready' } });
    firstLedger.close();

    const restartedLedger = openSqliteLedger({ filename, clock });
    const restarted = createOperatorWorkflowService(restartedLedger.repository, clock);
    expect(restarted.readPlanningOperation(task.reference, operationId)).toEqual(generated);
    expect(
      restarted.readPlanningOperation(
        task.reference,
        'tasker:v3:task:run-b:planning:workflow-candidate:1',
      ),
    ).toEqual({ ok: true, value: null });
    expect(restartedLedger.repository.readArtifact(`graph:${operationId}`)).not.toBeNull();
    restartedLedger.close();
  });

  it('isolates two runs of one task including their graph and provider session', () => {
    const clock = makeAdjustableClock('2026-08-01T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: databasePath(), clock });
    const service = createOperatorWorkflowService(ledger.repository, clock);
    const task = makePlanningTaskSnapshot();
    const output = makeAnalyzerOutput();
    const episodeA = 'tasker:v3:task:run-a:planning';
    const episodeB = 'tasker:v3:task:run-b:planning';
    const operationA = `${episodeA}:workflow-candidate:1`;
    const operationB = `${episodeB}:workflow-candidate:1`;

    const runA = service.assembleFromAnalyzerOutputAtOperation(
      task,
      output,
      receipt('session-run-a'),
      operationA,
    );
    const invalidOutput = WorkflowAnalyzerOutputSchema.parse({
      ...output,
      source: {
        ...output.source,
        root: {
          ...output.source.root,
          children: [
            { kind: 'step', id: 'unknown-step', uses: 'unknown.step@1', with: {} },
            ...output.source.root.children,
          ],
        },
      },
    });
    const runB = service.assembleFromAnalyzerOutputAtOperation(
      task,
      invalidOutput,
      receipt('session-run-b'),
      operationB,
    );

    expect(runA).toMatchObject({ ok: true, value: { status: 'ready' } });
    expect(runB).toMatchObject({ ok: true, value: { status: 'rejected' } });
    expect(service.readPlanningOperation(task.reference, operationA)).toEqual(runA);
    expect(service.readPlanningOperation(task.reference, operationB)).toEqual(runB);
    expect(service.readActivity(task.reference, episodeA)).toMatchObject({
      ok: true,
      value: { providerSession: { sessionId: 'session-run-a' } },
    });
    expect(service.readActivity(task.reference, episodeB)).toMatchObject({
      ok: true,
      value: { providerSession: { sessionId: 'session-run-b' } },
    });
    expect(
      ledger.repository.readProjection(OPERATOR_WORKFLOW_OPERATION_PROJECTION, operationA)?.payload,
    ).toMatchObject({ workflow: { status: 'valid' } });
    expect(
      ledger.repository.readProjection(OPERATOR_WORKFLOW_OPERATION_PROJECTION, operationB)?.payload,
    ).toMatchObject({ workflow: { status: 'rejected' } });
    ledger.close();
  });

  it('deduplicates one exact operation without accepting another run as its result', () => {
    const clock = makeAdjustableClock('2026-08-01T12:00:00.000Z');
    const ledger = openSqliteLedger({ filename: databasePath(), clock });
    const service = createOperatorWorkflowService(ledger.repository, clock);
    const task = makePlanningTaskSnapshot();
    const output = makeAnalyzerOutput();
    const episode = 'tasker:v3:task:run-provider:planning';
    const operationId = `${episode}:workflow-candidate:1`;
    const first = service.assembleFromAnalyzerOutputAtOperation(
      task,
      output,
      receipt('session-first'),
      operationId,
    );
    const duplicate = service.assembleFromAnalyzerOutputAtOperation(
      task,
      output,
      receipt('session-ignored'),
      operationId,
    );

    expect(duplicate).toEqual(first);
    expect(service.readActivity(task.reference, episode)).toMatchObject({
      ok: true,
      value: { providerSession: { sessionId: 'session-first' } },
    });
    ledger.close();
  });

  it('restores an immutable continuation subject after restart', () => {
    const filename = databasePath();
    const clock = makeAdjustableClock('2026-08-03T12:00:00.000Z');
    const taskReference = 'continuation:task:run-scope-1';
    const subject = {
      schemaVersion: 1 as const,
      repositoryPath: '/managed/twiket-ui-kit',
      task: makePlanningTaskSnapshot('avia-13236-short-bug', {
        origin: 'workflow_continuation',
        reference: taskReference,
        repository: 'twiket/ui-kit',
      }),
      taskSnapshot: { origin: 'workflow_continuation', parentTaskReference: 'jira:AVIA-13236' },
    };
    const firstLedger = openSqliteLedger({ filename, clock });
    const firstService = createOperatorWorkflowService(firstLedger.repository, clock);
    expect(firstService.saveGenerationSubject(taskReference, subject)).toEqual({
      ok: true,
      value: subject,
    });
    firstLedger.close();

    const restartedLedger = openSqliteLedger({ filename, clock });
    const restartedService = createOperatorWorkflowService(restartedLedger.repository, clock);
    const source = new WorkflowGenerationSubjectSource(
      [new PersistedGenerationSubjectResolver(restartedService)],
      new PersistedGenerationSubjectRunStore(restartedService),
    );
    expect(source.resolve(taskReference, 'continuation-run-1')).toEqual({
      ok: true,
      value: subject,
    });
    expect(
      restartedService.saveGenerationSubject(taskReference, {
        ...subject,
        repositoryPath: '/different-checkout',
      }),
    ).toMatchObject({
      ok: false,
      error: { kind: 'store_failure', error: { kind: 'generation_subject_conflict' } },
    });
    restartedLedger.close();
  });

  it('captures independent task-source snapshots for two runs of one task', () => {
    const filename = databasePath();
    const clock = makeAdjustableClock('2026-08-03T12:00:00.000Z');
    const taskReference = 'jira:AVIA-12045';
    const subject = (description: string) => ({
      schemaVersion: 1 as const,
      repositoryPath: '/managed/front-avia',
      task: makePlanningTaskSnapshot('avia-13236-short-bug', {
        origin: 'jira',
        reference: taskReference,
        description,
      }),
      taskSnapshot: { origin: 'jira', description },
    });
    let current = subject('first Jira revision');
    const remote = { resolve: () => ({ ok: true as const, value: current }) };
    const firstLedger = openSqliteLedger({ filename, clock });
    const firstService = createOperatorWorkflowService(firstLedger.repository, clock);
    const firstSource = new WorkflowGenerationSubjectSource(
      [remote],
      new PersistedGenerationSubjectRunStore(firstService),
    );

    expect(firstSource.resolve(taskReference, 'run-a')).toEqual({ ok: true, value: current });
    current = subject('second Jira revision');
    expect(firstSource.resolve(taskReference, 'run-b')).toEqual({ ok: true, value: current });
    firstLedger.close();

    const restartedLedger = openSqliteLedger({ filename, clock });
    const restartedService = createOperatorWorkflowService(restartedLedger.repository, clock);
    const restartedSource = new WorkflowGenerationSubjectSource(
      [remote],
      new PersistedGenerationSubjectRunStore(restartedService),
    );
    expect(restartedSource.resolve(taskReference, 'run-a')).toMatchObject({
      ok: true,
      value: { task: { description: 'first Jira revision' } },
    });
    expect(restartedSource.resolve(taskReference, 'run-b')).toMatchObject({
      ok: true,
      value: { task: { description: 'second Jira revision' } },
    });
    restartedLedger.close();
  });

  it('keeps run-captured dependency declarations frozen while later runs see newer revisions', () => {
    const filename = databasePath();
    const clock = makeAdjustableClock('2026-08-25T12:00:00.000Z');
    const taskReference = 'jira:AVIA-12045';
    const remote = {
      resolve: () => ({
        ok: true as const,
        value: {
          schemaVersion: 1 as const,
          repositoryPath: '/managed/front-avia',
          task: makePlanningTaskSnapshot('avia-13236-short-bug', {
            origin: 'jira',
            reference: taskReference,
          }),
          taskSnapshot: { origin: 'jira', issue: { issueKey: 'AVIA-12045' } },
        },
      }),
    };
    const firstLedger = openSqliteLedger({ filename, clock });
    const firstService = createOperatorWorkflowService(firstLedger.repository, clock);
    const firstDeclarations = new DependencyDeclarationStore(firstLedger.repository, clock);
    const firstSource = new WorkflowGenerationSubjectSource(
      [new DependencyDeclarationGenerationSubjectResolver(remote, firstDeclarations)],
      new PersistedGenerationSubjectRunStore(firstService),
    );

    const initialDeclaration = firstDeclarations.declare({
      consumerTaskReference: taskReference,
      producerTaskReference: 'jira:AVIA-400',
      producerRepository: 'onetwotrip/front-core-packages',
      packages: ['@ott/core-button'],
      mode: 'final_only',
      source: {
        kind: 'runtime_discovery',
        workflowRunId: 'run-a',
        requestArtifactId: 'artifact:dependency-request:1',
      },
    });
    if (!initialDeclaration.ok) throw new Error(JSON.stringify(initialDeclaration.error));

    expect(firstSource.resolve(taskReference, 'run-a')).toMatchObject({
      ok: true,
      value: {
        taskSnapshot: {
          dependencyDeclarations: [{ revision: 1, packages: ['@ott/core-button'] }],
        },
      },
    });

    const revisedDeclaration = firstDeclarations.declare({
      consumerTaskReference: taskReference,
      producerTaskReference: 'jira:AVIA-400',
      producerRepository: 'onetwotrip/front-core-packages',
      packages: ['@ott/core-button', '@ott/core-theme'],
      mode: 'final_only',
      source: {
        kind: 'runtime_discovery',
        workflowRunId: 'run-a',
        requestArtifactId: 'artifact:dependency-request:1',
      },
    });
    if (!revisedDeclaration.ok) throw new Error(JSON.stringify(revisedDeclaration.error));

    expect(firstSource.resolve(taskReference, 'run-a')).toMatchObject({
      ok: true,
      value: {
        taskSnapshot: {
          dependencyDeclarations: [{ revision: 1, packages: ['@ott/core-button'] }],
        },
      },
    });
    expect(firstSource.resolve(taskReference, 'run-b')).toMatchObject({
      ok: true,
      value: {
        taskSnapshot: {
          dependencyDeclarations: [
            { revision: 2, packages: ['@ott/core-button', '@ott/core-theme'] },
          ],
        },
      },
    });
    firstLedger.close();

    const restartedLedger = openSqliteLedger({ filename, clock });
    const restartedService = createOperatorWorkflowService(restartedLedger.repository, clock);
    const restartedDeclarations = new DependencyDeclarationStore(restartedLedger.repository, clock);
    const restartedSource = new WorkflowGenerationSubjectSource(
      [new DependencyDeclarationGenerationSubjectResolver(remote, restartedDeclarations)],
      new PersistedGenerationSubjectRunStore(restartedService),
    );
    expect(restartedSource.resolve(taskReference, 'run-a')).toMatchObject({
      ok: true,
      value: {
        taskSnapshot: {
          dependencyDeclarations: [{ revision: 1, packages: ['@ott/core-button'] }],
        },
      },
    });
    expect(restartedSource.resolve(taskReference, 'run-b')).toMatchObject({
      ok: true,
      value: {
        taskSnapshot: {
          dependencyDeclarations: [
            { revision: 2, packages: ['@ott/core-button', '@ott/core-theme'] },
          ],
        },
      },
    });
    restartedLedger.close();
  });
});
