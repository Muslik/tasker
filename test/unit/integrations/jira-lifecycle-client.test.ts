import { describe, expect, it, vi } from 'vitest';

import { JiraLifecycleClient } from '../../../src/integrations/index.js';

const configuration = {
  baseUrl: 'https://jira.example',
  token: 'secret-token',
};

describe('Jira lifecycle client', () => {
  it('uses the Jira Server assignment contract without leaking the token into the body', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const client = new JiraLifecycleClient(configuration, fetchImplementation);

    const result = await client.assign('AVIA-12536', 'agent@example.com');

    expect(result).toEqual({ status: 'accepted' });
    const call = fetchImplementation.mock.calls[0];
    if (call === undefined) throw new Error('Expected a Jira request');
    expect(call[0]).toBe('https://jira.example/rest/api/2/issue/AVIA-12536');
    expect(call[1]?.method).toBe('PUT');
    expect(call[1]?.body).toBe(
      JSON.stringify({ fields: { assignee: { name: 'agent@example.com' } } }),
    );
    expect(new Headers(call[1]?.headers).get('authorization')).toBe('Bearer secret-token');
    const requestBody = call[1]?.body;
    if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body');
    expect(requestBody).not.toContain('secret-token');
  });

  it('classifies a transition 400 as a non-retryable invalid request', async () => {
    const client = new JiraLifecycleClient(
      configuration,
      vi.fn(() => Promise.resolve(new Response(null, { status: 400 }))),
    );

    const result = await client.transition('AVIA-12536', '11');

    expect(result).toEqual({
      status: 'failed',
      problem: {
        kind: 'invalid_request',
        message: 'Jira rejected the lifecycle mutation',
        retryable: false,
        httpStatus: 400,
      },
    });
  });

  it('classifies Jira 403 as recoverable infrastructure', async () => {
    const client = new JiraLifecycleClient(
      configuration,
      vi.fn(() => Promise.resolve(new Response(null, { status: 403 }))),
    );

    const result = await client.observeIssue('AVIA-12536');

    expect(result).toMatchObject({
      status: 'failed',
      problem: { kind: 'access_blocked', retryable: true, httpStatus: 403 },
    });
  });
});
