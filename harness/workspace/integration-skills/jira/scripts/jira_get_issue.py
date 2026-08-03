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

import sys
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
    args = parser.parse_args()

    try:
        base_url = build_base_url()
        headers = build_headers()

        if args.comments:
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
