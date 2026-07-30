# Frontend Update: structured note queries (date filters + graph traversal)

**Commit:** `4b4d0d7`
**Date:** July 30, 2026

## Summary

No required frontend work — this is agent-tooling — but two additions you may
want to consume.

## 1. Date filters on note search

`GET /api/notes/search` gains `?created_from=` / `?created_to=` (ISO dates,
inclusive, filtering on the note's vault-approval date). They compose with
`q`, `tag`, and `mode`:

```
GET /api/notes/search?q=transit&created_from=2026-07-27          # this week, mentioning transit
GET /api/notes/search?created_from=2026-07-27&created_to=2026-07-30   # everything from the period
GET /api/notes/search?tag=decision&created_from=2026-07-01       # July's decisions
```

Useful for a "recent notes" view or date-scoped vault browsing whenever you
want it. (Unchanged: `?from=/&to=` still window EVENTS by start time — that's
the calendar query; the two ranges are different axes.)

## 2. Note-graph data (future graph view)

The agent has a new `graph_notes` tool (status label: "Mapping the note
graph…"). Its payload is deliberately shaped for a visual graph view, should
you build one later — there's no REST endpoint for it yet, but ask and it's a
five-line addition:

```json
{"center": "Transit is freedom",
 "nodes": [{"title": "...", "tags": [], "created": "2026-07-12",
            "distance": 1, "preview": "..."},
           {"title": "Ghost idea", "distance": 1, "missing": true}],
 "edges": [{"from": "Inbound note", "to": "Transit is freedom"}],
 "truncated": false}
```

`missing: true` nodes are wikilink targets with no note yet (Obsidian's
unresolved links — potential notes; render dashed/ghosted if you draw them).

## Context

These came from asking Collaborator itself what tooling it lacked (it has
read access to its own repo now) — its request was accurate: search existed,
but "notes from this week mentioning X" and structural queries didn't. We
deliberately did NOT build a query DSL; composable typed filters + bounded
traversal cover the need.

## Deploy

Parent `./deploy.sh`. Prompt-layer files (tools-spec/guidance) apply on the
next turn after restart.
