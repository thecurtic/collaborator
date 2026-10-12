# Atomic Note Format Specification

Defines the on-disk format of atomic notes — standalone, linkable knowledge units
distilled from conversation trees. This spec covers the **output** side of the notes
pipeline (what a note file looks like); the synthesis process that produces drafts is
specified separately (`synthesis-notes.md` prompt, later).

**Status:** v1, agreed 2026-07-06.

---

## Principles (from the intent spec)

1. **Synthesis, not transcription** — a note captures an idea, not a dialogue.
2. **Curated output only** — LLM output is always a *draft*; nothing enters the vault
   (or any graph) without explicit user approval.
3. **Open format** — plain Markdown + YAML frontmatter. Readable by Obsidian and any
   markdown tool. No proprietary encoding.
4. **Two-layer graph** — `[[wikilinks]]` are *local* edges (resolve within the vault,
   may point at notes that don't exist yet). Tags are the vocabulary that will later
   drive *social* edges — but any Nostr-facing representation is constructed at
   event-signing time, never stored in the file (see Nostr section).

---

## File identity

- **One file = one atomic idea.**
- **Filename = the note title, verbatim** (plus `.md`). This is what `[[wikilinks]]`
  resolve against, Obsidian-native, with no mapping layer.
  - Titles must avoid characters that break filesystems or Obsidian links:
    `/ \ : * ? " < > | # ^ [ ]`. The app enforces this at approval.
  - **Titles must be unique** within the vault. On collision, the user adjusts the
    title during approval (approval is interactive anyway).
  - Renames must rewrite inbound `[[links]]` (Obsidian does this natively; our
    backend must do the same when it manages renames).

### Title style

The title is a **declarative claim or an honest question**, never a topic label —
and it must be **short**. Titles are wikilink handles in an atomic wiki: a title
that doesn't read well inline as `…because [[Title]], I think…` is too long.
**Titles are 3–7 words.** Compress by cutting hedges and
qualifiers ("I think", "in most cases", "probably") and pushing every detail,
condition, and caveat into the body — the title carries the claim, the body carries
the argument.

- ✅ `SQLite fits local persistence`
- ✅ `Transit is freedom`
- ✅ `Is Postgres's JSON support worth the ops cost?` (questions get a little more room)
- ❌ `Database notes`, `Thoughts on SQLite` (topic labels, not claims)
- ❌ `SQLite is a good fit for single-user local-first persistence in this project`
  (a claim, but a sentence — trim to the handle, argue in the body)

Claims (and genuinely held questions) are what make notes atomic, linkable, and
arguable. Definitions are claims too ("A context boundary marks a memory reset") —
no noun-phrase titles. The note's *kind* (decision, open-question, concept…) is
carried by tags, not by the title shape or a `type` field.

---

## File anatomy

```markdown
---
created: 2026-07-06
tags: [databases, architecture, decision]
source_turns: [42, 47]
---

# SQLite fits single-user local persistence

For a single-user, self-hosted app, SQLite beats a client-server database:
zero ops, one portable file, and transactional safety matter more than
concurrent-write throughput you'll never use. The open tradeoff is JSON
querying, where [[Postgres JSON support]] remains stronger.
```

### Frontmatter (YAML) — app-managed, never LLM-emitted

Written by the app at **approval time** (the curation hook). The LLM never produces
frontmatter. v1 keys:

| key | type | meaning |
|---|---|---|
| `created` | date | when the note was approved into the vault |
| `tags` | list of strings | local vocabulary; lowercase, hyphenated (`open-question`) |
| `source_turns` | list of ints | provenance — the turn ids this note was distilled from |

- Tags in frontmatter are **local-only** semantics for now. The LLM *proposes* tags in
  its draft; the user curates them at approval; the app writes the survivors here.
- `source_turns` enables jump-to-source and the future note↔turn recall bridge. It
  may go stale if source conversations are deleted — dangling ids are harmless.
- Unknown/extra keys must be preserved by all tooling (forward compatibility).

### Types and tags (agreed 2026-10-12; supersedes the 2026-07-27 category table and the 2026-08-03 per-type fields)

Everything is **just tags on notes**, no other primitive. A tag earns a **type**
only when its entries carry fields of their own, and type and frontmatter come
together or not at all. Three tags qualify:

| type tag | holds | fields (all optional unless noted) |
|---|---|---|
| `event` | calendar events: appointments, meetings, deadlines | `start` (required), `end`, `all_day`, `location` (free text), `people` (list of social-graph note titles — indexed as GRAPH EDGES, same as body wikilinks), `repeat` (recurrence rule), `exceptions` (per-occurrence overrides; see Recurrence). Exportable via `GET /api/events.ics` |
| `social-graph` | one note per person/entity in the user's network; title = their name (a graph node; renames rewrite wikilinks) | `aliases` (list — other names, matched in search), `kind`: person / org, `relation` (free text), `birthday` (YYYY-MM-DD, or MM-DD when year unknown) |
| `user-profile` | facts about the user; the full profile is the totality of notes with this tag | `area` — which USER.md section a satellite note belongs to (lowercase-hyphenated) |

**Type tags are exclusive**: a note carries at most one (validation rejects
more; a thing that is an event and a person is two notes). No other note has
any fields, and no note has a manual `state`.

Every other tag is ordinary and combines with anything, type tags included.
`goal`, `decision`, `question` and `memory` were categories with their own
frontmatter until 2026-10-12; they are now plain tags with no type, no fields
and no state. A deadline or an outcome is written in the body.

Empty-string on edit clears a field.

#### Project membership

A note belongs to a project when it carries `project` plus one other tag, taken
as the project's **name**: `[project, garden]`, or on an event,
`[event, project, garden]`. `project` is not a type, so events and people can
belong to projects. Membership is single: a note carries exactly one name,
and a name never appears beside another name. That exclusivity is how the app
tells names apart from kind tags like `bug` or `feature`, which turn up beside
many names. Projects have no fields and no frontmatter of their own; there is
no repository field.

#### What changed on 2026-10-12, and the migration

- `project` left the exclusive set; `goal`, `question`, `decision` and
  `memory` left the type set altogether.
- The `state` key (goal / question / project) and goal's `due` are gone.
  Validation rejects them on every note, and the index no longer reads them.
- Existing frontmatter is **removed, not hidden**: existing vaults are
  migrated by stripping top-level `state` and `due` from every note, leaving
  the tags, every other key and the body untouched.

Every note of every type passes through the drafts review queue — the agent
proposes, the user approves. The agent can never silently update its model of the
user or anyone else. All values flow model→typed tool params→
validation→review→app-written YAML, per the frontmatter boundary below.

### USER.md — the profile hub

The note titled `USER` (file `USER.md`, tag `user-profile`) is the center of
the user profile. Its OWN extra frontmatter (this note only): `name`, `dob`,
`resides_in`, `timezone` (IANA zone, validated).

Its body carries FIXED section headings (scaffolded by the app when absent —
structure only; content still always arrives via review): Background,
Significant Relationships, Work, Interests, Philosophy & Values, Health &
Habits, Preferences, Current Focus. The sections are guardrails: the LLM
proposes edits *within* them, never new structure. Each section is a branch
point — satellite `user-profile` notes (frontmatter `area`) hang off it via
[[wikilinks]], giving retrieval a spine to crawl: USER.md → section → area
notes. "The full profile" = USER.md + all notes tagged `user-profile`.

### The frontmatter boundary (agreed 2026-07-27)

The precise rule behind "frontmatter is app-managed":

1. The model **never authors frontmatter** — no YAML ever comes from an LLM. It
   proposes structure exclusively through **typed tool parameters** (JSON), which
   are validated, stored on the draft, reviewed by the user, and serialized to
   YAML by the app at approval.
2. **App-authoritative keys** (`created`, `source_turns`) record system actions;
   they are never delegated to the model.
3. **Content-derived keys** (tags; the type fields: event `start`/`end`/
   `all_day`/…, person `aliases`/…, profile `area`) carry facts from the conversation the model legitimately knows.
   These follow the propose → review → app-writes pipeline.
4. The whitelist of content-derived keys grows only deliberately — every new key
   is a design decision, made here.

### Event notes (`event` tag)

Frontmatter keys (whitelisted, machine-parseable from day one):

| key | format | notes |
|---|---|---|
| `start` | ISO 8601 — `2026-08-02T14:00-05:00`; date-only `2026-08-02` when all-day | required for events. The model proposes local wall-clock time; the app stamps the timezone offset at approval (DST-correct for the event's date) |
| `end` | same format as `start` | optional |
| `all_day` | boolean | written only when true; a date-only `start` implies it |

- People are referenced in `people` or as normal `[[wikilinks]]` in the body —
  the graph edges are the connections. An event joins a project by its tags
  (`project` + the name), like any note.
- Description = the body, like any note.
- Export: `GET /api/events.ics` (standard iCalendar; all-day and timed both;
  recurring events as one VEVENT with RRULE and EXDATE);
  date-window queries via `GET /api/notes/search?tag=event&from=&to=` and the
  agent's `list_events` tool. Both return **expanded occurrences**, so a
  caller never computes a calendar itself.

### Recurrence (agreed 2026-10-06; supersedes the v1 "separate notes" rule)

A repeating event is **one note** carrying a rule. Occurrences are always
derived, never stored: the expander takes the rule, the exceptions and a date
window and does arithmetic, with no model involved. One file is the truth, the
horizon is infinite, "change all of them" is one edit, and ICS import/export
maps straight onto RRULE and EXDATE.

| key | format | notes |
|---|---|---|
| `repeat` | object: `freq` (daily / weekly / monthly / yearly), `interval` (int, default 1), `by_day` (list of MO…SU, weekly only), `by_month_day` (int, monthly only), `until` (ISO date) or `count` (int) | the rule; `start`/`end` on the note are the first occurrence and set the time of day and duration |
| `exceptions` | list of objects, each keyed by the occurrence's original `date` (ISO date): either `cancelled: true`, or a replacement `start`/`end`, or `note: <title>` pointing at a one-off event note that replaces the occurrence | per-occurrence overrides |

Rules:

- **Exceptions are kept forever, never pruned.** A cancelled occurrence
  pruned after the fact would reappear in that week as having happened; the
  calendar must stay truthful looking back.
- **An occurrence never grows its own fields in the rule note.** When one
  occurrence needs a body (notes from that meeting, different people), it
  becomes an ordinary one-off `event` note for that date, links back to the
  series with a `[[wikilink]]`, and an exception with `note:` points the
  occurrence at it. The expander emits the one-off in place of the derived
  occurrence.
- Editing a note with a rule asks "this one or all of them" (UI and typed
  tool params alike). "This one" writes an exception; "all of them" rewrites
  the rule. Editing a one-off never asks.
- Frontmatter boundary unchanged: the model proposes `repeat` and `exceptions`
  through typed tool parameters, validated and reviewed, and the app writes
  the YAML. The whitelist of content-derived keys grows by exactly these two.
- The index invariant unchanged: nothing about occurrences is stored
  index-only. Dropping the index and re-expanding from the files yields the
  same calendar.

### Body

- First line: `# <Title>` — identical to the filename (minus `.md`).
- Then distilled prose. Requirements:
  - **Written in the user's first-person voice.** The note reads as the user's own
    thought, not an assistant's summary of a conversation.
  - **Self-contained**: understandable with zero conversation context.
  - **No dialogue form, no speaker tags** — never "the user said / the assistant
    replied". **Direct quotes are allowed sparingly**, and only of the *user's own
    words*, when the original phrasing is itself the value. Assistant phrasing is
    absorbed into the prose, never quoted as a speaker.
  - **No confidence scores, internal ids, or technical metadata** of any kind.
  - `[[Wikilinks]]` inline where natural. Links to **not-yet-existing notes are
    valid** (Obsidian's unresolved links = potential notes). `[[Title|alias]]` allowed.
  - One idea. Typically 50–200 words; if it wants to be longer, it's probably two notes.

---

## What the LLM emits (draft contract)

The synthesis stage produces **drafts**, one per atomic idea, containing only:

1. the title (declarative claim),
2. the body (per the rules above),
3. proposed tags and any proposed links to existing/potential notes — carried in the
   draft envelope for the user to curate, **not** as frontmatter.

The LLM must never: write files, emit frontmatter, emit ids/confidence/metadata, or
publish anywhere. The app renders drafts for review; on approval it writes the file
(title-named) with app-generated frontmatter into the vault.

**Draft storage:** drafts live in the per-user SQLite DB (`note_drafts` table), never
in the vault — Obsidian indexes everything it sees, so unapproved content on disk
would leak into search/graph/links and defeat the approval gate. The vault contains
approved notes only.

### Synthesis weighting (agreed principles; full process spec comes with the prompt)

- **What counts as an idea** — anything passing three gates: *standalone*
  (understandable without the conversation), *assertable* (phrasable as a claim the
  user would endorse, or a question they actually hold), *reusable* (could matter
  outside the conversation that produced it).
- **User turns weigh far heavier than assistant turns.** Assistant contributions
  become note-worthy only when the user ratified them in conversation — endorsement
  transfers ownership, and the note then speaks the idea in the user's voice.
- Tree structure marks idea-dense spots: branch points (`paragraph_index` points at
  the paragraph that spawned a thought), sibling branches (comparison ideas), leaves
  of exhausted branches (resolutions or open questions), names/tags/context-resets
  (explicit user-attention signals).
- **Granularity:** fewer, stronger notes — review attention is the scarce resource.
  Drafts in one batch dedupe against each other (later: against the vault, proposing
  links instead of duplicates).

---

## Nostr (deferred — design constraints only)

Nostr export (kind 1) is a **future** feature. Nothing is built now, but the format
must not block it. Rules the future integration must honor:

- The event is **constructed at signing time**, from the note file. Nothing
  Nostr-specific is ever stored in the note.
- **All frontmatter is stripped completely** before signing — `source_turns`, `tags`,
  everything. No app metadata may leak into a public event.
- Event `t` tags (and any tags referencing *other people's* notes on the social
  knowledge graph) are computed at event-creation time — that mapping, and the whole
  public identity model, is deliberately unresolved until the integration is built.
- How `[[wikilinks]]` degrade in public plain text (leave as-is, rewrite, or drop) is
  decided then.

---

## Non-goals (v1)

- No `type` or `status` key: a type is derived from its tag, and no note has
  a manual status.
- No note ids separate from the title/filename.
- No Nostr fields, keys, or signatures in files.
- No LLM-written frontmatter, ever.

## Index (derived, rebuildable — the Nostr-foresight invariant)

The backend keeps a SQLite index over the vault (`notes_index`, per user) for
search, backlinks, and future recall/dedupe. Binding rule:

> **Everything graph-relevant — titles, `[[wikilink]]` edges, tags — is derived from
> note content/frontmatter alone and never stored index-only.** Dropping the index
> and rebuilding from the files must always yield the identical graph.

This is enforced by test, and it is exactly the property that keeps a future Nostr
export reconstructable: a converter emits each note as a kind-1 event (content =
`# Title` + body with its wikilinks intact; frontmatter tags → event `t` tags;
`created_at` from the event envelope; `source_turns` stripped as private), and anyone
pulling those events from relays can rebuild the full graph by parsing first-lines,
wikilinks, and event tags — no index required.

## Related

- Input side: `GET /api/tree/{id}/export` / `backend/export_tree.py` (turns → JSON).
- Synthesis: `synthesis-notes.md` + `POST /api/notes/synthesize/{tree_id}`.
- Index: `backend/notes_index.py` + `/api/notes` endpoints.
- Intent: `INTENTS.md`.
