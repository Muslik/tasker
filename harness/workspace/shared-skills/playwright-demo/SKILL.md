---
name: playwright-demo
description: Record a polished screen-capture demo video of a web UI change with Playwright — injected fake cursor, on-screen captions, deterministic waits, and ffmpeg render. Use when the task changes visible UI and the PR benefits from visual proof, when asked to "record/create a demo video", or to show a bug reproduction / fix working visually.
---

# Playwright Demo Recorder

Produce a clean, watchable demo video of a web feature: open the app on the
relevant page, drive the UI with a **visible fake cursor** and **top-center
captions**, and render an MP4. This skill encodes hard-won lessons so the first
take is usable instead of janky.

## When to use
- The change affects visible UI — attach visual proof to the PR
- A bug task: record the reproduction (before) and/or the fix working (after) —
  driven by `investigate-bug` / `fix-bug`
- Explicitly asked for a demo / walkthrough / screencast / gif / mp4
- You just need to DRIVE the app and read something out of it (a computed style, a
  stored value, a response) — same template, `DEMO_DEBUG=1`, no rendering step.
  Printing `KEY=value` to stdout beats describing what you saw

## Prerequisites (check first)
- **The app runbook**: `.ai/app-runbook.md` — how to start THIS
  project's dev server, its ready signal, base URL, login flow, and deep-link
  routes. **Read it first; do not guess or reverse-engineer the app setup.**
  If there is no runbook and the start command isn't obvious from package.json,
  say so in your output instead of burning time guessing.
- Credentials come ONLY from env (names listed in the runbook). Never hardcode
  secrets in files.
- `node` available. Playwright + a Chromium build + ffmpeg:
  `npx playwright --version` works even if not in `node_modules`;
  Chromium/ffmpeg live under `~/.cache/ms-playwright` (Linux) or
  `~/Library/Caches/ms-playwright` (macOS). If missing: `npx playwright install chromium`.
- System `ffmpeg` for the webm→mp4 render (Playwright bundles its own ffmpeg
  only for capture).

## Workflow
1. **Decide the start page and choreography first.** For small features, START
   ON THE FEATURE PAGE — do NOT record the login. Pick 3-6 concrete actions that
   tell the story (load → action → *show result* → next).
   **Reaching a deep page:** prefer a direct route/deep-link from the runbook's
   route map. Walk through intermediate steps ONLY when they build state the
   target page needs (e.g. a bug reproducible only after steps 1→2→3 — then the
   steps ARE the story: record them, with a caption per step). Task-specific
   steps come from the brief's "Как воспроизвести" section, not from guessing.
2. Start the dev server per the runbook (background it, wait for the ready
   signal — a URL responding beats a fixed sleep). Reuse it if already running.
3. Copy `assets/demo.template.js` (next to this SKILL.md) into `.demo/<feature>/demo.js`
   in the repo — `.demo/` is a scratch dir: keep it out of the commit and the PR
   (add `/.demo/` to `.git/info/exclude` if needed).
4. Fill in the config block (BASE url, login selectors from the runbook, creds
   via env) and the `// ===== CHOREOGRAPHY =====` block with your steps + captions.
5. Run with `DEMO_DEBUG=1` first: `DEMO_DEBUG=1 node .demo/<feature>/demo.js`.
   The debug run prints per-phase timing and saves screenshots so you can verify
   selectors, cursor, and captions WITHOUT re-watching the video.
6. Inspect the timing log. **If total ≫ sum of your sleeps, a wait is hanging**
   (see Gotcha 4). Fix before rendering.
7. Render the webm → mp4 with `assets/render.sh` (or the ffmpeg line below).
8. Verify by extracting a couple of frames (`ffmpeg -ss <t> -i out.mp4 -frames:v 1 f.png`)
   and viewing them — don't claim it looks right without checking pixels.
9. **Report the artifact**: state the final mp4 path (`.demo/<feature>/out.mp4`)
   in your final summary so it can be referenced from the PR description.

## The reusable infrastructure (in the template)
- **Fake cursor**: Playwright does NOT render the OS cursor into the video, so we
  inject one via `context.addInitScript` — a deep-blue SVG arrow that follows
  `mousemove`, plus a click ripple on `mousedown`. Re-injected on every navigation.
- **Captions**: a fixed center banner; call `caption('text')` from the script. Large
  (30px), legible at video scale. Sits top by default; flips to bottom when the
  address bar is on (they'd otherwise overlap).
- **Address bar** (opt-in `DEMO_URL_BAR=1`): a synthetic top bar showing the current
  URL — Playwright captures only the viewport, the real browser chrome is unavailable.
  Use it for routing, deep-link, query-param, and redirect demos, so the query being
  tested is visible on screen. Auto-updates on every navigation.
- **Glide helpers**: `glideTo(x,y)` / `glideToLocator(loc)` move the real mouse in
  steps (so the fake cursor animates) then click. Drive the mouse, not `.click()`,
  so motion is visible.
- **`payloadPanel(title, data)`** — puts the backend response on screen (dark JSON
  panel, truncated to N lines); `hidePayloadPanel()` removes it.
- **`magnify([{selector, label, strip}], {tokens})`** — side-by-side blow-up of small
  elements (icon colour, 1px border) that a 1440px frame swallows. `strip` removes
  noise from the clone (a price badge covering the thing being compared); `tokens`
  lists CSS custom properties to carry over — see the gotcha below.
- **Login isolation**: log in inside a throwaway, NON-recorded context, snapshot
  `storageState`, then create the recorded context with that state and `goto` the
  feature page. The video starts on the page, not the login form.

## What MUST be on screen (evidence rules)

A demo is evidence, not decoration. The thing being claimed has to be visible in frame:

- **The bug is about data from the backend** → the response MUST be on screen
  (`payloadPanel('GET /…/getSeatMap', body)`). A rendered result alone does not show
  which payload produced it, so it proves nothing about the API contract.
- **Anything touches the URL** — a redirect, a query param being read, a deep link,
  a route guard → run with `DEMO_URL_BAR=1` so the address bar is in frame. Playwright
  records only the viewport; without the synthetic bar the URL is invisible and the
  claim is unverifiable.
- **The difference is small** (icon colour, 1-2px, a shade) → `magnify(...)`. Do not
  ask the viewer to squint at a 24px element in a 1440px frame.
- **State that a human would check in devtools** (a computed style, a stored value) →
  print it via `payloadPanel`, don't narrate it in a caption. Captions claim; panels show.

## Gotchas (these WILL bite you — they're baked into the template)
1. **Start on the page, not login.** Use the storageState trick above.
2. **Inject the cursor** — the real one is invisible in recordings.
3. **Drive the mouse with `page.mouse.move(x,y,{steps})`** before clicking, or the
   cursor teleports and the video looks robotic.
4. **NEVER rely on Playwright's default 30s action timeout.** `boundingBox()`,
   `scrollIntoViewIfNeeded()`, `waitForSelector`, etc. wait up to 30s on a flaky/
   detached element — a couple of these silently add 60-80s of dead video. Always
   pass a short explicit `{ timeout: 2000-4000 }` and `.catch()` to fall back fast.
5. **Prefer deterministic state waits over fixed sleeps for correctness.** Wait for
   a DOM condition that proves the action landed (e.g. a result count changing),
   capped at a few seconds. `page.waitForResponse(predicate)` is great BUT if the
   predicate never matches it burns the FULL timeout — make the predicate loose
   (e.g. any POST to the API) or use a DOM-condition wait instead.
6. **Pause ON results.** Hold ~3s right after an operation's result renders so the
   viewer can read it; keep transitions snappy elsewhere. Dead time mid-video reads
   as "broken".
7. **Render settings that play everywhere**: `-pix_fmt yuv420p -movflags +faststart`,
   `scale=<W>:-2`, constant `fps=30`. Playwright's webm is variable-framerate, so
   ffmpeg time-seeks on the raw webm are inaccurate — convert to CFR mp4 first, then
   sample frames.
8. **Async-filled fields: wait for the STABILIZED/expected value, not the first
   non-empty one.** A field filled asynchronously passes through a transient state
   (cache / history / skeleton). Use `waitForFunction(() => el.value === EXPECTED)` or
   "two identical reads in a row", not "first non-empty" — otherwise you capture the
   transient. And **isolate state between scenes**: clear `localStorage` / use a fresh
   context, or one step bleeds into the next (e.g. a prior search's history preloads
   the next scene).
9. **Verify the INPUT yields a happy-path OUTPUT before recording.** A "show the
   results" demo fed inputs that return nothing ("no results found") looks broken.
   Check the chosen input against the live backend once, up front.
10. **CSS custom properties do not survive re-parenting.** A cloned node moved to
    `<body>` (the magnifier) leaves the scope where the design tokens are declared —
    it renders colourless, and you will not notice on a small frame. Pass the token
    names via `magnify(..., {tokens: ['--color-green-600', …]})`; the helper copies
    their computed values onto the panel.
11. **Captions are phase-dependent, the choreography is not.** Drive them from a
    `PHASE=before|after` env var (`const VERDICT = PHASE === 'after' ? [...] : [...]`)
    so the SAME script records the repro and the fix confirmation. Two hand-edited
    copies drift apart and you end up shipping an "after" video captioned "expected".

## Render (webm → mp4)
```
ffmpeg -y -i page@*.webm -vf "scale=1440:-2,fps=30" -c:v libx264 -pix_fmt yuv420p -movflags +faststart out.mp4
```

## Cleanup
Everything lives in `.demo/<feature>/` (never committed). Keep `demo.js`
(reusable) + the final mp4; delete the raw `page@*.webm`, `dbg-*.png`, and any
stray state dirs when done.
