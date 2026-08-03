---
name: loop
description: "Fetch thread from Loop (Mattermost) by URL or post_id. Use when user shares a Loop link or asks about a Loop discussion."
user-invocable: true
argument-hint: URL or post_id
---

# Loop Thread Fetcher

## Goal
Get full context from Loop (Mattermost) thread for analysis, task preparation, or documentation.

## Usage

```bash
"${TASKER_SKILLS_ROOT}/loop/scripts/fetch-thread.mjs" <url|post_id>
```

## Options
- No flags: markdown to stdout (best for AI context, saves tokens)
- `--html`: HTML file to `"${TASKER_SKILLS_ROOT}/loop/scripts/out/"`
- `--images`: download images locally (with --html)

## Workflow
1. User provides Loop URL or post_id (from `$ARGUMENTS`)
2. Run script, capture markdown output
3. Analyze thread content
4. If images needed: run with `--html --images`, then read from
   `"${TASKER_SKILLS_ROOT}/loop/scripts/out/<post_id>/"`.

## Examples

```bash
# Markdown (default)
"${TASKER_SKILLS_ROOT}/loop/scripts/fetch-thread.mjs" https://onetwotrip.loop.ru/onetwotrip/pl/abc123

# Post ID only
"${TASKER_SKILLS_ROOT}/loop/scripts/fetch-thread.mjs" abc123

# With images
"${TASKER_SKILLS_ROOT}/loop/scripts/fetch-thread.mjs" abc123 --html --images
```

## Setup
Token in `$TASKER_HARNESS_ENV_FILE`:
```
LOOP_TOKEN=your-token-here
```

Get token: Loop -> Profile -> Security -> Personal Access Tokens

## Output
After fetching, summarize the thread:
- **Topic**: what the discussion is about
- **Participants**: who is involved
- **Key points**: main decisions/questions
- **Action items**: if any mentioned
