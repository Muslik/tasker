#!/usr/bin/env python3
"""
Fetch Bitbucket pull request metadata (title, state, branches, description, reviewers).

Usage:
  bb_pr_get.py <PR-URL|number> [--project KEY --repo SLUG] [--json] [--diff-stat]
"""

from __future__ import annotations

import argparse
import json

from bb_common import call, die, paged, parse_pr_ref, pr_api


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch a Bitbucket pull request")
    parser.add_argument("pr", help="PR URL or number")
    parser.add_argument("--project", help="Project key (needed when passing a bare number)")
    parser.add_argument("--repo", help="Repository slug (needed when passing a bare number)")
    parser.add_argument("--json", action="store_true", help="Print the raw API payload")
    parser.add_argument("--diff-stat", action="store_true", help="Also list changed files")
    args = parser.parse_args()

    try:
        project, repo, pr = parse_pr_ref(args.pr, args.project, args.repo)
        data = call(pr_api(project, repo, pr))

        if args.json:
            print(json.dumps(data, indent=2, ensure_ascii=False))
            return 0

        print(f"#{data.get('id')} {data.get('title')}")
        print(f"state:   {data.get('state')}  author: {data.get('author', {}).get('user', {}).get('displayName')}")
        print(
            f"branch:  {data.get('fromRef', {}).get('displayId')}"
            f" -> {data.get('toRef', {}).get('displayId')}"
        )
        approvals = [
            r.get("user", {}).get("displayName")
            for r in data.get("reviewers", [])
            if r.get("approved")
        ]
        print(f"approved by: {', '.join(approvals) if approvals else '—'}")
        description = (data.get("description") or "").strip()
        if description:
            print("\n--- description ---")
            print(description)

        if args.diff_stat:
            print("\n--- changed files ---")
            for change in paged(pr_api(project, repo, pr, "/changes")):
                path = change.get("path", {}).get("toString")
                print(f"{change.get('type', '?'):<8} {path}")

        return 0
    except Exception as exc:  # noqa: BLE001
        return die(exc)


if __name__ == "__main__":
    raise SystemExit(main())
