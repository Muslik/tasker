File the approved Jira tasks from the published SA page without duplicating existing work.

Read the approved draft, the published page result, and `research_input.product`.

1. Write the approved `proposedTasks` array to `$TASKER_SCRATCH_ROOT/proposed-tasks.json`.
2. Run `node .tasker/harness/lib/research-task-idempotency.mjs <PROJECT> <proposed-tasks.json>`.
   Use `research_input.product.jiraProjects[0]` for `<PROJECT>`.
3. The helper returns `existing` and `missing`. Create Jira issues only for `missing`,
   using `jira-issue` and `jira-edit` as needed.
4. Return one `issueKeys` array containing both the carried-forward keys from `existing`
   and the newly created keys.

The earlier `research.document-review@1` approval already authorizes this filing step.
Do not ask for another approval.

After the Jira issues are created, update the published page's Release panel with
`confluence-edit`. Read the whole current storage-format body first using the published
page URL, then replace the Release placeholder (or the existing Release Jira macro) with
one Jira macro using serverId `1a1267ac-5a85-3eb5-ba08-d62a99477f6d` and
`jqlQuery` `project = <PROJECT> and issueKey in (<keys>)`. Use the exact macro shape from
`confluence-edit/references/storage-format.md`; never hand-guess Confluence XML. This update
is idempotent: on a retry, replace the existing Release macro or leave the identical single
macro in place, never append a second one. Re-read the page after the update and return its
current positive integer `version.number` as `pageVersion` alongside `issueKeys`.

Return `completed` only with an output object matching `research_task_filing_output`.
