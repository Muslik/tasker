import { describe, expect, it, vi } from 'vitest';

import { JiraLifecycleClient } from '../../../src/integrations/index.js';

const configuration = {
  baseUrl: 'https://jira.example',
  token: 'secret-token',
};

describe('Jira lifecycle client', () => {
  it('preserves transition field requirements exposed by Jira', async () => {
    const client = new JiraLifecycleClient(
      configuration,
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            transitions: [
              {
                id: '31',
                name: 'Ready for review',
                to: { name: 'Code Review' },
                fields: {
                  customfield_12345: {
                    required: true,
                    name: 'Development estimate',
                    hasDefaultValue: false,
                    operations: ['set'],
                  },
                },
              },
            ],
          }),
        ),
      ),
    );

    const result = await client.listTransitions('AVIA-12536');

    expect(result).toEqual({
      status: 'observed',
      transitions: [
        {
          id: '31',
          name: 'Ready for review',
          toStatus: 'Code Review',
          fields: [
            {
              id: 'customfield_12345',
              name: 'Development estimate',
              required: true,
              hasDefaultValue: false,
              operations: ['set'],
            },
          ],
        },
      ],
    });
  });

  it('reads current values for transition fields in one request', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ fields: { customfield_12345: 3, customfield_54321: null } })),
    );
    const client = new JiraLifecycleClient(configuration, fetchImplementation);

    const result = await client.observeFieldValues('AVIA-12536', [
      'customfield_12345',
      'customfield_54321',
    ]);

    expect(result).toEqual({
      status: 'observed',
      values: { customfield_12345: 3, customfield_54321: null },
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://jira.example/rest/api/2/issue/AVIA-12536?fields=customfield_12345%2Ccustomfield_54321',
      expect.objectContaining({ method: 'GET' }),
    );
  });

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

  it('preserves actionable Jira validation errors when a transition is rejected', async () => {
    const client = new JiraLifecycleClient(
      configuration,
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            {
              errorMessages: ['Transition prerequisites are not satisfied'],
              errors: { customfield_12345: 'Development estimate is required' },
            },
            { status: 400 },
          ),
        ),
      ),
    );

    const result = await client.transition('AVIA-12536', '11');

    expect(result).toEqual({
      status: 'failed',
      problem: {
        kind: 'invalid_request',
        message:
          'Jira rejected the lifecycle mutation: Transition prerequisites are not satisfied; Development estimate is required',
        reasons: ['Transition prerequisites are not satisfied', 'Development estimate is required'],
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

  it('reads and publishes Jira Server comments without leaking the token', async () => {
    const fetchImplementation = vi.fn<typeof fetch>((_input, init) =>
      Promise.resolve(
        init?.method === 'GET'
          ? Response.json({ comments: [{ id: '9', body: 'Existing comment' }] })
          : new Response(null, { status: 201 }),
      ),
    );
    const client = new JiraLifecycleClient(configuration, fetchImplementation);

    const observed = await client.listComments('AVIA-12536');
    const published = await client.comment('AVIA-12536', 'PR ready: [73|https://example/pr/73]');

    expect(observed).toEqual({
      status: 'observed',
      comments: [{ id: '9', body: 'Existing comment' }],
    });
    expect(published).toEqual({ status: 'accepted' });
    const [read, write] = fetchImplementation.mock.calls;
    expect(read?.[0]).toBe(
      'https://jira.example/rest/api/2/issue/AVIA-12536/comment?maxResults=1000',
    );
    expect(write?.[0]).toBe('https://jira.example/rest/api/2/issue/AVIA-12536/comment');
    const requestBody = write?.[1]?.body;
    expect(requestBody).toBe(JSON.stringify({ body: 'PR ready: [73|https://example/pr/73]' }));
    if (typeof requestBody !== 'string') throw new Error('Expected a JSON request body');
    expect(requestBody).not.toContain('secret-token');
  });

  it('reads and uploads Jira attachments with the Jira Server multipart contract', async () => {
    const fetchImplementation = vi.fn<typeof fetch>((_input, init) =>
      Promise.resolve(
        init?.method === 'GET'
          ? Response.json({
              fields: {
                attachment: [{ id: '11', filename: 'before.mp4', mimeType: 'video/mp4', size: 3 }],
              },
            })
          : new Response(null, { status: 200 }),
      ),
    );
    const client = new JiraLifecycleClient(configuration, fetchImplementation);

    const observed = await client.listAttachments('AVIA-12536');
    const uploaded = await client.uploadAttachment('AVIA-12536', {
      filename: 'before.mp4',
      mimeType: 'video/mp4',
      content: Uint8Array.from([1, 2, 3]),
    });

    expect(observed).toEqual({
      status: 'observed',
      attachments: [{ id: '11', filename: 'before.mp4', mimeType: 'video/mp4', size: 3 }],
    });
    expect(uploaded).toEqual({ status: 'accepted' });
    const [, write] = fetchImplementation.mock.calls;
    expect(write?.[0]).toBe('https://jira.example/rest/api/2/issue/AVIA-12536/attachments');
    expect(new Headers(write?.[1]?.headers).get('x-atlassian-token')).toBe('no-check');
    expect(new Headers(write?.[1]?.headers).get('authorization')).toBe('Bearer secret-token');
    expect(write?.[1]?.headers).not.toHaveProperty('content-type');
    const form = write?.[1]?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) throw new Error('Expected multipart form data');
    const file = form.get('file');
    expect(file).toBeInstanceOf(Blob);
    if (!(file instanceof Blob)) throw new Error('Expected attachment blob');
    expect(file).toMatchObject({ name: 'before.mp4', type: 'video/mp4', size: 3 });
  });
});
