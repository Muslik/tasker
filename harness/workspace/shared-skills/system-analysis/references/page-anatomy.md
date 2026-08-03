# Anatomy of an SA page

Derived from the pages that already exist on `confluence.twiket.com`:

- `107306371` — [FE] ЖД Убрать завязки на babies (FE-only, mostly mechanical)
- `152510564` — Дет5 к ранее оформленному билету (FE + `<h1>Бекенд</h1>`, contracts-heavy)
- `148421330` — Выбор мест в webview на готовом заказе, order-based (FE, one broken handle)

All three are built on the **Feature Tech Passport** template (`templateId 41713665`) — the
one behind the «Создать страницу Системной Аналитики» buttons — so a new page starts from
`assets/sa-page.template.xml`, which mirrors it.

## Where the page goes

| Project | Space | Parent page | Parent title |
|---|---|---|---|
| Railways (`front-railways`) | `PID` | `60555687` | Railways › Системная аналитика |
| Avia (`front-avia`) | `AVIA` | `39748148` | Flights › Development & QA › Системная Аналитика › Product(Avia) |

Everything before 07.2026 landed under the Avia parent, including the ЖД page — the `PID`
parent is newer and is where Railways SA goes now. Other projects: no established parent,
ask.

Confirm space + parent + title in the step-7 stop message; they are cheap to get wrong and
annoying to fix (moving a page breaks links people already shared).

## Title

- Full-feature SA → the feature, as a human would say it:
  `Выбор мест в webview на готовом заказе (order-based)`.
- Frontend-scoped SA → prefix `[FE] `: `[FE] ЖД Убрать завязки в жд на babies…`.
- No ticket keys in the title. They live in the `Links` panel.

## Page frame (from the template, keep it)

**Header**, two columns:
- `panel Responsible` — table TL / Dev / QA / Статус. Put yourself in **Dev** via
  `<ac:link><ri:user ri:userkey="…"/></ac:link>`; leave TL and QA as `<ac:placeholder>`.
  Статус is a `status-handy` lozenge — `DOCUMENTATION` while the SA is being written.
- `panel Links` — table with `Epic` and `SA` rows, each a `jira` macro. Add `Loop` /
  `Макеты` rows when those exist. **Leave the SA key as a placeholder until the user gives
  it** — an invented key renders as a real link to the wrong issue.

Then a `toc` macro on its own row, then the body in a `single` layout section.

**Footer**: `<hr />` and the `panel Release`, which on a finished feature holds a JQL `jira`
macro listing the implementation tickets. During SA those tickets don't exist yet, so the
template keeps an `<ac:placeholder>` there — a `jira` macro with an unresolvable JQL renders
as an error box, so do not pre-fill it. Once the keys exist, swap the placeholder for:

```xml
<ac:structured-macro ac:name="jira" ac:schema-version="1">
  <ac:parameter ac:name="server">Jira</ac:parameter>
  <ac:parameter ac:name="serverId">1a1267ac-5a85-3eb5-ba08-d62a99477f6d</ac:parameter>
  <ac:parameter ac:name="columnIds">issuekey,summary,issuetype,created,updated,duedate,assignee,reporter,priority,status,resolution</ac:parameter>
  <ac:parameter ac:name="columns">key,summary,type,created,updated,due,assignee,reporter,priority,status,resolution</ac:parameter>
  <ac:parameter ac:name="maximumIssues">20</ac:parameter>
  <ac:parameter ac:name="jqlQuery">project = RR and issueKey in (RR-9060)</ac:parameter>
</ac:structured-macro>
```

## Template markers

`assets/sa-page.template.xml` has exactly one literal to substitute — `__EPIC_KEY__` in the
`Links` panel. Everything else is either frame to keep verbatim or an `<ac:placeholder>` you
replace with content or delete along with its section.

Before publishing, grep the draft for `__` and for `ac:placeholder` and account for every hit:
a placeholder is legitimate only where a human is expected to fill it in (TL, QA, the SA
ticket key, the Release panel). A placeholder left in a body section means you shipped an
empty heading.

## Body sections

Not a fixed list — the epic decides which ones earn a place. These are the ones that recur,
in the order they recur. Skip a section rather than filling it with nothing.

### Проблема (or Цель)
What is broken or wanted, in the user's terms first, then the technical cause in one or two
sentences. Carry over any number that quantifies it (error counts over a window, share of
affected orders). Name the handle / route / component involved — a reader who knows the
system should be able to place the problem after two sentences.

Use `Цель` instead when nothing is broken and this is new capability.

### Требования
Checkable bullets. Each one must be verifiable by someone who didn't write it: "открытие
webview показывает карту мест без вызова `getcheckavailresult`", not "работает корректно".
This is the epic's acceptance criteria, sharpened — plus the constraints you discovered
(what must keep working, what contract must not change).

### Как сейчас
The measured current state (skill step 3). Numbered steps of the existing flow, with the
handles and files named, and **explicitly which step is the broken one**:

> Шаг 2 — единственный сломанный. Шаги 3–4 универсальны и переиспользуются в решении.

Include the control here — the neighbouring case that works and why («Почему на вебе "Мой
заказ" работает»). Screenshots of the current behaviour go in this section.

### Идея решения / Что конкретно делаем
The decision, and the reasoning that makes it inevitable. State what is being reused versus
what is new — reuse is the strongest argument an SA can make.

Record the non-obvious choices **with their reason inline**, because that is the sentence
that survives into code review:

> Роут — отдельный `/webview/seats-order` (через дефис, не `/webview/seats/order`). Дефис
> важен — это отдельный сегмент, он не попадает в слот `:id` роута `/webview/seats/:id`.

### Объём работ
A table, one row per **change a reader can observe** — not per module, file or architectural
layer. Managers and analysts read this page too, and "query parse → state → request builder"
tells them nothing; it is internal vocabulary that names where you will type, not what will
be different.

Key each row by what changes for the user, then say what is required, then where it lives in
code. The code column is for whoever implements it and can be skipped by everyone else:

| Что изменится для пользователя | Что для этого нужно | Где в коде | Характер |
|---|---|---|---|
| Класс перестаёт пропадать с экрана | Не вырезать места для пассажиров с детьми из расчёта | `prepareFreeSeats.ts:169` | сердце задачи |

Open with a one-sentence plain-language summary of the whole change before the table.

This section is what the ticket breakdown is cut from, so a needed change must not be
silently absent. Mark which rows are mechanical and which carry risk — it changes how the
work is reviewed and tested.

Same rule everywhere else on the page: a heading, a bullet or a table key must be readable by
someone who will never open the repo. Identifiers belong inside the explanation, not in place
of it.

### Сценарии
The user-visible cases, one sub-heading each, including the negative and boundary ones
(one-way vs round-trip, the limit, the age boundary, the refund, cancelled tickets). Texts
and modals get their own sub-heading when copy has to be agreed with anyone.

### Контракты и API
Only when a contract is involved. Request/response in a `code` macro (`typescript` for
shapes, `json` for bodies), error mechanics in a table (code → what FE does → what the user
sees). Long bodies inside an `expand`.

### Архитектура и компоненты
Where the code lives and what gets added: files, stores/models, the component tree. Short
`code` blocks for the key signatures only — the page is not the diff.

### Что тестировать
Split it: what needs a human, and what is covered by typecheck / existing autotests / a
code search. The babies page does this well — three manual scenarios with the exact entry
URLs and what to check, then a «Механические проверки» list. Name the Playwright specs that
must be added or updated.

### Открытые вопросы
The point of the whole exercise. One bullet per unknown, each with:
- what exactly is unknown,
- **who** answers it (person, team, or "уточнить с мобилами"),
- whether it blocks implementation or not.

> Уточнить с мобилами: в URL нужен `code` заказа (`accessMode.codes.full`) — есть ли он в
> модели заказа на обеих платформах. Если нет — фронт добавит поддержку `number`.
> *Не блокирует реализацию.*

If a question got answered during the SA, keep it with the answer instead of deleting it —
the next reader will ask it too.

## Writing style

The house style, verifiable against all three pages:

- Dense declarative prose, present tense. No hedging, no "мы могли бы рассмотреть".
- Concrete nouns everywhere: real routes, real handle names, real fields, real file paths.
  Every claim traceable to a measurement, a `file:line`, or a response body.
- Bold only for the one word that carries the sentence. Both header panels and the TOC are
  navigation enough — don't add decorative emoji or divider art.
- Short paragraphs (2–4 sentences) between headings; bullets when the items are parallel;
  a table when there are three or more columns of the same shape.
- Inline `<code>` for identifiers, handles, params, files.
- Nothing over ~15 lines of code and no media outside an `expand`.
- No changelog of your own investigation ("сначала я подумал…"). The page is the conclusion.
