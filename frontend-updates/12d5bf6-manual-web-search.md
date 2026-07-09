# Manual web search endpoint for the search screen (12d5bf6)

The backend now exposes user-driven web search — you can build the search screen
against a real API instead of routing through the chat/agent.

## Endpoint

```
GET /api/search?q=<query>&limit=<1-20>
X-Passkey: <passkey>
```

```json
200 {
  "query": "collaborator chat",
  "results": [
    {"title": "…", "url": "https://…", "snippet": "…", "engine": "mojeek"}
  ],
  "answers":   ["direct answer text"],                  // sometimes present
  "infoboxes": [{"title": "…", "content": "…"}]         // sometimes present
}
```

- `q` — required. Blank/whitespace → `400`.
- `limit` — optional, clamped to 1–20. Omitted → server default (5). Ask for more
  here than the agent gets; a search screen wants ~10–20.
- Searches go through the user's private SearXNG instance (same privacy path as
  the agent's `web_search` tool). No LLM involved; nothing is saved to any
  conversation. Works regardless of the `tools.enabled` setting.

## Error handling — please render these distinctly

| Status | Meaning | Render as |
|---|---|---|
| `200` with empty `results` | Search worked, genuinely no hits | "No results" |
| `502` | Search backend failed; `detail` has per-engine reasons (e.g. `"web search failed — no engines responded (brave: too many requests; duckduckgo: CAPTCHA)"`) | "Search failed: <detail>" — never "no results" |
| `503` | Search not configured on this server | Hide/disable the search UI |
| `400` | Blank query | Inline validation |

The 502-vs-empty distinction is deliberate (same philosophy as the agent-side
outcome events in 0720fd7): the search VM's engines do go down, and the user
should see that, not a silent empty state.

## Notes

- `answers` / `infoboxes` are optional keys — render when present, skip when not.
- No pagination; `limit` is the only knob. If you need paging later, ask and we'll
  add an offset.
- This is standalone. If/when the search screen grows "continue this search as a
  chat", that's the existing flow: POST /api/messages (a new seed conversation)
  with the user's follow-up — no special linkage needed from this endpoint.
