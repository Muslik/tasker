import { expect, test } from '@playwright/test';
import type { APIResponse, Page } from '@playwright/test';
import type { ZodType } from 'zod';

import {
  ExecutionRunViewSchema,
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
  const path = `/api/workflows/${encodeURIComponent(fixtureId)}`;
  await expect
    .poll(async () => (await page.request.get(path)).status(), { timeout: 20_000 })
    .toBe(200);
  const response = await page.request.get(path);
  return readJson(response, WorkflowResponseSchema);
};

const loadActivity = async (page: Page, fixtureId: string) => {
  const response = await page.request.get(
    `/api/operator/tasks/${encodeURIComponent(fixtureId)}/activity`,
  );
  return readJson(response, OperatorActivityResponseSchema);
};

const loadRun = async (page: Page, fixtureId: string) => {
  const response = await page.request.get(`/api/workflows/${encodeURIComponent(fixtureId)}/run`);
  return readJson(response, ExecutionRunViewSchema);
};

const clickTask = async (page: Page, fixtureId: string) => {
  await page.getByTestId(`task-item-${fixtureId}`).click();
};

const generateAutomatically = async (page: Page): Promise<void> => {
  await page.getByRole('checkbox', { name: 'Review plan before execution' }).uncheck();
  await page.getByRole('button', { name: 'Generate workflow' }).click();
};

const waitForRunWait = async (page: Page, fixtureId: string, waitKind: string): Promise<void> => {
  await expect
    .poll(
      async () => {
        try {
          const run = await loadRun(page, fixtureId);
          return run.status === 'waiting' ? run.wait.waitKind : run.status;
        } catch {
          return 'runtime_query_unavailable';
        }
      },
      { timeout: 20_000 },
    )
    .toBe(waitKind);
};

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
  await expect(page.getByRole('button', { name: 'Live', exact: true })).toBeVisible();
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

test('the task rail can be hidden, restored, and keeps its preference', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('complementary', { name: 'Task queue' })).toBeVisible();
  await page.getByRole('button', { name: 'Hide tasks' }).click();
  await expect(page.getByRole('complementary', { name: 'Task queue' })).toHaveCount(0);
  await expect(page.getByTestId('operator-layout')).toHaveAttribute('data-tasks-collapsed', 'true');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Show tasks' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Task queue' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Show tasks' }).click();
  await expect(page.getByRole('complementary', { name: 'Task queue' })).toBeVisible();
});

test('the operator theme can be changed and survives reload', async ({ page }) => {
  await page.goto('/');

  const root = page.locator('html');
  const rootClass = await root.getAttribute('class');
  const dark = rootClass?.split(/\s+/u).includes('dark') ?? false;
  const toggle = page.getByRole('button', {
    name: dark ? 'Use light theme' : 'Use dark theme',
  });
  await toggle.click();
  if (dark) {
    await expect(root).not.toHaveClass(/\bdark\b/u);
  } else {
    await expect(root).toHaveClass(/\bdark\b/u);
  }

  await page.reload();
  await expect(
    page.getByRole('button', { name: dark ? 'Use dark theme' : 'Use light theme' }),
  ).toBeVisible();
});

test('the planning agent log presents attempts instead of raw provider JSONL', async ({ page }) => {
  const errorMessage = "Invalid response schema. Missing 'evidenceRequests'.";
  const output = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({
      type: 'error',
      message: JSON.stringify({ error: { message: errorMessage }, status: 400 }),
    }),
    JSON.stringify({ type: 'turn.failed', error: { message: errorMessage } }),
  ].join('\n');
  await page.route('**/api/workflows/*/planning-transcript', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        transcriptId: 'planning-transcript:browser-test',
        operationId: 'browser-test',
        chunks: [
          {
            schemaVersion: 1,
            transcriptId: 'planning-transcript:browser-test',
            operationId: 'browser-test',
            sequence: 1,
            providerAttempt: 1,
            stream: 'stdout',
            content: output,
            byteLength: output.length,
            recordedAt: '2026-08-05T12:00:00.000Z',
          },
        ],
        totalBytes: output.length,
        truncated: false,
      }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Agent log/u }).click();

  const log = page.getByTestId('planning-transcript');
  await expect(log).toContainText('Attempt 1');
  await expect(log).toContainText(errorMessage);
  const rawLog = log.locator('details', { hasText: 'Raw JSONL' });
  await expect(rawLog).not.toHaveAttribute('open', '');
  await expect(rawLog.locator('pre')).toBeHidden();
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
  await expect(page.getByTestId('task-activity-timeline')).toContainText(
    'No persisted activity yet',
  );
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

  await waitForRunWait(page, 'jira:AVIA-13235', 'plan.approved@1');

  const workflow = await loadWorkflow(page, 'jira:AVIA-13235');
  expect(workflow).toMatchObject({
    status: 'ready',
    view: { fixture: { id: 'jira:AVIA-13235', family: 'short_bugfix' } },
  });
  await expect(page.getByTestId('task-activity-timeline')).toContainText(
    'Workflow compiled and persisted',
  );
  const workflowRail = page.getByRole('complementary', { name: 'Current workflow' });
  await expect(workflowRail).toContainText('Validate');
  await expect(workflowRail).not.toContainText('bug.validate_fix@1');
});

test('generating a backlog task materializes the workflow, timeline, and operator stages', async ({
  page,
}) => {
  const tasks = await loadTasks(page);
  const backlog = requireTask(
    tasks.tasks.find((task) => task.id === 'avia-13236-short-bug'),
    'Expected the short bug task in the queue',
  );

  await page.goto('/');
  await clickTask(page, backlog.id);
  await generateAutomatically(page);
  await waitForRunWait(page, backlog.id, 'execution.start@1');

  const workflow = await loadWorkflow(page, backlog.id);
  expect(workflow.status).toBe('ready');
  expect(workflow.view.workflow.graphHash).not.toBeNull();

  const activity = await loadActivity(page, backlog.id);
  expect(activity.entries.length).toBeGreaterThan(0);

  await expect(page.getByTestId('workflow-sidebar')).toContainText(backlog.title);
  await expect(page.getByTestId('workflow-stages')).toBeVisible();
  await expect(
    page
      .getByTestId('workflow-stage-bootstrap:workspace:1')
      .getByText('Workspace', { exact: true }),
  ).toBeVisible();
  const workflowStages = page.getByTestId('workflow-stages');
  await expect(workflowStages).toContainText('Validate');
  await expect(workflowStages).toContainText('Agent review');
  await expect(workflowStages).not.toContainText('Validate targeted');
  await expect(workflowStages).not.toContainText('Repair validation');
  await expect(workflowStages).not.toContainText('initialize AI assistance');
  await expect(workflowStages).not.toContainText('0/3 attempts');
  await expect(page.getByTestId('task-activity-timeline')).toBeVisible();
  await expect(page.getByTestId('workflow-decisions')).toBeVisible();
  await expect(page.getByTestId('validation-panel')).toContainText('Workflow graph valid');
  await expect(page.getByTestId('graph-hash')).not.toHaveText('not compiled');
  await expect(page.getByTestId('workflow-debug-details')).toContainText('Task-specific graph');
  await expect(page.getByRole('link', { name: 'Download graph JSON' })).toBeVisible();
});

test('generation progress remains attached to the task that started it', async ({ page }) => {
  const tasks = await loadTasks(page);
  const candidates = tasks.tasks.filter(
    (task) =>
      task.status === 'backlog' &&
      task.planning.status === 'available' &&
      task.origin.kind === 'fixture' &&
      task.origin.family !== 'invalid_workflow',
  );
  const first = requireTask(candidates[0], 'Expected a first backlog task');
  const second = requireTask(candidates[1], 'Expected a second backlog task');
  let releaseGeneration = (): void => {
    throw new Error('Generation request was not intercepted');
  };
  const generationGate = new Promise<void>((resolve) => {
    releaseGeneration = resolve;
  });
  await page.route(`**/api/workflows/${first.id}/generate`, async (route) => {
    await generationGate;
    await route.abort('failed');
  });

  await page.goto('/');
  await clickTask(page, first.id);
  await page.getByRole('button', { name: 'Generate workflow' }).click();
  await expect(page.getByRole('button', { name: 'Generating…' })).toBeVisible();

  await clickTask(page, second.id);

  await expect(page.getByTestId('selected-task')).toContainText(second.title);
  await expect(page.getByRole('button', { name: 'Generate workflow' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Generating…' })).toHaveCount(0);

  releaseGeneration();
  await expect(page.getByTestId(`task-item-${first.id}`)).toContainText('Backlog');
});

test('I can send plan feedback and review the new planning attempt', async ({ page }) => {
  const fixtureId = 'avia-12536-feature-review';
  const guidance = 'Keep the visual check, but verify the booking summary before the full suite.';
  const tasks = await loadTasks(page);
  const candidate = requireTask(
    tasks.tasks.find((task) => task.id === fixtureId),
    'Expected the feature-with-review fixture to exist',
  );

  await page.goto('/');
  await clickTask(page, fixtureId);
  if (candidate.status === 'backlog') {
    await page.getByRole('button', { name: 'Generate workflow' }).click();
  }

  await waitForRunWait(page, fixtureId, 'plan.approved@1');
  await expect(page.getByTestId(`task-item-${fixtureId}`)).toContainText('Plan review');
  const reviewSurface = page.getByTestId('plan-review-surface');
  const reviewActions = page.getByTestId('plan-review-actions');
  await expect(reviewSurface).toBeVisible();
  await expect(reviewSurface).toContainText('Implement the requested task');
  await expect(reviewSurface).toContainText('Action required · review plan');
  await expect(reviewActions.getByRole('button', { name: 'Approve plan' })).toBeVisible();
  await reviewActions.getByRole('textbox', { name: 'Plan review guidance' }).fill(guidance);
  await reviewActions.getByRole('button', { name: 'Request changes' }).click();

  await expect(page.getByTestId(`task-item-${fixtureId}`)).toContainText('Plan review');
  await expect(reviewSurface).toBeVisible();
  const planGuidance = page.getByRole('textbox', { name: 'Plan review guidance' });
  await expect(reviewSurface).toContainText('attempt 2');
  await expect(planGuidance).toHaveValue('', { timeout: 20_000 });
  await expect(page.getByTestId('implementation-plan')).toContainText(guidance);
  const activity = await loadActivity(page, fixtureId);
  expect(activity.entries.some((entry) => entry.title === 'Implementation planning')).toBe(true);
});

test('the plan review document renders safe Markdown next to its decision controls', async ({
  page,
}) => {
  const fixtureId = 'avia-13236-short-bug';

  await page.route(`**/api/workflows/${fixtureId}/implementation-plan`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      status?: string;
      decision?: { plan?: { summary?: string; steps?: Array<{ objective?: string }> } };
    };
    if (body.status === 'ready' && body.decision?.plan !== undefined) {
      body.decision.plan.summary =
        '**Review focus**: preserve `booking-summary` behavior.\n\n<div data-unsafe="true">raw HTML must not render</div>';
      const firstStep = body.decision.plan.steps?.[0];
      if (firstStep !== undefined) {
        firstStep.objective = '- Keep the existing flow\n- Verify the changed surface';
      }
    }
    await route.fulfill({ response, json: body });
  });

  await page.goto('/');
  await clickTask(page, fixtureId);
  await page.getByRole('button', { name: 'Generate workflow' }).click();
  await waitForRunWait(page, fixtureId, 'plan.approved@1');

  const reviewSurface = page.getByTestId('plan-review-surface');
  await expect(reviewSurface.locator('strong').filter({ hasText: 'Review focus' })).toBeVisible();
  await expect(reviewSurface.locator('code').filter({ hasText: 'booking-summary' })).toBeVisible();
  await expect(reviewSurface.locator('[data-unsafe="true"]')).toHaveCount(0);
  await expect(reviewSurface.getByText('Keep the existing flow', { exact: true })).toBeVisible();
  await expect(
    reviewSurface.getByText('Verify the changed surface', { exact: true }),
  ).toBeVisible();
  await reviewSurface.getByRole('button', { name: 'Open plan full screen' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const planArtifactId = await reviewSurface
    .locator('[data-plan-anchor]')
    .getAttribute('data-plan-anchor');
  if (planArtifactId === null) throw new Error('Expected the plan artifact id');
  const annotationDraft = JSON.stringify({
    [planArtifactId]: [
      {
        id: 'annotation-browser-test',
        anchor: planArtifactId,
        quote: 'Review focus',
        startOffset: 0,
        endOffset: 12,
        comment: 'Keep this constraint explicit in the revised plan.',
      },
    ],
  });
  await page.evaluate(
    `globalThis.localStorage.setItem('tasker.operator.planAnnotations', ${JSON.stringify(annotationDraft)})`,
  );
  await expect
    .poll(async () =>
      page.evaluate(`globalThis.localStorage.getItem('tasker.operator.planAnnotations') ?? ''`),
    )
    .toContain('annotation-browser-test');
  await page.reload();
  await expect
    .poll(async () =>
      page.evaluate(`globalThis.localStorage.getItem('tasker.operator.planAnnotations') ?? ''`),
    )
    .toContain('annotation-browser-test');
  await expect(page.getByTestId('plan-annotation-list')).toContainText(
    'Keep this constraint explicit in the revised plan.',
  );
  await expect(page.getByRole('button', { name: 'Approve plan' })).toBeDisabled();
  await reviewSurface.getByRole('button', { name: 'Open plan full screen' }).click();
  await page.getByRole('button', { name: 'Close full screen plan' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('plan-review-actions')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve plan' })).toBeDisabled();
  await page.getByRole('button', { name: 'Remove annotation 1' }).click();
  await page.getByRole('button', { name: 'Approve plan' }).click();
  await waitForRunWait(page, fixtureId, 'execution.start@1');
});

test('the planner owns a cross-repository workflow candidate before freeze', async ({ page }) => {
  const fixtureId = 'avia-13236-short-bug';
  const tasks = await loadTasks(page);
  const candidate = requireTask(
    tasks.tasks.find((task) => task.id === fixtureId),
    'Expected the short bug fixture to exist',
  );

  await page.goto('/');
  await clickTask(page, fixtureId);
  if (candidate.status === 'backlog') {
    await generateAutomatically(page);
  }

  await waitForRunWait(page, fixtureId, 'execution.start@1');
  const parentAfter = await loadWorkflow(page, fixtureId);
  expect(JSON.stringify(parentAfter.view.workflow.graph)).toContain('twiket/ui-kit');
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
  await waitForRunWait(page, fixtureId, 'code_review@1');
  const run = await loadRun(page, fixtureId);
  expect(run).toMatchObject({
    runtime: 'execution',
    workflowHash: parentAfter.view.workflow.graphHash,
  });
  const activity = await loadActivity(page, fixtureId);
  expect(activity.entries.some((entry) => entry.title === 'Implementation planning')).toBe(true);
});

test('a planned workflow can be tested to the durable code-review wait', async ({ page }) => {
  const tasks = await loadTasks(page);
  const candidate = requireTask(
    tasks.tasks.find((task) => task.id === 'avia-12536-feature-review'),
    'Expected the single-repository review fixture',
  );

  await page.goto('/');
  await clickTask(page, candidate.id);
  if (candidate.status === 'backlog') {
    await page.getByRole('button', { name: 'Generate workflow' }).click();
  }
  await waitForRunWait(page, candidate.id, 'plan.approved@1');
  await page.getByRole('button', { name: 'Approve plan' }).click();
  await waitForRunWait(page, candidate.id, 'execution.start@1');
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click();

  await expect(page.getByTestId(`task-item-${candidate.id}`)).toContainText('Code review', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('selected-task')).toContainText('Waiting for code review', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('workflow-stages').getByLabel('stage waiting')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Sync review' })).toBeVisible();
  await page.getByRole('button', { name: 'Mark done' }).click();
  await expect(page.getByTestId(`task-item-${candidate.id}`)).toContainText('Done');
  await expect(page.getByTestId('selected-task')).toContainText('Workflow completed');
});

test('the project profile explains why inline copy adds no translation wait', async ({ page }) => {
  const tasks = await loadTasks(page);
  const inlineCopy = requireTask(
    tasks.tasks.find((task) => task.id === 'avia-14002-inline-copy'),
    'Expected the inline-copy policy fixture to exist',
  );

  await page.goto('/');
  await clickTask(page, inlineCopy.id);
  await generateAutomatically(page);

  await waitForRunWait(page, inlineCopy.id, 'human_clarification');
  await expect(page.getByTestId('planning-clarification')).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Should this copy stay local to the application?' })
    .fill('Yes, keep the copy in the application locale JSON.');
  await page.getByRole('button', { name: 'Continue planning' }).click();
  await waitForRunWait(page, inlineCopy.id, 'execution.start@1');

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
  await expect(page.getByTestId('workflow-decision-list')).toContainText(
    'project:onetwotrip/front-avia',
  );
  await expect(page.getByTestId('workflow-decision-list')).toContainText(
    'add no translation commands or wait',
  );
  await expect(page.getByTestId('implementation-plan')).toContainText('attempt 2');
  await expect(page.getByTestId('task-activity-timeline')).toContainText(
    'Planning clarification answered',
  );
  await expect(page.getByTestId('task-activity-timeline')).toContainText('Implementation planning');
});

test('an invalid planner candidate pauses planning without an executable graph', async ({
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

  await waitForRunWait(page, invalid.id, 'planning.candidate-guidance@1');
  const workflow = await loadWorkflow(page, invalid.id);

  expect(workflow.status).toBe('rejected');
  expect(workflow.view.workflow.graphHash).toBeNull();
  expect(workflow.view.workflow.graph).toBeNull();
  expect(workflow.view.workflow.validatorReport.issues.length).toBeGreaterThan(0);
  await expect(page.getByTestId('validation-errors')).toBeVisible();
  await expect(page.getByTestId('workflow-stages')).toBeVisible();
  await expect(page.getByTestId('workflow-stages').locator(':scope > details')).toHaveCount(3);
  await expect(page.getByTestId('workflow-stages')).toContainText('Plan');
  await expect(page.getByTestId(`task-item-${invalid.id}`)).toContainText('Waiting', {
    timeout: 20_000,
  });
  await expect(page.getByText('Action required', { exact: true })).toBeVisible();
  await expect(page.getByTestId('selected-task')).toContainText(
    'Workflow candidate rejected after automatic correction',
  );
  await expect(page.getByTestId('selected-task')).not.toContainText('Workflow ready');
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
});

test('reloading restores the selected task before subscribing to live updates', async ({
  page,
}) => {
  const tasks = await loadTasks(page);
  const backlog = requireTask(
    tasks.tasks.find((task) => task.id === 'avia-12536-feature-review'),
    'Expected the stable single-repository fixture',
  );

  await page.goto('/');
  await clickTask(page, backlog.id);
  if (backlog.status === 'backlog') {
    await generateAutomatically(page);
    await waitForRunWait(page, backlog.id, 'execution.start@1');
  }

  const workflow = await loadWorkflow(page, backlog.id);
  const hash = workflow.view.workflow.graphHash;
  expect(hash).not.toBeNull();

  const taskSnapshotLoaded = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/operator/tasks',
  );
  const liveUpdatesConnected = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/events',
    { timeout: 15_000 },
  );

  await page.reload();
  const [taskSnapshotResponse, liveUpdatesRequest] = await Promise.all([
    taskSnapshotLoaded,
    liveUpdatesConnected,
  ]);
  const taskSnapshot = OperatorTaskListResponseSchema.parse(await taskSnapshotResponse.json());
  expect(new URL(liveUpdatesRequest.url()).searchParams.get('after')).toBe(
    String(taskSnapshot.streamCursor),
  );

  await expect(page.getByTestId('selected-task')).toContainText(backlog.title);
  await expect(page.getByTestId('graph-hash')).toHaveText(hash ?? '', { timeout: 15_000 });
  await expect(page.getByTestId('workflow-stages')).toBeVisible({ timeout: 15_000 });
});

test('a ledger event from another page refreshes the visible task status', async ({
  context,
  page,
}) => {
  const tasks = await loadTasks(page);
  const backlog = requireTask(
    tasks.tasks.find((task) => task.id === 'invalid-missing-terminal'),
    'Expected an unused invalid fixture that can emit a ledger event',
  );

  await page.goto('/');
  await clickTask(page, backlog.id);
  await expect(page.getByTestId(`task-item-${backlog.id}`)).toContainText('Backlog');
  await expect(page.getByRole('button', { name: 'Live', exact: true })).toBeVisible();

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
  expect(generatedWorkflow.status).toBe('rejected');
  await waitForRunWait(page, backlog.id, 'planning.candidate-guidance@1');
  await expect(page.getByTestId(`task-item-${backlog.id}`)).toContainText('Waiting');
  await expect(page.getByTestId('selected-task')).toContainText(backlog.title);
  await expect(page.getByTestId('validation-panel')).toBeVisible();
  await expect(page.getByTestId('task-activity-timeline')).toBeVisible();
});
