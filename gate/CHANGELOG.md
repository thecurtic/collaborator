# Changelog

Changes to the gate. Any change to the control API says which
`api_version` it belongs to.

## 1.0.0 — 2026-10-18 (api_version 1)

- First release. It proxies `/v1/*` to LM Studio, streaming SSE through. It
  holds new `POST`s while paused and releases them in arrival order on
  resume. A held client that disconnects is never forwarded.
- Control API: `GET /gate/status`, `POST /gate/pause` and
  `POST /gate/resume`, all with a bearer token.
- launchd install via `install.sh`.
