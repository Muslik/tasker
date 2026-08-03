#!/usr/bin/env python3
"""
Post comments / thread replies to a pull request.

Replies come from a JSON file mapping parent comment id -> reply text:

    { "85464": "Поправил, ...", "85475": "Померил, ..." }

A top-level comment uses the key "root" (a list of strings, or one string).

Usage:
  bb_pr_reply.py <PR-URL|number> --file replies.json            # dry run: prints the plan
  bb_pr_reply.py <PR-URL|number> --file replies.json --post     # actually posts

ALWAYS dry-run first and show the texts to the user before --post.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from bb_common import call, die, parse_pr_ref, pr_api


def main() -> int:
    parser = argparse.ArgumentParser(description="Reply to PR comments")
    parser.add_argument("pr", help="PR URL or number")
    parser.add_argument("--project")
    parser.add_argument("--repo")
    parser.add_argument("--file", required=True, help="JSON file: {parent_id: text}")
    parser.add_argument("--post", action="store_true", help="Send (otherwise dry run)")
    args = parser.parse_args()

    try:
        project, repo, pr = parse_pr_ref(args.pr, args.project, args.repo)
        replies = json.loads(Path(args.file).read_text(encoding="utf-8"))
        url = pr_api(project, repo, pr, "/comments")

        jobs: list[tuple[str | None, str]] = []
        for key, value in replies.items():
            texts = value if isinstance(value, list) else [value]
            for text in texts:
                jobs.append((None if key == "root" else str(key), text))

        if not args.post:
            print(f"ЧЕРНОВИК, ничего не отправлено. Готово к отправке: {len(jobs)}\n")
            for parent, text in jobs:
                target = f"ответ в тред {parent}" if parent else "новый общий коммент"
                print("=" * 88)
                print(f"{target}  ({len(text)} символов)")
                print(text)
            print("\nПерепроверь тексты, затем запусти с --post")
            return 0

        for parent, text in jobs:
            payload: dict = {"text": text}
            if parent:
                payload["parent"] = {"id": int(parent)}
            created = call(url, payload=payload, method="POST")
            target = f"тред {parent}" if parent else "общий коммент"
            print(f"OK  {target} -> id={created.get('id')}")
        return 0
    except Exception as exc:  # noqa: BLE001
        return die(exc)


if __name__ == "__main__":
    raise SystemExit(main())
