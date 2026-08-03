---
name: confluence
description: Confluence page reader via REST API. Use when user asks to read or summarize a Confluence page, provides a Confluence URL or pageId, or needs page content/metadata/history.
user-invocable: true
argument-hint: PAGE_ID or URL
---

# Confluence Page Reader

## Overview
Fetch Confluence page content and metadata by page id using a local script.

## Setup
Environment variables required:
- `CONFLUENCE_BASE_URL` (e.g., `https://your-domain.atlassian.net/wiki`)
- `CONFLUENCE_TOKEN` (API token or PAT)

## Workflow

1. Identify the page id.
   - Extract from `pageId=123456` in the URL.
   - Extract from `/pages/123456/` or `/spaces/SPACE/pages/123456/Title`.
   - If `$ARGUMENTS` contains a URL, parse it to get the page id.
   - If no id is provided, ask for the page link or id.

2. Read the page.
   - Run `python3 "${TASKER_SKILLS_ROOT}/confluence/scripts/confluence_get_page.py" 123456` to fetch JSON.
   - Use `--body` to print only the page body.
   - Use `--expand` to add extra fields as needed.

3. Handle common follow-ups.
   - Body only: `--body --body-format storage|view|export_view`.
   - History/ancestors/space: include via `--expand` (already included by default).

## Examples

Basic page fetch:

```bash
python3 "${TASKER_SKILLS_ROOT}/confluence/scripts/confluence_get_page.py" 123456
```

Body only (storage format):

```bash
python3 "${TASKER_SKILLS_ROOT}/confluence/scripts/confluence_get_page.py" 123456 --body
```

Rendered body (HTML):

```bash
python3 "${TASKER_SKILLS_ROOT}/confluence/scripts/confluence_get_page.py" 123456 --body --body-format view
```

Custom expand fields:

```bash
python3 "${TASKER_SKILLS_ROOT}/confluence/scripts/confluence_get_page.py" 123456 --expand body.storage,version,space,history
```

## Output
After fetching, summarize the page in a clear format:
- **Title**: page title
- **Space**: space name/key
- **Version**: version number and last modified date
- **Content**: main content (converted from HTML to readable text)
- **Ancestors**: parent pages path
