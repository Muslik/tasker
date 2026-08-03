# Tasker

Personal, local-first task-adaptive agent harness. The canonical design and delivery
status are under [`docs/codex`](docs/codex/README.md).

Prompts, company policy, and project workflow guidance are editable under
[`harness`](harness); typed step contracts and executor bindings live in
[`src/harness/step-definitions.ts`](src/harness/step-definitions.ts). There are no
base workflow templates: each graph is assembled for one task from the registered
catalog and then rejected or accepted by deterministic validation. See the
[`customization guide`](docs/codex/customization-guide.md) before adding a step or
using a separate company pack.

M0, M1, and the first M2 execution slices are implemented. A local fixture task now becomes an untrusted proposal,
then a deterministic validated graph with a stable hash, persisted projections, a
Fastify API, a CLI tree, and a React operator cockpit. An accepted graph can execute
deterministic local stub nodes through a bounded queue, survive scheduler restart, and
stop at durable plan-review and code-review waits. At plan review, the operator can
approve or request changes; guidance is persisted as a new immutable provider planning
attempt. Planning uses subscription Codex CLI with operator-selectable `auto`, `fast`,
or `ralplan` strategy. Later workflow nodes remain deterministic stubs, and Tasker
cannot mutate repositories or remote systems yet.

The cockpit is an operator console: task/status queue on the left, persisted realtime
activity and workflow rationale in the center, and the selected workflow tree on the
right. Project profiles contribute repository-specific workflow facts such as
translation handling, verification shape, and manual gates; reusable rules such as
frontend `@ott` package publication live in global workflow policy.

```bash
fnm exec --using=24.16.0 /usr/local/bin/pnpm verify
fnm exec --using=24.16.0 /usr/local/bin/pnpm demo:m0
fnm exec --using=24.16.0 /usr/local/bin/pnpm test:e2e
fnm exec --using=24.16.0 /usr/local/bin/pnpm demo:m1
```

After `demo:m1`, open `http://127.0.0.1:4311`. The default ledger is
`.tasker/m1-operator.sqlite`; set `TASKER_DB_PATH` to run an isolated demo database.
Stub execution admits two runs by default; set `TASKER_STUB_CAPACITY=1` (or another
positive integer) to test a different scheduler capacity.
