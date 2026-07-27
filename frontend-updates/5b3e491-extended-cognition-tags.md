# Frontend Update: Extended-cognition category tags (phase 1)

**Commit:** `5b3e491`
**Date:** July 27, 2026

## Summary

The agent now acts as the user's extended cognition using existing primitives:
tagged atomic notes + the drafts review queue. No new endpoints, no breaking
changes — but two things you'll want to surface.

## 1. Category tags will start appearing on drafts

The model is instructed to propose notes tagged with a reserved vocabulary when
it spots trigger patterns in conversation:

| tag | proposed when |
|---|---|
| `user-profile` | a lasting fact/perception about the user |
| `social-graph` | a person/entity is mentioned (note title = their name) |
| `memory` | the agent deems something salient worth remembering |
| `goal` | "I want to X" / "I should Y" / "I'll Z by Friday" |
| `decision` | "I'm going with X because Y" (the reasoning is the point) |
| `question` | expressed uncertainty, open threads |
| `project` | grouping container (membership = wikilinks) |

Everything still flows through the existing drafts inbox — same shapes, same
approve/reject endpoints. Suggested UI: show the category tag as a badge on
draft cards, and consider grouping the inbox by tag as volume grows.

## 2. Tag-scoped note search

`GET /api/notes/search` gained `?tag=` (and `q` is now optional):

```
GET /api/notes/search?tag=user-profile          → the user's full profile
GET /api/notes/search?tag=social-graph          → everyone in their network
GET /api/notes/search?q=deploys&tag=decision    → scoped search
```

Tag with empty `q` lists the whole category (keyword mode, alphabetical). The
model has the same power via its `search_notes` tool, so expect tool-activity
entries with tag filters.

Good UI hooks when you want them: a "Profile" view (`?tag=user-profile`), a
"People" view (`?tag=social-graph`), an open-questions list (`?tag=question`).

## Coming later (heads-up, not yet built)

Phase 2 adds goal lifecycle state (`proposed/started/finished/discarded`) in
note frontmatter and person-note field conventions; phase 3 adds a post-turn
salience sweeper and per-tag approval policies. Wire format notes will follow
each.

## Deploy

`git pull && ./restart.sh` — prompt/spec files are read fresh per turn; only
the backend restart is needed for the search changes.
