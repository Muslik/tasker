# Tasker managed run

- Текущий workflow, принятый план, ветка и worktree уже подготовлены Tasker.
- Не создавай и не переключай worktree, не запускай второй planning workflow.
- Работай только в текущем workspace и в пределах эффектов, разрешённых шагом.
- Выполняй проверки, указанные в текущем шаге. Не запускай весь UI/visual suite без
  точного selector, явно полученного от шага.
- Если не хватает контекста, доступа, окружения или задача требует другой репозиторий,
  верни typed blocked/continuation result вместо самостоятельной смены процесса.

## Docker runtime проекта

- Dependencies устанавливаются в pinned Docker runtime через
  `pnpm install --frozen-lockfile` и `pnpm run dicts`; host Node/pnpm не используются.
- Tasker запускает `pnpm start` как task-scoped service текущего worktree.
- Базовый URL — `https://local.onetwotrip.com:3004`; self-signed certificate ожидаем.
- Не используй dev server другого run только потому, что на host уже занят порт 3004.
