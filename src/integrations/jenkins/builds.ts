import { Buffer } from 'node:buffer';

import { z } from 'zod';

import { loadHarnessEnvironmentDefaults } from '../../shared/env-file.js';

const DEFAULT_BASE_URL = 'https://build.twiket.com';

const JenkinsBuildConfigurationSchema = z
  .object({
    baseUrl: z.httpUrl(),
    user: z.string().min(1),
    token: z.string().min(1),
    requestTimeoutMs: z.number().int().positive(),
    pollIntervalMs: z.number().int().positive(),
    observationTimeoutMs: z.number().int().positive(),
  })
  .strict();

const RawBranchPageSchema = z
  .object({
    jobs: z.array(z.object({ name: z.string().min(1), url: z.httpUrl() }).loose()).default([]),
  })
  .loose();

const RawBuildSchema = z
  .object({
    number: z.number().int().nonnegative(),
    url: z.httpUrl(),
    building: z.boolean(),
    result: z.string().nullable(),
    duration: z.number().int().nonnegative().default(0),
    actions: z
      .array(
        z
          .object({
            lastBuiltRevision: z
              .object({ SHA1: z.string().min(1) })
              .loose()
              .optional(),
          })
          .loose(),
      )
      .default([]),
  })
  .loose();

const RawStageResponseSchema = z
  .object({
    stages: z
      .array(z.object({ name: z.string().min(1), status: z.string().min(1) }).loose())
      .default([]),
  })
  .loose();

const RawAllureNodeSchema = z
  .object({
    uid: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    flaky: z.boolean().optional(),
    children: z.array(z.unknown()).optional(),
  })
  .loose();

const RawAllureCaseSchema = z
  .object({
    statusMessage: z.string().optional(),
    flaky: z.boolean().optional(),
    attachments: z.array(z.unknown()).optional(),
    steps: z.array(z.unknown()).optional(),
    testStage: z.unknown().optional(),
    beforeStages: z.array(z.unknown()).optional(),
    afterStages: z.array(z.unknown()).optional(),
  })
  .loose();

const RawAttachmentSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  source: z.string().min(1),
});

export type JenkinsBuildConfiguration = z.infer<typeof JenkinsBuildConfigurationSchema>;

export interface JenkinsStage {
  readonly name: string;
  readonly status: string;
}

export interface JenkinsTestFailure {
  readonly uid: string;
  readonly name: string;
  readonly status: string;
  readonly message: string | null;
  readonly flaky: boolean;
  readonly attachments: readonly {
    readonly name: string;
    readonly type: string;
    readonly source: string;
  }[];
}

export interface JenkinsFinishedBuild {
  readonly number: number;
  readonly url: string;
  readonly revision: string;
  readonly result: string;
  readonly durationMs: number;
  readonly stages: readonly JenkinsStage[];
  readonly failures: readonly JenkinsTestFailure[];
}

export type JenkinsBuildProblem = {
  readonly kind:
    'access_blocked' | 'auth_failed' | 'invalid_response' | 'job_not_found' | 'unavailable';
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
};

export type JenkinsBuildObservation =
  | {
      readonly status: 'pending';
      readonly reason: 'branch_not_indexed' | 'build_not_started' | 'building' | 'stale_revision';
      readonly buildUrl: string | null;
    }
  | { readonly status: 'finished'; readonly build: JenkinsFinishedBuild }
  | { readonly status: 'failed'; readonly problem: JenkinsBuildProblem };

export type JenkinsAttachmentObservation =
  | { readonly status: 'found'; readonly bytes: Uint8Array }
  | { readonly status: 'not_found' }
  | { readonly status: 'failed'; readonly problem: JenkinsBuildProblem };

export interface JenkinsBuildPort {
  observe(input: {
    readonly job: string;
    readonly branch: string;
    readonly expectedRevision: string;
    readonly signal: AbortSignal;
  }): Promise<JenkinsBuildObservation>;
  readAttachment(input: {
    readonly buildUrl: string;
    readonly source: string;
    readonly signal: AbortSignal;
  }): Promise<JenkinsAttachmentObservation>;
}

type FetchImplementation = typeof fetch;

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const loadJenkinsBuildConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): JenkinsBuildConfiguration | null => {
  const defaults = loadHarnessEnvironmentDefaults(environment);
  const parsed = JenkinsBuildConfigurationSchema.safeParse({
    baseUrl:
      environment.TASKER_JENKINS_BASE_URL ?? defaults.TASKER_JENKINS_BASE_URL ?? DEFAULT_BASE_URL,
    user: environment.JENKINS_USER ?? defaults.JENKINS_USER,
    token: environment.JENKINS_TOKEN ?? defaults.JENKINS_TOKEN,
    requestTimeoutMs: positiveInteger(environment.TASKER_JENKINS_REQUEST_TIMEOUT_MS, 15_000),
    pollIntervalMs: positiveInteger(environment.TASKER_JENKINS_POLL_INTERVAL_MS, 15_000),
    observationTimeoutMs: positiveInteger(
      environment.TASKER_JENKINS_OBSERVATION_TIMEOUT_MS,
      30 * 60_000,
    ),
  });
  return parsed.success
    ? { ...parsed.data, baseUrl: parsed.data.baseUrl.replace(/\/$/u, '') }
    : null;
};

const problemForStatus = (status: number): JenkinsBuildProblem => {
  if (status === 401) {
    return {
      kind: 'auth_failed',
      message: 'Jenkins rejected the configured user/token credentials',
      retryable: false,
      httpStatus: status,
    };
  }
  if (status === 403) {
    return {
      kind: 'access_blocked',
      message: 'Jenkins returned 403. VPN or Jenkins access may be required',
      retryable: true,
      httpStatus: status,
    };
  }
  return {
    kind: 'unavailable',
    message: `Jenkins request failed with HTTP ${String(status)}`,
    retryable: status >= 500,
    httpStatus: status,
  };
};

const jobPath = (job: string): string =>
  job
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => `/job/${encodeURIComponent(segment)}`)
    .join('');

const branchNameMatches = (candidate: string, expected: string): boolean => {
  if (candidate === expected) return true;
  try {
    return decodeURIComponent(candidate) === expected;
  } catch {
    return false;
  }
};

const collectAttachments = (
  value: unknown,
  output: z.infer<typeof RawAttachmentSchema>[],
): void => {
  if (Array.isArray(value)) {
    for (const child of value) collectAttachments(child, output);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Readonly<Record<string, unknown>>;
  const attachment = RawAttachmentSchema.safeParse(record);
  if (attachment.success) output.push(attachment.data);
  for (const key of ['attachments', 'steps', 'testStage', 'beforeStages', 'afterStages']) {
    if (key in record) collectAttachments(record[key], output);
  }
};

const collectFailures = (
  value: unknown,
  output: { uid: string; name: string; status: string; flaky: boolean }[],
): void => {
  const parsed = RawAllureNodeSchema.safeParse(value);
  if (!parsed.success) return;
  if (parsed.data.children !== undefined && parsed.data.children.length > 0) {
    for (const child of parsed.data.children) collectFailures(child, output);
    return;
  }
  if (
    parsed.data.uid !== undefined &&
    parsed.data.name !== undefined &&
    parsed.data.status !== undefined &&
    !['passed', 'skipped'].includes(parsed.data.status.toLocaleLowerCase('en-US'))
  ) {
    output.push({
      uid: parsed.data.uid,
      name: parsed.data.name,
      status: parsed.data.status,
      flaky: parsed.data.flaky ?? false,
    });
  }
};

type RequestResult =
  | { readonly status: 'ok'; readonly body: unknown }
  | { readonly status: 'not_found' }
  | { readonly status: 'failed'; readonly problem: JenkinsBuildProblem };

export class JenkinsBuildClient implements JenkinsBuildPort {
  private readonly origin: string;

  public constructor(
    private readonly configuration: JenkinsBuildConfiguration,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {
    this.origin = new URL(configuration.baseUrl).origin;
  }

  public async observe(input: {
    readonly job: string;
    readonly branch: string;
    readonly expectedRevision: string;
    readonly signal: AbortSignal;
  }): Promise<JenkinsBuildObservation> {
    const branchPage = await this.request(
      `${this.configuration.baseUrl}${jobPath(input.job)}/api/json?tree=jobs%5Bname,url%5D`,
      input.signal,
    );
    if (branchPage.status === 'not_found') {
      return {
        status: 'failed',
        problem: {
          kind: 'job_not_found',
          message: `Jenkins job ${input.job} was not found`,
          retryable: false,
          httpStatus: 404,
        },
      };
    }
    if (branchPage.status === 'failed') return branchPage;
    const parsedBranches = RawBranchPageSchema.safeParse(branchPage.body);
    if (!parsedBranches.success) return this.invalidResponse('branch job page');
    const branch = parsedBranches.data.jobs.find(({ name }) =>
      branchNameMatches(name, input.branch),
    );
    if (branch === undefined) {
      return { status: 'pending', reason: 'branch_not_indexed', buildUrl: null };
    }
    if (!this.sameOrigin(branch.url)) return this.invalidResponse('branch job URL');

    const buildResponse = await this.request(
      `${branch.url.replace(/\/$/u, '')}/lastBuild/api/json`,
      input.signal,
    );
    if (buildResponse.status === 'not_found') {
      return { status: 'pending', reason: 'build_not_started', buildUrl: null };
    }
    if (buildResponse.status === 'failed') return buildResponse;
    const parsedBuild = RawBuildSchema.safeParse(buildResponse.body);
    if (!parsedBuild.success) return this.invalidResponse('build');
    if (!this.sameOrigin(parsedBuild.data.url)) return this.invalidResponse('build');
    const revisions = parsedBuild.data.actions.flatMap(({ lastBuiltRevision }) =>
      lastBuiltRevision === undefined ? [] : [lastBuiltRevision.SHA1],
    );
    if (revisions.length === 0 && (parsedBuild.data.building || parsedBuild.data.result === null)) {
      return { status: 'pending', reason: 'building', buildUrl: parsedBuild.data.url };
    }
    if (revisions.length === 0) return this.invalidResponse('build revision');
    if (!revisions.includes(input.expectedRevision)) {
      return { status: 'pending', reason: 'stale_revision', buildUrl: parsedBuild.data.url };
    }
    if (parsedBuild.data.building || parsedBuild.data.result === null) {
      return { status: 'pending', reason: 'building', buildUrl: parsedBuild.data.url };
    }

    const stages = await this.readStages(parsedBuild.data.url, input.signal);
    if (stages.status === 'failed') return stages;
    const failures = await this.readFailures(parsedBuild.data.url, input.signal);
    if (failures.status === 'failed') return failures;
    return {
      status: 'finished',
      build: {
        number: parsedBuild.data.number,
        url: parsedBuild.data.url,
        revision: input.expectedRevision,
        result: parsedBuild.data.result,
        durationMs: parsedBuild.data.duration,
        stages: stages.value,
        failures: failures.value,
      },
    };
  }

  public async readAttachment(input: {
    readonly buildUrl: string;
    readonly source: string;
    readonly signal: AbortSignal;
  }): Promise<JenkinsAttachmentObservation> {
    const url = `${input.buildUrl.replace(/\/$/u, '')}/allure/data/attachments/${encodeURIComponent(input.source)}`;
    if (!this.sameOrigin(url)) return this.invalidResponse('attachment URL');
    const timeoutSignal = AbortSignal.timeout(this.configuration.requestTimeoutMs);
    try {
      const response = await this.fetchImplementation(url, {
        headers: {
          accept: '*/*',
          authorization: `Basic ${Buffer.from(`${this.configuration.user}:${this.configuration.token}`).toString('base64')}`,
        },
        signal: AbortSignal.any([input.signal, timeoutSignal]),
      });
      if (response.status === 404) return { status: 'not_found' };
      if (!response.ok) return { status: 'failed', problem: problemForStatus(response.status) };
      return { status: 'found', bytes: new Uint8Array(await response.arrayBuffer()) };
    } catch {
      return {
        status: 'failed',
        problem: {
          kind: 'unavailable',
          message: 'Jenkins attachment is unreachable',
          retryable: true,
        },
      };
    }
  }

  private async readStages(
    buildUrl: string,
    signal: AbortSignal,
  ): Promise<
    | { readonly status: 'ready'; readonly value: readonly JenkinsStage[] }
    | { readonly status: 'failed'; readonly problem: JenkinsBuildProblem }
  > {
    const response = await this.request(`${buildUrl.replace(/\/$/u, '')}/wfapi/describe`, signal);
    if (response.status === 'not_found') return { status: 'ready', value: [] };
    if (response.status === 'failed') return response;
    const parsed = RawStageResponseSchema.safeParse(response.body);
    return parsed.success
      ? {
          status: 'ready',
          value: parsed.data.stages.map(({ name, status }) => ({ name, status })),
        }
      : this.invalidResponse('pipeline stages');
  }

  private async readFailures(
    buildUrl: string,
    signal: AbortSignal,
  ): Promise<
    | { readonly status: 'ready'; readonly value: readonly JenkinsTestFailure[] }
    | { readonly status: 'failed'; readonly problem: JenkinsBuildProblem }
  > {
    const allureRoot = `${buildUrl.replace(/\/$/u, '')}/allure`;
    const response = await this.request(`${allureRoot}/data/suites.json`, signal);
    if (response.status === 'not_found') return { status: 'ready', value: [] };
    if (response.status === 'failed') return response;
    const leaves: { uid: string; name: string; status: string; flaky: boolean }[] = [];
    collectFailures(response.body, leaves);
    const failures: JenkinsTestFailure[] = [];
    for (const leaf of leaves.slice(0, 20)) {
      const detail = await this.request(
        `${allureRoot}/data/test-cases/${encodeURIComponent(leaf.uid)}.json`,
        signal,
      );
      if (detail.status === 'failed') return detail;
      const parsed = detail.status === 'ok' ? RawAllureCaseSchema.safeParse(detail.body) : null;
      const attachments: z.infer<typeof RawAttachmentSchema>[] = [];
      if (parsed?.success) collectAttachments(parsed.data, attachments);
      failures.push({
        ...leaf,
        message: parsed?.success ? (parsed.data.statusMessage?.trim() ?? null) : null,
        flaky: leaf.flaky || (parsed?.success ? (parsed.data.flaky ?? false) : false),
        attachments,
      });
    }
    return { status: 'ready', value: failures };
  }

  private sameOrigin(value: string): boolean {
    try {
      return new URL(value).origin === this.origin;
    } catch {
      return false;
    }
  }

  private invalidResponse(subject: string): {
    readonly status: 'failed';
    readonly problem: JenkinsBuildProblem;
  } {
    return {
      status: 'failed',
      problem: {
        kind: 'invalid_response',
        message: `Jenkins returned an invalid ${subject} response`,
        retryable: false,
      },
    };
  }

  private async request(url: string, signal: AbortSignal): Promise<RequestResult> {
    if (!this.sameOrigin(url)) return this.invalidResponse('request URL');
    const timeoutSignal = AbortSignal.timeout(this.configuration.requestTimeoutMs);
    try {
      const response = await this.fetchImplementation(url, {
        headers: {
          accept: 'application/json',
          authorization: `Basic ${Buffer.from(`${this.configuration.user}:${this.configuration.token}`).toString('base64')}`,
        },
        signal: AbortSignal.any([signal, timeoutSignal]),
      });
      if (response.status === 404) return { status: 'not_found' };
      if (!response.ok) return { status: 'failed', problem: problemForStatus(response.status) };
      return { status: 'ok', body: await response.json() };
    } catch (error) {
      signal.throwIfAborted();
      return {
        status: 'failed',
        problem: {
          kind: 'unavailable',
          message: error instanceof Error ? error.message : 'Jenkins request failed',
          retryable: true,
        },
      };
    }
  }
}
