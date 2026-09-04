import { z } from 'zod';

import { loadHarnessEnvironmentDefaults } from '../../shared/env-file.js';
import { err, ok, type Outcome } from '../../shared/outcome.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const CHILD_PAGE_BATCH_SIZE = 100;

export const ConfluenceConfigurationSchema = z
  .object({
    baseUrl: z.url(),
    token: z.string().min(1),
  })
  .strict();

export type ConfluenceConfiguration = z.infer<typeof ConfluenceConfigurationSchema>;

const RawConfluenceLinksSchema = z
  .object({
    base: z.url().optional(),
    webui: z.string().min(1).optional(),
  })
  .loose();

const RawConfluencePageSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    version: z.object({ number: z.number().int().positive() }).loose(),
    space: z.object({ key: z.string().min(1) }).loose(),
    body: z.object({ storage: z.object({ value: z.string() }).loose() }).loose(),
    _links: RawConfluenceLinksSchema.optional(),
  })
  .loose();

const RawConfluencePageCollectionSchema = z
  .object({
    results: z.array(RawConfluencePageSchema),
  })
  .loose();

const RawConfluenceErrorSchema = z
  .object({
    message: z.string().optional(),
    reason: z.string().optional(),
    statusCode: z.number().int().optional(),
    data: z
      .object({
        errors: z.record(z.string(), z.string()).optional(),
      })
      .loose()
      .optional(),
    errors: z.record(z.string(), z.string()).optional(),
  })
  .loose();

export interface ConfluencePage {
  readonly pageId: string;
  readonly title: string;
  readonly version: number;
  readonly spaceKey: string;
  readonly bodyStorage: string;
  readonly pageUrl: string;
}

export type ConfluencePublishProblem =
  | {
      readonly kind: 'not_configured';
      readonly message: string;
      readonly retryable: false;
    }
  | {
      readonly kind: 'invalid_request';
      readonly message: string;
      readonly retryable: false;
      readonly httpStatus: 400;
    }
  | {
      readonly kind: 'auth_failed';
      readonly message: string;
      readonly retryable: false;
      readonly httpStatus: 401;
    }
  | {
      readonly kind: 'access_blocked';
      readonly message: string;
      readonly retryable: true;
      readonly httpStatus: 403;
    }
  | {
      readonly kind: 'not_found';
      readonly message: string;
      readonly retryable: false;
      readonly httpStatus: 404;
    }
  | {
      readonly kind: 'conflict';
      readonly message: string;
      readonly retryable: true;
      readonly httpStatus: 409;
    }
  | {
      readonly kind: 'invalid_response';
      readonly message: string;
      readonly retryable: false;
    }
  | {
      readonly kind: 'unavailable';
      readonly message: string;
      readonly retryable: true;
      readonly httpStatus?: number;
    };

export interface ConfluenceContentPort {
  fetchPage(pageId: string): Promise<Outcome<ConfluencePage, ConfluencePublishProblem>>;
  findExactChildPages(
    parentPageId: string,
    title: string,
  ): Promise<Outcome<readonly ConfluencePage[], ConfluencePublishProblem>>;
  createPage(input: {
    readonly parentPageId: string;
    readonly title: string;
    readonly bodyStorage: string;
    readonly spaceKey: string;
  }): Promise<Outcome<ConfluencePage, ConfluencePublishProblem>>;
  updatePage(input: {
    readonly pageId: string;
    readonly title: string;
    readonly bodyStorage: string;
    readonly spaceKey: string;
    readonly version: number;
  }): Promise<Outcome<ConfluencePage, ConfluencePublishProblem>>;
}

type FetchImplementation = typeof fetch;

const parseProblemMessage = (payload: unknown): string | null => {
  const parsed = RawConfluenceErrorSchema.safeParse(payload);
  if (!parsed.success) return null;
  const messages = [
    parsed.data.message,
    parsed.data.reason,
    ...Object.values(parsed.data.errors ?? {}),
    ...Object.values(parsed.data.data?.errors ?? {}),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return messages[0] ?? null;
};

const problemForStatus = (status: number, message: string | null): ConfluencePublishProblem => {
  if (status === 400) {
    return {
      kind: 'invalid_request',
      message: message ?? 'Confluence rejected the page payload',
      retryable: false,
      httpStatus: 400,
    };
  }
  if (status === 401) {
    return {
      kind: 'auth_failed',
      message: message ?? 'Confluence rejected the configured token',
      retryable: false,
      httpStatus: 401,
    };
  }
  if (status === 403) {
    return {
      kind: 'access_blocked',
      message: message ?? 'Confluence returned 403. VPN or Confluence access may be required',
      retryable: true,
      httpStatus: 403,
    };
  }
  if (status === 404) {
    return {
      kind: 'not_found',
      message: message ?? 'Confluence page does not exist or is not visible to this account',
      retryable: false,
      httpStatus: 404,
    };
  }
  if (status === 409) {
    return {
      kind: 'conflict',
      message: message ?? 'Confluence reported a page version conflict',
      retryable: true,
      httpStatus: 409,
    };
  }
  return {
    kind: 'unavailable',
    message: message ?? `Confluence request failed with HTTP ${String(status)}`,
    retryable: true,
    httpStatus: status,
  };
};

const pageUrlFrom = (
  configuration: ConfluenceConfiguration,
  raw: z.infer<typeof RawConfluencePageSchema>,
): string => {
  const base = raw._links?.base ?? configuration.baseUrl;
  const webui = raw._links?.webui;
  return webui === undefined
    ? `${configuration.baseUrl}/pages/viewpage.action?pageId=${encodeURIComponent(raw.id)}`
    : webui.startsWith('http')
      ? webui
      : webui.startsWith('/')
        ? `${base}${webui}`
        : new URL(webui, `${base}/`).toString();
};

const normalizePage = (
  configuration: ConfluenceConfiguration,
  raw: z.infer<typeof RawConfluencePageSchema>,
): ConfluencePage => ({
  pageId: raw.id,
  title: raw.title,
  version: raw.version.number,
  spaceKey: raw.space.key,
  bodyStorage: raw.body.storage.value,
  pageUrl: pageUrlFrom(configuration, raw),
});

export const loadConfluenceConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ConfluenceConfiguration | null => {
  const defaults = loadHarnessEnvironmentDefaults(environment);
  const parsed = ConfluenceConfigurationSchema.safeParse({
    baseUrl: environment.CONFLUENCE_BASE_URL ?? defaults.CONFLUENCE_BASE_URL,
    token: environment.CONFLUENCE_TOKEN ?? defaults.CONFLUENCE_TOKEN,
  });
  return parsed.success
    ? { ...parsed.data, baseUrl: parsed.data.baseUrl.replace(/\/$/u, '') }
    : null;
};

export class ConfluenceServerClient implements ConfluenceContentPort {
  public constructor(
    private readonly configuration: ConfluenceConfiguration | null,
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  public async fetchPage(
    pageId: string,
  ): Promise<Outcome<ConfluencePage, ConfluencePublishProblem>> {
    return this.fetchSinglePage(
      `/rest/api/content/${encodeURIComponent(pageId)}?expand=${encodeURIComponent(
        'body.storage,version,space',
      )}`,
    );
  }

  public async findExactChildPages(
    parentPageId: string,
    title: string,
  ): Promise<Outcome<readonly ConfluencePage[], ConfluencePublishProblem>> {
    const configuration = this.configuration;
    if (configuration === null) {
      return err({
        kind: 'not_configured',
        message: 'Confluence credentials are not configured for Tasker',
        retryable: false,
      });
    }

    const matches: ConfluencePage[] = [];
    for (let start = 0; ; start += CHILD_PAGE_BATCH_SIZE) {
      const response = await this.request(
        `/rest/api/content/${encodeURIComponent(parentPageId)}/child/page?limit=${String(
          CHILD_PAGE_BATCH_SIZE,
        )}&start=${String(start)}&expand=${encodeURIComponent('body.storage,version,space')}`,
      );
      if (!response.ok) return response;

      let payload: unknown;
      try {
        payload = await response.value.json();
      } catch {
        return err({
          kind: 'invalid_response',
          message: 'Confluence returned a non-JSON child page response',
          retryable: false,
        });
      }

      const parsed = RawConfluencePageCollectionSchema.safeParse(payload);
      if (!parsed.success) {
        return err({
          kind: 'invalid_response',
          message: `Confluence child page response did not match the normalized contract: ${parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
          retryable: false,
        });
      }

      matches.push(
        ...parsed.data.results
          .filter((page) => page.title === title)
          .map((page) => normalizePage(configuration, page)),
      );
      if (parsed.data.results.length < CHILD_PAGE_BATCH_SIZE) {
        return ok(matches);
      }
    }
  }

  public async createPage(input: {
    readonly parentPageId: string;
    readonly title: string;
    readonly bodyStorage: string;
    readonly spaceKey: string;
  }): Promise<Outcome<ConfluencePage, ConfluencePublishProblem>> {
    return this.writePage('/rest/api/content', {
      method: 'POST',
      body: JSON.stringify({
        type: 'page',
        title: input.title,
        ancestors: [{ id: input.parentPageId }],
        space: { key: input.spaceKey },
        body: { storage: { value: input.bodyStorage, representation: 'storage' } },
      }),
    });
  }

  public async updatePage(input: {
    readonly pageId: string;
    readonly title: string;
    readonly bodyStorage: string;
    readonly spaceKey: string;
    readonly version: number;
  }): Promise<Outcome<ConfluencePage, ConfluencePublishProblem>> {
    return this.writePage(`/rest/api/content/${encodeURIComponent(input.pageId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        id: input.pageId,
        type: 'page',
        title: input.title,
        version: { number: input.version + 1 },
        space: { key: input.spaceKey },
        body: { storage: { value: input.bodyStorage, representation: 'storage' } },
      }),
    });
  }

  private async fetchSinglePage(
    path: string,
  ): Promise<Outcome<ConfluencePage, ConfluencePublishProblem>> {
    if (this.configuration === null) {
      return err({
        kind: 'not_configured',
        message: 'Confluence credentials are not configured for Tasker',
        retryable: false,
      });
    }
    const response = await this.request(path);
    if (!response.ok) return response;

    let payload: unknown;
    try {
      payload = await response.value.json();
    } catch {
      return err({
        kind: 'invalid_response',
        message: 'Confluence returned a non-JSON page response',
        retryable: false,
      });
    }
    const parsed = RawConfluencePageSchema.safeParse(payload);
    if (!parsed.success) {
      return err({
        kind: 'invalid_response',
        message: `Confluence page response did not match the normalized contract: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
        retryable: false,
      });
    }
    return ok(normalizePage(this.configuration, parsed.data));
  }

  private async writePage(
    path: string,
    requestInit: { readonly method: 'POST' | 'PUT'; readonly body: string },
  ): Promise<Outcome<ConfluencePage, ConfluencePublishProblem>> {
    if (this.configuration === null) {
      return err({
        kind: 'not_configured',
        message: 'Confluence credentials are not configured for Tasker',
        retryable: false,
      });
    }
    const response = await this.request(path, {
      method: requestInit.method,
      headers: { 'content-type': 'application/json' },
      body: requestInit.body,
    });
    if (!response.ok) return response;

    let payload: unknown;
    try {
      payload = await response.value.json();
    } catch {
      return err({
        kind: 'invalid_response',
        message: 'Confluence returned a non-JSON write response',
        retryable: false,
      });
    }
    const parsed = RawConfluencePageSchema.safeParse(payload);
    if (!parsed.success) {
      return err({
        kind: 'invalid_response',
        message: `Confluence write response did not match the normalized contract: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
        retryable: false,
      });
    }
    return ok(normalizePage(this.configuration, parsed.data));
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Outcome<Response, ConfluencePublishProblem>> {
    if (this.configuration === null) {
      return err({
        kind: 'not_configured',
        message: 'Confluence credentials are not configured for Tasker',
        retryable: false,
      });
    }

    try {
      const headers = new Headers(init.headers);
      headers.set('Accept', 'application/json');
      headers.set('Authorization', `Bearer ${this.configuration.token}`);
      const response = await this.fetchImplementation(`${this.configuration.baseUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (response.ok) return ok(response);

      let payload: unknown = null;
      try {
        payload = await response.clone().json();
      } catch {
        payload = null;
      }
      return err(problemForStatus(response.status, parseProblemMessage(payload)));
    } catch (error) {
      return err({
        kind: 'unavailable',
        message:
          error instanceof Error ? error.message : 'Confluence request failed before a response',
        retryable: true,
      });
    }
  }
}
