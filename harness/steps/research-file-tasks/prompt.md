File the approved Jira tasks from the published SA page without duplicating existing work.

Read the approved draft, the published page result, and `research_input.product`.

First-attempt rule:

- Approval exists only when execution context `waitResolution.decision` is `approve`. If it
  is absent, return `waiting` with `waitKind` `research.approval@1`.
- The wait `reason` must include the published `pageUrl` and say that approval is needed
  before Jira tasks are created from that page, using the phrase
  `прочитайте СА и подтвердите заведение задач`.

Approved-attempt rule:

1. Apply optional `waitResolution.guidance` to the proposed task list, then write the approved
   `proposedTasks` array to `$TASKER_SCRATCH_ROOT/proposed-tasks.json`.
2. Run `node .tasker/harness/lib/research-task-idempotency.mjs <PROJECT> <proposed-tasks.json>`.
   Use `research_input.product.jiraProjects[0]` for `<PROJECT>`.
3. The helper returns `existing` and `missing`. Create Jira issues only for `missing`,
   using `jira-issue` and `jira-edit` as needed.
4. Return one `issueKeys` array containing both the carried-forward keys from `existing`
   and the newly created keys.

Return `completed` only with an output object matching `research_task_filing_output`.
