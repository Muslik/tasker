# Архитектура

**Feature-Sliced Design.** Стек: React 18 + TS 5.8, React Router DOM **v5**, Redux Toolkit (thunks), React Hook Form + Zod (формы), Jest + Playwright, pnpm. UI — дизайн-система `@ott/ui`; проектные компоненты в `shared/ui` (Atomic Design: `atoms`/`molecules`/`organisms`). Иконки — `@ott/icons`.

## Слои (снизу вверх; импорт — только вниз)
| Слой | Что | Импортирует |
|---|---|---|
| `shared` | переиспользуемое без бизнес-логики: `lib`, `hooks`, `api`, `ui`. `lib`/`hooks` из публичного API — покрывать тестами | — |
| `entities` | бизнес-сущности (`search`, `reservation`, `fareRules`…): `model/` + опц. `ui/` | shared |
| `features` | пользовательские сценарии (`attachDocuments`, `sendApplicationLink`…) | entities, shared |
| `widgets` | составные секции из features/entities | features, entities, shared |
| `pages` | роуты и страницы | всё ниже |
| `app` | глобальная инициализация: провайдеры, роутинг | всё ниже |

(`src/` также содержит `l10n/` — переводы, `redux/` — стор/setup, `meta/`; и легаси `components/`/`helpers/`/`types/`/`utility/` — новое туда не клади.)

## Структура слайса
```
src/<layer>/<name>/
├── index.ts        # публичный API — снаружи импортируют ТОЛЬКО отсюда
├── model/          # Redux: reducer/slice, selectors (.ts или /), types
├── lib/            # утилиты слайса
├── ui/<Component>/ # компоненты
├── types.ts
└── constants.ts
```

## Импорты
- **Абсолютные между слайсами** (`src/entities/search`), **относительные внутри слайса** (`./model/selectors`).
- **Только через `index.ts`** — без глубоких импортов (`src/entities/x/model/reducer` ❌). Исключение: из `shared` можно по подпапкам.
- **Нет кросс-импортов между слайсами одного слоя.** Общее выноси вниз (в entities/shared); неизбежное — через папку `@x` (`src/entities/airline/@x/aircraft.ts`), таких в проекте единицы.
