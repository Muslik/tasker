import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { loadEnv, require_ } from './harness-env.mjs';

export const selectUnfiledProposedTasks = (proposedTasks, existingIssues) => {
  const titles = proposedTasks.map(({ title }) => title);
  if (new Set(titles).size !== titles.length) {
    throw new Error('Proposed task titles must be unique');
  }
  const issueBySummary = new Map(existingIssues.map((issue) => [issue.summary, issue]));
  return {
    existing: proposedTasks.flatMap((task) => {
      const issue = issueBySummary.get(task.title);
      return issue === undefined ? [] : [{ localId: task.localId, title: task.title, issueKey: issue.key }];
    }),
    missing: proposedTasks.filter((task) => !issueBySummary.has(task.title)),
  };
};

const escapeJqlString = (value) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

const searchExactSummary = async (baseUrl, token, project, summary) => {
  const jql = `project = "${escapeJqlString(project)}" AND summary ~ "\\"${escapeJqlString(summary)}\\""`;
  const query = new URLSearchParams({ jql, fields: 'summary', maxResults: '50' });
  const response = await fetch(`${baseUrl}/rest/api/2/search?${query.toString()}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Jira summary search failed with HTTP ${String(response.status)}`);
  const payload = await response.json();
  if (!Array.isArray(payload.issues)) throw new Error('Jira summary search returned no issues array');
  return payload.issues.flatMap((issue) =>
    issue !== null &&
    typeof issue === 'object' &&
    typeof issue.key === 'string' &&
    issue.fields !== null &&
    typeof issue.fields === 'object' &&
    issue.fields.summary === summary
      ? [{ key: issue.key, summary }]
      : [],
  );
};

const main = async () => {
  const [project, tasksPath] = process.argv.slice(2);
  if (project === undefined || tasksPath === undefined) {
    throw new Error('usage: node research-task-idempotency.mjs <PROJECT> <proposed-tasks.json>');
  }
  loadEnv();
  const [baseUrl, token] = require_('JIRA_BASE_URL', 'JIRA_TOKEN');
  const proposedTasks = JSON.parse(await readFile(tasksPath, 'utf8'));
  if (!Array.isArray(proposedTasks)) throw new Error('Proposed tasks file must contain a JSON array');
  const existingIssues = (
    await Promise.all(
      proposedTasks.map((task) => {
        if (task === null || typeof task !== 'object' || typeof task.title !== 'string') {
          throw new Error('Every proposed task must have a title');
        }
        return searchExactSummary(baseUrl.replace(/\/$/u, ''), token, project, task.title);
      }),
    )
  ).flat();
  process.stdout.write(`${JSON.stringify(selectUnfiledProposedTasks(proposedTasks, existingIssues))}\n`);
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
