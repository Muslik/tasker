---
name: localization
description: "front-avia localization (l10n) — how to add/use translated strings, the key conventions, and the tolgee sync. Use whenever a task touches user-facing text — a label, button, message, error, or anything shown to the user. Never hardcode user-facing text."
---

# Localization (l10n)

All user-facing text goes through l10n — **never hardcode strings**. The Russian source
of truth is `src/l10n/ru.json`; translations are managed in **tolgee** (`@ott/tolgee-cli`).

## Using it in code

```ts
import { l10n } from '@ott/l10n-next';

l10n('book.startNewSearch')
```

- **Pass the key as a literal** — never a variable or bracket access. Keys are typed as a
  huge union (generated into `src/shared/types/l10n-next.d.ts`); a non-literal key silently
  skips that check, so a typo ships broken.
- Need more than a plain key (params, HTML inside text)? Copy a neighbouring component
  instead of guessing the helper name.

## Adding keys

- **Edit `src/l10n/ru.json`.** Every other `src/l10n/*.json` is filled by human translators
  through tolgee — never write translations into them yourself.
- **Exception — text that genuinely needs no translation** (brand names, codes, RU-only
  copy): put the literal string **`TRANSLATION_IS_NOT_REQUIRED`** as the value for that key
  in every other locale file. The spelling matters.
- **Key naming:** descriptive, grouped by domain, nested objects — `button.save`,
  `search.form.placeholder`, `book.passenger.firstName`. Never flat `btn1` / `text123`.
- **After adding keys run `l10n:generate-types`** — otherwise the new keys aren't in the
  typed union and the build fails.

## Translation sync (tolgee)

- Other languages are filled by **human translators — not instant.** A new key ships with
  its RU source only; other locales stay empty until a translator fills them (the ticket tag
  notifies them via the **`l10nnotificator`** Slack channel). Don't wait for them and don't
  expect them in your diff — **RU is what you deliver.**
- `l10n:sync` pulls translations **already done** in tolgee. It does NOT translate your new
  keys — running it right after adding a key will not populate other locales.
