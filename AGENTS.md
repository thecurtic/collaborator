## Project Context

Collaborator is a self-hosted personal chat interface backed by local LLM inference.

### Development Workflow

When making changes to Collaborator, follow this workflow:

1. **Develop locally in dev environment** (`/home/chat/collaborator`)
2. **Test before committing or pushing**:
   ```bash
   npm run build          # Verify build succeeds
   npm start              # Start standalone server to test full app
   npx playwright test    # Run API and e2e tests
   ```
3. **Verify functionality works locally**:
   - Open http://localhost:3000 in browser
   - Test sending messages
   - Verify button enable/disable behavior
   - Check console for errors
4. **Commit and push changes**
5. **Deploy to production** on webserver:
   ```bash
   cd /home/chat/collaborator
   git pull origin main
   ./deploy.sh
   ```
6. **Test production deployment**:
   - Verify site loads at collaborator.example.com
   - Test all functionality including send button
   - Check browser console for errors

### Important Notes
- **Dev and Production are separate environments** - Changes must be tested locally before production deployment
- **Always run `npm build && npm start` locally before pushing** - This catches build failures and runtime issues
- **Test the deploy.sh script locally first** if possible, or ensure it works on webserver
- **Production testing is mandatory** after deployment - verify critical functionality (send button, chat flow)

### Architecture

This is a monorepo with two runtime contexts:

- **backend/** — runs on this VM. Manages SQLite conversation persistence (with tree-structured branching), context assembly, and proxies inference to the local LLM endpoint. Exposes a simple HTTP API.
- **frontend/** — served from a separate machine on the tailnet. Web UI (PWA) for sending messages, viewing responses, editing or discarding turns before they commit to memory. Supports conversation branching with a vertical tree visualization optimized for mobile devices.

They are loosely coupled. The frontend talks to the backend over HTTP. Either side can be swapped without breaking the other.

## Inference

All inference is local. Use the same endpoint and model that Pi itself is using for this session (`qwen/qwen3-coder-next` via LM Studio at `http://<inference-host>:1234/v1`).

## Networking

The web UI must be accessible from any network via the tailnet. The frontend is served from a machine on the tailnet. The backend API on this VM is also reachable via its tailnet IP. No public internet exposure. All communication stays within the tailnet.

## Memory Model

Conversations are stored as a tree structure in SQLite. Each turn records the user message and the final model response (not intermediate tool calls). The user can discard any turn before it commits — discarded turns never enter memory or future context. Context for each new turn is assembled from the active branch (path from root to current turn).

### Conversation Branching

Conversations form a tree, not a linear list. This is a core architectural feature:
- **Forking** — Users can fork at any point to explore alternative threads
- **Branch switching** — When exhausted, users return to the fork point and switch to another branch
- **Synthesis** — Users can combine insights from multiple branches into a unified response

## Principles
- Minimal dependencies
- Privacy-first, no external services unless explicitly requested
- Self-hosted everything
- Local inference only

## Testing Requirements
**CRITICAL: Always test your work before pushing to the repository**

Before committing or pushing any changes to Collaborator, you MUST:
1. Run `npm run build` - Verify the frontend builds without errors
2. Run `npm start` or `./deploy.sh` - Start the standalone server and verify functionality
3. Open http://localhost:3000 in browser - Test the send button and chat flow
4. Run `npx playwright test` - Ensure API tests pass
5. Verify no console errors in browser DevTools

**CRITICAL: Frontend developers must be notified before backend changes are pushed**
- Backend developers: Create frontend-updates one-pagers for any API/config/data changes
- Frontend developers: Check `frontend-updates/` after pull to understand backend changes

Failure to test before pushing will result in broken deployments and wasted time debugging production issues.

## Config Layer

The project uses a single `config.yaml` at the project root for shared configuration:
- **Inference** - Endpoint, model ID, temperature, max tokens, thinking mode, streaming
- **Memory** - Default context window size, database path
- **Server** - Backend host/port, allowed CORS origins
- **System prompt** - Text or file path for system prompt template

Both the backend and Pi read from this config. The model can be swapped without touching code, allowing Pi to use a more powerful coding model while Collaborator uses a conversational one.

## Housekeeping

When making backend changes, follow this housekeeping checklist to keep frontend developers informed:

### For Backend Developers (PREREQUISITE: Always notify frontend engineer before pushing)

1. **Update INTENTS.md** - Update `Last Updated:` date and add any new philosophical or architectural notes
2. **Create frontend-updates one-pager** - For commits affecting frontend:
   - File: `frontend-updates/{commit-hash}-{short-description}.md`
   - Include: API changes, config changes, data model changes, testing checklist
3. **Update API-SPEC.md** - Document any endpoint or schema changes
4. **Update config.yaml.example** - Add new configuration options with comments
5. **Run `npm run build && npm start` locally** - Verify no breaking changes
6. **Push and deploy** - Only after frontend engineer has been notified

### For Frontend Developers (DURING PULL)

1. **Read frontend-updates/** - Check for new one-pagers since last sync
2. **Review INTENTS.md** - Check `Last Updated:` for new changes
3. **Check API-SPEC.md** - Look for endpoint or schema changes
4. **Test locally** - Verify frontend works with backend changes
5. **Report issues** - Flag any broken functionality before production deployment
