# Frontend Update: per-type frontmatter — the schema for type-specific views

**Commit:** `1f18a9b`
**Date:** August 3, 2026

## Summary

Notes now carry validated, typed frontmatter per category, editable through the
API (this also fixes the bug where `PATCH /api/notes/{title}` couldn't touch
event times at all). This is the data layer for per-type note views.

## The schema

Every note object from search/get/list/graph endpoints now includes a `fields`
dict. Categories are **discrete** — a note has at most one category tag
(server rejects more with 422/tool error):

| category | `fields` keys |
|---|---|
| `event` | `start` (req), `end`, `all_day`, `location`, `people` (list of social-graph note titles) |
| `goal` | `state` (`proposed/started/finished/discarded`), `due` (ISO date) |
| `question` | `state` (`open/answered`) |
| `project` | `state` (`proposed/started/paused/done/abandoned`) |
| `social-graph` | `aliases` (list), `kind` (`person/org`), `relation`, `birthday` (`YYYY-MM-DD` or `MM-DD`) |
| `user-profile` | `area` (which USER.md section a satellite belongs to) |
| `memory`, `decision` | none |

**One shared `state` key** across goal/question/project — render it as one
generic state-chip component; the value set differs per category. Note: a
finished goal keeps its goal tag (`state: finished` IS the record; there's no
tag graduation).

## Editing (bug fix + new)

`PATCH /api/notes/{title}` and `PATCH /api/notes/drafts/{id}` accept `fields`:

```json
{"fields": {"start": "2026-08-11T09:00", "location": ""}}
```

- Omitted keys keep their value; **empty string (or empty list) clears a key**.
- Everything is validated server-side (422 with a human-readable reason):
  state enums per category, ISO dates, IANA timezones, kind enum, category
  exclusivity. Draft cards for events/goals should render `fields`
  prominently — structured values are what review exists to catch.

## USER.md — the profile hub (new concept, worth a dedicated view)

The note titled `USER` is the center of the user profile:

- Own extra fields (this note only): `name`, `dob`, `resides_in`, `timezone`.
- Body has **fixed section headings** (Background, Significant Relationships,
  Work, Interests, Philosophy & Values, Health & Habits, Preferences, Current
  Focus) — scaffolded automatically on reindex if absent. The LLM only ever
  proposes edits within sections.
- Satellite notes tagged `user-profile` carry `area` (= a section, lowercase:
  `work`, `interests`, …) and are wiki-linked from the matching section.
- Queries: `GET /api/notes/search?tag=user-profile` (whole profile),
  `&area=work` (one area). A profile view = USER.md rendered with its
  satellites grouped by section.

## Search additions

- `?area=` on `GET /api/notes/search` (composes with q/tag/dates).
- **Aliases match searches**: "Bob" finds "Robert Chen" in both keyword and
  semantic search (aliases are embedded with the note).
- Event `people` are **graph edges**: a person's backlinks/graph include their
  events — useful for a person view ("events with Sarah").
- `GET /api/events.ics` now emits `LOCATION:`; `list_events`/event objects
  include `location` and `people`.

## Deploy

Parent `./deploy.sh`. Index migration is automatic; run
`POST /api/notes/reindex` once after deploy so existing notes populate their
`fields` (and USER.md gets scaffolded).
