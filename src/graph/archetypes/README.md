# Workflow archetypes

Archetypes turn validated planner slots into semantic workflow sources.
`deliver-pr` derives its required stages and loop predicates from the snapshotted
quality-boundaries policy and owns all topology. `research` owns a fixed
investigate -> (draft -> review -> document review) loop followed by publish and
task filing.

Its fixed node IDs are `task-work`, `delivery-feedback`, `delivery-attempt`,
`review-feedback`, `review-attempt`, `development`, `development-attempt`,
`implement-change`, `run-validation`, `verify-change`, `review-change`,
`prepare-delivery`, and `deliver-change`. Optional IDs are
`await-dependency-N`, `consume-dependency-N`, `extract-translations`, and
`pull-translations`.

`research` uses `task-work`, `review-feedback`, `review-attempt`,
`investigate-research`, `draft-research`, `review-research`,
`document-review-research`, `publish-research`, and `file-research-tasks`.
