import { Buffer } from 'node:buffer';
import { extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import type { WorkspaceCommandRunner } from '../../agents/command-runner.js';
import { JsonValueSchema } from '../../graph/schema.js';
import type {
  IntegrationEvidenceFile,
  IntegrationEvidenceSink,
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

const AllureImageDiffSchema = z
  .object({
    expected: z.string().optional(),
    actual: z.string().optional(),
    diff: z.string().optional(),
  })
  .loose();

const ALLURE_IMAGE_DIFF = 'application/vnd.allure.image.diff';

const isVisualDiffFailure = (failure: JenkinsFinishedBuild['failures'][number]): boolean =>
  failure.attachments.some(({ type }) => type === ALLURE_IMAGE_DIFF);

export interface JenkinsObserverTime {
  now(): number;
  sleep(durationMs: number, signal: AbortSignal): Promise<void>;
}

const systemTime: JenkinsObserverTime = {
  now: () => Date.now(),
  sleep: (durationMs, signal) => delay(durationMs, undefined, { signal }),
};

const commandMessage = (result: Awaited<ReturnType<WorkspaceCommandRunner['run']>>): string => {
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
  if (result === 'ABORTED' || result === 'NOT_BUILT') return 'infrastructure';
  if (build.failures.some((failure) => isVisualDiffFailure(failure) || !failure.flaky)) {
    return 'likely_caused_by_change';
  }
  if (build.failures.length > 0 || result === 'UNSTABLE') return 'likely_flaky';
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

const terminalResult = (
  build: JenkinsFinishedBuild,
  artifactIds: readonly string[] = [],
): IntegrationStepExecutionResult => {
  const verdict = classify(build);
  const output = outputFor(build, verdict);
  return {
    status: 'completed',
    summary:
      verdict === 'passed'
        ? `Jenkins build #${String(build.number)} passed for ${build.revision.slice(0, 12)}`
        : `Jenkins build #${String(build.number)} classified as ${verdict.replaceAll('_', ' ')}`,
    output,
    artifactIds,
  };
};

const safeFilename = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 100) || 'attachment';

const dataUriBytes = (value: string): Uint8Array | null => {
  const match = /^data:[^;,]+;base64,(.+)$/u.exec(value);
  return match?.[1] === undefined ? null : new Uint8Array(Buffer.from(match[1], 'base64'));
};

const imageDiffFiles = (
  build: JenkinsFinishedBuild,
  failureUid: string,
  attachmentName: string,
  bytes: Uint8Array,
): readonly IntegrationEvidenceFile[] | null => {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch {
    return null;
  }
  const parsed = AllureImageDiffSchema.safeParse(payload);
  if (!parsed.success) return null;
  const root = `jenkins/build-${String(build.number)}/${safeFilename(failureUid)}`;
  return (['expected', 'actual', 'diff'] as const).flatMap((kind) => {
    const value = parsed.data[kind];
    if (value === undefined) return [];
    const decoded = dataUriBytes(value);
    return decoded === null
      ? []
      : [
          {
            relativePath: `${root}/${safeFilename(attachmentName)}-${kind}.png`,
            bytes: decoded,
          },
        ];
  });
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
    private readonly commands: WorkspaceCommandRunner,
    private readonly builds: JenkinsBuildPort,
    private readonly time: JenkinsObserverTime = systemTime,
    private readonly evidence: IntegrationEvidenceSink | null = null,
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
      operationId: `${request.operationId}:resolve-revision`,
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: request.workspace.path,
      workspaceAccess: 'read_only',
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
      if (observation.status === 'finished') {
        const evidence = await this.persistRepairEvidence(request, observation.build);
        return evidence.ok
          ? terminalResult(observation.build, evidence.artifactIds)
          : evidence.result;
      }
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

  private async persistRepairEvidence(
    request: IntegrationStepExecutionRequest,
    build: JenkinsFinishedBuild,
  ): Promise<
    | { readonly ok: true; readonly artifactIds: readonly string[] }
    | { readonly ok: false; readonly result: IntegrationStepExecutionResult }
  > {
    if (classify(build) !== 'likely_caused_by_change' || this.evidence === null) {
      return { ok: true, artifactIds: [] };
    }
    const files: IntegrationEvidenceFile[] = [];
    for (const failure of build.failures) {
      for (const attachment of failure.attachments) {
        const read = await this.builds.readAttachment({
          buildUrl: build.url,
          source: attachment.source,
          signal: request.runtime.cancellationSignal,
        });
        if (read.status !== 'found') {
          return {
            ok: false,
            result: {
              status: 'blocked',
              kind: 'infrastructure',
              summary: 'Cannot preserve Jenkins repair evidence',
              details:
                read.status === 'failed'
                  ? JsonValueSchema.parse(read.problem)
                  : { source: attachment.source, problem: 'attachment_not_found' },
              artifactIds: [],
            },
          };
        }
        if (attachment.type === ALLURE_IMAGE_DIFF) {
          const expanded = imageDiffFiles(build, failure.uid, attachment.name, read.bytes);
          if (expanded === null || expanded.length === 0) {
            return {
              ok: false,
              result: {
                status: 'blocked',
                kind: 'configuration',
                summary: 'Jenkins returned an invalid Allure image-diff attachment',
                details: { source: attachment.source, failureUid: failure.uid },
                artifactIds: [],
              },
            };
          }
          files.push(...expanded);
          continue;
        }
        const suffix = extname(attachment.source);
        files.push({
          relativePath: `jenkins/build-${String(build.number)}/${safeFilename(failure.uid)}/${safeFilename(attachment.name)}${suffix}`,
          bytes: read.bytes,
        });
      }
    }
    if (files.length === 0) return { ok: true, artifactIds: [] };
    const persisted = await this.evidence.persist(request.operationId, files);
    return persisted.ok
      ? { ok: true, artifactIds: persisted.artifactIds }
      : {
          ok: false,
          result: {
            status: 'blocked',
            kind: 'infrastructure',
            summary: 'Cannot persist Jenkins repair evidence',
            details: { message: persisted.message },
            artifactIds: [],
          },
        };
  }
}
