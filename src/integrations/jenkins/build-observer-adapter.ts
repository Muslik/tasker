import { setTimeout as delay } from 'node:timers/promises';

import type { CommandRunner } from '../../providers/command-runner.js';
import { JsonValueSchema } from '../../workflow/schema.js';
import type {
  IntegrationStepAdapter,
  IntegrationStepExecutionRequest,
  IntegrationStepExecutionResult,
} from '../execution.js';
import type {
  JenkinsBuildConfiguration,
  JenkinsBuildObservation,
  JenkinsBuildPort,
  JenkinsFinishedBuild,
} from './builds.js';

type JenkinsVerdict =
  'passed' | 'likely_caused_by_change' | 'likely_flaky' | 'infrastructure' | 'unknown';

export interface JenkinsObserverTime {
  now(): number;
  sleep(durationMs: number, signal: AbortSignal): Promise<void>;
}

const systemTime: JenkinsObserverTime = {
  now: () => Date.now(),
  sleep: (durationMs, signal) => delay(durationMs, undefined, { signal }),
};

const commandMessage = (result: Awaited<ReturnType<CommandRunner['run']>>): string => {
  switch (result.status) {
    case 'spawn_failed':
      return result.message;
    case 'timed_out':
      return result.stderr.trim() || 'git rev-parse timed out';
    case 'exited':
      return result.stderr.trim() || `git rev-parse exited with ${String(result.exitCode)}`;
  }
};

const classify = (build: JenkinsFinishedBuild): JenkinsVerdict => {
  const result = build.result.toLocaleUpperCase('en-US');
  if (result === 'SUCCESS') return 'passed';
  if (result === 'UNSTABLE' || build.failures.some(({ flaky }) => flaky)) return 'likely_flaky';
  if (result === 'ABORTED' || result === 'NOT_BUILT') return 'infrastructure';
  if (build.failures.length > 0) return 'likely_caused_by_change';
  const failedStages = build.stages
    .filter(({ status }) => ['FAILED', 'ABORTED'].includes(status.toLocaleUpperCase('en-US')))
    .map(({ name }) => name.toLocaleLowerCase('en-US'));
  if (failedStages.some((name) => /agent|checkout|docker|infrastructure|provision/u.test(name))) {
    return 'infrastructure';
  }
  if (failedStages.some((name) => /build|compile|lint|snapshot|test|typecheck/u.test(name))) {
    return 'likely_caused_by_change';
  }
  return 'unknown';
};

const outputFor = (build: JenkinsFinishedBuild, status: JenkinsVerdict) =>
  JsonValueSchema.parse({
    externalId: String(build.number),
    status,
    provider: 'jenkins',
    build: {
      number: build.number,
      url: build.url,
      revision: build.revision,
      result: build.result,
      durationMs: build.durationMs,
    },
    stages: build.stages,
    failures: build.failures,
  });

const terminalResult = (build: JenkinsFinishedBuild): IntegrationStepExecutionResult => {
  const verdict = classify(build);
  const output = outputFor(build, verdict);
  if (verdict === 'passed') {
    return {
      status: 'completed',
      summary: `Jenkins build #${String(build.number)} passed for ${build.revision.slice(0, 12)}`,
      output,
      artifactIds: [],
    };
  }
  return {
    status: 'blocked',
    kind:
      verdict === 'likely_caused_by_change'
        ? 'verification'
        : verdict === 'unknown'
          ? 'unknown_outcome'
          : 'infrastructure',
    summary: `Jenkins build #${String(build.number)} requires attention: ${verdict.replaceAll('_', ' ')}`,
    details: output,
    artifactIds: [],
  };
};

const problemResult = (
  observation: Extract<JenkinsBuildObservation, { readonly status: 'failed' }>,
): IntegrationStepExecutionResult => ({
  status: 'blocked',
  kind:
    observation.problem.kind === 'access_blocked' || observation.problem.kind === 'unavailable'
      ? 'infrastructure'
      : 'configuration',
  summary: observation.problem.message,
  details: JsonValueSchema.parse(observation.problem),
  artifactIds: [],
});

export class JenkinsBuildObserverAdapter implements IntegrationStepAdapter {
  public readonly id = 'jenkins.build@1';

  public constructor(
    private readonly configuration: JenkinsBuildConfiguration,
    private readonly commands: CommandRunner,
    private readonly builds: JenkinsBuildPort,
    private readonly time: JenkinsObserverTime = systemTime,
  ) {}

  public async execute(
    request: IntegrationStepExecutionRequest,
  ): Promise<IntegrationStepExecutionResult> {
    if (request.project?.ci.kind !== 'jenkins') {
      return {
        status: 'blocked',
        kind: 'configuration',
        summary: 'The snapshotted project has no Jenkins job mapping',
        details: { repository: request.workspace.repository.reference },
        artifactIds: [],
      };
    }
    const revision = await this.commands.run({
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: request.workspace.path,
      stdin: '',
      timeoutMs: 10_000,
      cancellationSignal: request.runtime.cancellationSignal,
    });
    if (revision.status !== 'exited' || revision.exitCode !== 0) {
      return {
        status: 'blocked',
        kind: 'infrastructure',
        summary: 'Cannot resolve the exact commit expected in Jenkins',
        details: { message: commandMessage(revision) },
        artifactIds: [],
      };
    }
    const expectedRevision = revision.stdout.trim();
    if (!/^[a-f0-9]{40,64}$/u.test(expectedRevision)) {
      return {
        status: 'blocked',
        kind: 'invalid_request',
        summary: 'The managed worktree returned an invalid Git revision',
        details: { revision: expectedRevision },
        artifactIds: [],
      };
    }

    const deadline = this.time.now() + this.configuration.observationTimeoutMs;
    let polls = 0;
    let pending: Extract<JenkinsBuildObservation, { readonly status: 'pending' }> | null = null;
    let transientProblem:
      Extract<JenkinsBuildObservation, { readonly status: 'failed' }>['problem'] | null = null;
    while (this.time.now() < deadline) {
      request.runtime.cancellationSignal.throwIfAborted();
      polls += 1;
      request.runtime.heartbeat({
        phase: 'jenkins_observation',
        job: request.project.ci.job,
        branch: request.workspace.branch,
        expectedRevision,
        polls,
        pending: pending?.reason ?? null,
        transientProblem: transientProblem?.kind ?? null,
      });
      const observation = await this.builds.observe({
        job: request.project.ci.job,
        branch: request.workspace.branch,
        expectedRevision,
        signal: request.runtime.cancellationSignal,
      });
      if (observation.status === 'finished') return terminalResult(observation.build);
      if (observation.status === 'failed') {
        if (observation.problem.kind !== 'unavailable' || !observation.problem.retryable) {
          return problemResult(observation);
        }
        transientProblem = observation.problem;
      } else {
        pending = observation;
        transientProblem = null;
      }
      await this.time.sleep(this.configuration.pollIntervalMs, request.runtime.cancellationSignal);
    }
    return {
      status: 'blocked',
      kind: 'infrastructure',
      summary: 'Jenkins did not produce a terminal build for the exact task commit in time',
      details: {
        job: request.project.ci.job,
        branch: request.workspace.branch,
        expectedRevision,
        polls,
        lastPendingReason: pending?.reason ?? null,
        lastBuildUrl: pending?.buildUrl ?? null,
        lastTransientProblem: transientProblem?.kind ?? null,
      },
      artifactIds: [],
    };
  }
}
