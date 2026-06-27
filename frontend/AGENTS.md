# AGENTS.md — Collaborator Frontend

This repository holds the **frontend** for Collaborator. Agents and contributors
working here must respect a strict separation between the two Gitea
repositories.

## Repositories

| Role     | Git remote | URL                                                        | Allowed operations |
| -------- | ---------- | ---------------------------------------------------------- | ------------------ |
| Frontend | `origin`   | `http://<gitea-host>:3000/gitadmin/collaborator-frontend.git` | fetch **and** push |
| Backend  | `backend`  | `http://<gitea-host>:3000/gitadmin/collaborator-backend.git`  | fetch **only**     |

## Hard constraints

1. **All frontend code is pushed to `origin` (collaborator-frontend) only.**
   Never push application code, commits, branches, or tags to the backend
   repository.

2. **The backend repository is read-only and is used for exactly one thing:
   pulling the design/contract documents.** Currently that means two files,
   both vendored into `api-spec/`:
   - `API-SPEC.md` — the REST contract the frontend codes against.
   - `INTENTS.md` — the product philosophy / intended behavior the UI must
     embody (recall, editability, tagging, context visibility).

   Do not pull, copy, or vendor any other backend source code, configuration,
   or files into this repo.

3. **Never push to `backend`.** Its push URL has been intentionally disabled
   (`git remote set-url --push backend DISABLED_NO_PUSH_TO_BACKEND`). Do not
   re-enable it.

## Pulling the API spec from the backend

Fetch the backend without merging it into the working tree, then check out only
the spec file:

```bash
git fetch backend
# Pull ONLY the design docs from the backend default branch into api-spec/:
git show backend/main:API-SPEC.md > api-spec/API-SPEC.md
git show backend/main:INTENTS.md  > api-spec/INTENTS.md
```

These files live under `api-spec/` in this repo. Commit them to a frontend
branch and push to `origin`. Treat them as vendored artifacts: the backend is
the source of truth, so update them by re-pulling rather than editing by hand.

> Note: `INTENTS.md` lists recall/tagging endpoints under "API Extensions
> Needed" — these are **planned, not yet implemented**. Only `API-SPEC.md`
> describes endpoints that currently exist. Build forward-looking UI behind an
> abstraction so it can light up when the backend ships those endpoints.

## Backend `frontend-updates/` one-pagers (transient inbox)

The backend repo has a `frontend-updates/` directory of single-use one-pagers
(`{commit-hash}-{desc}.md`) flagging backend changes that affect the frontend.
Treat it as an **inbox, not an archive**:

1. On pull, read any new one-pagers (via `git show backend/main:frontend-updates/<file>`).
   Do **not** vendor them into this repo — they're transient.
2. Implement the change (or confirm it's a no-op for the frontend).
3. Record a row in `docs/backend-sync.md` (hash, date, action). That ledger is
   pure coordination — it tracks what's been processed and signals the backend
   dev which one-pagers are safe to delete. **Durable state is not stored there**
   — it lands in `API-SPEC.md` / `INTENTS.md`, which we re-pull (see above).
4. The applied one-pager is then deleted from the backend inbox (backend dev's
   job — we can't push to the backend).

## Quick checklist before pushing

- [ ] Push target is `origin` (collaborator-frontend), never `backend`.
- [ ] No backend files other than `API-SPEC.md` / `INTENTS.md` were copied in.
- [ ] Vendored docs, if updated, came from `backend/main` via `git show`.
