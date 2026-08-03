---
name: jira
description: Jira issue reader via REST API. Use when user asks to read a Jira task/issue, status, summary, assignee, priority, links, comments, changelog, or provides a Jira issue key or URL.
user-invocable: true
argument-hint: ISSUE-KEY
---

# Jira Issue Reader

## Overview
Fetch Jira issue data directly from the Jira REST API using a local script.

## Setup
Environment variables required:
- `JIRA_BASE_URL` (e.g., `https://your-domain.atlassian.net`)
- `JIRA_TOKEN` (API token or PAT)

## Workflow

1. Identify the issue key.
   - Extract KEY-123 from user text or `$ARGUMENTS`.
   - If the user provides a Jira URL, extract the key from the `/browse/KEY-123` segment.
   - If no key is provided, ask for it.

2. Read the issue.
   - Run `python3 "${TASKER_SKILLS_ROOT}/jira/scripts/jira_get_issue.py" ISSUE-123` to fetch the issue JSON.
   - Use `--fields` to limit payload (faster for summaries).
   - Use `--expand changelog` when the user asks for history.

3. Handle common follow-ups.
   - Comments: run with `--comments --max-results 10`.
   - Changelog: run with `--expand changelog`.

## Examples

Basic issue fetch:

```bash
python3 "${TASKER_SKILLS_ROOT}/jira/scripts/jira_get_issue.py" PROJ-123
```

Summary-only fields:

```bash
python3 "${TASKER_SKILLS_ROOT}/jira/scripts/jira_get_issue.py" PROJ-123 --fields summary,status,assignee,priority
```

Changelog:

```bash
python3 "${TASKER_SKILLS_ROOT}/jira/scripts/jira_get_issue.py" PROJ-123 --expand changelog
```

Latest comments:

```bash
python3 "${TASKER_SKILLS_ROOT}/jira/scripts/jira_get_issue.py" PROJ-123 --comments --max-results 10
```

## Output
After fetching, summarize the issue in a clear format:
- **Key**: issue key
- **Summary**: title
- **Status**: current status
- **Assignee**: who is responsible
- **Priority**: priority level
- **Description**: brief description (truncated if too long)
- **Links**: related issues if any
