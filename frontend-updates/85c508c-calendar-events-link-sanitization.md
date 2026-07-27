# Frontend Update: Calendar events (`event` tag) + server-side link sanitization

**Commit:** `85c508c`
**Date:** July 27, 2026

## 1. Event notes — your phase-2 format spec, implemented as requested

Events are ordinary vault notes tagged `event`, with machine-parseable
frontmatter exactly per your spec:

```yaml
---
created: 2026-07-27
tags: [event]
start: 2026-08-02T14:00-05:00   # ISO 8601 with offset; date-only when all_day
end: 2026-08-02T15:00-05:00     # optional
all_day: true                    # only written when true; date-only start implies it
---
```

- People/projects = normal `[[wikilinks]]` in the body (graph edges, no special
  fields). Description = body. **No recurrence** (agreed; repeat = separate notes).
- Offset detail: the model proposes local wall-clock time; the **backend stamps
  the server's local UTC offset at approval** (DST-correct for the event's own
  date). Frontmatter therefore always carries offsets without trusting an LLM
  to know them.
- The model can never author frontmatter: event fields travel as typed tool
  params, validated (strict ISO — fuzzy dates rejected), stored on the draft,
  and serialized by the app at approval. Formalized in NOTES-FORMAT.md
  ("The frontmatter boundary").

### What your UI gets

**Draft cards:** drafts now carry a `fields` object —
`{"start": "...", "end": "...", "all_day": false}` — on event proposals.
**Please render the times prominently on event draft cards**: a wrong date in a
structured field is the thing review exists to catch. `PATCH
/api/notes/drafts/{id}` accepts `fields` so times are editable during review.

**The calendar query you asked to keep trivial — available now, not later:**

```
GET /api/notes/search?tag=event&from=2026-08-01&to=2026-08-31
```

`from`/`to` are inclusive ISO dates; results are event notes (with
`event_start`, `event_end`, `event_all_day` fields) sorted by start, overlap
semantics (a multi-day event spanning the window edge is included).

**ICS export:** `GET /api/events.ics` (optionally `?from=&to=`) — RFC 5545,
all-day and timed (timed emitted in UTC), importable anywhere. Wire it to an
"Export calendar" button whenever convenient.

**Agent side (FYI):** new `list_events` tool — schedule questions ("what are my
obligations this week?") now resolve against event notes; status label:
"Checking your calendar…".

## 2. Link sanitization — done, same contract as yours

`utm_*` plus known click/share ids (`fbclid`, `gclid`, `dclid`, `gbraid`,
`wbraid`, `msclkid`, `yclid`, `twclid`, `igshid`, `si`, `mc_cid`, `mc_eid`,
`_hsenc`, `_hsmi`, `mkt_tok`, and a few more) are now stripped server-side at
every point a URL enters the model's world: fetch/screenshot targets,
web_search result URLs (before they're streamed or persisted in tool records),
and hyperlinks harvested from fetched pages. Functional params are never
touched. If you extend your frontend list, tell us and we'll mirror.

## 3. Notes-to-self

Acknowledged — parked by agreement until current work lands. We'll spec it
together; your instinct to keep scratch capture OUTSIDE the vault/graph matches
how we'd build it.

## Deploy

`git pull && ./restart.sh`. DB migrations (draft `fields` column, index event
columns) run automatically; existing notes are untouched. Existing event-less
vaults behave identically.
