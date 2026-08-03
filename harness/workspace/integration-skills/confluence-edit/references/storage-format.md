# Confluence storage format — what renders on this instance

Copy-paste these. Everything below was taken from live pages on `confluence.twiket.com`,
so the macro names, parameter names and the Jira `serverId` are the real ones.

`ac:macro-id` may be omitted when creating content — Confluence generates one. Keep it when
you are editing an existing body, so diffs stay small.

## Text basics

Storage format is XHTML: `<p>`, `<ul>/<ol>/<li>`, `<strong>`, `<em>`, `<code>`, `<hr />`,
`<h1>`–`<h6>`, `<br />`. Every tag must be closed and every `&` escaped as `&amp;`.

Headings are the page's skeleton — the `toc` macro is built from them, so don't fake a
heading with bold text.

Tables:
```xml
<table class="wrapped"><tbody>
  <tr><th>Слой</th><th>Что меняем</th></tr>
  <tr><td>query parse</td><td>нормализуем <code>babies</code> в <code>infants</code></td></tr>
</tbody></table>
```

## Code

```xml
<ac:structured-macro ac:name="code" ac:schema-version="1">
  <ac:parameter ac:name="language">typescript</ac:parameter>
  <ac:parameter ac:name="title">seatFilter.ts</ac:parameter>
  <ac:plain-text-body><![CDATA[const x = a && b < c;]]></ac:plain-text-body>
</ac:structured-macro>
```
`CDATA` is what lets code contain `<`, `>` and `&` untouched. Languages seen in use:
`typescript`, `js`, `text`, `json`, `bash`, `diff`.
The code body must not itself contain `]]>`.

## Expand — collapse anything long

```xml
<ac:structured-macro ac:name="expand" ac:schema-version="1">
  <ac:parameter ac:name="title">Полный ответ getRequests</ac:parameter>
  <ac:rich-text-body>
    <ac:structured-macro ac:name="code" ac:schema-version="1">
      <ac:parameter ac:name="language">json</ac:parameter>
      <ac:plain-text-body><![CDATA[{ "…": 1 }]]></ac:plain-text-body>
    </ac:structured-macro>
  </ac:rich-text-body>
</ac:structured-macro>
```
`rich-text-body` accepts anything, including images, tables and other macros.

## Images and video

Upload the file first (`--attach`), then reference it by filename:
```xml
<ac:image ac:align="center" ac:width="900">
  <ri:attachment ri:filename="seats-empty-before.png" />
</ac:image>
```
Caption it by putting an `<p><em>…</em></p>` right after, or use `ac:alt="…"`.

Video (mp4 from `playwright-demo`):
```xml
<ac:structured-macro ac:name="multimedia" ac:schema-version="1">
  <ac:parameter ac:name="name"><ri:attachment ri:filename="demo.mp4" /></ac:parameter>
  <ac:parameter ac:name="width">800</ac:parameter>
</ac:structured-macro>
```

External image (no upload needed):
```xml
<ac:image ac:width="800"><ri:url ri:value="https://example.com/a.png" /></ac:image>
```

## Callouts

```xml
<ac:structured-macro ac:name="info" ac:schema-version="1">
  <ac:parameter ac:name="title">Решено с продуктом</ac:parameter>
  <ac:rich-text-body><p>…</p></ac:rich-text-body>
</ac:structured-macro>
```
Same shape for `note`, `warning`, `tip`, and `panel` (`panel` also takes
`ac:parameter ac:name="bgColor"`).

## Table of contents

```xml
<p><ac:structured-macro ac:name="toc" ac:schema-version="1" /></p>
```

## Jira macros

`serverId` on this instance is `1a1267ac-5a85-3eb5-ba08-d62a99477f6d` — a wrong or missing
one renders as "unknown server".

Single issue:
```xml
<ac:structured-macro ac:name="jira" ac:schema-version="1">
  <ac:parameter ac:name="server">Jira</ac:parameter>
  <ac:parameter ac:name="serverId">1a1267ac-5a85-3eb5-ba08-d62a99477f6d</ac:parameter>
  <ac:parameter ac:name="key">RR-7969</ac:parameter>
</ac:structured-macro>
```

Issue table by JQL (used in the `Release` panel):
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

## Links, users, placeholders

```xml
<a href="https://onetwotrip.loop.ru/…">обсуждение в Loop</a>
<ac:link><ri:page ri:content-title="Дет5" /><ac:plain-text-link-body><![CDATA[СА по Дет5]]></ac:plain-text-link-body></ac:link>
<ac:link><ri:user ri:userkey="8a7f808a7acdabdf017acdd13a300058" /></ac:link>
<ac:placeholder>Тимлид</ac:placeholder>
```
`ac:placeholder` renders as grey prompt text and disappears on print — use it for fields
you deliberately leave for a human (TL, QA), never as a stand-in for content you owed.

## Status lozenge

```xml
<ac:structured-macro ac:name="status-handy" ac:schema-version="1">
  <ac:parameter ac:name="Status">DOCUMENTATION</ac:parameter>
  <ac:parameter ac:name="id">450</ac:parameter>
</ac:structured-macro>
```
Third-party macro; `Status` values come from its own configured set (`DOCUMENTATION` is what
in-progress SA pages use). Copy the value from a comparable page instead of inventing one.

## Two-column layout (the header of every SA / tech-passport page)

```xml
<ac:layout>
  <ac:layout-section ac:type="two_equal">
    <ac:layout-cell>…left panel…</ac:layout-cell>
    <ac:layout-cell>…right panel…</ac:layout-cell>
  </ac:layout-section>
  <ac:layout-section ac:type="single">
    <ac:layout-cell>…body…</ac:layout-cell>
  </ac:layout-section>
</ac:layout>
```
A page either uses `<ac:layout>` for its whole body or not at all — you cannot put layout
sections inside ordinary content. If the page you are editing starts with `<ac:layout>`,
your new content goes inside a `<ac:layout-cell>`.

## Failure modes

- A malformed macro does **not** fail the API call. It renders as a red error box on the
  page. Re-read the body after publishing.
- Unescaped `&` or an unclosed tag → HTTP 400 with `Error parsing xhtml` in the body.
- `<ac:image>` naming a file that was never attached → broken image icon.
- Nested `CDATA` (`]]>` inside code) silently truncates the block.
