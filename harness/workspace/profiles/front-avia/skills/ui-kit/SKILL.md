---
name: ui-kit
description: "front-avia UI kit — the @ott/ui component library (+ @ott/icons). Use when building or changing ANY UI — picking a component, checking whether one already exists before writing one, styling with tokens/mixins, or adding an icon. Do NOT re-implement what @ott/ui already provides."
---

# UI kit — `@ott/ui`

The UI building blocks are the installed package **`@ott/ui`** (+ **`@ott/icons`** for icons). It is the single source of truth — read it directly in `node_modules`.

## Always
- **Reuse first.** Before writing a component, check whether `@ott/ui` already has it. Compose existing components rather than building from scratch.
- **Import from the package root** (everything is re-exported): `import { Button, type ButtonProps } from '@ott/ui';` · icons: `import { IconArrowRight } from '@ott/icons';`.
- **Styles — tokens + mixins from the package.** Use the design-token CSS vars (`var(--bg-surface-primary)`, `--text-primary`, …); never invent custom vars or borrow another component's. Mixins via `@use '@ott/ui/styles/<name>';` — e.g. `@use '@ott/ui/styles/font';` (`@include font.title-2;`). What's available: `@ott/ui/styles/`.
- **Icons** only from `@ott/icons` — never hand-draw SVGs.

## Authoring a component
Put it under `src/{features,entities}/<slice>/ui/<Component>/`:
- `<Component>.tsx`, `<Component>.scss`, `index.ts` (public export); optional `hooks.ts`, `types.ts`, nested `ui/` for subcomponents.
- Functional component, typed `Props` — `React.PropsWithChildren<{…}>`, or `React.ComponentProps<'button'> & {…}` to extend an element.
- Classes via `import cls from 'classnames'` + a scss-module `import styles from './<Component>.scss';` → `cls(styles.root, { [styles.disabled]: isDisabled }, className)`.
- Styles use `@ott/ui/styles/*` mixins + design tokens (see **Styles** above) — never custom vars.

## Where to look (read on demand — don't crawl the whole library)
- **Components:** `@ott/ui/src/{core,blocks,headless}/<Name>/` — each ships `docs/` (usage examples) + `index.ts` (exports + prop types). Search these dirs by component name; open only the one(s) the task touches.
- **All exports / what exists:** `@ott/ui/index.ts` (re-exports `core`, `blocks`, `headless`, `utils`).
- **Styles / mixins:** `@ott/ui/styles/` (`font.scss`, `screen.scss`, …).
- **Icons:** `@ott/icons/`.
