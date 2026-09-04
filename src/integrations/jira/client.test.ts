import { describe, expect, it, vi } from 'vitest';

import { JiraServerClient } from './client.js';

const configuration = {
  baseUrl: 'https://jira.twiket.com',
  token: 'test-token',
} as const;

describe('Jira Server client', () => {
  it('normalizes the workflow-relevant issue fields at the network boundary', async () => {
    const request = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: '325225',
          key: 'AVIA-13235',
          fields: {
            summary: 'Seat map uses the wrong arrow color',
            description: 'h3. Steps\n# Open the seat map',
            issuetype: { name: 'Bug' },
            status: { name: 'In Release' },
            priority: { name: 'None' },
            labels: ['frontend'],
            assignee: { displayName: 'Dzhabrail Markhiev' },
            reporter: { displayName: 'Dzhabrail Markhiev' },
            created: '2026-07-30T12:46:36.136+0300',
            updated: '2026-07-31T13:12:04.077+0300',
            attachment: [
              {
                id: '245370',
                filename: 'before.mp4',
                mimeType: 'video/mp4',
                size: 123,
                created: '2026-07-30T12:46:47.388+0300',
                content: 'https://jira.twiket.com/secure/attachment/245370/before.mp4',
              },
            ],
            comment: {
              comments: [
                {
                  id: '1',
                  author: { displayName: 'Dzhabrail Markhiev' },
                  body: 'Fixed',
                  created: '2026-07-30T13:14:14.190+0300',
                  updated: '2026-07-30T13:14:14.190+0300',
                },
              ],
            },
            issuelinks: [
              {
                id: '118870',
                type: {
                  id: '10002',
                  name: 'Deployment',
                  inward: 'deploys',
                  outward: 'is deployed by',
                },
                outwardIssue: {
                  key: 'AVIA-13247',
                  fields: {
                    summary: 'FE Release 31.07.2026',
                    status: { name: 'Testing' },
                  },
                },
              },
            ],
            customfield_14100: 'module:src/features/selectSeats',
          },
        }),
      ),
    );
    const client = new JiraServerClient(configuration, request);

    const result = await client.fetchIssue('AVIA-13235', '2026-08-01T19:15:00.000Z');

    expect(result).toMatchObject({
      ok: true,
      value: {
        issueKey: 'AVIA-13235',
        issueType: 'Bug',
        status: 'In Release',
        repositoryHint: 'module:src/features/selectSeats',
        attachments: [{ filename: 'before.mp4' }],
        comments: [{ body: 'Fixed' }],
        links: [
          {
            linkId: '118870',
            linkTypeId: '10002',
            linkTypeName: 'Deployment',
            direction: 'outward',
            issueKey: 'AVIA-13247',
            relationship: 'is deployed by',
          },
        ],
      },
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('classifies a Jira 403 as recoverable access loss', async () => {
    const client = new JiraServerClient(
      configuration,
      vi.fn(() => Promise.resolve(new Response('', { status: 403 }))),
    );

    const result = await client.fetchIssue('AVIA-13235', '2026-08-01T19:15:00.000Z');

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'access_blocked',
        message: 'Jira returned 403. VPN or Jira access may be required',
        retryable: true,
        httpStatus: 403,
      },
    });
  });
});
