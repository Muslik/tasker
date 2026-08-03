# Соглашения о кодировании

## Нейминг
- **Папки** `camelCase`; **React-компоненты** `PascalCase.tsx`, остальные файлы `camelCase.ts`.
- **Переменные/функции** `camelCase`; **константы** `UPPER_SNAKE_CASE`; **типы/классы/компоненты** `PascalCase`.
- **Булевы** — префикс `is`/`has`/`was` (`isLoading`); **функции, возвращающие boolean** — префикс `checkIf` (`checkIfUserCanEdit`).
- **Redux**: селекторы — суффикс `selector` (`userSelector`); API-thunks — суффикс `Fx` (`fetchUserFx`).

## TypeScript
- `any` запрещён без веской причины. `type` вместо `interface`.
- Функция с >1 параметром принимает один объект-аргумент.
- Без `enum` — объект `as const`: `const S = {...} as const; type S = typeof S[keyof typeof S]`.
- Глубокие импорты библиотек для tree-shaking (`import debounce from 'lodash/debounce'`).

## React-компонент — порядок внутри
1. импорты → 2. типы → 3. Redux-хуки (`useAppSelector`/`useAppDispatch`) → 4. локальный `useState` → 5. обработчики → 6. ранние возвраты → 7. JSX.

Бизнес-логику держи не в компоненте и не в хуках, а в Redux.

> Стили, Redux/API, структура слайса и компонента — в скиллах `ui-kit` / `state-data` и в `architecture.md`. Здесь не дублируем.
