# Frontend Update: location context, video transcripts, new agent tools

**Commit:** `b23d8ea`
**Date:** July 27, 2026

## 1. Per-turn location (needs frontend wiring)

`POST /api/messages` and `POST /api/branches/{id}` accept an optional field:

```json
{"message": "...", "location": {"lat": 40.0150, "lon": -105.2705, "accuracy": 12, "ts": 1785200000}}
```

- Send it on **every turn** when the user has granted geolocation permission;
  omit it entirely otherwise (absence degrades cleanly — no placeholder).
- The backend turns it into a context line via **named places** from server
  config (`location.places`: home/work/etc. with radii) — "at home", "3.2 km
  from work" — falling back to raw coordinates. No external geocoding ever;
  coordinates never leave the server.
- **Ephemeral by default**: location informs the turn but is NOT stored.
  Server config `location.store: true` toggles persistence onto user turn rows
  (`turns.location`, JSON) — surface that as a privacy setting if you build UI
  for it, but the toggle itself is server config.
- OSM map browsing is a future feature (agreed, parked) — nothing to build.

## 2. Video transcription (STT on audio, never captions)

New `transcribe_video` tool. Flow the UI should expect:

- Short videos (≤ ~10 min): transcript arrives within the turn (status event:
  "Transcribing video …" — it can take ~a minute; the spinner is honest).
- Longer videos: the model replies that transcription is running in the
  **background**. Jobs surface at:

```
GET /api/transcripts            → {"transcripts": [{id, url, title, duration_s,
                                    status: processing|done|error, chars,
                                    created_at, finished_at}], "count": n}
GET /api/transcripts/{id}       → {"transcript": {..., "text": "full text"}}
```

Suggested UI: a transcripts list (reuse the drafts-inbox pattern) with a
processing badge; the user can also just ask the model again — it re-checks by
URL and returns the finished transcript. Results are cached per URL.

## 3. New/expanded tools (FYI — tool-activity labels you'll see)

| tool | label | notes |
|---|---|---|
| `get_notes` | "Reading N notes…" | batch graph traversal, up to 20 full notes/call |
| `search_notes` | (unchanged) | now accepts `limit` up to 50; results include `created` |
| `calculate` | "Calculating …" | exact arithmetic, safe evaluator |
| `git_read` | "Reading git (action): repo/path…" | read-only Gitea; only registers when `tools.git` is configured |
| `transcribe_video` | "Transcribing video …" | see above |

## Deploy (backend)

```bash
git pull
.venv/bin/pip install -r requirements.txt   # adds yt-dlp
./restart.sh
```

Server config additions (`.config.yaml`):

```yaml
tools:
  git:
    api_url: "http://<gitea-host>:3000/api/v1"
    token: "<READ-ONLY gitea token>"
location:
  places:
    home: {lat: 0.0, lon: 0.0, radius_m: 150}   # fill in real places
  # store: true   # opt-in: persist location on turn rows
```

ffmpeg must be on the backend box (already required for tap-to-record).
Note: yt-dlp egresses directly from the backend (config `tools.transcribe_video.proxy`
available); it does not route through the webtool VM.
