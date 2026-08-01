import { expect, test } from '@playwright/test';
import type { APIResponse, Page } from '@playwright/test';
import type { ZodType } from 'zod';

import {
  OperatorActivityResponseSchema,
  OperatorStreamEventSchema,
  OperatorTaskListResponseSchema,
  WorkflowResponseSchema,
} from '../../src/control-plane/m1-contracts.js';

const readJson = async <T>(response: APIResponse, schema: ZodType<T>): Promise<T> => {
  if (!response.ok()) {
    throw new Error(`Expected HTTP success, got ${String(response.status())}`);
  }

  const body: unknown = await response.json();
  return schema.parse(body);
};

const loadTasks = async (page: Page) => {
  const response = await page.request.get('/api/operator/tasks');
  return readJson(response, OperatorTaskListResponseSchema);
};

const loadWorkflow = async (page: Page, fixtureId: string) => {
  const response = await page.request.get(`/api/workflows/${encodeURIComponent(fixtureId)}`);
  return readJson(response, WorkflowResponseSchema);
};

const loadActivity = async (page: Page, fixtureId: string) => {
  const response = await page.request.get(
    `/api/operator/tasks/${encodeURIComponent(fixtureId)}/activity`,
  );
  return readJson(response, OperatorActivityResponseSchema);
};

const clickTask = async (page: Page, fixtureId: string) => {
  await page.getByTestId(`task-item-${fixtureId}`).click();
};

type LoadedTasks = Awaited<ReturnType<typeof loadTasks>>;

const pickBacklogTask = (tasks: LoadedTasks['tasks']) =>
  tasks.find((task) => task.status === 'backlog') ?? null;

const requireTask = <T>(value: T | null | undefined, message: string): T => {
  if (value === null || value === undefined) {
    throw new Error(message);
  }

  return value;
};

test('the operator console renders the queue and lets me inspect a task', async ({ page }) => {
  const tasks = await loadTasks(page);

  await page.goto('/');
  await expect(page.getByTestId('task-list')).toBeVisible();
  await expect(page.getByTestId('task-list').locator('li')).toHaveCount(tasks.tasks.length);

  const candidate = requireTask(
    tasks.tasks[tasks.tasks.length - 1],
    'Expected at least one task in the queue',
  );
  await clickTask(page, candidate.fixture.id);

  await expect(page.getByTestId(`task-item-${candidate.fixture.id}`)).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(page.getByTestId('selected-task')).toContainText(candidate.fixture.title);
  await expect(page.getByTestId('selected-task')).toContainText(candidate.currentStage);
  await expect(page.getByTestId('provider-session-banner')).toHaveText(
    'not started · M1 planning only',
  );
});

test('generating a backlog task materializes the workflow, timeline, and graph tree', async ({
  page,
}) => {
  const tasks = await loadTasks(page);
  const backlog = requireTask(
    pickBacklogTask(tasks.tasks),
    'Expected at least one backlog task in the queue',
  );

  await page.goto('/');
  await clickTask(page, backlog.fixture.id);
  await page.getByRole('button', { name: 'Generate workflow' }).click();

  const workflow = await loadWorkflow(page, backlog.fixture.id);
  expect(workflow.status).toBe('ready');
  expect(workflow.view.workflow.graphHash).not.toBeNull();

  const activity = await loadActivity(page, backlog.fixture.id);
  expect(activity.entries.length).toBeGreaterThan(0);

  await expect(page.getByTestId('workflow-sidebar')).toContainText(backlog.fixture.title);
  await expect(page.getByTestId('workflow-tree')).toBeVisible();
  await expect(page.getByTestId('task-activity-timeline')).toBeVisible();
  await expect(page.getByTestId('workflow-decisions')).toBeVisible();
  await expect(page.getByTestId('validation-panel')).toContainText('Validator passed');
  await expect(page.getByTestId('graph-hash')).not.toHaveText('not compiled');
  await expect(page.getByTestId('workflow-debug-details')).toContainText('Template → task graph');
  await expect(page.getByRole('link', { name: 'Download graph JSON' })).toBeVisible();
});

test('the project profile explains why inline copy adds no translation wait', async ({ page }) => {
  const tasks = await loadTasks(page);
  const inlineCopy = requireTask(
    tasks.tasks.find((task) => task.fixture.id === 'avia-14002-inline-copy'),
    'Expected the inline-copy policy fixture to exist',
  );

  await page.goto('/');
  await clickTask(page, inlineCopy.fixture.id);
  await page.getByRole('button', { name: 'Generate workflow' }).click();

  const workflow = await loadWorkflow(page, inlineCopy.fixture.id);
  expect(workflow.view.workflow.waits.map((wait) => wait.waitKind)).not.toContain(
    'translation_complete@1',
  );
  expect(
    workflow.view.workflow.assemblyDecisions.find(
      (decision) => decision.id === 'translation-policy',
    )?.title,
  ).toBe('Inline translation policy applied');

  await page.getByRole('button', { name: /Why this workflow/ }).click();
  await expect(page.getByTestId('workflow-decision-list')).toContainText(
    'Inline translation policy applied',
  );
  await expect(page.getByTestId('workflow-decision-list')).toContainText('project:twiket/avia-web');
  await expect(page.getByTestId('workflow-decision-list')).toContainText(
    'add no translation commands or wait',
  );
});

test('an invalid workflow is rejected and surfaces validation issues instead of a tree', async ({
  page,
}) => {
  const tasks = await loadTasks(page);
  const invalid = requireTask(
    tasks.tasks.find((task) => task.fixture.family === 'invalid_workflow'),
    'Expected an invalid workflow fixture to exist',
  );

  await page.goto('/');
  await clickTask(page, invalid.fixture.id);
  await page.getByRole('button', { name: 'Generate workflow' }).click();

  const workflow = await loadWorkflow(page, invalid.fixture.id);
  expect(workflow.status).toBe('rejected');
  expect(workflow.view.workflow.tree).toBeNull();
  expect(workflow.view.workflow.validatorReport.issues.length).toBeGreaterThan(0);

  await expect(page.getByTestId('validation-errors')).toBeVisible();
  await expect(page.getByTestId('workflow-sidebar')).toContainText('rejected');
  await expect(page.getByTestId('workflow-tree')).toHaveCount(0);
});

test('reloading restores the persisted workflow for the selected task', async ({ page }) => {
  const tasks = await loadTasks(page);
  const backlog = requireTask(
    pickBacklogTask(tasks.tasks),
    'Expected at least one backlog task in the queue',
  );

  await page.goto('/');
  await clickTask(page, backlog.fixture.id);
  await page.getByRole('button', { name: 'Generate workflow' }).click();

  const workflow = await loadWorkflow(page, backlog.fixture.id);
  const hash = workflow.view.workflow.graphHash;
  expect(hash).not.toBeNull();

  await page.reload();

  await expect(page.getByTestId('selected-task')).toContainText(backlog.fixture.title);
  await expect(page.getByTestId('graph-hash')).toHaveText(hash ?? '');
  await expect(page.getByTestId('workflow-tree')).toBeVisible();
});

test('a ledger event from another page refreshes the visible task status', async ({
  context,
  page,
}) => {
  const tasks = await loadTasks(page);
  const backlog = requireTask(
    tasks.tasks.find(
      (task) => task.status === 'backlog' && task.fixture.family !== 'invalid_workflow',
    ),
    'Expected a backlog task that can generate a ready graph',
  );

  await page.goto('/');
  await clickTask(page, backlog.fixture.id);
  await expect(page.getByTestId(`task-item-${backlog.fixture.id}`)).toContainText('Backlog');

  const ledgerEventPromise = page.evaluate(
    (fixtureId: string) =>
      new Promise<string>((resolve) => {
        const source = new EventSource('/api/events');
        source.addEventListener('ledger', (event) => {
          if (!(event instanceof MessageEvent)) {
            return;
          }

          const data: unknown = event.data;
          if (typeof data !== 'string') {
            return;
          }

          const parsed: { fixtureId?: unknown } = JSON.parse(data) as { fixtureId?: unknown };
          if (parsed.fixtureId !== fixtureId) {
            return;
          }

          resolve(data);
          source.close();
        });
      }),
    backlog.fixture.id,
  );

  const secondaryPage = await context.newPage();
  await secondaryPage.goto('/');
  await clickTask(secondaryPage, backlog.fixture.id);
  await secondaryPage.getByRole('button', { name: 'Generate workflow' }).click();

  const rawLedgerEvent = await ledgerEventPromise;
  const parsedLedgerEvent = OperatorStreamEventSchema.parse(JSON.parse(rawLedgerEvent));
  expect(parsedLedgerEvent.fixtureId).toBe(backlog.fixture.id);

  const generatedWorkflow = await loadWorkflow(page, backlog.fixture.id);
  const expectedStatus = generatedWorkflow.status === 'ready' ? 'Planned' : 'Workflow rejected';

  await expect(page.getByTestId(`task-item-${backlog.fixture.id}`)).toContainText(expectedStatus);
  await expect(page.getByTestId('selected-task')).toContainText(backlog.fixture.title);
  await expect(page.getByTestId('validation-panel')).toBeVisible();
  await expect(page.getByTestId('task-activity-timeline')).toBeVisible();
});
