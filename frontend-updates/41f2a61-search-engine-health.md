# 41f2a61 — search responses now carry an engine-health report

## What changed

Every search response — the search screen's `GET /api/search` and the agent's
`web_search` tool results alike — now includes an `engines` field:

```json
{
  "query": "how do heat pumps work",
  "results": [ ... ],
  "engines": {
    "responded": { "brave": 12, "duckduckgo": 9 },
    "failed": [
      { "engine": "startpage", "reason": "CAPTCHA" },
      { "engine": "google cse", "reason": "unexpected crash" }
    ]
  }
}
```

- `responded`: engine name → number of results it contributed.
- `failed`: engines that were queried but returned nothing usable, with the
  reason SearXNG gave (CAPTCHA, timeout, crash). May be empty.
- The field is always present on success. Total failure (zero engines) still
  errors as a 502 with the reason in `detail`, same as before.

## Suggested UI (optional, small)

A coverage badge on the search screen: nothing when all engines responded;
a subtle "partial coverage — N engines down" chip (expandable to the failed
list) when `failed` is non-empty. Recent history: the instance spent weeks
silently reduced to Brave-only and nobody could see it. This field is how
you'd see it.

If you render tool payloads in the debug view, the same block appears inside
`web_search` tool results — no special handling needed, it's just JSON.

## Not frontend-relevant (same commit)

`fetch_url` gained transcript-style paging (`chunk=N`, "Part N of M") — agent
tool loop only, no UI surface.
