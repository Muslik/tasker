import { describe, expect, it, vi } from 'vitest';

import { loadHarnessPack } from '../../../src/harness/index.js';
import {
  JenkinsBuildClient,
  JenkinsBuildObserverAdapter,
  loadJenkinsBuildConfiguration,
  type JenkinsBuildConfiguration,
  type JenkinsBuildObservation,
  type JenkinsBuildPort,
  type JenkinsFinishedBuild,
  type JenkinsObserverTime,
} from '../../../src/integrations/index.js';
import type { CommandRunner } from '../../../src/providers/command-runner.js';
import type { IntegrationStepExecutionRequest } from '../../../src/integrations/execution.js';
import { makePlanningTaskSnapshot } from '../../support/planning.js';

const revision = 'a'.repeat(40);
const task = makePlanningTaskSnapshot('avia-13236-short-bug');
const pack = loadHarnessPack();
const project = pack.projects.find(({ repository }) => repository === task.repository);
if (project === undefined) throw new Error('Missing project profile');
const { guidance, ...projectManifest } = project;
void guidance;

const configuration: JenkinsBuildConfiguration = {
  baseUrl: 'https://jenkins.example',
  user: 'developer@example.com',
  token: 'secret-token',
  requestTimeoutMs: 1_000,
  pollIntervalMs: 10,
  observationTimeoutMs: 100,
};

const commands: CommandRunner = {
  run: () =>
    Promise.resolve({
      status: 'exited',
      exitCode: 0,
      stdout: `${revision}\n`,
      stderr: '',
      durationMs: 1,
    }),
};

const requestFor = (heartbeat = vi.fn()): IntegrationStepExecutionRequest => ({
  operationId: 'tasker:test:observe-ci:attempt-1',
  stepReference: 'ci.observe@1',
  taskReference: task.reference,
  task,
  taskSnapshot: task,
  stepInput: {
    objective: 'Observe CI',
    repository: task.repository,
    taskId: task.taskId,
  },
  workspace: {
    schemaVersion: 1,
    workspaceId: 'b'.repeat(24),
    taskReference: task.reference,
    workflowId: `tasker:${task.reference}`,
    workflowRunId: 'run-1',
    repository: {
      reference: task.repository,
      sourcePath: '/tmp/source',
      baseCommit: 'd'.repeat(40),
    },
    runnerId: 'test',
    path: '/tmp/worktree',
    branch: 'tasker/AVIA-13236/run-1',
    preparedAt: '2026-08-04T00:00:00.000Z',
  },
  operatorGuidance: null,
  evidence: { acceptedPlan: null, completedSteps: [], reviewInputs: [] },
  policies: [],
  project: projectManifest,
  runtime: {
    attempt: 1,
    cancellationSignal: new AbortController().signal,
    heartbeat,
  },
});

const build = (input: Partial<JenkinsFinishedBuild> = {}): JenkinsFinishedBuild => ({
  number: 73,
  url: 'https://jenkins.example/job/front-avia/job/tasker%252FAVIA-13236/73/',
  revision,
  result: 'SUCCESS',
  durationMs: 12_000,
  stages: [{ name: 'Tests', status: 'SUCCESS' }],
  failures: [],
  ...input,
});

const sequencedPort = (observations: readonly JenkinsBuildObservation[]): JenkinsBuildPort => {
  let index = 0;
  return {
    observe: () =>
      Promise.resolve(
        observations[Math.min(index++, observations.length - 1)] as JenkinsBuildObservation,
      ),
  };
};

const advancingTime = (): JenkinsObserverTime => {
  let now = 0;
  return {
    now: () => now,
    sleep: (durationMs) => {
      now += durationMs;
      return Promise.resolve();
    },
  };
};

describe('Jenkins build observation', () => {
  it('prefers the Tasker CI endpoint over a legacy Jenkins endpoint', () => {
    expect(
      loadJenkinsBuildConfiguration({
        TASKER_HARNESS_WORK_PATH: '/missing-harness',
        TASKER_JENKINS_BASE_URL: 'https://build.example/',
        JENKINS_BASE_URL: 'https://legacy.example',
        JENKINS_USER: 'developer@example.com',
        JENKINS_TOKEN: 'token',
      }),
    ).toMatchObject({ baseUrl: 'https://build.example' });
  });

  it('waits for the exact branch revision and completes only after it passes', async () => {
    const heartbeat = vi.fn();
    const port = sequencedPort([
      { status: 'pending', reason: 'branch_not_indexed', buildUrl: null },
      {
        status: 'pending',
        reason: 'stale_revision',
        buildUrl: 'https://jenkins.example/job/front-avia/72/',
      },
      { status: 'finished', build: build() },
    ]);
    const adapter = new JenkinsBuildObserverAdapter(configuration, commands, port, advancingTime());

    const result = await adapter.execute(requestFor(heartbeat));

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        externalId: '73',
        status: 'passed',
        build: { revision },
      },
    });
    expect(heartbeat).toHaveBeenCalledTimes(3);
  });

  it('returns product failures as classified observations for workflow recovery', async () => {
    const failure = {
      uid: 'fare-card-test',
      name: 'renders the fare card',
      status: 'failed',
      message: 'Expected card to be visible',
      flaky: false,
      attachments: [{ name: 'actual', type: 'image/png', source: 'actual.png' }],
    };
    const adapter = new JenkinsBuildObserverAdapter(
      configuration,
      commands,
      sequencedPort([
        { status: 'finished', build: build({ result: 'FAILURE', failures: [failure] }) },
      ]),
      advancingTime(),
    );

    const result = await adapter.execute(requestFor());

    expect(result).toMatchObject({
      status: 'completed',
      output: {
        status: 'likely_caused_by_change',
        failures: [{ uid: 'fare-card-test', message: 'Expected card to be visible' }],
      },
    });
  });

  it('returns flaky failures as classified observations outside the implementation budget', async () => {
    const adapter = new JenkinsBuildObserverAdapter(
      configuration,
      commands,
      sequencedPort([{ status: 'finished', build: build({ result: 'UNSTABLE' }) }]),
      advancingTime(),
    );

    const result = await adapter.execute(requestFor());

    expect(result).toMatchObject({
      status: 'completed',
      output: { status: 'likely_flaky' },
    });
  });

  it('returns unknown terminal failures for an explicit workflow decision', async () => {
    const adapter = new JenkinsBuildObserverAdapter(
      configuration,
      commands,
      sequencedPort([
        {
          status: 'finished',
          build: build({ result: 'FAILURE', stages: [], failures: [] }),
        },
      ]),
      advancingTime(),
    );

    const result = await adapter.execute(requestFor());

    expect(result).toMatchObject({
      status: 'completed',
      output: { status: 'unknown' },
    });
  });

  it('turns a Jenkins 403 into a resumable infrastructure boundary', async () => {
    const adapter = new JenkinsBuildObserverAdapter(
      configuration,
      commands,
      sequencedPort([
        {
          status: 'failed',
          problem: {
            kind: 'access_blocked',
            message: 'Jenkins returned 403. VPN or Jenkins access may be required',
            retryable: true,
            httpStatus: 403,
          },
        },
      ]),
      advancingTime(),
    );

    const result = await adapter.execute(requestFor());

    expect(result).toMatchObject({ status: 'blocked', kind: 'infrastructure' });
    expect(JSON.stringify(result)).not.toContain(configuration.token);
  });

  it('absorbs a transient Jenkins outage while the observation deadline remains', async () => {
    const adapter = new JenkinsBuildObserverAdapter(
      configuration,
      commands,
      sequencedPort([
        {
          status: 'failed',
          problem: {
            kind: 'unavailable',
            message: 'Jenkins request failed with HTTP 503',
            retryable: true,
            httpStatus: 503,
          },
        },
        { status: 'finished', build: build() },
      ]),
      advancingTime(),
    );

    await expect(adapter.execute(requestFor())).resolves.toMatchObject({ status: 'completed' });
  });

  it('bounds polling when Jenkins never indexes the task branch', async () => {
    const adapter = new JenkinsBuildObserverAdapter(
      configuration,
      commands,
      sequencedPort([{ status: 'pending', reason: 'branch_not_indexed', buildUrl: null }]),
      advancingTime(),
    );

    const result = await adapter.execute(requestFor());

    expect(result).toMatchObject({
      status: 'blocked',
      kind: 'infrastructure',
      details: { polls: 10, lastPendingReason: 'branch_not_indexed' },
    });
  });

  it('uses Jenkins basic auth and reads pipeline plus Allure evidence from same-origin URLs', async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const fetchImplementation: typeof fetch = vi.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requests.push({
          url,
          authorization: new Headers(init?.headers).get('authorization'),
        });
        const body = url.includes('tree=jobs')
          ? {
              jobs: [
                {
                  name: 'tasker%2FAVIA-13236%2Frun-1',
                  url: 'https://jenkins.example/job/front-avia/job/tasker%252FAVIA-13236/',
                },
              ],
            }
          : url.endsWith('/lastBuild/api/json')
            ? {
                number: 73,
                url: 'https://jenkins.example/job/front-avia/job/tasker%252FAVIA-13236/73/',
                building: false,
                result: 'SUCCESS',
                duration: 12_000,
                actions: [{ lastBuiltRevision: { SHA1: revision } }],
              }
            : url.endsWith('/wfapi/describe')
              ? {
                  stages: [
                    {
                      name: 'Tests',
                      status: 'SUCCESS',
                      id: '12',
                      execNode: 'built-in',
                      startTimeMillis: 1_786_455_000_000,
                      durationMillis: 12_000,
                      pauseDurationMillis: 0,
                      _links: {},
                    },
                  ],
                }
              : { uid: 'root', name: 'root', status: 'passed', children: [] };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    );
    const client = new JenkinsBuildClient(configuration, fetchImplementation);

    const result = await client.observe({
      job: 'front-avia',
      branch: 'tasker/AVIA-13236/run-1',
      expectedRevision: revision,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: 'finished', build: { result: 'SUCCESS', revision } });
    expect(requests).toHaveLength(4);
    expect(
      requests.every(({ authorization }) => authorization?.startsWith('Basic ') === true),
    ).toBe(true);
    expect(requests.every(({ url }) => new URL(url).origin === 'https://jenkins.example')).toBe(
      true,
    );
  });

  it('keeps polling while a new build has not published its revision action yet', async () => {
    const fetchImplementation: typeof fetch = vi.fn((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = url.includes('tree=jobs')
        ? {
            jobs: [
              {
                name: 'tasker%2FAVIA-13236%2Frun-1',
                url: 'https://jenkins.example/job/front-avia/job/tasker%252FAVIA-13236/',
              },
            ],
          }
        : {
            number: 73,
            url: 'https://jenkins.example/job/front-avia/job/tasker%252FAVIA-13236/73/',
            building: true,
            result: null,
            duration: 0,
            actions: [],
          };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    const client = new JenkinsBuildClient(configuration, fetchImplementation);

    await expect(
      client.observe({
        job: 'front-avia',
        branch: 'tasker/AVIA-13236/run-1',
        expectedRevision: revision,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      status: 'pending',
      reason: 'building',
      buildUrl: 'https://jenkins.example/job/front-avia/job/tasker%252FAVIA-13236/73/',
    });
  });
});
