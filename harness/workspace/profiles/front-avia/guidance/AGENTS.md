## Tasker-managed execution

Tasker уже подготовил workflow, план, ветку, worktree и Docker runtime. Не создавай
и не переключай worktree, не запускай второй planning workflow и не останавливайся
перед разрешёнными текущим step внешними действиями.

Следуй `./.ai/tasker.md` для runtime-ограничений. При конфликте с интерактивными
правилами создания worktree и ручной финализации правила Tasker имеют приоритет.
