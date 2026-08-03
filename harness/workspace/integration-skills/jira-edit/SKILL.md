---
name: jira-edit
description: Jira issue writer via REST API — update fields, set summary/description, add comments, create issues. Use when the user asks to fill, update, edit, or create a Jira task/issue/epic, set its description or summary, leave a comment, or provides an issue key with content to write.
user-invocable: true
argument-hint: ISSUE-KEY
---

# Jira Issue Writer

## Overview
Write to Jira directly via the Jira REST API v2 (Server/DC) using a local script.
Companion to the read-only `jira` skill (`jira_get_issue.py`) — same auth.

## Setup
Environment variables required:
- `JIRA_BASE_URL` (e.g., `https://your-domain.atlassian.net` or on-prem host)
- `JIRA_TOKEN` (API token or PAT)

Descriptions use **Jira wiki markup** on Server/DC (`h3.` headings, `*bold*`, `* bullet`,
`# numbered`, `{{monospace}}`), not ADF.

## Workflow

1. Identify the issue key (extract `KEY-123` from text or a `/browse/KEY-123` URL).

2. **Read before overwriting.** Before replacing a description/summary, fetch the current
   issue first so you don't blindly clobber existing content:
   `python3 "${TASKER_SKILLS_ROOT}/jira/scripts/jira_get_issue.py" KEY-123 --fields summary,description`
   If it already has real content, confirm with the user before overwriting.

3. For long descriptions, write the wiki-markup text to a file and pass `--description-file`
   (avoids shell-escaping issues). Use `--dry-run` first to inspect the payload.

4. Run the writer script (see examples). Success: update → `204`, comment/create → `201`.

5. Confirm by re-reading the issue with `jira_get_issue.py`.

## Examples

Update summary + description (long text from a file):
```bash
python3 "${TASKER_SKILLS_ROOT}/jira-edit/scripts/jira_update_issue.py" AVIA-123 \
  --summary "New title" --description-file /tmp/body.txt
```

Update a simple field:
```bash
python3 "${TASKER_SKILLS_ROOT}/jira-edit/scripts/jira_update_issue.py" AVIA-123 \
  --raw-field assignee='{"name":"ivanov"}'
```

Add a comment:
```bash
python3 "${TASKER_SKILLS_ROOT}/jira-edit/scripts/jira_update_issue.py" AVIA-123 --comment "Done, see PR"
```

Create a new epic:
```bash
python3 "${TASKER_SKILLS_ROOT}/jira-edit/scripts/jira_update_issue.py" --create \
  --project AVIA --type Epic --summary "..." --description-file /tmp/body.txt
```

Inspect payload without sending:
```bash
python3 "${TASKER_SKILLS_ROOT}/jira-edit/scripts/jira_update_issue.py" AVIA-123 --summary x --dry-run
```

## Safety
- Writing modifies shared issues other people see. Always read the issue first (step 2) and
  do not overwrite a populated description without the user's go-ahead.
- Prefer `--dry-run` to review the payload for non-trivial edits.
