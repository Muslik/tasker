#!/usr/bin/env python3
"""
Standalone Jira issue fetcher.

Requires:
  JIRA_BASE_URL (e.g., https://your-domain.atlassian.net)
  JIRA_TOKEN (API token or PAT)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from urllib import request, parse

from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "lib"))
from harness_env import load_env

load_env()



def build_headers() -> dict[str, str]:
    token = os.environ.get("JIRA_TOKEN", "").strip()

    if not token:
        raise RuntimeError("Missing JIRA_TOKEN environment variable")

    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


def build_base_url() -> str:
    base_url = os.environ.get("JIRA_BASE_URL", "").strip()
    if not base_url:
        raise RuntimeError("Missing JIRA_BASE_URL environment variable")
    return base_url.rstrip("/")


def fetch_json(url: str, headers: dict[str, str]) -> dict:
    req = request.Request(url, headers=headers)
    with request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def download_attachment(
    base_url: str,
    headers: dict[str, str],
    issue_key: str,
    attachment_id: str,
    output: Path,
) -> dict[str, object]:
    issue = fetch_json(
        f"{base_url}/rest/api/2/issue/{issue_key}?fields=attachment",
        headers,
    )
    attachments = issue.get("fields", {}).get("attachment", [])
    attachment = next(
        (item for item in attachments if str(item.get("id")) == attachment_id),
        None,
    )
    if attachment is None:
        raise RuntimeError(
            f"Attachment {attachment_id} does not belong to {issue_key}"
        )
    req = request.Request(str(attachment["content"]), headers=headers)
    with request.urlopen(req) as response:
        content = response.read()
        content_type = response.headers.get_content_type()
    expected_size = int(attachment.get("size", len(content)))
    if len(content) != expected_size:
        raise RuntimeError(
            f"Attachment size mismatch: expected {expected_size}, received {len(content)}"
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(content)
    return {
        "attachmentId": attachment_id,
        "filename": attachment.get("filename"),
        "contentType": content_type,
        "byteLength": len(content),
        "output": str(output),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch Jira issue details")
    parser.add_argument("issue_key", help="Issue key like PROJ-123")
    parser.add_argument(
        "--fields",
        help="Comma-separated list of fields to request",
    )
    parser.add_argument(
        "--expand",
        help="Comma-separated list for expand parameter (e.g., changelog)",
    )
    parser.add_argument(
        "--comments",
        action="store_true",
        help="Fetch comments instead of issue details",
    )
    parser.add_argument(
        "--max-results",
        type=int,
        default=50,
        help="Max comments to return when using --comments",
    )
    parser.add_argument(
        "--download-attachment",
        metavar="ID",
        help="Download an attachment that belongs to the issue",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Destination for --download-attachment",
    )
    args = parser.parse_args()

    try:
        base_url = build_base_url()
        headers = build_headers()

        if args.download_attachment:
            if args.output is None:
                raise RuntimeError("--output is required with --download-attachment")
            data = download_attachment(
                base_url,
                headers,
                args.issue_key,
                args.download_attachment,
                args.output,
            )
            print(json.dumps(data, indent=2, ensure_ascii=True))
            return 0
        elif args.comments:
            query = parse.urlencode({"maxResults": args.max_results})
            url = (
                f"{base_url}/rest/api/2/issue/{args.issue_key}/comment?{query}"
            )
        else:
            params = {}
            if args.fields:
                params["fields"] = args.fields
            if args.expand:
                params["expand"] = args.expand
            query = parse.urlencode(params)
            suffix = f"?{query}" if query else ""
            url = f"{base_url}/rest/api/2/issue/{args.issue_key}{suffix}"

        data = fetch_json(url, headers)
        print(json.dumps(data, indent=2, ensure_ascii=True))
        return 0
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
