Independently review the drafted SA package before anything is published.

Read the investigated evidence, the draft document body, the proposed Jira task list,
and the open questions. Judge only what is in the research package:

- human Russian and manager readability outside the technical section,
- no self-narration,
- sources on factual claims,
- a measured and trustworthy "Как сейчас",
- questions grouped by addressee and shaped as decisions,
- tables where the content is enumerable,
- a task list that can be filed as separate Jira work.

Return one JSON object matching `research_review_output`. Use `accepted` only when the
draft is ready to publish without hidden assumptions. Use `changes_requested` only with
`concreteEdits` that tell the drafter exactly what to fix.

Do not publish the page. Do not create Jira tasks.
