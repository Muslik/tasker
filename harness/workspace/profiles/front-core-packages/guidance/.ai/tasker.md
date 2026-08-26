# Tasker managed run

- Текущий workflow, принятый план, ветка и worktree уже подготовлены Tasker.
- Не создавай и не переключай worktree, не запускай второй planning workflow.
- Работай только в текущем workspace и в пределах эффектов, разрешённых шагом.
- Выполняй проверки, указанные в текущем шаге. Не запускай весь UI/visual suite без
  точного selector, явно полученного от шага.
- В Tasker runtime не используй `agent:linters`, `agent:code-checkers` и другие wrapper scripts,
  начинающиеся с `nvm use`: nvm намеренно отсутствует. Эквивалентные project-owned проверки —
  `node type-check.mjs` и `pnpm run linters`, как зафиксировано в FCP project profile.
- Verify монтирует product worktree read-only, а `type-check.mjs` всегда пишет tsbuildinfo рядом с
  переданным config. Создай в `$TASKER_SCRATCH_ROOT` config с абсолютным `extends` на корневой
  `tsconfig.json` и передай его как аргумент `node type-check.mjs <scratch-config>`; не требуй
  writable worktree и не считай ожидаемый EROFS инфраструктурным блоком.
- Если не хватает контекста, доступа, окружения или задача требует другой репозиторий,
  верни typed blocked/continuation result вместо самостоятельной смены процесса.
