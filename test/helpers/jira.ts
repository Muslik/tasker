import {
  JiraIssueSnapshotSchema,
  type JiraIssueSnapshot,
} from '../../src/integrations/jira/contracts.js';

export const makeJiraSnapshot = (overrides: Partial<JiraIssueSnapshot> = {}): JiraIssueSnapshot =>
  JiraIssueSnapshotSchema.parse({
    schemaVersion: 1,
    issueKey: 'AVIA-13235',
    issueId: '325225',
    browseUrl: 'https://jira.twiket.com/browse/AVIA-13235',
    summary: 'Seat map uses the wrong color for the leg-space arrow',
    description:
      'h3. Environment\nWeb and mobile\n\nh3. Steps\n# Open seat selection\n# Find an exit-row seat\n\nh3. Expected result\nThe arrow matches the seat back.',
    issueType: 'Bug',
    status: 'In Release',
    priority: 'None',
    labels: ['bug_verified', 'frontend', 'seats_selection'],
    assignee: { displayName: 'Dzhabrail Markhiev' },
    reporter: { displayName: 'Dzhabrail Markhiev' },
    repositoryHint: 'module:src/features/additionalServices/selectSeats',
    createdAt: '2026-07-30T09:46:36.136Z',
    updatedAt: '2026-07-31T10:12:04.077Z',
    syncedAt: '2026-08-01T19:15:00.000Z',
    attachments: [
      {
        id: '245370',
        filename: 'seatmap-legspace-arrow.mp4',
        mimeType: 'video/mp4',
        size: 543_651,
        createdAt: '2026-07-30T09:46:47.388Z',
        contentUrl: 'https://jira.twiket.com/secure/attachment/245370/seatmap-legspace-arrow.mp4',
      },
      {
        id: '245379',
        filename: 'fix-before-after.png',
        mimeType: 'image/png',
        size: 19_837,
        createdAt: '2026-07-30T10:04:32.754Z',
        contentUrl: 'https://jira.twiket.com/secure/attachment/245379/fix-before-after.png',
        thumbnailUrl: 'https://jira.twiket.com/secure/thumbnail/245379/_thumb_245379.png',
      },
    ],
    comments: [
      {
        id: '1094745',
        author: { displayName: 'Dzhabrail Markhiev' },
        body: 'Fixed — video: [^seatmap-legspace-arrow.mp4]\n\nPR: [729|https://bitbucket.twiket.com/pull-requests/729]',
        createdAt: '2026-07-30T10:14:14.190Z',
        updatedAt: '2026-07-30T10:30:23.432Z',
      },
    ],
    links: [
      {
        issueKey: 'AVIA-13247',
        summary: 'FE Release 31.07.2026',
        relationship: 'is deployed by',
        status: 'Testing',
      },
    ],
    ...overrides,
  });
