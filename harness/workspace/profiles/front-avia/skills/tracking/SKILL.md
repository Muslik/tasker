---
name: tracking
description: "front-avia analytics/tracking events — how to define and fire them. Use whenever a task adds or changes analytics — a click/view/submit event, a funnel step, or any user action you need to report. Events are typed factory wrappers fired through Redux dispatch — never the raw tracker directly."
---

# Tracking (analytics events)

Events are defined per domain via a factory and fired through Redux `dispatch`. Never call the raw tracker straight from a component — the factory injects the shared state (searchId, directionIndex, …) the tracker needs.

## Define an event
In `src/entities/<domain>/tracking/events/<name>Event.ts`:
```ts
import { searchPageTracking } from 'src/shared/tracking';   // raw tracker
import { createSearchEvent } from '../createSearchEvents';  // the domain factory

// no params — callback gets { searchData, state }
export const priceAlertQuitEvent = createSearchEvent(({ searchData }) =>
  searchPageTracking.priceAlertQuit(searchData),
);

// with params — type them; callback gets { searchData, params, state }
export const searchFilterEvent = createSearchEvent<SearchFilterParams>(
  ({ searchData, params }) => searchPageTracking.serpFilter({ ...searchData, ...params }),
);
```
- **Use the factory of the entity you're in** — there's one per domain (`createSearchEvent`, plus siblings for reservation/booking/orderInfo). Follow the existing one.
- **Raw trackers come from `src/shared/tracking`** — the factory only wraps them with state.
- **Type the params** (`export type …Params = {…}`), never `any`.

## Fire it
The factory returns a thunk, so dispatch it (events are surfaced as `<domain>Tracking`):
```ts
dispatch(searchTracking.searchFilterEvent({ filterType, filterValue }));
```
A direct call (no `dispatch`) loses the Redux state and does nothing useful.

## Naming & layout
- Name `verb + object + Event` — `searchFilterEvent`, `bookFormSubmitEvent`; not `filterChanged` / `submit`.
- One file per event in `tracking/events/`; factory in `tracking/createSearchEvents/`; re-exported up the entity as `export * as <domain>Tracking`.

**Canonical example to copy:** `src/entities/search/tracking/`.
