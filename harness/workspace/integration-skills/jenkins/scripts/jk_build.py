#!/usr/bin/env python3
"""Статус билда, его стадии, список последних билдов ветки и список ветвей job."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone

from jk_common import die, fetch_json, job_url, parse_build_ref


def _stamp(millis: int | None) -> str:
    if not millis:
        return "—"
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def _print_build(url: str) -> None:
    info = fetch_json(f"{url}/api/json")
    print(f"#{info.get('number')}  {info.get('result') or 'IN PROGRESS'}")
    print(f"url:      {info.get('url')}")
    print(f"started:  {_stamp(info.get('timestamp'))}")
    print(f"duration: {round((info.get('duration') or 0) / 1000)}s")
    if info.get("description"):
        print(f"desc:     {info['description']}")

    for action in info.get("actions") or []:
        for item in action.get("lastBuiltRevision", {}).get("branch", []) or []:
            print(f"revision: {item.get('SHA1', '')[:12]} {item.get('name', '')}")

    # Стадии живут в отдельном wfapi, в /api/json их нет.
    stages = fetch_json(f"{url}/wfapi/describe").get("stages") or []
    if stages:
        print("\nstages:")
        for stage in stages:
            mark = "x" if stage.get("status") in ("FAILED", "ABORTED") else "+"
            print(f"  {mark} {stage.get('status'):<10} {stage.get('name')}")


def _print_builds(job: str, branch: str | None, limit: int) -> None:
    url = job_url(job, branch)
    data = fetch_json(f"{url}/api/json?tree=builds%5Bnumber,result,timestamp,duration%5D")
    for item in (data.get("builds") or [])[:limit]:
        result = item.get("result") or "IN PROGRESS"
        print(f"#{item['number']:<5} {result:<12} {_stamp(item.get('timestamp'))}")


def _print_branches(job: str) -> None:
    data = fetch_json(f"{job_url(job)}/api/json?tree=jobs%5Bname,color%5D")
    for item in data.get("jobs") or []:
        print(f"{item.get('color', ''):<14} {item['name']}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Read Jenkins build status")
    parser.add_argument("build", nargs="?", help="build URL, number, lastBuild or lastFailedBuild")
    parser.add_argument("--job", help="job name, e.g. front-backoffice")
    parser.add_argument("--branch", help="branch name for a multibranch job")
    parser.add_argument("--builds", type=int, metavar="N", help="list N last builds of the branch")
    parser.add_argument("--branches", action="store_true", help="list branches of the job")
    parser.add_argument("--json", action="store_true", help="print the raw /api/json payload")
    args = parser.parse_args()

    try:
        if args.branches:
            if not args.job:
                raise RuntimeError("--branches needs --job")
            _print_branches(args.job)
            return 0

        if args.builds:
            if not args.job:
                raise RuntimeError("--builds needs --job")
            _print_builds(args.job, args.branch, args.builds)
            return 0

        if not args.build:
            raise RuntimeError("Pass a build URL/number, or use --builds / --branches")

        url = parse_build_ref(args.build, args.job, args.branch)
        if args.json:
            print(json.dumps(fetch_json(f"{url}/api/json"), ensure_ascii=False, indent=2))
            return 0

        _print_build(url)
        return 0
    except Exception as exc:  # noqa: BLE001
        return die(exc)


if __name__ == "__main__":
    raise SystemExit(main())
