#!/usr/bin/env python3
"""
Standalone Jira issue writer (update / comment / create).

Companion to jira_get_issue.py — same auth, same REST API v2.

Requires:
  JIRA_BASE_URL (e.g., https://your-domain.atlassian.net or on-prem host)
  JIRA_TOKEN (API token or PAT)

Examples:
  # Update summary + description (long descriptions: use --description-file)
  jira_update_issue.py PROJ-123 --summary "New title" --description-file body.txt

  # Set arbitrary simple fields
  jira_update_issue.py PROJ-123 --field priority='{"name":"High"}' --raw-field priority

  # Add a comment
  jira_update_issue.py PROJ-123 --comment "Done, see PR"

  # Create a new issue
  jira_update_issue.py --create --project AVIA --type Epic --summary "..." --description-file body.txt

  # Inspect payload without sending
  jira_update_issue.py PROJ-123 --summary x --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from urllib import request, error

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "lib"))
from harness_env import load_env

load_env()



def build_headers() -> dict[str, str]:
    token = os.environ.get("JIRA_TOKEN", "").strip()
    if not token:
        raise RuntimeError("Missing JIRA_TOKEN environment variable")
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def build_base_url() -> str:
    base_url = os.environ.get("JIRA_BASE_URL", "").strip()
    if not base_url:
        raise RuntimeError("Missing JIRA_BASE_URL environment variable")
    return base_url.rstrip("/")


def send(url: str, method: str, headers: dict[str, str], body: dict) -> tuple[int, str]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = request.Request(url, data=data, method=method, headers=headers)
    with request.urlopen(req) as resp:
        payload = resp.read().decode("utf-8") if resp.length else ""
        return resp.status, payload


def read_text(value: str | None, file_path: str | None) -> str | None:
    if file_path:
        with open(file_path, "r", encoding="utf-8") as fh:
            return fh.read()
    return value


def build_fields(args) -> dict:
    fields: dict = {}
    if args.summary is not None:
        fields["summary"] = args.summary
    description = read_text(args.description, args.description_file)
    if description is not None:
        fields["description"] = description
    # Simple string fields: --field name=value
    for item in args.field or []:
        if "=" not in item:
            raise RuntimeError(f"--field expects name=value, got: {item}")
        name, value = item.split("=", 1)
        fields[name.strip()] = value
    # Raw JSON fields: --raw-field name='{"id":"123"}'
    for item in args.raw_field or []:
        if "=" not in item:
            raise RuntimeError(f"--raw-field expects name=json, got: {item}")
        name, value = item.split("=", 1)
        fields[name.strip()] = json.loads(value)
    return fields


def main() -> int:
    parser = argparse.ArgumentParser(description="Update, comment on, or create a Jira issue")
    parser.add_argument("issue_key", nargs="?", help="Issue key like PROJ-123 (omit with --create)")
    parser.add_argument("--summary", help="Set the summary/title")
    parser.add_argument("--description", help="Set the description (Jira wiki markup for Server/DC)")
    parser.add_argument("--description-file", help="Read description from a file (preferred for long text)")
    parser.add_argument("--field", action="append", help="Set a simple field: name=value (repeatable)")
    parser.add_argument("--raw-field", action="append", help="Set a JSON field: name='{...}' (repeatable)")
    parser.add_argument("--comment", help="Add a comment with this text")
    parser.add_argument("--comment-file", help="Add a comment read from a file")
    parser.add_argument("--create", action="store_true", help="Create a new issue instead of updating")
    parser.add_argument("--project", help="Project key for --create (e.g., AVIA)")
    parser.add_argument("--type", dest="issue_type", help="Issue type name for --create (e.g., Epic, Task)")
    parser.add_argument("--dry-run", action="store_true", help="Print the payload without sending")
    args = parser.parse_args()

    try:
        base_url = build_base_url()
        headers = build_headers()

        # CREATE -------------------------------------------------------------
        if args.create:
            if not (args.project and args.issue_type and args.summary):
                raise RuntimeError("--create requires --project, --type and --summary")
            fields = build_fields(args)
            fields["project"] = {"key": args.project}
            fields["issuetype"] = {"name": args.issue_type}
            body = {"fields": fields}
            url = f"{base_url}/rest/api/2/issue"
            if args.dry_run:
                print(json.dumps(body, indent=2, ensure_ascii=False))
                return 0
            status, payload = send(url, "POST", headers, body)
            print(f"Created ({status}): {payload}")
            return 0

        # COMMENT ------------------------------------------------------------
        comment = read_text(args.comment, args.comment_file)
        if comment is not None:
            if not args.issue_key:
                raise RuntimeError("issue_key is required to add a comment")
            body = {"body": comment}
            url = f"{base_url}/rest/api/2/issue/{args.issue_key}/comment"
            if args.dry_run:
                print(json.dumps(body, indent=2, ensure_ascii=False))
                return 0
            status, payload = send(url, "POST", headers, body)
            print(f"Comment added ({status})")
            return 0

        # UPDATE -------------------------------------------------------------
        if not args.issue_key:
            raise RuntimeError("issue_key is required for update")
        fields = build_fields(args)
        if not fields:
            raise RuntimeError("Nothing to update — provide --summary/--description/--field/--raw-field")
        body = {"fields": fields}
        url = f"{base_url}/rest/api/2/issue/{args.issue_key}"
        if args.dry_run:
            print(json.dumps(body, indent=2, ensure_ascii=False))
            return 0
        status, _ = send(url, "PUT", headers, body)
        print(f"Updated {args.issue_key} ({status})")
        return 0

    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        print(f"HTTP {exc.code}: {detail}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
