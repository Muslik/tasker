import { expect, test } from '@playwright/test';

test('a task becomes an inspectable persisted workflow', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Task fixture')).toBeEnabled();

  await page.getByRole('button', { name: 'Generate workflow' }).click();

  await expect(page.getByTestId('workflow-details')).toBeVisible();
  await expect(page.getByTestId('workflow-tree')).toBeVisible();
  await expect(page.getByTestId('graph-hash')).not.toHaveText('not compiled');
  await expect(page.getByRole('link', { name: 'Download graph JSON' })).toBeVisible();
  await expect(page.getByText('disabled in M1')).toBeVisible();
});

test('an invalid proposal exposes validator errors and no workflow tree', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Task fixture').selectOption('invalid-unknown-step');

  await page.getByRole('button', { name: 'Generate workflow' }).click();

  await expect(page.getByTestId('validation-errors')).toBeVisible();
  await expect(page.getByText('Graph rejected')).toBeVisible();
  await expect(page.getByTestId('workflow-tree')).toHaveCount(0);
});

test('a persisted graph is restored after a page reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Task fixture')).toBeEnabled();
  await page.getByRole('button', { name: 'Generate workflow' }).click();
  const hash = await page.getByTestId('graph-hash').textContent();

  await page.reload();

  await expect(page.getByTestId('workflow-details')).toBeVisible();
  await expect(page.getByTestId('graph-hash')).toHaveText(hash ?? '');
});
