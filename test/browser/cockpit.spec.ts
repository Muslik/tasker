import { expect, test } from '@playwright/test';

test('renders an empty operator console without a workflow surface', async ({ page }) => {
  await page.route('**/api/operator/tasks', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [], streamCursor: 0 }),
    }),
  );
  await page.route('**/api/events?**', async (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: ': connected\n\n',
    }),
  );

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  await expect(page.getByRole('main')).toHaveText('No tasks');
  await expect(page.getByRole('heading', { name: 'Workflow' })).toHaveCount(0);
});

test('starts a Jira task with immutable repository and status settings', async ({ page }) => {
  await page.route('**/api/operator/tasks', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [], streamCursor: 0 }),
    }),
  );
  await page.route('**/api/repositories', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        repositories: [
          {
            repositoryId: 'front-core-packages',
            remoteUrl: 'ssh://bitbucket.example/front-core-packages.git',
            checkout: { runnerId: 'local', path: '/projects/front-core-packages' },
            checkoutPaths: ['/projects/front-core-packages'],
            aliases: ['front-core-packages', 'onetwotrip/front-core-packages'],
          },
        ],
      }),
    }),
  );
  await page.route('**/api/events?**', async (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: ': connected\n\n',
    }),
  );
  await page.route('**/api/jira/issues/FC-2244/sync', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'current',
        issue: {
          schemaVersion: 2,
          issueKey: 'FC-2244',
          issueId: '327835',
          browseUrl: 'https://jira.example/browse/FC-2244',
          summary: 'Fix limiter interceptor',
          description: 'Handle attempts exceeded',
          issueType: 'Bug',
          status: 'Open',
          priority: 'None',
          labels: [],
          assignee: { displayName: 'Operator' },
          reporter: { displayName: 'Reporter' },
          repositoryHint: null,
          createdAt: '2026-08-26T00:00:00.000Z',
          updatedAt: '2026-08-26T00:00:00.000Z',
          syncedAt: '2026-08-26T00:00:00.000Z',
          attachments: [],
          comments: [],
          links: [],
        },
        lastSuccessfulSyncAt: '2026-08-26T00:00:00.000Z',
        recordedAt: '2026-08-26T00:00:00.000Z',
      }),
    }),
  );
  await page.route('**/api/workflows/jira%3AFC-2244/generate', async (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'runtime_unavailable', message: 'Temporal is offline' }),
    }),
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Start Jira task' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start Jira task' });
  await dialog.getByRole('textbox', { name: 'Jira task' }).fill('FC-2244');
  await dialog.getByRole('combobox', { name: 'Repository' }).selectOption('front-core-packages');
  await dialog.getByRole('checkbox', { name: 'Update Jira statuses' }).uncheck();
  const generateRequest = page.waitForRequest((request) =>
    request.url().includes('/api/workflows/jira%3AFC-2244/generate'),
  );

  await dialog.getByRole('button', { name: 'Start task' }).click();

  expect((await generateRequest).postDataJSON()).toMatchObject({
    settings: { trackerStatusUpdates: 'disabled' },
  });
  await expect(dialog).toContainText('Temporal is offline');
});
