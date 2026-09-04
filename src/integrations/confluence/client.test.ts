import { describe, expect, it, vi } from 'vitest';

import { ConfluenceServerClient } from './client.js';

const configuration = {
  baseUrl: 'https://confluence.example',
  token: 'test-token',
} as const;

const bodyText = (body: RequestInit['body']): string => {
  if (typeof body !== 'string') throw new Error('Expected a JSON request body');
  return body;
};

describe('Confluence server client', () => {
  it('lists exact child pages and sends bearer auth', async () => {
    const calls: { input: unknown; init: RequestInit | undefined }[] = [];
    const request = vi.fn((input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(
        Response.json({
          results: [
            {
              id: '301',
              title: 'Research page',
              version: { number: 7 },
              space: { key: 'RND' },
              body: { storage: { value: '<p>ready</p>' } },
              _links: { webui: '/pages/viewpage.action?pageId=301' },
            },
            {
              id: '302',
              title: 'Another title',
              version: { number: 2 },
              space: { key: 'RND' },
              body: { storage: { value: '<p>skip</p>' } },
              _links: { webui: '/pages/viewpage.action?pageId=302' },
            },
          ],
        }),
      );
    });
    const client = new ConfluenceServerClient(configuration, request);

    const result = await client.findExactChildPages('42', 'Research page');

    expect(result).toEqual({
      ok: true,
      value: [
        {
          pageId: '301',
          title: 'Research page',
          version: 7,
          spaceKey: 'RND',
          bodyStorage: '<p>ready</p>',
          pageUrl: 'https://confluence.example/pages/viewpage.action?pageId=301',
        },
      ],
    });
    expect(request).toHaveBeenCalledOnce();
    expect(String(calls[0]?.input)).toContain('/rest/api/content/42/child/page');
    expect(calls[0]?.init?.headers).toBeInstanceOf(Headers);
    const headers = calls[0]?.init?.headers;
    if (!(headers instanceof Headers)) throw new Error('Expected fetch headers');
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer test-token');
  });

  it('creates a page in storage format', async () => {
    const calls: { init: RequestInit | undefined }[] = [];
    const request = vi.fn((_input: unknown, init?: RequestInit) => {
      calls.push({ init });
      return Promise.resolve(
        Response.json({
          id: '401',
          title: 'Research page',
          version: { number: 1 },
          space: { key: 'RND' },
          body: { storage: { value: '<p>body</p>' } },
          _links: { webui: '/pages/viewpage.action?pageId=401' },
        }),
      );
    });
    const client = new ConfluenceServerClient(configuration, request);

    const result = await client.createPage({
      parentPageId: '42',
      title: 'Research page',
      bodyStorage: '<p>body</p>',
      spaceKey: 'RND',
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        pageId: '401',
        pageUrl: 'https://confluence.example/pages/viewpage.action?pageId=401',
      },
    });
    expect(calls[0]?.init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(bodyText(calls[0]?.init?.body))).toEqual({
      type: 'page',
      title: 'Research page',
      ancestors: [{ id: '42' }],
      space: { key: 'RND' },
      body: { storage: { value: '<p>body</p>', representation: 'storage' } },
    });
  });

  it('updates a page with the next version number', async () => {
    const calls: { init: RequestInit | undefined }[] = [];
    const request = vi.fn((_input: unknown, init?: RequestInit) => {
      calls.push({ init });
      return Promise.resolve(
        Response.json({
          id: '401',
          title: 'Research page',
          version: { number: 8 },
          space: { key: 'RND' },
          body: { storage: { value: '<p>updated</p>' } },
          _links: { webui: '/pages/viewpage.action?pageId=401' },
        }),
      );
    });
    const client = new ConfluenceServerClient(configuration, request);

    const result = await client.updatePage({
      pageId: '401',
      title: 'Research page',
      bodyStorage: '<p>updated</p>',
      spaceKey: 'RND',
      version: 7,
    });

    expect(result).toMatchObject({ ok: true, value: { pageId: '401', version: 8 } });
    expect(calls[0]?.init).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(bodyText(calls[0]?.init?.body))).toEqual({
      id: '401',
      type: 'page',
      title: 'Research page',
      version: { number: 8 },
      space: { key: 'RND' },
      body: { storage: { value: '<p>updated</p>', representation: 'storage' } },
    });
  });

  it('normalizes a Confluence conflict as retryable', async () => {
    const client = new ConfluenceServerClient(
      configuration,
      vi.fn(() => Promise.resolve(Response.json({ message: 'Version mismatch' }, { status: 409 }))),
    );

    const result = await client.updatePage({
      pageId: '401',
      title: 'Research page',
      bodyStorage: '<p>updated</p>',
      spaceKey: 'RND',
      version: 7,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        message: 'Version mismatch',
        retryable: true,
        httpStatus: 409,
      },
    });
  });
});
