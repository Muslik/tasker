import { describe, expect, it } from 'vitest';

const modulePath = new URL(
  '../../../harness/workspace/lib/research-task-idempotency.mjs',
  import.meta.url,
).href;

describe('research task filing idempotency', () => {
  it('skips a proposed task when Jira already has the exact summary', async () => {
    const { selectUnfiledProposedTasks } = (await import(modulePath)) as {
      readonly selectUnfiledProposedTasks: (
        proposedTasks: readonly { readonly localId: string; readonly title: string }[],
        existingIssues: readonly { readonly key: string; readonly summary: string }[],
      ) => {
        readonly existing: readonly {
          readonly issueKey: string;
          readonly localId: string;
          readonly title: string;
        }[];
        readonly missing: readonly { readonly title: string }[];
      };
    };
    const proposed = [
      { localId: 'add-filter', title: 'Добавить новый фильтр' },
      { localId: 'update-api', title: 'Обновить контракт API' },
    ];

    const result = selectUnfiledProposedTasks(proposed, [
      { key: 'AVIA-42', summary: 'Добавить новый фильтр' },
    ]);

    expect(result).toEqual({
      existing: [{ issueKey: 'AVIA-42', localId: 'add-filter', title: 'Добавить новый фильтр' }],
      missing: [{ localId: 'update-api', title: 'Обновить контракт API' }],
    });
  });

  it('rejects duplicate proposed summaries before any Jira search or create', async () => {
    const { selectUnfiledProposedTasks } = (await import(modulePath)) as {
      readonly selectUnfiledProposedTasks: (
        proposedTasks: readonly { readonly localId: string; readonly title: string }[],
        existingIssues: readonly { readonly key: string; readonly summary: string }[],
      ) => unknown;
    };

    expect(() =>
      selectUnfiledProposedTasks(
        [
          { localId: 'first-task', title: 'Одинаковая задача' },
          { localId: 'second-task', title: 'Одинаковая задача' },
        ],
        [],
      ),
    ).toThrow('Proposed task titles must be unique');
  });
});
