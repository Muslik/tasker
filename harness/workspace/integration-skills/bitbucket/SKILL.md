---
name: bitbucket
description: Bitbucket Server (bitbucket.twiket.com) reader/writer via REST API — pull request metadata, changed files, comment threads, posting comments and thread replies. Use when the user gives a Bitbucket PR link or asks to read/answer PR comments, check PR status, or list what a PR changed.
user-invocable: true
argument-hint: PR-URL or PR number
---

# Bitbucket PR Reader / Writer

## Overview
Talk to the Bitbucket Server REST API through local scripts. No browser and no Chrome
extension needed.

## Setup
The token is read from the environment, falling back to `$TASKER_HARNESS_ENV_FILE`:

- `BITBUCKET_TOKEN` — HTTP access token (Profile → Manage account → HTTP access tokens)
- `BITBUCKET_BASE_URL` — optional, defaults to `https://bitbucket.twiket.com`

A token is required even for reads: anonymous requests return `401`.

## Scripts
They live in `scripts/` next to this file. `SC="${TASKER_SKILLS_ROOT}/bitbucket/scripts"`

All three accept either a full pull request URL or a number plus `--project`/`--repo`.

### PR metadata
```bash
python3 $SC/bb_pr_get.py <PR-URL>              # title, state, branches, approvals, description
python3 $SC/bb_pr_get.py <PR-URL> --diff-stat  # plus the list of changed files
python3 $SC/bb_pr_get.py <PR-URL> --json       # raw API payload
```

### Comments
```bash
python3 $SC/bb_pr_comments.py <PR-URL>                     # threads with file:line anchors
python3 $SC/bb_pr_comments.py <PR-URL> --unanswered "Name" # only threads not last-answered by Name
python3 $SC/bb_pr_comments.py <PR-URL> --include-bots      # keep review-bot summaries
python3 $SC/bb_pr_comments.py <PR-URL> --json              # for programmatic use
```
Review-bot summaries are filtered out by default — they are noise. Every comment is
printed with its id; that id is what you pass as `parent` when replying.

### Replies and new comments
Replies come from a JSON file, `{"<parent id>": "text"}`. The key `"root"` posts a
top-level PR comment (a string, or a list of strings).

```bash
python3 $SC/bb_pr_reply.py <PR-URL> --file replies.json          # DRY RUN, sends nothing
python3 $SC/bb_pr_reply.py <PR-URL> --file replies.json --post   # send
```

**Always dry-run first**, show the texts to the user, and send only after an explicit
go-ahead. A posted comment is immediately visible to colleagues.

Write replies in the language of the thread — these PRs are reviewed in Russian.

## Notes
- Threads come from `/activities` (`action == COMMENTED`); nested replies are expanded
  recursively together with `commentAnchor` — path, line, `lineType`, `orphaned`.
- Bitbucket pagination is followed to the end; no need to pass `limit`/`start` yourself.
- Replying to a thread and posting a top-level comment hit the same endpoint; the only
  difference is whether `parent.id` is present.
