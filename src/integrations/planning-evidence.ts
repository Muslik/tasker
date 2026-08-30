import { z } from 'zod';

import type {
  PlanningEvidenceReader,
  PlanningEvidenceReadError,
} from '../server/planning-evidence.js';
import type { PlanningEvidenceObservation, PlanningEvidenceRequest } from '../planning/index.js';
import { loadHarnessEnvironmentDefaults } from '../shared/env-file.js';
import type { Clock } from '../shared/clock.js';
import { err, ok, type Outcome } from '../shared/outcome.js';
import { JsonValueSchema } from '../graph/schema.js';
import { JiraIssueKeySchema, type JiraIssuePort, type JiraSyncProblem } from './jira/index.js';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DOCUMENT_CHARACTERS = 200_000;
const LOOP_PAGE_SIZE = 200;
const MAX_LOOP_PAGES = 10;

const boundedText = (value: string): string =>
  value.length <= MAX_DOCUMENT_CHARACTERS
    ? value
    : `${value.slice(0, MAX_DOCUMENT_CHARACTERS)}\n[truncated by Tasker]`;

const invalidLocator = (
  skill: string,
  locator: string,
  message: string,
): Outcome<never, PlanningEvidenceReadError> =>
  err({ kind: 'invalid_locator', skill, locator, message, retryable: false });

const unavailable = (
  skill: string,
  message: string,
  retryable: boolean,
): Outcome<never, PlanningEvidenceReadError> =>
  err({ kind: 'reader_unavailable', skill, message, retryable });

const jiraKeyFrom = (locator: string): string | null => {
  const direct = JiraIssueKeySchema.safeParse(locator.toUpperCase());
  if (direct.success) return direct.data;
  const match = /\/browse\/([A-Z][A-Z0-9_]+-\d+)/iu.exec(locator);
  const parsed = JiraIssueKeySchema.safeParse(match?.[1]?.toUpperCase());
  return parsed.success ? parsed.data : null;
};

const jiraFailure = (problem: JiraSyncProblem): PlanningEvidenceReadError => ({
  kind: 'reader_unavailable',
  skill: 'jira',
  message: problem.message,
  retryable: problem.retryable,
});

export class JiraPlanningEvidenceReader implements PlanningEvidenceReader {
  public readonly skill = 'jira';
  public readonly credentialEnvironment = ['JIRA_TOKEN'];

  public constructor(
    private readonly jira: JiraIssuePort,
    private readonly clock: Clock,
  ) {}

  public async read(
    request: PlanningEvidenceRequest,
  ): Promise<Outcome<PlanningEvidenceObservation, PlanningEvidenceReadError>> {
    const issueKey = jiraKeyFrom(request.locator);
    if (issueKey === null) {
      return invalidLocator(this.skill, request.locator, 'Expected a Jira key or browse URL');
    }
    const fetched = await this.jira.fetchIssue(issueKey, this.clock.now());
    if (!fetched.ok) return err(jiraFailure(fetched.error));
    const content = Object.fromEntries(
      Object.entries(fetched.value).filter(([field]) => field !== 'syncedAt'),
    );
    return ok({
      skill: this.skill,
      locator: issueKey,
      title: `${issueKey}: ${fetched.value.summary}`,
      observedVersion: fetched.value.updatedAt,
      mediaType: 'application/json',
      content: JsonValueSchema.parse(content),
    });
  }
}

const ExternalReaderConfigurationSchema = z
  .object({ baseUrl: z.url(), token: z.string().min(1) })
  .strict();
type ExternalReaderConfiguration = z.infer<typeof ExternalReaderConfigurationSchema>;

export const loadConfluencePlanningEvidenceConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ExternalReaderConfiguration | null => {
  const defaults = loadHarnessEnvironmentDefaults(environment);
  const parsed = ExternalReaderConfigurationSchema.safeParse({
    baseUrl: environment.CONFLUENCE_BASE_URL ?? defaults.CONFLUENCE_BASE_URL,
    token: environment.CONFLUENCE_TOKEN ?? defaults.CONFLUENCE_TOKEN,
  });
  return parsed.success
    ? { ...parsed.data, baseUrl: parsed.data.baseUrl.replace(/\/$/u, '') }
    : null;
};

export const loadLoopPlanningEvidenceConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ExternalReaderConfiguration | null => {
  const defaults = loadHarnessEnvironmentDefaults(environment);
  const token = environment.LOOP_TOKEN ?? defaults.LOOP_TOKEN;
  const parsed = ExternalReaderConfigurationSchema.safeParse({
    baseUrl: environment.LOOP_BASE_URL ?? defaults.LOOP_BASE_URL ?? 'https://onetwotrip.loop.ru',
    token,
  });
  return parsed.success
    ? { ...parsed.data, baseUrl: parsed.data.baseUrl.replace(/\/$/u, '') }
    : null;
};

type FetchImplementation = typeof fetch;

const fetchJson = async (
  skill: string,
  configuration: ExternalReaderConfiguration | null,
  path: string,
  fetchImplementation: FetchImplementation,
): Promise<Outcome<unknown, PlanningEvidenceReadError>> => {
  if (configuration === null) {
    return unavailable(skill, `${skill} planning evidence is not configured`, false);
  }
  let response: Response;
  try {
    response = await fetchImplementation(`${configuration.baseUrl}${path}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${configuration.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return unavailable(
      skill,
      error instanceof Error ? error.message : `${skill} request failed`,
      true,
    );
  }
  if (!response.ok) {
    return unavailable(
      skill,
      `${skill} returned HTTP ${String(response.status)}${response.status === 403 ? '; VPN or access may be required' : ''}`,
      response.status === 403 ||
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500,
    );
  }
  try {
    return ok(await response.json());
  } catch {
    return unavailable(skill, `${skill} returned invalid JSON`, false);
  }
};

const ConfluencePageSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    version: z.object({ number: z.number().int().positive(), when: z.string().optional() }).loose(),
    space: z.object({ key: z.string().optional(), name: z.string().optional() }).loose().optional(),
    ancestors: z
      .array(z.object({ id: z.string(), title: z.string().optional() }).loose())
      .optional(),
    body: z.object({ storage: z.object({ value: z.string() }).loose() }).loose(),
  })
  .loose();

const confluencePageIdFrom = (locator: string): string | null => {
  if (/^\d+$/u.test(locator)) return locator;
  const match = /(?:pageId=|\/pages\/)(\d+)/u.exec(locator);
  return match?.[1] ?? null;
};

export class ConfluencePlanningEvidenceReader implements PlanningEvidenceReader {
  public readonly skill = 'confluence';
  public readonly credentialEnvironment = ['CONFLUENCE_TOKEN'];

  public constructor(
    private readonly configuration: ExternalReaderConfiguration | null,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  public async read(
    request: PlanningEvidenceRequest,
  ): Promise<Outcome<PlanningEvidenceObservation, PlanningEvidenceReadError>> {
    const pageId = confluencePageIdFrom(request.locator);
    if (pageId === null) {
      return invalidLocator(
        this.skill,
        request.locator,
        'Expected a Confluence page ID or page URL',
      );
    }
    const fetched = await fetchJson(
      this.skill,
      this.configuration,
      `/rest/api/content/${encodeURIComponent(pageId)}?expand=${encodeURIComponent('body.storage,version,space,ancestors')}`,
      this.fetchImplementation,
    );
    if (!fetched.ok) return fetched;
    const page = ConfluencePageSchema.safeParse(fetched.value);
    if (!page.success) return unavailable(this.skill, 'Confluence page payload is invalid', false);
    return ok({
      skill: this.skill,
      locator: pageId,
      title: page.data.title,
      observedVersion: `${String(page.data.version.number)}:${page.data.version.when ?? 'unknown'}`,
      mediaType: 'application/json',
      content: JsonValueSchema.parse({
        id: page.data.id,
        title: page.data.title,
        version: page.data.version,
        space: page.data.space ?? null,
        ancestors: page.data.ancestors ?? [],
        bodyStorage: boundedText(page.data.body.storage.value),
      }),
    });
  }
}

const LoopThreadSchema = z
  .object({
    order: z.array(z.string()),
    posts: z.record(
      z.string(),
      z
        .object({
          id: z.string(),
          user_id: z.string(),
          message: z.string(),
          create_at: z.number().int().nonnegative(),
          update_at: z.number().int().nonnegative(),
        })
        .loose(),
    ),
  })
  .loose();

const loopPostIdFrom = (locator: string): string | null => {
  if (/^[a-z0-9]+$/iu.test(locator)) return locator;
  const match = /\/pl\/([a-z0-9]+)/iu.exec(locator);
  return match?.[1] ?? null;
};

export class LoopPlanningEvidenceReader implements PlanningEvidenceReader {
  public readonly skill = 'loop';
  public readonly credentialEnvironment = ['LOOP_TOKEN'];

  public constructor(
    private readonly configuration: ExternalReaderConfiguration | null,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  public async read(
    request: PlanningEvidenceRequest,
  ): Promise<Outcome<PlanningEvidenceObservation, PlanningEvidenceReadError>> {
    const postId = loopPostIdFrom(request.locator);
    if (postId === null) {
      return invalidLocator(this.skill, request.locator, 'Expected a Loop post ID or permalink');
    }
    const postsById = new Map<string, z.infer<typeof LoopThreadSchema>['posts'][string]>();
    const order: string[] = [];
    let fromCreateAt: number | null = null;
    let complete = false;
    for (let page = 0; page < MAX_LOOP_PAGES; page += 1) {
      const parameters = new URLSearchParams({ perPage: String(LOOP_PAGE_SIZE) });
      if (fromCreateAt !== null) {
        parameters.set('fromCreateAt', String(fromCreateAt));
        parameters.set('direction', 'down');
      }
      const fetched = await fetchJson(
        this.skill,
        this.configuration,
        `/api/v4/posts/${encodeURIComponent(postId)}/thread?${parameters.toString()}`,
        this.fetchImplementation,
      );
      if (!fetched.ok) return fetched;
      const thread = LoopThreadSchema.safeParse(fetched.value);
      if (!thread.success) return unavailable(this.skill, 'Loop thread payload is invalid', false);
      for (const [id, post] of Object.entries(thread.data.posts)) postsById.set(id, post);
      for (const id of thread.data.order) if (!order.includes(id)) order.push(id);
      if (thread.data.order.length < LOOP_PAGE_SIZE) {
        complete = true;
        break;
      }
      const lastPost = thread.data.posts[thread.data.order.at(-1) ?? ''];
      if (lastPost === undefined || lastPost.create_at === fromCreateAt) {
        return unavailable(this.skill, 'Loop thread pagination did not advance', false);
      }
      fromCreateAt = lastPost.create_at;
    }
    if (!complete) {
      return unavailable(
        this.skill,
        `Loop thread exceeds the bounded ${String(MAX_LOOP_PAGES * LOOP_PAGE_SIZE)} post limit`,
        false,
      );
    }
    const posts = order
      .map((id) => postsById.get(id))
      .filter((post) => post !== undefined)
      .sort((left, right) => left.create_at - right.create_at)
      .map((post) => ({
        id: post.id,
        userId: post.user_id,
        message: boundedText(post.message),
        createdAt: new Date(post.create_at).toISOString(),
        updatedAt: new Date(post.update_at || post.create_at).toISOString(),
      }));
    const latest = posts.reduce(
      (value, post) => (post.updatedAt > value ? post.updatedAt : value),
      '1970-01-01T00:00:00.000Z',
    );
    return ok({
      skill: this.skill,
      locator: postId,
      title: `Loop thread ${postId}`,
      observedVersion: `${latest}:${String(posts.length)}`,
      mediaType: 'application/json',
      content: JsonValueSchema.parse({ postId, posts }),
    });
  }
}
