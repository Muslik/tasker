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
