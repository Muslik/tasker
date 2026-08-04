import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JiraIssuePort } from '../../src/integrations/jira/client.js';
import { createJiraIssueService } from '../../src/integrations/jira/service.js';
import { openSqliteLedger, type SqliteLedger } from '../../src/ledger/index.js';
import { StaticRepositoryCatalog } from '../../src/repositories/catalog.js';
import { makeAdjustableClock } from '../../src/shared/clock.js';
import { err, ok } from '../../src/shared/outcome.js';
import { makeJiraSnapshot } from '../helpers/jira.js';
import { makeRepositoryCatalog } from '../helpers/repositories.js';

const resources: { readonly directory: string; readonly ledger: SqliteLedger }[] = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.ledger.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('Jira issue persistence', () => {
  it('keeps an intake repository when the first Jira request is blocked', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-jira-blocked-intake-'));
    const clock = makeAdjustableClock('2026-08-01T19:15:00.000Z');
    const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
    resources.push({ directory, ledger });
    const blockedPort: JiraIssuePort = {
      fetchIssue: vi.fn(() =>
        Promise.resolve(
          err({
            kind: 'access_blocked' as const,
            message: 'Jira returned 403. VPN or Jira access may be required',
            retryable: true as const,
            httpStatus: 403 as const,
          }),
        ),
      ),
      fetchAttachment: vi.fn(),
    };
    const service = createJiraIssueService(ledger.repository, clock, blockedPort, {
      repositoryCatalog: makeRepositoryCatalog(),
    });

    const sync = await service.sync('AVIA-12045', 'front-avia');
    const tasks = service.listOperatorTasks();

    expect(sync).toMatchObject({ ok: true, value: { status: 'unavailable' } });
    expect(tasks).toMatchObject({
      ok: true,
      value: [
        {
          id: 'jira:AVIA-12045',
          status: 'needs_attention',
          currentStage: 'Jira sync blocked · no cached snapshot',
          origin: {
            repositoryBinding: {
              status: 'resolved',
              source: 'intake_fallback',
              reference: 'front-avia',
              repository: { repositoryId: 'front-avia' },
            },
          },
          planning: { status: 'blocked' },
        },
      ],
    });
  });

  it('keeps the last successful snapshot when Jira later returns 403', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-jira-restart-'));
    const database = join(directory, 'ledger.sqlite');
    const clock = makeAdjustableClock('2026-08-01T19:15:00.000Z');
    const firstLedger = openSqliteLedger({ filename: database, clock });
    resources.push({ directory, ledger: firstLedger });
    const successfulPort: JiraIssuePort = {
      fetchIssue: vi.fn(() =>
        Promise.resolve(ok(makeJiraSnapshot({ description: 'repo:front-avia' }))),
      ),
      fetchAttachment: vi.fn(),
    };
    const firstService = createJiraIssueService(firstLedger.repository, clock, successfulPort, {
      repositoryCatalog: makeRepositoryCatalog(),
    });

    const firstSync = await firstService.sync('AVIA-13235');

    expect(firstSync).toMatchObject({ ok: true, value: { status: 'current' } });
    expect(
      firstLedger.repository.listEvents('intake:jira:AVIA-13235').map((event) => event.eventType),
    ).toEqual(['JiraIntakeRequested', 'JiraRepositoryBound']);
    firstLedger.close();
    resources.pop();

    clock.advance(60_000);
    const restartedLedger = openSqliteLedger({ filename: database, clock });
    resources.push({ directory, ledger: restartedLedger });
    const blockedPort: JiraIssuePort = {
      fetchIssue: vi.fn(() =>
        Promise.resolve(
          err({
            kind: 'access_blocked' as const,
            message: 'Jira returned 403. VPN or Jira access may be required',
            retryable: true as const,
            httpStatus: 403 as const,
          }),
        ),
      ),
      fetchAttachment: vi.fn(),
    };
    const restartedService = createJiraIssueService(
      restartedLedger.repository,
      clock,
      blockedPort,
      {
        repositoryCatalog: makeRepositoryCatalog(),
      },
    );

    const blockedSync = await restartedService.sync('AVIA-13235');
    const tasks = restartedService.listOperatorTasks();

    expect(blockedSync.ok).toBe(true);
    if (!blockedSync.ok) throw new Error('Expected the cached Jira sync to remain readable');
    expect(blockedSync.value.status).toBe('stale');
    if (blockedSync.value.status !== 'stale') throw new Error('Expected a stale Jira snapshot');
    expect(blockedSync.value.issue.summary).toBe(
      'Seat map uses the wrong color for the leg-space arrow',
    );
    expect(blockedSync.value.issue.attachments[0]?.filename).toBe('seatmap-legspace-arrow.mp4');
    expect(blockedSync.value.problem).toMatchObject({ kind: 'access_blocked', httpStatus: 403 });
    expect(tasks).toMatchObject({
      ok: true,
      value: [
        {
          id: 'jira:AVIA-13235',
          status: 'needs_attention',
          currentStage: 'Jira sync blocked · showing cached snapshot',
          origin: {
            repositoryBinding: {
              status: 'resolved',
              repository: { repositoryId: 'front-avia' },
            },
          },
          planning: { status: 'blocked' },
        },
      ],
    });
    expect(
      restartedLedger.repository
        .listEvents('intake:jira:AVIA-13235')
        .map((event) => event.eventType),
    ).toEqual(['JiraIntakeRequested', 'JiraRepositoryBound']);
  });

  it('does not reuse a persisted checkout that is outside the current managed store', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasker-jira-managed-store-'));
    const clock = makeAdjustableClock('2026-08-01T19:15:00.000Z');
    const ledger = openSqliteLedger({ filename: join(directory, 'ledger.sqlite'), clock });
    resources.push({ directory, ledger });
    const port: JiraIssuePort = {
      fetchIssue: vi.fn(() =>
        Promise.resolve(ok(makeJiraSnapshot({ description: 'repo:front-avia' }))),
      ),
      fetchAttachment: vi.fn(),
    };
    const importingService = createJiraIssueService(ledger.repository, clock, port, {
      repositoryCatalog: makeRepositoryCatalog(),
    });
    await importingService.sync('AVIA-13235');
    const restartedService = createJiraIssueService(ledger.repository, clock, port, {
      repositoryCatalog: new StaticRepositoryCatalog([]),
    });

    const tasks = restartedService.listOperatorTasks();

    expect(tasks).toMatchObject({
      ok: true,
      value: [
        {
          status: 'needs_attention',
          origin: {
            repositoryBinding: {
              status: 'unavailable',
              problem: { kind: 'unavailable', retryable: true },
            },
          },
        },
      ],
    });
  });
});
