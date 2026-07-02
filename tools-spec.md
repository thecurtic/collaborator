# Collaborator tool descriptions

This file is the editable source of truth for the **tool descriptions the model
sees** — i.e. the `description` field of each function/tool passed to the LLM. Edit
the text under each `## tool_name` heading to change how the model understands and
decides to use a tool. It is read fresh each turn (no restart needed). Any tool not
listed here falls back to a built-in default.

(This is separate from `tools-guidance.md`, which is the higher-level "when to reach
for tools at all" instruction appended to the system prompt.)

## recall_semantic
Search the user's past conversation turns by meaning (semantic / embedding similarity).
Use this when the user refers to earlier discussion, ideas, or decisions and you don't
know the exact wording — it finds related content even when the words differ. Returns
matching turns with their text, tags, and branch id.

## recall_keyword
Search the user's past conversation turns by exact keywords or terms. Use this for
names, specific identifiers, quoted phrases, or when a semantic search might miss a
literal match. Returns matching turns with their text, tags, and branch id.

## synthesize
Combine retrieved snippets into a concise, first-person memory block. Call this after a
recall/search tool when you want to present the user with a clean summary of what was
found. The result is shown to the user and saved with the turn as its recall block.
Argument `kind` selects the synthesis style (e.g. "memory"); `items` is the list of
snippets to synthesize.
