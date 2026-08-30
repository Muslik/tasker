import { expect, test } from '@playwright/test';

test('renders the new operator console', async ({ page }) => {
  await page.route('**/api/operator/tasks', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [], streamCursor: 0 }),
    }),
  );
  await page.route('**/api/repositories', async (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ repositories: [] }) }),
  );
  await page.route('**/api/events**', async (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' }),
  );

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Tasker Operator' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Jira task' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('No operator tasks');
});
