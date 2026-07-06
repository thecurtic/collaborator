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

The title is a **declarative claim or an honest question**, never a topic label:

- ✅ `SQLite fits single-user local persistence`
- ✅ `Is Postgres's JSON support worth the ops cost?`
- ❌ `Database notes`, `Thoughts on SQLite`

Claims (and genuinely held questions) are what make notes atomic, linkable, and
arguable. Definitions are claims too ("A context boundary marks where conversation
memory resets") — no noun-phrase titles. The note's *kind* (decision, open-question,
concept…) is carried by tags, not by the title shape or a `type` field.

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

- No `type`, `status`, or other forced structure per the intent spec.
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
