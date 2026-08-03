#!/usr/bin/env python3
"""
Standalone Confluence page fetcher.

Requires:
  CONFLUENCE_BASE_URL (e.g., https://your-domain.atlassian.net/wiki)
  CONFLUENCE_TOKEN (API token or PAT)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from urllib import parse, request

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "lib"))
from harness_env import load_env

load_env()



def build_headers() -> dict[str, str]:
    token = os.environ.get("CONFLUENCE_TOKEN", "").strip()
    if not token:
        raise RuntimeError("Missing CONFLUENCE_TOKEN environment variable")

    headers = {"Accept": "application/json"}
    headers["Authorization"] = f"Bearer {token}"

    return headers


def build_base_url() -> str:
    base_url = os.environ.get("CONFLUENCE_BASE_URL", "").strip()
    if not base_url:
        raise RuntimeError("Missing CONFLUENCE_BASE_URL environment variable")
    return base_url.rstrip("/")


def fetch_json(url: str, headers: dict[str, str]) -> dict:
    req = request.Request(url, headers=headers)
    with request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def normalize_expand(expand: str | None, body_format: str | None) -> str | None:
    if not expand and not body_format:
        return "body.storage,version,space,history,ancestors"

    if body_format:
        body_token = f"body.{body_format}"
        if expand:
            parts = [part.strip() for part in expand.split(",") if part.strip()]
            if body_token not in parts:
                parts.append(body_token)
            return ",".join(parts)
        return body_token

    return expand


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch Confluence page details")
    parser.add_argument("page_id", help="Page id like 123456")
    parser.add_argument(
        "--expand",
        help="Comma-separated list for expand parameter",
    )
    parser.add_argument(
        "--body",
        action="store_true",
        help="Print only the page body",
    )
    parser.add_argument(
        "--body-format",
        choices=("storage", "view", "export_view"),
        default="storage",
        help="Body format when using --body (default: storage)",
    )
    args = parser.parse_args()

    try:
        base_url = build_base_url()
        headers = build_headers()
        expand = normalize_expand(args.expand, args.body_format if args.body else None)

        params = {}
        if expand:
            params["expand"] = expand

        query = parse.urlencode(params)
        suffix = f"?{query}" if query else ""
        url = f"{base_url}/rest/api/content/{args.page_id}{suffix}"

        data = fetch_json(url, headers)

        if args.body:
            body = data.get("body", {})
            body_format = body.get(args.body_format, {})
            value = body_format.get("value", "")
            print(value)
        else:
            print(json.dumps(data, indent=2, ensure_ascii=True))
        return 0
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
