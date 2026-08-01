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
  tasks.find((task) => task.status === 'backlog' && task.planning.status === 'available') ?? null;

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
  await clickTask(page, candidate.id);

  await expect(page.getByTestId(`task-item-${candidate.id}`)).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(page.getByTestId('selected-task')).toContainText(candidate.title);
  await expect(page.getByTestId('selected-task')).toContainText(candidate.currentStage);
  await expect(page.getByTestId('provider-session-banner')).toHaveText(
    'no provider session · deterministic fixture',
  );
});

test('I can import a Jira issue, inspect its evidence, and compile its workflow', async ({
  page,
}) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Import Jira issue' }).click();
  await page.getByRole('textbox', { name: 'Jira issue key' }).fill('AVIA-13235');
  await page.getByRole('combobox', { name: 'Repository (optional)' }).fill('front-avia');
  await page.getByRole('button', { name: 'Open' }).click();

  await expect(page.getByTestId('task-item-jira:AVIA-13235')).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(page.getByTestId('jira-task-details')).toContainText('Jira synced');
  await expect(page.getByTestId('jira-task-details')).toContainText('Environment');
  await expect(page.getByTestId('jira-task-details')).toContainText('Open seat selection');
  await expect(page.getByTestId('jira-task-details')).toContainText('Evidence · 2');
  await expect(page.getByTestId('jira-task-details')).toContainText('Comments · 1');
  await expect(page.getByTestId('task-activity-timeline')).toContainText('Repository mapped');
  await expect(page.getByTestId('task-activity-timeline')).not.toContainText(
    'Jira snapshot synchronized',
  );
  await expect(page.getByRole('button', { name: 'Generate workflow' })).toBeVisible();
  await expect(page.getByText('front-avia mapped · ready to generate workflow')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Current workflow' })).toContainText(
    'Repository mappingcomplete',
  );
  await expect(page.getByRole('complementary', { name: 'Current workflow' })).toContainText(
    'Read-only analysisready',
  );

  await page.getByRole('button', { name: 'Generate workflow' }).click();

  const workflow = await loadWorkflow(page, 'jira:AVIA-13235');
  expect(workflow).toMatchObject({
    status: 'ready',
    view: { fixture: { id: 'jira:AVIA-13235', family: 'short_bugfix' } },
  });
  await expect(page.getByTestId('task-activity-timeline')).toContainText(
    'Workflow compiled and persisted',
  );
  await expect(page.getByRole('complementary', { name: 'Current workflow' })).toContainText(
    'reproduce-bug',
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
  await clickTask(page, backlog.id);
  await page.getByRole('button', { name: 'Generate workflow' }).click();

  const workflow = await loadWorkflow(page, backlog.id);
  expect(workflow.status).toBe('ready');
  expect(workflow.view.workflow.graphHash).not.toBeNull();

  const activity = await loadActivity(page, backlog.id);
  expect(activity.entries.length).toBeGreaterThan(0);

  await expect(page.getByTestId('workflow-sidebar')).toContainText(backlog.title);
  await expect(page.getByTestId('workflow-tree')).toBeVisible();
  await expect(page.getByTestId('task-activity-timeline')).toBeVisible();
  await expect(page.getByTestId('workflow-decisions')).toBeVisible();
  await expect(page.getByTestId('validation-panel')).toContainText('Validator passed');
  await expect(page.getByTestId('graph-hash')).not.toHaveText('not compiled');
  await expect(page.getByTestId('workflow-debug-details')).toContainText('Template → task graph');
  await expect(page.getByRole('link', { name: 'Download graph JSON' })).toBeVisible();
});

test('a planned workflow runs to the durable code-review wait', async ({ page }) => {
  const tasks = await loadTasks(page);
  const candidate = requireTask(
    tasks.tasks.find((task) => task.status === 'planned') ?? pickBacklogTask(tasks.tasks),
    'Expected a task that can reach stub execution',
  );

  await page.goto('/');
  await clickTask(page, candidate.id);
  if (candidate.status === 'backlog') {
    await page.getByRole('button', { name: 'Generate workflow' }).click();
  }
  await page.getByRole('button', { name: 'Start', exact: true }).click();

  await expect(page.getByTestId(`task-item-${candidate.id}`)).toContainText('Code review');
  await expect(page.getByTestId('selected-task')).toContainText('Waiting for code review');
  await expect(page.getByTestId('task-activity-timeline')).toContainText('Run started');
  await expect(page.getByTestId('task-activity-timeline')).toContainText('Waiting for code review');
  await expect(page.getByTestId('workflow-tree').getByLabel('waiting')).toHaveCount(2);
});

test('the project profile explains why inline copy adds no translation wait', async ({ page }) => {
  const tasks = await loadTasks(page);
  const inlineCopy = requireTask(
    tasks.tasks.find((task) => task.id === 'avia-14002-inline-copy'),
    'Expected the inline-copy policy fixture to exist',
  );

  await page.goto('/');
  await clickTask(page, inlineCopy.id);
  await page.getByRole('button', { name: 'Generate workflow' }).click();

  const workflow = await loadWorkflow(page, inlineCopy.id);
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
    tasks.tasks.find(
      (task) => task.origin.kind === 'fixture' && task.origin.family === 'invalid_workflow',
    ),
    'Expected an invalid workflow fixture to exist',
  );

  await page.goto('/');
  await clickTask(page, invalid.id);
  await page.getByRole('button', { name: 'Generate workflow' }).click();

  const workflow = await loadWorkflow(page, invalid.id);
  expect(workflow.status).toBe('rejected');
  expect(workflow.view.workflow.tree).toBeNull();
  expect(workflow.view.workflow.validatorReport.issues.length).toBeGreaterThan(0);

  await expect(page.getByTestId('validation-errors')).toBeVisible();
  await expect(page.getByTestId('workflow-sidebar')).toContainText('rejected');
  await expect(page.getByTestId('workflow-tree')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Regenerate workflow' })).toBeVisible();

  await page.getByRole('button', { name: 'Regenerate workflow' }).click();

  await expect(
    page.getByTestId('task-activity-timeline').getByText('Workflow rejected'),
  ).toHaveCount(2);
});

test('reloading restores the persisted workflow for the selected task', async ({ page }) => {
  const tasks = await loadTasks(page);
  const backlog = requireTask(
    pickBacklogTask(tasks.tasks),
    'Expected at least one backlog task in the queue',
  );

  await page.goto('/');
  await clickTask(page, backlog.id);
  await page.getByRole('button', { name: 'Generate workflow' }).click();

  const workflow = await loadWorkflow(page, backlog.id);
  const hash = workflow.view.workflow.graphHash;
  expect(hash).not.toBeNull();

  await page.reload();

  await expect(page.getByTestId('selected-task')).toContainText(backlog.title);
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
      (task) =>
        task.status === 'backlog' &&
        task.origin.kind === 'fixture' &&
        task.origin.family !== 'invalid_workflow',
    ),
    'Expected a backlog task that can generate a ready graph',
  );

  await page.goto('/');
  await clickTask(page, backlog.id);
  await expect(page.getByTestId(`task-item-${backlog.id}`)).toContainText('Backlog');

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
    backlog.id,
  );

  const secondaryPage = await context.newPage();
  await secondaryPage.goto('/');
  await clickTask(secondaryPage, backlog.id);
  await secondaryPage.getByRole('button', { name: 'Generate workflow' }).click();

  const rawLedgerEvent = await ledgerEventPromise;
  const parsedLedgerEvent = OperatorStreamEventSchema.parse(JSON.parse(rawLedgerEvent));
  expect(parsedLedgerEvent.fixtureId).toBe(backlog.id);

  const generatedWorkflow = await loadWorkflow(page, backlog.id);
  const expectedStatus = generatedWorkflow.status === 'ready' ? 'Planned' : 'Workflow rejected';

  await expect(page.getByTestId(`task-item-${backlog.id}`)).toContainText(expectedStatus);
  await expect(page.getByTestId('selected-task')).toContainText(backlog.title);
  await expect(page.getByTestId('validation-panel')).toBeVisible();
  await expect(page.getByTestId('task-activity-timeline')).toBeVisible();
});
