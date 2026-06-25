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
   pulling the API spec document.** Do not pull, copy, or vendor any other
   backend source code, configuration, or files into this repo.

3. **Never push to `backend`.** Its push URL has been intentionally disabled
   (`git remote set-url --push backend DISABLED_NO_PUSH_TO_BACKEND`). Do not
   re-enable it.

## Pulling the API spec from the backend

Fetch the backend without merging it into the working tree, then check out only
the spec file:

```bash
git fetch backend
# Inspect where the spec lives on the backend default branch, e.g.:
git ls-tree -r --name-only backend/main | grep -i -E 'openapi|swagger|api.*spec'
# Check out ONLY the spec file into this repo:
git checkout backend/main -- <path/to/api-spec.yaml>
```

Place the retrieved spec under `api-spec/` in this repo, commit it to a frontend
branch, and push it to `origin`. Treat it as a generated/vendored artifact: the
backend is the source of truth, so update it by re-pulling rather than editing
it by hand.

## Quick checklist before pushing

- [ ] Push target is `origin` (collaborator-frontend), never `backend`.
- [ ] No backend files other than the API spec were copied into this repo.
- [ ] The API spec, if updated, came from `backend/main` via `git checkout`.
