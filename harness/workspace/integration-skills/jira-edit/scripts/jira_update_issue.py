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

  # Link issues (repeatable; PROJ-123 blocks PROJ-124)
  jira_update_issue.py PROJ-123 --link "blocks:PROJ-124"
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


def send(url: str, method: str, headers: dict[str, str], body: dict | None = None) -> tuple[int, str]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = request.Request(url, data=data, method=method, headers=headers)
    with request.urlopen(req) as resp:
        payload = resp.read().decode("utf-8")
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


LINK_TYPES = {"blocks": "Blocks", "relates": "Relates"}


def parse_link(value: str) -> tuple[str, str]:
    if ":" not in value:
        raise RuntimeError(f"--link expects TYPE:KEY, got: {value}")
    link_type, target = value.split(":", 1)
    normalized_type = link_type.strip().lower()
    target = target.strip()
    if normalized_type not in LINK_TYPES or not target:
        raise RuntimeError("--link supports blocks:KEY and relates:KEY")
    return LINK_TYPES[normalized_type], target


def build_link_payload(issue_key: str, link: str) -> dict:
    link_type, target = parse_link(link)
    return {
        "type": {"name": link_type},
        "outwardIssue": {"key": issue_key},
        "inwardIssue": {"key": target},
    }


def has_identical_link(payload: dict, issue: dict) -> bool:
    for link in issue.get("fields", {}).get("issuelinks", []):
        if link.get("type", {}).get("name") != payload["type"]["name"]:
            continue
        outward = link.get("outwardIssue", {}).get("key")
        inward = link.get("inwardIssue", {}).get("key")
        if outward == payload["outwardIssue"]["key"] and inward == payload["inwardIssue"]["key"]:
            return True
        if payload["type"]["name"] == "Relates" and outward == payload["inwardIssue"]["key"] and inward == payload["outwardIssue"]["key"]:
            return True
    return False


def fetch_issue_links(base_url: str, headers: dict[str, str], issue_key: str) -> dict:
    url = f"{base_url}/rest/api/2/issue/{issue_key}?fields=issuelinks"
    _, payload = send(url, "GET", headers)
    return json.loads(payload)


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
    parser.add_argument("--link", action="append", help="Create a link: blocks:KEY or relates:KEY (repeatable)")
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

        # LINKS --------------------------------------------------------------
        if args.link:
            if not args.issue_key:
                raise RuntimeError("issue_key is required to add a link")
            payloads = [build_link_payload(args.issue_key, link) for link in args.link]
            if args.dry_run:
                print(json.dumps(payloads, indent=2, ensure_ascii=False))
                return 0
            issue = fetch_issue_links(base_url, headers, args.issue_key)
            url = f"{base_url}/rest/api/2/issueLink"
            for payload in payloads:
                if has_identical_link(payload, issue):
                    print(f"Skipped existing link for {args.issue_key} ({payload['type']['name']})")
                    continue
                status, _ = send(url, "POST", headers, payload)
                print(f"Linked {args.issue_key} ({status})")
                issue.setdefault("fields", {}).setdefault("issuelinks", []).append(payload)
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
