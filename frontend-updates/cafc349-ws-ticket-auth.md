# Frontend Update: WebSocket Auth via One-Time Ticket

**Commit:** `cafc349`
**Date:** July 5, 2026

## Summary

The streaming transcription WS can now authenticate with a **short-lived, single-use
ticket** instead of putting the long-lived passkey in the URL (which leaks into access
/ proxy logs).

## Flow

1. Get a ticket over a normal (header-authenticated) request:
   ```
   POST /api/auth/ws-ticket
   X-Passkey: <passkey>
   -> 200 { "ticket": "<random>", "expires_in": 30 }
   ```
2. Open the socket with the **ticket** in the URL (not the passkey):
   ```
   WS /api/transcribe/stream?ticket=<ticket>
   ```

- The ticket is **single-use** (consumed on first connect) and expires in **~30s**, so
  fetch it right before opening the socket.
- `403` from `POST /api/auth/ws-ticket` if the passkey is missing/invalid.
- Invalid/missing/expired/reused ticket → `{"type":"error"}` then close (1008).

## Backward compatibility (deprecated)

`?passkey=<secret>` and the first-frame `{"passkey":"..."}` still work for now — so no
rush — but please migrate to the ticket flow; we'll remove the passkey-in-URL path
once you've shipped it.

## Notes

- Only relevant when `authentication.enabled` is true. With auth off, the WS accepts
  connections without a ticket (unchanged).
- Tickets are in-memory (fine for a single backend process); they don't survive a
  backend restart, which is irrelevant at a 30s TTL.

## Related files

| File | Change |
|------|--------|
| `backend/main.py` | `POST /api/auth/ws-ticket`; WS accepts `?ticket=` |
| `API-SPEC.md` | documented the ticket flow |
</content>
