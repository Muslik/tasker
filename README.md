# Tasker

Personal, local-first task-adaptive agent harness. The canonical design and delivery
status are under [`docs/codex`](docs/codex/README.md).

M0 and M1 are implemented. A local fixture task now becomes an untrusted proposal,
then a deterministic validated graph with a stable hash, persisted projections, a
Fastify API, a CLI tree, and a read-only React cockpit. It intentionally cannot invoke
providers, queue workflow nodes, or mutate remote systems yet.

```bash
fnm exec --using=24.16.0 /usr/local/bin/pnpm verify
fnm exec --using=24.16.0 /usr/local/bin/pnpm demo:m0
fnm exec --using=24.16.0 /usr/local/bin/pnpm test:e2e
fnm exec --using=24.16.0 /usr/local/bin/pnpm demo:m1
```

After `demo:m1`, open `http://127.0.0.1:4311`. The default ledger is
`.tasker/m1.sqlite`; set `TASKER_DB_PATH` to run an isolated demo database.
