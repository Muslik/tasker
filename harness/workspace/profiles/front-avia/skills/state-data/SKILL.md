---
name: state-data
description: "front-avia state & data layer — Redux Toolkit, thunks, API calls, loading state, selectors. Use whenever a task touches application state or the backend — fetching data, an async action, a slice/reducer/selector, or wiring an API response into the store. Business logic lives in the Redux `model/` layer, not in components."
---

# State & data (Redux `model/`)

Components stay dumb — async, business logic, and API calls live in the Redux `model/` layer. Helpers come from **`src/shared/lib/redux`**, the API client from **`src/shared/api`**, slices from **`@reduxjs/toolkit`** (`createSlice`).

## Where state goes
- **URL** — navigation, filters, pagination, search params.
- **Local component state** — pure UI not shared elsewhere (modal open, in-progress form).
- **Redux** — shared app data, server cache, complex cross-component UI state.
- **React Context** — rarely-changing wide data (theme, locale, user).

## Always
- **All async / API in a thunk via `createApiThunk`** — never call `api.*` from a component. Pass `signal` when it should be cancellable:
  ```ts
  import { createApiThunk } from 'src/shared/lib/redux';
  import { api } from 'src/shared/api';
  export const sendLinkFx = createApiThunk('sendLink', (phone: string, { signal }) => api.sendLink(phone, signal));
  ```
- **Loading state via a loader, not hand-rolled flags** — `createLoader()` (status only) or `createDataLoader<T>()` (status + data), wired in the slice `extraReducers` on the thunk lifecycle:
  ```ts
  const loader = createLoader();                       // initialState: loader.initial()
  builder.addCase(fx.pending,   () => loader.begin());
  builder.addCase(fx.fulfilled, (_s, a) => loader.success(a.payload));  // dataLoader carries payload
  builder.addCase(fx.rejected,  () => loader.error());
  ```
- **Type responses from a zod schema** — `const schema = z.object({…}); type T = z.infer<typeof schema>` (schema first, type from it). Use **`Either`** (`left`/`right` from `@sweet-monads/either`) for results; type API errors via an `ErrorResponse` + error adapter.
- **Selectors are typed functions** (in `model/selectors.ts` for a split model) — never an inline `useAppSelector(s => s.x)`.
- **Actions are events, not setters** — `userLoggedIn`, not `setUser`.

## Layout (FSD)
`src/{features,entities}/<name>/model/` → `thunks.ts`, `reducer.ts` (or a `createSlice`), `selectors.ts`, `types.ts`, `index.ts`. A small feature can keep it all in one `model.ts`.

**Canonical examples:** `src/features/attachDocuments/model/` (full split) · `src/features/sendApplicationLink/model.ts` (compact single-file).
