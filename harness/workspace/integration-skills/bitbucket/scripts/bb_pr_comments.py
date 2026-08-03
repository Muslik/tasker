#!/usr/bin/env python3
"""
Dump pull request comment threads (from /activities), with file + line anchors.

Usage:
  bb_pr_comments.py <PR-URL|number> [--project KEY --repo SLUG]
                    [--json] [--unanswered ME] [--include-bots]

  --unanswered ME   keep only threads whose last reply is NOT from ME
                    (substring match on the author's display name)
  --include-bots    keep automated review-bot summaries (dropped by default)
"""

from __future__ import annotations

import argparse
import datetime as dt
import json

from bb_common import die, paged, parse_pr_ref, pr_api

BOT_MARKERS = ("_bot", "bot_", "jenkins", "code_review_bot")


def _is_bot(name: str) -> bool:
    low = name.lower()
    return any(marker in low for marker in BOT_MARKERS)


def _stamp(millis: int | None) -> str:
    if not millis:
        return "?"
    return dt.datetime.fromtimestamp(millis / 1000).strftime("%Y-%m-%d %H:%M")


def _flatten(comment: dict, depth: int = 0) -> list[dict]:
    rows = [
        {
            "id": comment.get("id"),
            "depth": depth,
            "author": comment.get("author", {}).get("displayName", "?"),
            "created": _stamp(comment.get("createdDate")),
            "state": comment.get("state"),
            "resolved": comment.get("resolvedDate") is not None,
            "text": comment.get("text", ""),
        }
    ]
    for child in comment.get("comments", []):
        rows.extend(_flatten(child, depth + 1))
    return rows


def collect(project: str, repo: str, pr: str) -> list[dict]:
    threads = []
    for activity in paged(pr_api(project, repo, pr, "/activities"), limit=200):
        if activity.get("action") != "COMMENTED":
            continue
        anchor = activity.get("commentAnchor") or {}
        rows = _flatten(activity["comment"])
        threads.append(
            {
                "root_id": rows[0]["id"],
                "path": anchor.get("path"),
                "line": anchor.get("line"),
                "line_type": anchor.get("lineType"),
                "orphaned": anchor.get("orphaned"),
                "comments": rows,
            }
        )
    return threads


def main() -> int:
    parser = argparse.ArgumentParser(description="Dump PR comment threads")
    parser.add_argument("pr", help="PR URL or number")
    parser.add_argument("--project")
    parser.add_argument("--repo")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--unanswered", metavar="ME", help="Only threads not last-answered by ME")
    parser.add_argument("--include-bots", action="store_true")
    args = parser.parse_args()

    try:
        project, repo, pr = parse_pr_ref(args.pr, args.project, args.repo)
        threads = collect(project, repo, pr)

        if not args.include_bots:
            threads = [t for t in threads if not _is_bot(t["comments"][0]["author"])]

        if args.unanswered:
            threads = [
                t for t in threads if args.unanswered.lower() not in t["comments"][-1]["author"].lower()
            ]

        if args.json:
            print(json.dumps(threads, indent=2, ensure_ascii=False))
            return 0

        print(f"тредов: {len(threads)}\n")
        for thread in threads:
            where = (
                f"{thread['path']}:{thread['line']} ({thread['line_type']})"
                if thread["path"]
                else "ОБЩИЙ КОММЕНТ"
            )
            print("=" * 88)
            print(f"тред #{thread['root_id']}  {where}")
            for row in thread["comments"]:
                pad = "  " * row["depth"]
                flags = " [resolved]" if row["resolved"] else ""
                print(f"{pad}[{row['id']}] {row['author']} {row['created']}{flags}")
                for line in row["text"].splitlines():
                    print(f"{pad}  | {line}")
        return 0
    except Exception as exc:  # noqa: BLE001
        return die(exc)


if __name__ == "__main__":
    raise SystemExit(main())
