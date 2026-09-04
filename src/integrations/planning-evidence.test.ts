import { describe, expect, it } from 'vitest';

import {
  ConfluencePlanningEvidenceReader,
  LoopPlanningEvidenceReader,
} from './planning-evidence.js';

const configuration = { baseUrl: 'https://internal.example.test', token: 'secret-token' };
const requestUrl = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

describe('planning evidence integrations', () => {
  it('normalizes a Confluence page and sends the configured bearer token', async () => {
    let observedUrl = '';
    let observedAuthorization = '';
    const fetchImplementation: typeof fetch = (input, init) => {
      observedUrl = requestUrl(input);
      observedAuthorization = new Headers(init?.headers).get('Authorization') ?? '';
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: '42',
            title: 'Frontend delivery policy',
            version: { number: 7, when: '2026-08-05T09:00:00.000Z' },
            space: { key: 'AVIA', name: 'Avia' },
            ancestors: [{ id: '1', title: 'Engineering' }],
            body: { storage: { value: '<p>Run the targeted checks.</p>' } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    };
    const reader = new ConfluencePlanningEvidenceReader(configuration, fetchImplementation);

    const result = await reader.read({
      requestId: 'delivery-policy',
      skill: 'confluence',
      locator: 'https://internal.example.test/pages/42/Delivery-policy',
      purpose: 'Confirm required verification.',
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        skill: 'confluence',
        locator: '42',
        title: 'Frontend delivery policy',
        observedVersion: '7:2026-08-05T09:00:00.000Z',
        content: { bodyStorage: '<p>Run the targeted checks.</p>' },
      },
    });
    expect(observedUrl).toContain('/rest/api/content/42?expand=');
    expect(observedAuthorization).toBe('Bearer secret-token');
  });

  it('classifies a 403 as a retryable VPN/access failure', async () => {
    const reader = new ConfluencePlanningEvidenceReader(configuration, () =>
      Promise.resolve(new Response('forbidden', { status: 403 })),
    );

    const result = await reader.read({
      requestId: 'blocked-page',
      skill: 'confluence',
      locator: '42',
      purpose: 'Read the policy.',
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'reader_unavailable',
        skill: 'confluence',
        message: 'confluence returned HTTP 403; VPN or access may be required',
        retryable: true,
      },
    });
  });

  it('paginates and orders a Loop thread before returning planner evidence', async () => {
    const urls: string[] = [];
    const firstPosts = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => {
        const id = `p${String(index)}`;
        return [
          id,
          {
            id,
            user_id: 'u1',
            message: `message ${String(index)}`,
            create_at: index + 1,
            update_at: index + 1,
          },
        ];
      }),
    );
    const fetchImplementation: typeof fetch = (input) => {
      const url = requestUrl(input);
      urls.push(url);
      const payload = url.includes('fromCreateAt=200')
        ? {
            order: ['p200'],
            posts: {
              p200: {
                id: 'p200',
                user_id: 'u2',
                message: 'final message',
                create_at: 201,
                update_at: 202,
              },
            },
          }
        : { order: Object.keys(firstPosts), posts: firstPosts };
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    };
    const reader = new LoopPlanningEvidenceReader(configuration, fetchImplementation);

    const result = await reader.read({
      requestId: 'product-thread',
      skill: 'loop',
      locator: 'https://internal.example.test/team/pl/thread123',
      purpose: 'Read the product decision.',
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        skill: 'loop',
        locator: 'thread123',
        observedVersion: '1970-01-01T00:00:00.202Z:201',
      },
    });
    if (!result.ok) throw new Error('Expected Loop evidence');
    const content = result.value.content;
    if (content === null || Array.isArray(content) || typeof content !== 'object') {
      throw new Error('Expected normalized Loop content');
    }
    const posts = content.posts;
    if (!Array.isArray(posts)) throw new Error('Expected normalized Loop posts');
    expect(posts).toHaveLength(201);
    expect(posts[0]).toMatchObject({ id: 'p0', message: 'message 0' });
    expect(posts[200]).toMatchObject({ id: 'p200', message: 'final message' });
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('fromCreateAt=200');
  });
});
