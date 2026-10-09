# Collaborator — Frontend

Web UI for **Collaborator**, a self-hosted personal AI hub backed by local LLM
inference. See [`../INTENTS.md`](../INTENTS.md) for the product philosophy and
[`../API-SPEC.md`](../API-SPEC.md) for the REST and WebSocket contract this app
codes against.

## Stack

- Vite + React 19 + TypeScript
- Tailwind CSS v4 + shadcn/ui-style components
- **Mobile-first** layout (primary target is phone; desktop supported)
- **Installable PWA** (vite-plugin-pwa: manifest, service worker, offline shell)
- Capacitor Android shell in `android/` (remote-URL mode, see `DEV.md`)
- Thin typed API layer with a swappable service seam

## Getting started

```bash
npm install
npm run dev          # http://localhost:3000 (proxies /api -> backend :8001)
```

Make sure the backend is running on `http://localhost:8001` (or set
`VITE_BACKEND_URL`). Copy `.env.example` to `.env.local` to override.

```bash
npm run build        # type-check + production build -> dist/
npm run typecheck    # types only
npm test             # vitest
```

`DEV.md` covers the full dev loop: running the backend, testing on a phone,
PWA install, and building the Android shell.

## Microphone use (heads-up for self-hosters)

Voice features are **local-first by design**, but the microphone is on in more
situations than you might expect:

- **Read-aloud keeps the mic on while speaking.** Tapping the speaker icon (or
  any TTS playback) starts an on-device keyword spotter so you can say the
  configured stop word (default "stop") to interrupt. This is intentional
  barge-in, not surveillance — audio is processed locally by a TF.js model and
  never leaves the device — but expect a mic permission prompt the first time.
- **Call mode streams mic audio continuously** while listening. With the
  on-device engine selected, transcription happens locally (Whisper via
  Transformers.js); with the server engine, PCM audio is streamed to *your*
  backend only.

## Architecture

```
src/
  api/        wire types, HTTP client, and the CollaboratorApi service seam
  auth/       session handling, auth gate context, and the passkey screen
  domain/     canonical app models + adapters from the wire format
  features/   chat, scratch, notes, events, voice, settings
  components/ shadcn-style UI primitives
  native/     feature-detected bridge to the Android shell (no-op in browsers)
  lib/        utilities
```

Everything that talks to the backend goes through the `CollaboratorApi`
interface (`src/api/collaborator.ts`), so endpoints can be added or mocked
without touching the UI.

## Authentication

The passkey is exchanged at login for a device session and never stored
client-side: browsers get an httpOnly cookie, the Android shell stores the
session token and sends `X-Session`. A 403 locks the app and shows the login
screen. Auth is optional; with it disabled on the backend the app runs
without a lock screen.
