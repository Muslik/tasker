import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadHarnessPack } from '../../../src/harness/index.js';
import {
  AiAssistanceInitializeAdapter,
  AiAssistanceRecordPlanAdapter,
  AiAssistanceValidateAdapter,
  ExternalEffectStore,
  type IntegrationStepExecutionRequest,
} from '../../../src/integrations/index.js';
import { openSqliteLedger, type SqliteLedger } from '../../../src/ledger/index.js';
import { findTaskFixture } from '../../../src/planning/index.js';
import { systemClock } from '../../../src/shared/clock.js';
import type { JsonValue } from '../../../src/workflow/index.js';

const task = findTaskFixture('avia-13236-short-bug');
if (task === undefined) throw new Error('Missing task fixture');

const temporaryDirectories: string[] = [];
let ledger: SqliteLedger | undefined;

const acceptedPlan: JsonValue = {
  artifactId: 'implementation-plan:avia-13236:attempt-1',
  attempt: 1,
  selectedStrategy: 'fast',
  plan: {
    schemaVersion: 1,
    title: 'Restore the fare card',
    summary: 'Repair the localized rendering regression.',
    steps: [
      {
        id: 'repair-card',
        title: 'Repair card rendering',
        objective: 'Preserve the fare card when baggage data is absent.',
        repository: task.repository,
        files: ['src/features/fare-card'],
        verification: ['pnpm test fare-card'],
      },
    ],
    assumptions: [],
    risks: [],
    acceptanceCriteria: ['The fare card remains visible without baggage data.'],
  },
};

const requestFor = async (
  stepReference: string,
  evidence: IntegrationStepExecutionRequest['evidence'] = {
    acceptedPlan: null,
    completedSteps: [],
    reviewInputs: [],
  },
): Promise<IntegrationStepExecutionRequest> => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'tasker-ai-assistance-'));
  temporaryDirectories.push(workspacePath);
  return {
    operationId: `tasker:test:${stepReference}`,
    stepReference,
    taskReference: task.fixtureId,
    task,
    taskSnapshot: task,
    stepInput: {
      objective: task.title,
      repository: task.repository,
      taskId: task.taskId,
      ...(stepReference.endsWith('validate@1')
        ? { draftPath: '.tasker/pull-request/draft.json' }
        : {}),
    },
    workspace: {
      schemaVersion: 1,
      workspaceId: 'a'.repeat(24),
      taskReference: task.fixtureId,
      workflowId: `tasker:${task.fixtureId}`,
      workflowRunId: 'run-1',
      workflowHash: 'b'.repeat(64),
      repository: {
        reference: task.repository,
        sourcePath: workspacePath,
        baseCommit: 'c'.repeat(40),
      },
      runnerId: 'test',
      path: workspacePath,
      branch: 'tasker/avia-13236/run-1',
      preparedAt: '2026-08-04T00:00:00.000Z',
    },
    operatorGuidance: null,
    evidence,
    policies: loadHarnessPack().policies,
    project: null,
    runtime: {
      attempt: 1,
      cancellationSignal: new AbortController().signal,
      heartbeat: () => {},
    },
  };
};

afterEach(async () => {
  ledger?.close();
  ledger = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('AI-assistance workflow adapters', () => {
  it('reconciles the initialized README without overwriting a later conflicting edit', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const adapter = new AiAssistanceInitializeAdapter(
      new ExternalEffectStore(ledger.repository, systemClock),
    );
    const request = await requestFor(adapter.id);
    const path = join(request.workspace.path, '.ai/workspace/AVIA-13236/README.md');
    await adapter.execute(request);
    await writeFile(path, '# operator edit\n', 'utf8');

    const result = await adapter.execute(request);

    expect(result).toMatchObject({ status: 'blocked', kind: 'remote_conflict' });
    await expect(readFile(path, 'utf8')).resolves.toBe('# operator edit\n');
  });

  it('records the accepted ledger plan before implementation', async () => {
    ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
    const adapter = new AiAssistanceRecordPlanAdapter(
      new ExternalEffectStore(ledger.repository, systemClock),
    );
    const request = await requestFor(adapter.id, {
      acceptedPlan,
      completedSteps: [],
      reviewInputs: [],
    });

    const result = await adapter.execute(request);

    expect(result).toMatchObject({ status: 'completed' });
    await expect(
      readFile(join(request.workspace.path, '.ai/workspace/AVIA-13236/plan.md'), 'utf8'),
    ).resolves.toContain('Source artifact: implementation-plan:avia-13236:attempt-1');
  });

  it('accepts matching branch artifacts and pull-request section', async () => {
    const adapter = new AiAssistanceValidateAdapter();
    const request = await requestFor(adapter.id, {
      acceptedPlan,
      completedSteps: [],
      reviewInputs: [],
    });
    const taskRoot = join(request.workspace.path, '.ai/workspace/AVIA-13236');
    const pullRequestRoot = join(request.workspace.path, '.tasker/pull-request');
    await mkdir(taskRoot, { recursive: true });
    await mkdir(pullRequestRoot, { recursive: true });
    const level = 'Full Generation (>80%)';
    const section = `## AI assistance\n\n- AI assistance: ${level}\n- Tools: Codex\n\n### Summary\n\nАгент выполнил задачу, автор проверил результат.\n`;
    await writeFile(
      join(taskRoot, 'README.md'),
      `# AVIA-13236\n\n- AI assistance: ${level}\n\n## Agent contribution\n\nАгент выполнил задачу.\n`,
      'utf8',
    );
    await writeFile(
      join(taskRoot, 'plan.md'),
      '# Plan\n\nAccepted implementation plan evidence.\n',
      'utf8',
    );
    await writeFile(
      join(taskRoot, 'result.md'),
      '# Result\n\nThe reported behavior was repaired.\n',
      'utf8',
    );
    await writeFile(
      join(taskRoot, 'verification.md'),
      '# Verification\n\n`pnpm test fare-card` passed.\n',
      'utf8',
    );
    await writeFile(join(pullRequestRoot, 'ai-assistance.md'), section, 'utf8');
    await writeFile(
      join(pullRequestRoot, 'draft.json'),
      `${JSON.stringify({
        title: 'AVIA-13236: Restore fare card',
        description: section,
        branchArtifacts: [
          '.ai/workspace/AVIA-13236/README.md',
          '.ai/workspace/AVIA-13236/plan.md',
          '.ai/workspace/AVIA-13236/result.md',
          '.ai/workspace/AVIA-13236/verification.md',
        ],
      })}\n`,
      'utf8',
    );

    const result = await adapter.execute(request);

    expect(result).toMatchObject({
      status: 'completed',
      output: { status: 'valid' },
    });
  });
});
