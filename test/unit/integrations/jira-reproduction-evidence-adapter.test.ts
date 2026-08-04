import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadHarnessPack } from '../../../src/harness/index.js';
import {
  ExternalEffectStore,
  JiraReproductionEvidenceAdapter,
  type JiraAttachmentObservation,
  type JiraAttachmentPort,
  type JiraLifecycleMutation,
} from '../../../src/integrations/index.js';
import type { IntegrationStepExecutionRequest } from '../../../src/integrations/execution.js';
import { openSqliteLedger, type SqliteLedger } from '../../../src/ledger/index.js';
import { findTaskFixture, TaskFixtureSchema } from '../../../src/planning/index.js';
import { systemClock } from '../../../src/shared/clock.js';

const sourceTask = findTaskFixture('avia-13236-short-bug');
if (sourceTask === undefined) throw new Error('Missing bug test fixture');
const task = TaskFixtureSchema.parse({
  ...sourceTask,
  origin: 'jira',
  fixtureId: 'jira:AVIA-13236',
});
const jiraPolicy = loadHarnessPack().policies.find(({ id }) => id === 'jira-reproduction-evidence');
if (jiraPolicy === undefined) throw new Error('Missing Jira reproduction policy');

const requestFor = (
  operationId: string,
  workspacePath: string,
  evidence: readonly {
    readonly kind: 'video' | 'image' | 'log';
    readonly path: string;
    readonly mimeType: string;
  }[] = [{ kind: 'video', path: 'evidence/seatmap.mp4', mimeType: 'video/mp4' }],
): IntegrationStepExecutionRequest => ({
  operationId,
  stepReference: 'jira.attach-reproduction@1',
  taskReference: task.fixtureId,
  task,
  taskSnapshot: { origin: 'jira', issue: { issueKey: task.taskId } },
  stepInput: { objective: task.title, repository: task.repository, taskId: task.taskId },
  workspace: {
    schemaVersion: 1,
    workspaceId: 'a'.repeat(24),
    taskReference: task.fixtureId,
    workflowId: `tasker:${task.fixtureId}`,
    workflowRunId: 'run-1',
    workflowHash: 'b'.repeat(64),
    repository: {
      reference: task.repository,
      sourcePath: '/repositories/front-avia',
      baseCommit: 'c'.repeat(40),
    },
    runnerId: 'test',
    path: workspacePath,
    branch: 'tasker/avia-13236/run-1',
    preparedAt: '2026-08-04T00:00:00.000Z',
  },
  operatorGuidance: null,
  evidence: {
    acceptedPlan: null,
    completedSteps: [
      {
        operationId: 'workflow:reproduce:attempt-1',
        nodeId: 'reproduce-before',
        stepReference: 'bug.reproduce@1',
        status: 'completed',
        summary: 'Bug reproduced',
        artifactIds: ['reproduction:before'],
        details: {
          output: {
            summary: 'Bug reproduced with visible evidence',
            phase: 'before',
            outcome: 'reproduced',
            evidence: [...evidence],
          },
        },
        recordedAt: '2026-08-04T00:01:00.000Z',
      },
    ],
    reviewInputs: [],
  },
  policies: [jiraPolicy],
  project: null,
  runtime: {
    attempt: 1,
    cancellationSignal: new AbortController().signal,
    heartbeat: () => {},
  },
});

class StatefulJiraAttachmentPort implements JiraAttachmentPort {
  public attachments: {
    readonly id: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly size: number;
  }[] = [];
  public readonly uploadCalls: {
    readonly filename: string;
    readonly mimeType: string;
    readonly content: Uint8Array;
  }[] = [];
  public mode: 'normal' | 'forbidden' | 'lose-response' = 'normal';
  public forbiddenUploadCall: number | null = null;

  public listAttachments(): Promise<JiraAttachmentObservation> {
    return Promise.resolve({ status: 'observed', attachments: this.attachments });
  }

  public uploadAttachment(
    _issueKey: string,
    attachment: {
      readonly filename: string;
      readonly mimeType: string;
      readonly content: Uint8Array;
    },
  ): Promise<JiraLifecycleMutation> {
    this.uploadCalls.push({ ...attachment, content: Uint8Array.from(attachment.content) });
    if (this.mode === 'forbidden' || this.uploadCalls.length === this.forbiddenUploadCall) {
      return Promise.resolve({
        status: 'failed',
        problem: {
          kind: 'access_blocked',
          message: 'Jira returned 403. VPN required',
          retryable: true,
          httpStatus: 403,
        },
      });
    }
    this.attachments.push({
      id: String(this.attachments.length + 1),
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.content.byteLength,
    });
    return Promise.resolve(
      this.mode === 'lose-response'
        ? {
            status: 'failed',
            problem: {
              kind: 'unavailable',
              message: 'response lost after request',
              retryable: true,
            },
          }
        : { status: 'accepted' },
    );
  }
}

let ledger: SqliteLedger | undefined;
const directories: string[] = [];

afterEach(async () => {
  ledger?.close();
  ledger = undefined;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const workspaceWithVideo = async (): Promise<{ readonly path: string; readonly bytes: Buffer }> => {
  const path = await mkdtemp(join(tmpdir(), 'tasker-jira-evidence-'));
  directories.push(path);
  await mkdir(join(path, 'evidence'));
  const bytes = Buffer.from('deterministic before video');
  await writeFile(join(path, 'evidence/seatmap.mp4'), bytes);
  return { path, bytes };
};

const adapterFor = (jira: JiraAttachmentPort): JiraReproductionEvidenceAdapter => {
  ledger = openSqliteLedger({ filename: ':memory:', clock: systemClock });
  return new JiraReproductionEvidenceAdapter(
    jira,
    new ExternalEffectStore(ledger.repository, systemClock),
  );
};

describe('Jira reproduction-evidence effect adapter', () => {
  it('uploads successful before media under a content-addressed filename', async () => {
    const workspace = await workspaceWithVideo();
    const jira = new StatefulJiraAttachmentPort();

    const result = await adapterFor(jira).execute(
      requestFor('workflow:jira-evidence:attempt-1', workspace.path),
    );

    const hash = createHash('sha256').update(workspace.bytes).digest('hex').slice(0, 12);
    expect(result).toMatchObject({
      status: 'completed',
      output: { externalId: 'AVIA-13236', status: 'attached:1' },
    });
    expect(jira.uploadCalls).toHaveLength(1);
    expect(jira.uploadCalls[0]).toMatchObject({
      filename: `seatmap-before-${hash}.mp4`,
      mimeType: 'video/mp4',
    });
    expect(Buffer.from(jira.uploadCalls[0]?.content ?? [])).toEqual(workspace.bytes);
  });

  it('reconciles a lost upload response without duplicating the attachment', async () => {
    const workspace = await workspaceWithVideo();
    const jira = new StatefulJiraAttachmentPort();
    jira.mode = 'lose-response';
    const adapter = adapterFor(jira);
    const request = requestFor('workflow:jira-evidence:attempt-1', workspace.path);

    const first = await adapter.execute(request);
    const redelivered = await adapter.execute(request);

    expect(first).toMatchObject({ status: 'completed' });
    expect(redelivered).toMatchObject({ status: 'completed' });
    expect(jira.uploadCalls).toHaveLength(1);
    expect(jira.attachments).toHaveLength(1);
  });

  it('resumes after 403 and reuses existing evidence across a later attempt', async () => {
    const workspace = await workspaceWithVideo();
    const jira = new StatefulJiraAttachmentPort();
    jira.mode = 'forbidden';
    const adapter = adapterFor(jira);

    const blocked = await adapter.execute(
      requestFor('workflow:jira-evidence:attempt-1', workspace.path),
    );
    jira.mode = 'normal';
    const resumed = await adapter.execute(
      requestFor('workflow:jira-evidence:attempt-2', workspace.path),
    );
    const repeated = await adapter.execute(
      requestFor('workflow:jira-evidence:attempt-3', workspace.path),
    );

    expect(blocked).toMatchObject({ status: 'blocked', kind: 'infrastructure' });
    expect(resumed).toMatchObject({ status: 'completed' });
    expect(repeated).toMatchObject({ status: 'completed' });
    expect(jira.uploadCalls).toHaveLength(2);
    expect(jira.attachments).toHaveLength(1);
  });

  it('resumes a partial batch without uploading the completed attachment again', async () => {
    const workspace = await workspaceWithVideo();
    const secondBytes = Buffer.from('second deterministic before video');
    await writeFile(join(workspace.path, 'evidence/seatmap-mobile.mp4'), secondBytes);
    const jira = new StatefulJiraAttachmentPort();
    jira.forbiddenUploadCall = 2;
    const adapter = adapterFor(jira);
    const evidence = [
      { kind: 'video' as const, path: 'evidence/seatmap.mp4', mimeType: 'video/mp4' },
      {
        kind: 'video' as const,
        path: 'evidence/seatmap-mobile.mp4',
        mimeType: 'video/mp4',
      },
    ];

    const blocked = await adapter.execute(
      requestFor('workflow:jira-evidence:attempt-1', workspace.path, evidence),
    );
    jira.forbiddenUploadCall = null;
    const resumed = await adapter.execute(
      requestFor('workflow:jira-evidence:attempt-2', workspace.path, evidence),
    );

    expect(blocked).toMatchObject({ status: 'blocked', kind: 'infrastructure' });
    expect(resumed).toMatchObject({ status: 'completed', output: { status: 'attached:2' } });
    expect(jira.uploadCalls).toHaveLength(3);
    expect(
      jira.uploadCalls.filter(({ filename }) => filename.startsWith('seatmap-before-')),
    ).toHaveLength(1);
    expect(jira.attachments).toHaveLength(2);
  });

  it('completes without a Jira write when reproduction produced no selected media', async () => {
    const workspace = await workspaceWithVideo();
    const jira = new StatefulJiraAttachmentPort();

    const result = await adapterFor(jira).execute(
      requestFor('workflow:jira-evidence:attempt-1', workspace.path, [
        { kind: 'log', path: 'evidence/reproduction.log', mimeType: 'text/plain' },
      ]),
    );

    expect(result).toMatchObject({ status: 'completed', output: { status: 'no_media' } });
    expect(jira.uploadCalls).toEqual([]);
  });

  it('refuses evidence that resolves outside the managed worktree', async () => {
    const workspace = await workspaceWithVideo();
    const outside = await mkdtemp(join(tmpdir(), 'tasker-jira-evidence-outside-'));
    directories.push(outside);
    const outsideVideo = join(outside, 'outside.mp4');
    await writeFile(outsideVideo, 'outside bytes');
    await symlink(outsideVideo, join(workspace.path, 'evidence/escaped.mp4'));
    const jira = new StatefulJiraAttachmentPort();

    const result = await adapterFor(jira).execute(
      requestFor('workflow:jira-evidence:attempt-1', workspace.path, [
        { kind: 'video', path: 'evidence/escaped.mp4', mimeType: 'video/mp4' },
      ]),
    );

    expect(result).toMatchObject({ status: 'blocked', kind: 'verification' });
    expect(jira.uploadCalls).toEqual([]);
  });
});
