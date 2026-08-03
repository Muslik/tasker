"""Единый загрузчик <слой>/.env для скриптов скиллов.

Зачем отдельный модуль: раньше загрузчик копировался в каждый скрипт и стоял под
guard'ом «если мой токен уже в окружении — выйти». Из-за этого достаточно было
иметь в шелле JIRA_TOKEN, чтобы файл не дочитался и JIRA_BASE_URL остался пустым.
Здесь guard'а нет: файл читается всегда, а setdefault оставляет приоритет за
реальным окружением.

Использование (скрипт лежит в <слой>/skills/<скилл>/scripts/):

    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "lib"))
    from harness_env import load_env

    load_env()
"""

from __future__ import annotations

import os
from pathlib import Path

# Tasker passes the external secret file explicitly. The local fallback keeps the
# package usable outside Tasker without ever placing secrets in a snapshot.
_configured_env_file = os.environ.get("TASKER_HARNESS_ENV_FILE", "").strip()
ENV_FILE = (
    Path(_configured_env_file).expanduser()
    if _configured_env_file
    else Path(__file__).resolve().parents[1] / ".env"
)


def load_env(env_file: Path | None = None) -> Path | None:
    """Подмешивает .env в os.environ. Возвращает прочитанный файл или None."""
    path = env_file or ENV_FILE
    if not path.is_file():
        return None

    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))

    return path


def require(*names: str) -> list[str]:
    """Значения обязательных переменных; в ошибке — что именно не найдено и где искали."""
    load_env()
    missing = [n for n in names if not os.environ.get(n, "").strip()]
    if missing:
        raise RuntimeError(
            f"Не заданы переменные: {', '.join(missing)} "
            f"(искал в окружении и в {ENV_FILE})"
        )
    return [os.environ[n].strip() for n in names]
