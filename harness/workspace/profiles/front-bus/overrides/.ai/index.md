# front-bus ai guide

## 🔥 КРИТИЧЕСКИЕ ПРАВИЛА (ВСЕГДА СОБЛЮДАЙ)

### Обязательно
1. **Прочитай UI-Kit документацию** - `.ui/ui-kit-integration.md`

### Правила переиспользования
- **ПЕРЕИСПОЛЬЗУЙ** существующие компоненты/утилиты/токены перед созданием новых
- **СОБЛЮДАЙ** ESLint правила проекта
- **ИСПОЛЬЗУЙ** миксины @ott/ui, НЕ изобретай свои
- **СЛЕДУЙ** структуре проекта и именованиям
- Если команда не выполняется несколько раз - продолжай, не зацикливайся
- Не исправляй StyleLint самостоятельно, только Prettier форматирование

## Технологии
- **Основа:** TypeScript + React
- **Стили:** SCSS + CSS Modules + @ott/ui
- **Стейт менеджмент** - Redux toolkit
- **Работа с API** - React query
- **Работа с формами** - React Hook Form
- **Тесты:** Jest + Playwright
- **Линтинг:** ESLint + StyleLint + Prettier

## Иконки
**ВАЖНО: НЕ создавай SVG-иконки самостоятельно!**

Для использования иконок:
1. **Проверь `.ui/ui-kit/icons.json`** - найди подходящую иконку по названию
2. **Используй компонент Icon** из `@ott/icons`:

```typescript
import { Icon } from '@ott/icons';

type IconProps = {
  name: IconName;
} & Omit<SVGProps<SVGSVGElement>, 'href'>;

// Пример использования
<Icon name="close" className={styles.closeIcon} />
<Icon name="arrow-right" width={24} height={24} />
```

## Локализация
```typescript
import { l10n, l10nhtml } from '@ott/l10n'
l10n('timer.days') // базовый
l10n('timer.days', { days: date.day }) // с параметрами
l10nhtml('timer.days') // с HTML разметкой
```
Переводы добавляй в `src/l10n/ru.json` используй формат ICU

---

# Code Style Guide

## TypeScript
- Строгий режим (`strict: true`)
- **ВСЕГДА используй `type` вместо `interface`**
- Используй lodash если нужно, не изобретай велосипед
- Типы пропсов: `ComponentNameProps`
- Дженерики для универсальных компонентов
- JSDoc комментарии на русском
- Utility типы: `Omit`, `Pick`, `Partial`
- Явные типы хуков: `useState<T>()`
- Избегать `any`
- Всегда указываем `{}` для `if` блоков

```typescript
type ButtonProps = {
  /** Вариант отображения кнопки */
  variant?: 'primary' | 'secondary';
  /** Обработчик клика */
  onClick?: () => void;
  /** Локатор для тестов */
  specificLocator?: string;
}
```

## React компоненты
- Функциональные компоненты + хуки
- `forwardRef` для компонентов с refs
- `memo` для оптимизации
- Никогда не используем shorthand для пропов
- Вместо data-testid указываем data-locator
- Именование: PascalCase
- Compound components: `SegmentedControl.Item`
- Декомпозиция в `blocks/`
- Предпочитай для текста компонент Typography вместо миксинов шрифта
- Для композиции блоков используем `Grid` из `@ott/ui`

```typescript
const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', onClick, specificLocator, ...props }, ref) => {
    return (
      <button
        ref={ref}
        onClick={onClick}
        data-locator={specificLocator}
        {...props}
      />
    );
  }
);
```

## CSS/SCSS
- CSS Modules: `import styles from './Component.scss'`
- Классы: camelCase (`rootIsChecked`)
- Глобальные переменные из @ott/ui

```scss
.root {
  background: var(--local-background);
}
```

## Именования
- camelCase: переменные, функции
- PascalCase: компоненты, типы
- UPPER_CASE: константы
- Булевы: `is*`, `has*`, `should*`, `can*`, `will*`
- Обработчики: `handle*` (`handleChange`)

## Accessibility
- ARIA роли и атрибуты
- Доступность с клавиатуры
- Тестирование скринридерами

## Паттерны
- Headless компоненты из `@ott/ui`
- Кастомные хуки для общей логики
- throttle/debounce для производительности
- Async/await > промисы

---

# Styling Guide - @ott/ui

## ОБЯЗАТЕЛЬНО: Проверь .ui/ui-kit/styles.json
Перед написанием любых стилей проверь доступные токены и миксины в `.ui/ui-kit/styles.json`!

## Пример готовых миксинов (используй из styles.json)
```scss
@use '@ott/ui/styles/font';
@use '@ott/ui/styles/screen'

.title { @include font.title-2; }        // 24px/28px
.root { @include font.base; }         // 14px/20px
.content { @include screen.mobile {padding: 12px;};}
```

## Иерархия CSS переменных
1. **Глобальные** (уровень 1): `--color-*`, `--duration-*`, `--shadow-*`, `--border-radius-*`
2. **Токены** (уровень 2): `--bg-*`, `--text-*`, `--brand-*`, `--error-*`
3. **Компонентные** (уровень 3): `--counter-default-background-color`

**Правила использования:**
- **ИСПОЛЬЗУЙ только уровень 2** (семантические токены)
- **НЕ используй уровень 1** (глобальные переменные) напрямую

## Паттерн стилизации
```scss
@use '@ott/ui/styles/font';

// Варианты через локальные переменные
.rootSmall {
  @include font.small;
}

.rootMedium {
  @include font.base;
}

// Общие стили
.root {
  padding: 16px;
  border-radius: var(--border-radius-m);
}
```

## Правила
1. **Проверяй .ui/ui-kit/styles.json** перед любыми стилями
2. **Используй ТОЛЬКО уровень 2** (токены и компонентные переменные)
4. **Только готовые миксины** для типографики/layout
6. **Соблюдай иерархию** абстракций
7. **data-redesigned="true"** для новых стилей

# Работа с запросами
Для запросов используем библиотеку openapi-fetch

Есть 2 созданных клиента в `src/api`

- authClient
- busClient

Так же в папке `src/api/types` находится сгенерированные типы

# Определение вьюпорта
Для определения desktop/mobile используем хук `useLayoutContext` из библиотеки `@ott/ui`

```tsx
const { isDesktop, isMobile } = useLayoutContext();
```

# Команды
Прогон еслинта - `pnpm run agent:eslint-for-staged`
Билд и проверка типов - `agent:check-ts-by-build`

## Коммиты

Одна строка, без тела. **Никаких подписей и трейлеров** — ни `Co-Authored-By`,
ни «Generated with …», ни упоминаний инструмента.

Формат: `TICKET-123: краткое описание` (ключ задачи — из ветки). Допустим тип:
`TICKET-123: fix: ...`, `TICKET-123: chore: ...`.

За референсом стиля — последние коммиты репозитория: `git log --oneline -20`.

<!-- wt-guide -->
---

## Worktree

Worktree создаются и удаляются через `wt`:

- `wt <ветка>` — подключить worktree к **существующей** ветке (локальной или с origin).
  Ветки нет → ошибка с подсказкой, новая НЕ создаётся.
- `wt -b <ветка> [--base <ref>]` — создать **новую** ветку + worktree.
- `wt` — выбрать существующую ветку через fzf.
- `wt cd [ветка]` — перейти в worktree (без аргумента — fzf).
- `wt list` — worktree текущего проекта.
- `wt rm <ветка> [--force]` — удалить worktree.
