#!/usr/bin/env python3
"""
Standalone Confluence page writer (Server/DC REST API).

Companion to the read-only confluence skill (confluence_get_page.py) — same auth.

Requires:
  CONFLUENCE_BASE_URL (e.g., https://confluence.example.com)
  CONFLUENCE_TOKEN (API token or PAT)

Bodies are Confluence *storage format* (XHTML + ac: macros), never wiki markup.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import uuid
from pathlib import Path
from urllib import error, request

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "lib"))
from harness_env import load_env

load_env()


def base_url() -> str:
    value = os.environ.get("CONFLUENCE_BASE_URL", "").strip()
    if not value:
        raise RuntimeError("Missing CONFLUENCE_BASE_URL environment variable")
    return value.rstrip("/")


def token() -> str:
    value = os.environ.get("CONFLUENCE_TOKEN", "").strip()
    if not value:
        raise RuntimeError("Missing CONFLUENCE_TOKEN environment variable")
    return value


def call(method: str, path: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {token()}",
    }
    if data:
        headers["Content-Type"] = "application/json"
    req = request.Request(base_url() + path, data=data, headers=headers, method=method)
    try:
        with request.urlopen(req) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except error.HTTPError as exc:
        # Confluence puts the actual reason in the body; without it every failure
        # reads as a bare "400 Bad Request".
        detail = exc.read().decode("utf-8", "replace")[:2000]
        raise RuntimeError(f"HTTP {exc.code} {method} {path}\n{detail}") from None


def post_multipart(path: str, file_path: Path, comment: str | None) -> dict:
    boundary = uuid.uuid4().hex
    mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    parts: list[bytes] = []

    def field(name: str, value: str) -> None:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n".encode("utf-8")
        )

    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
        f'filename="{file_path.name}"\r\nContent-Type: {mime}\r\n\r\n'.encode("utf-8")
    )
    parts.append(file_path.read_bytes())
    parts.append(b"\r\n")
    if comment:
        field("comment", comment)
    field("minorEdit", "true")
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(parts)

    req = request.Request(
        base_url() + path,
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token()}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            # Required by Confluence for any non-JSON write, even with a PAT.
            "X-Atlassian-Token": "no-check",
        },
    )
    try:
        with request.urlopen(req) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:2000]
        raise RuntimeError(f"HTTP {exc.code} POST {path}\n{detail}") from None


def read_body(args) -> str:
    if args.body_file:
        return Path(args.body_file).read_text(encoding="utf-8")
    if args.body is not None:
        return args.body
    return ""


def page_url(page: dict) -> str:
    links = page.get("_links", {})
    return (links.get("base") or base_url()) + (links.get("webui") or "")


def do_create(args) -> int:
    payload = {
        "type": "page",
        "title": args.title,
        "space": {"key": args.space},
        "body": {"storage": {"value": read_body(args), "representation": "storage"}},
    }
    if args.parent:
        payload["ancestors"] = [{"id": str(args.parent)}]
    if args.dry_run:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0
    page = call("POST", "/rest/api/content", payload)
    print(f"created {page['id']} v{page['version']['number']}")
    print(page_url(page))
    return 0


def do_update(args) -> int:
    current = call(
        "GET", f"/rest/api/content/{args.update}?expand=version,space,ancestors,body.storage"
    )
    version = current["version"]["number"]
    title = args.title or current["title"]
    body = read_body(args) if (args.body_file or args.body is not None) else None

    payload = {
        "id": str(args.update),
        "type": "page",
        "title": title,
        "space": {"key": current["space"]["key"]},
        "version": {"number": version + 1, "minorEdit": bool(args.minor)},
    }
    if args.message:
        payload["version"]["message"] = args.message
    if body is not None:
        payload["body"] = {"storage": {"value": body, "representation": "storage"}}

    if args.dry_run:
        print(f"# current v{version}, title={current['title']!r}")
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0
    page = call("PUT", f"/rest/api/content/{args.update}", payload)
    print(f"updated {page['id']} v{version} -> v{page['version']['number']}")
    print(page_url(page))
    return 0


def do_attach(args) -> int:
    page_id = args.attach
    existing = {
        item["title"]: item["id"]
        for item in call(
            "GET", f"/rest/api/content/{page_id}/child/attachment?limit=200"
        ).get("results", [])
    }
    for raw_path in args.files:
        path = Path(raw_path)
        if not path.is_file():
            raise RuntimeError(f"Not a file: {path}")
        if args.dry_run:
            action = "replace" if path.name in existing else "add"
            print(f"{action} {path.name} ({path.stat().st_size} bytes) -> page {page_id}")
            continue
        if path.name in existing:
            # Re-posting a duplicate filename to the collection endpoint 400s;
            # a new version has to go to that attachment's own /data.
            target = f"/rest/api/content/{page_id}/child/attachment/{existing[path.name]}/data"
        else:
            target = f"/rest/api/content/{page_id}/child/attachment"
        post_multipart(target, path, args.message)
        print(f"attached {path.name}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create/update Confluence pages and upload attachments"
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--create", action="store_true", help="Create a new page")
    mode.add_argument("--update", metavar="PAGE_ID", help="Update an existing page")
    mode.add_argument("--attach", metavar="PAGE_ID", help="Upload attachments to a page")

    parser.add_argument("files", nargs="*", help="Files to upload (with --attach)")
    parser.add_argument("--space", help="Space key (with --create)")
    parser.add_argument("--parent", help="Parent page id (with --create)")
    parser.add_argument("--title", help="Page title")
    parser.add_argument("--body-file", help="File with the storage-format body")
    parser.add_argument("--body", help="Inline storage-format body")
    parser.add_argument("--message", help="Version comment / attachment comment")
    parser.add_argument(
        "--minor", action="store_true", help="Mark the update as minor (no watcher mail)"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Print what would be sent and exit"
    )
    args = parser.parse_args()

    try:
        if args.create:
            if not args.space or not args.title:
                parser.error("--create requires --space and --title")
            return do_create(args)
        if args.update:
            return do_update(args)
        if not args.files:
            parser.error("--attach requires at least one file")
        return do_attach(args)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
