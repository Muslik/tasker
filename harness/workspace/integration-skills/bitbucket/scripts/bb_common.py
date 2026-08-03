#!/usr/bin/env python3
"""
Shared helpers for the Bitbucket Server (Stash) REST API.

Requires:
  BITBUCKET_TOKEN (HTTP access token / PAT)
  BITBUCKET_BASE_URL (optional, defaults to https://bitbucket.twiket.com)
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from urllib import error, parse, request

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "lib"))
from harness_env import ENV_FILE, load_env

load_env()


DEFAULT_BASE_URL = "https://bitbucket.twiket.com"

PR_URL_RE = re.compile(
    r"/projects/(?P<project>[^/]+)/repos/(?P<repo>[^/]+)/pull-requests/(?P<pr>\d+)",
    re.IGNORECASE,
)



def build_headers() -> dict[str, str]:
    token = os.environ.get("BITBUCKET_TOKEN", "").strip()
    if not token:
        raise RuntimeError(
            "Missing BITBUCKET_TOKEN environment variable "
            f"(looked in the environment and in {ENV_FILE})"
        )
    return {
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
    }


def build_base_url() -> str:
    return os.environ.get("BITBUCKET_BASE_URL", DEFAULT_BASE_URL).strip().rstrip("/")


def parse_pr_ref(value: str, project: str | None, repo: str | None) -> tuple[str, str, str]:
    """Принимает URL пул-реквеста либо его номер (тогда нужны --project/--repo)."""
    match = PR_URL_RE.search(value)
    if match:
        return match.group("project"), match.group("repo"), match.group("pr")

    if not value.isdigit():
        raise RuntimeError(f"Cannot parse PR reference from {value!r}: pass a PR URL or a number")
    if not project or not repo:
        raise RuntimeError("A bare PR number needs --project and --repo")
    return project, repo, value


def pr_api(project: str, repo: str, pr: str, suffix: str = "") -> str:
    return (
        f"{build_base_url()}/rest/api/1.0/projects/{project}"
        f"/repos/{repo}/pull-requests/{pr}{suffix}"
    )


def call(url: str, payload: dict | None = None, method: str | None = None) -> dict:
    headers = build_headers()
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = request.Request(url, data=data, headers=headers, method=method)
    try:
        with request.urlopen(req) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"HTTP {exc.code} on {url}: {detail}") from exc


def paged(url: str, limit: int = 100) -> list[dict]:
    """Собирает все страницы Bitbucket-пагинации."""
    values: list[dict] = []
    start = 0
    while True:
        query = parse.urlencode({"limit": limit, "start": start})
        page = call(f"{url}?{query}")
        values.extend(page.get("values", []))
        if page.get("isLastPage", True):
            return values
        start = page.get("nextPageStart") or start + limit


def die(exc: Exception) -> int:
    print(f"Error: {exc}", file=sys.stderr)
    return 1
