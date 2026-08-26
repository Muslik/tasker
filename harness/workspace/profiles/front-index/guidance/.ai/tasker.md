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
  `pnpm install --frozen-lockfile`; host Node/pnpm не используются.
- Tasker запускает `pnpm start` как task-scoped service текущего worktree и
  публикует его по alias `local.onetwotrip.com`.
- Рабочий адрес — `https://local.onetwotrip.com:3000`; plain
  `http://local.onetwotrip.com:3000` перенаправляется туда же, self-signed certificate
  ожидаем.

## Проверки

- `pnpm run agent:check` — безопасная проверка типов из repository-owned entrypoint.
- `pnpm run eslint-no-fix` — non-mutating ESLint validation.
- `pnpm run build:all` — bounded production build validation.
- `pnpm test:ui` остаётся вне обычной validation surface, пока шаг не передаст точный
  bounded selector.
