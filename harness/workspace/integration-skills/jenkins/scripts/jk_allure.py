#!/usr/bin/env python3
"""
Allure-отчёт билда: упавшие тесты, детали кейса, выгрузка вложений.

Скриншотные расхождения Playwright приезжают вложением типа
application/vnd.allure.image.diff — это JSON с тремя data-URI (expected/actual/diff),
а не png. --save раскладывает их отдельными файлами; actual — это то, что отрендерил CI,
то есть готовая замена для устаревшего снепшота.
"""

from __future__ import annotations

import argparse
import base64
import json
import struct
from pathlib import Path

from jk_common import die, fetch_bytes, fetch_json, parse_build_ref

IMAGE_DIFF_TYPE = "application/vnd.allure.image.diff"


def _walk(node: dict, out: list[dict]) -> None:
    children = node.get("children")
    if children:
        for child in children:
            _walk(child, out)
        return
    if node.get("uid"):
        out.append(node)


def _leaves(allure_url: str) -> list[dict]:
    tree = fetch_json(f"{allure_url}/data/suites.json")
    leaves: list[dict] = []
    _walk(tree, leaves)
    return leaves


def _attachments(node: dict, out: list[dict]) -> None:
    for attachment in node.get("attachments") or []:
        out.append(attachment)
    for step in node.get("steps") or []:
        _attachments(step, out)
    for key in ("testStage", "beforeStages", "afterStages"):
        stage = node.get(key)
        if isinstance(stage, dict):
            _attachments(stage, out)
        elif isinstance(stage, list):
            for item in stage:
                _attachments(item, out)


def _png_size(raw: bytes) -> str:
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        return f"{len(raw)} байт"
    width, height = struct.unpack(">II", raw[16:24])
    return f"{width}x{height}, {len(raw)} байт"


def _save(raw: bytes, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    print(f"  -> {path}  ({_png_size(raw)})")


def _save_attachment(allure_url: str, attachment: dict, out_dir: Path) -> None:
    source = attachment["source"]
    name = attachment.get("name") or source
    raw = fetch_bytes(f"{allure_url}/data/attachments/{source}")

    if attachment.get("type") != IMAGE_DIFF_TYPE:
        _save(raw, out_dir / f"{name}{Path(source).suffix}")
        return

    payload = json.loads(raw.decode("utf-8"))
    for key in ("expected", "actual", "diff"):
        value = payload.get(key)
        if not value:
            continue
        _save(base64.b64decode(value.split(",", 1)[1]), out_dir / f"{name}-{key}.png")


def main() -> int:
    parser = argparse.ArgumentParser(description="Read the Allure report of a Jenkins build")
    parser.add_argument("build", help="build URL, number, lastBuild or lastFailedBuild")
    parser.add_argument("--job", help="job name, e.g. front-backoffice")
    parser.add_argument("--branch", help="branch name for a multibranch job")
    parser.add_argument("--all", action="store_true", help="list every test, not only broken ones")
    parser.add_argument("--case", metavar="UID", help="show one test case with its attachments")
    parser.add_argument("--save", metavar="DIR", help="save the attachments of --case into DIR")
    args = parser.parse_args()

    try:
        allure_url = f"{parse_build_ref(args.build, args.job, args.branch)}/allure"

        if args.case:
            case = fetch_json(f"{allure_url}/data/test-cases/{args.case}.json")
            print(f"{case.get('status')}  {case.get('name')}")
            if case.get("statusMessage"):
                print(f"\n{case['statusMessage'].strip()}\n")

            attachments: list[dict] = []
            _attachments(case, attachments)
            for attachment in attachments:
                print(f"  {attachment.get('name')}  [{attachment.get('type')}]  {attachment.get('source')}")

            if args.save:
                out_dir = Path(args.save)
                print()
                for attachment in attachments:
                    _save_attachment(allure_url, attachment, out_dir)
            return 0

        leaves = _leaves(allure_url)
        shown = leaves if args.all else [n for n in leaves if n.get("status") not in ("passed", "skipped")]
        print(f"тестов: {len(leaves)}, показано: {len(shown)}")
        for node in shown:
            print(f"{node.get('status'):<8} {node['uid']}  {node.get('name')}")
        return 0
    except Exception as exc:  # noqa: BLE001
        return die(exc)


if __name__ == "__main__":
    raise SystemExit(main())
