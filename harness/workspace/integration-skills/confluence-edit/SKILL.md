---
name: confluence-edit
description: Confluence page writer via REST API — create pages, update bodies, upload attachments (screenshots, video, diagrams). Use when the user asks to create, fill, update or publish a Confluence page, add a section to an existing one, or attach images to a page. Companion to the read-only `confluence` skill.
user-invocable: true
argument-hint: PAGE_ID or URL
---

# Confluence Page Writer

## Overview
Write to Confluence (Server/DC REST API) with a local script. Same auth as the read-only
`confluence` skill.

Bodies are **storage format** — XHTML plus `<ac:…>` macros — not wiki markup and not
Markdown. See `references/storage-format.md` for the macros that actually render on this
instance, copy-pasteable.

## Setup
Environment variables required (already in `$TASKER_HARNESS_ENV_FILE`):
- `CONFLUENCE_BASE_URL` (e.g. `https://confluence.example.com`)
- `CONFLUENCE_TOKEN` (API token or PAT)

`SCRIPT="${TASKER_SKILLS_ROOT}/confluence-edit/scripts/confluence_write_page.py"`

## Workflow

1. **Read before you write.** A page belongs to whoever wrote it, and an update replaces the
   *whole* body — there is no partial patch. Always fetch the current storage body first:
   ```bash
   python3 "${TASKER_SKILLS_ROOT}/confluence/scripts/confluence_get_page.py" 123456 --body > /tmp/page.xml
   ```
   Edit that file and send it back whole. Never assemble an update body from memory of what
   the page looked like — you will silently delete sections you never saw.

2. **Body goes in a file**, always (`--body-file`). Storage format is full of quotes and
   angle brackets; passing it inline through the shell mangles it.

3. **`--dry-run` first** for anything non-trivial. It prints the exact payload and, for
   `--update`, the current version and title.

4. **Send it.** Then re-read the page (`confluence_get_page.py … --body`) and check the
   macros survived — a malformed `<ac:structured-macro>` does not fail the request, it just
   renders as an error placeholder on the page.

5. **Attachments before references.** Upload images/video first, then reference them by
   filename in the body (`<ri:attachment ri:filename="…"/>`). An `<ac:image>` pointing at a
   file that isn't attached renders as a broken image.

## Examples

Create a child page:
```bash
python3 $SCRIPT --create --space AVIA --parent 39748148 \
  --title "Выбор мест в webview на готовом заказе" --body-file /tmp/body.xml
```

Update a page (title kept unless `--title` is passed):
```bash
python3 $SCRIPT --update 148421330 --body-file /tmp/body.xml --message "добавил раздел Frontend"
```

Rename only:
```bash
python3 $SCRIPT --update 148421330 --title "Новый заголовок"
```

Attach screenshots and video (re-uploading the same filename adds a new version):
```bash
python3 $SCRIPT --attach 148421330 /tmp/before.png /tmp/after.png /tmp/demo.mp4
```

Inspect without sending:
```bash
python3 $SCRIPT --update 148421330 --body-file /tmp/body.xml --dry-run
```

## Safety
- Pages are shared documents other people read and get mail about. Show the user what you
  are about to publish and get an explicit go-ahead before the first `--create` / `--update`
  of a session.
- Use `--minor` for cosmetic follow-up edits so watchers aren't notified again.
- Editing someone else's page: add your own section, keep their terminology, do not
  restructure or reword what they wrote.
- No delete support here on purpose. Removing a page or an attachment is a manual action.
