#!/usr/bin/env python3
"""
Shared helpers for the Jenkins REST API.

Requires:
  JENKINS_USER  (логин, под которым выпущен токен — например me@onetwotrip.com)
  JENKINS_TOKEN (API token из профиля Jenkins)
  JENKINS_BASE_URL (optional, defaults to https://build.twiket.com)
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
from pathlib import Path
from urllib import error, request

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "lib"))
from harness_env import ENV_FILE, load_env

load_env()


DEFAULT_BASE_URL = "https://build.twiket.com"

BUILD_URL_RE = re.compile(r"^(?P<job>https?://.+?)/(?P<number>\d+|lastBuild|lastFailedBuild)/?$")



def build_headers() -> dict[str, str]:
    """Jenkins принимает токен только как basic auth; Bearer отдаёт 403."""
    user = os.environ.get("JENKINS_USER", "").strip()
    token = os.environ.get("JENKINS_TOKEN", "").strip()
    if not user or not token:
        raise RuntimeError(
            "Missing JENKINS_USER / JENKINS_TOKEN "
            f"(looked in the environment and in {ENV_FILE})"
        )
    credentials = base64.b64encode(f"{user}:{token}".encode()).decode()
    return {"Accept": "application/json", "Authorization": f"Basic {credentials}"}


def build_base_url() -> str:
    return os.environ.get("JENKINS_BASE_URL", DEFAULT_BASE_URL).strip().rstrip("/")


def job_url(job: str, branch: str | None = None) -> str:
    """Путь многоветочного job: front-backoffice + ветка -> /job/front-backoffice/job/BRANCH."""
    url = f"{build_base_url()}/job/{job}"
    if branch:
        url = f"{url}/job/{branch}"
    return url


def parse_build_ref(value: str, job: str | None, branch: str | None) -> str:
    """Принимает полный URL билда либо его номер (тогда нужен --job)."""
    match = BUILD_URL_RE.match(value.strip())
    if match:
        return f"{match.group('job')}/{match.group('number')}"

    if not (value.isdigit() or value.startswith("last")):
        raise RuntimeError(f"Cannot parse build reference from {value!r}: pass a build URL or a number")
    if not job:
        raise RuntimeError("A bare build number needs --job (and --branch for multibranch jobs)")
    return f"{job_url(job, branch)}/{value}"


def fetch_bytes(url: str) -> bytes:
    req = request.Request(url, headers=build_headers())
    try:
        with request.urlopen(req) as resp:
            return resp.read()
    except error.HTTPError as exc:
        # На ошибках Jenkins отдаёт целую html-страницу — в сообщение её тащить незачем.
        detail = " ".join(exc.read().decode("utf-8", "replace").split())
        suffix = "" if detail.startswith("<") else f": {detail[:300]}"
        raise RuntimeError(f"HTTP {exc.code} {exc.reason} on {url}{suffix}") from exc


def fetch_json(url: str) -> dict:
    body = fetch_bytes(url).decode("utf-8")
    return json.loads(body) if body else {}


def fetch_text(url: str) -> str:
    return fetch_bytes(url).decode("utf-8", "replace")


def die(exc: Exception) -> int:
    print(f"Error: {exc}", file=sys.stderr)
    return 1
