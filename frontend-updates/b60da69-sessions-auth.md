# Frontend Update: device sessions replace the stored passkey

**Commit:** `b60da69`
**Date:** August 1, 2026

## Why

The passkey guards extended cognition now (profile, social graph, calendar,
location, git) — a forever-credential in localStorage is the wrong tier.
Backend gains Argon2id hashing, brute-force lockout, and **device sessions**.
Your `X-Passkey` header **keeps working unchanged** — migrate at your pace,
nothing breaks on deploy.

## The new flow

**Login (replaces "store the passkey"):**

```
POST /api/auth/login
{"passkey": "<user-entered>", "device_label": "my phone"}

200 → {"token": "...", "session_id": 3, "label": "...", "expires_at": "..."}
   + Set-Cookie: collaborator_session=...; HttpOnly; Secure; SameSite=Lax
403 → wrong passkey        429 (+ Retry-After) → brute-force lockout; show the wait
```

- **Browser/PWA:** do nothing after login — the httpOnly cookie rides every
  request automatically (JS can never read it; XSS can no longer steal the
  credential). Ignore the `token` in the body. **Stop writing
  `collaborator_passkey` to localStorage entirely; delete any stored one.**
- **Capacitor wrapper:** cookies across the WebView/API origin split are
  unreliable — store the body `token` and send it as an **`X-Session`** header
  on every request (same place you attach X-Passkey today). Storing the
  session token in localStorage is acceptable (unlike the passkey it expires
  and is revocable); Phase B moves it to biometric-gated secure storage.
- Pass a meaningful `device_label` (e.g. platform + browser) — it's what the
  user sees in the devices list.

**Sessions expire** (30 days idle / 90 days absolute, server-configurable):
any request then returns 403 — which your existing 403→locked flow already
handles. Just make the lock screen submit to `/api/auth/login` instead of
storing the passkey. Handle **429** on the lock screen (new): show "too many
attempts, retry in Ns" from the Retry-After header.

## Devices UI (new, when ready)

```
GET  /api/auth/sessions            → {"sessions": [{id, label, created_at,
                                       last_seen, expires_at, current}]}
DELETE /api/auth/sessions/{id}     → revoke that device immediately
POST /api/auth/logout              → revoke current session + clear cookie
```

Settings screen: list devices with label + last-seen, badge the current one,
red "sign out" per row. This is the lost-phone story: revoke from any other
device and the stolen session dies instantly.

## Android wrapper asks

1. **Now:** `android:allowBackup="false"` in AndroidManifest.xml (credentials
   in WebView storage currently ride device backups/transfers).
2. **Phase B:** biometric gate on app open + move the session token to
   Capacitor secure storage; real WebAuthn is on the roadmap after that.

## Deploy (backend)

```bash
./deploy.sh    # parent folder — pip installs argon2-cffi
```

Existing passkeys keep working with zero user action: legacy hashes verify
once more and silently upgrade to Argon2id. Lockout and sessions are active
immediately. `X-Passkey` remains supported until you've migrated — we'll
announce before ever removing it.
