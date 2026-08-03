#!/usr/bin/env python3
"""Консольный лог билда: целиком, хвостом или по регулярке."""

from __future__ import annotations

import argparse
import re

from jk_common import die, fetch_text, parse_build_ref


def main() -> int:
    parser = argparse.ArgumentParser(description="Read a Jenkins console log")
    parser.add_argument("build", help="build URL, number, lastBuild or lastFailedBuild")
    parser.add_argument("--job", help="job name, e.g. front-backoffice")
    parser.add_argument("--branch", help="branch name for a multibranch job")
    parser.add_argument("--tail", type=int, metavar="N", help="print only the last N lines")
    parser.add_argument("--grep", metavar="RE", help="print only lines matching the regex")
    parser.add_argument("--context", type=int, default=0, metavar="N", help="lines around a --grep hit")
    args = parser.parse_args()

    try:
        url = parse_build_ref(args.build, args.job, args.branch)
        lines = fetch_text(f"{url}/consoleText").splitlines()

        if args.grep:
            pattern = re.compile(args.grep)
            hits = [index for index, line in enumerate(lines) if pattern.search(line)]
            shown: set[int] = set()
            for index in hits:
                shown.update(range(max(0, index - args.context), min(len(lines), index + args.context + 1)))
            lines = [lines[index] for index in sorted(shown)]
            print(f"# {len(hits)} строк совпало с {args.grep!r}")

        if args.tail:
            lines = lines[-args.tail :]

        print("\n".join(lines))
        return 0
    except Exception as exc:  # noqa: BLE001
        return die(exc)


if __name__ == "__main__":
    raise SystemExit(main())
