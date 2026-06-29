# Collaborator Deployment Guide

## Development vs Production Environments

### Development Environment
- **Location**: `/home/chat/collaborator`
- **Runs on**: localhost:3000
- **Usage**: Local testing, feature development, running tests
- **Commands**:
  ```bash
  # Start dev server
  npm run dev
  
  # Build for production
  npm run build
  
  # Run tests
  npx playwright test
  ```

### Production Environment
- **Location**: `/home/chat/collaborator` (on webserver)
- **Runs on**: collaborator.example.com:3000
- **Usage**: Public-facing deployment
- **Deployment**: Use the deploy script (see below)

## Quick Start on Webserver

1. Pull the latest code from git:
   ```bash
   cd /home/chat/collaborator
   git pull origin main
   ```
2. Copy and configure config.yaml:
   ```bash
   cp config.yaml.example config.yaml
   # Edit with your tailnet IPs and production URL
   ```
3. Copy environment template:
   ```bash
   cp .env.local.example .env.local
   # Edit with your production domain (e.g., https://collaborator.example.com)
   ```
4. Run the deploy script:
   ```bash
   chmod +x deploy.sh
   ./deploy.sh
   ```

## Restarting the backend

The Python backend (FastAPI/uvicorn) is a **separate process** from the Next.js
server. Pulling code does not restart it. Use the one-command restarter:

```bash
./restart.sh
```

It reads the port from `config.yaml`, uses the project `.venv`, and prints a health
check. `./deploy.sh` calls it automatically, so a normal deploy bounces the backend.

**Optional — run it under systemd** (boot persistence + `journalctl` logs). Once
installed, `./restart.sh` automatically uses it:

```bash
sudo cp deploy/collaborator-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now collaborator-backend
# adjust User/paths in the unit if your checkout isn't /srv/collaborator
```

Verify a restart took effect:
```bash
curl -s http://localhost:8001/api/health   # {"status":"healthy","version":"0.2.0"}
```

## Configuration

### config.yaml
Update these values:
- `inference.endpoint_url`: LM Studio endpoint (tailnet IP:1234)
- `server.cors_origins`: Add your production domain
- `server.backend_port`: Change if 8001 is occupied (default)
- `memory.db_path`: Database location

### .env.local
Set `NEXT_PUBLIC_BACKEND_URL` to your production domain.

## Port Conflicts

If ports conflict, change in `config.yaml`:
```yaml
server:
  backend_port: 8002  # Backend API port
```

Set PORT environment variable for frontend:
```bash
PORT=3001 ./deploy.sh  # Frontend port
```

## Architecture

Collaborator uses a **Next.js standalone server** that:
- Serves static frontend assets (CSS, JS)
- Proxies `/api/*` requests to the Python FastAPI backend
- Handles both frontend and backend in a single process

The deploy script now runs `node .next/standalone/server.js` which:
1. Loads the built Next.js application
2. Serves static assets on port 3000 (or custom PORT)
3. Proxies API calls to the Python backend on port 8001 (or custom)

## Development Workflow

### Making Changes Locally
1. Work on your feature in the development environment
2. **Always test before committing/pushing**:
   ```bash
   npm run build
   npm start  # or use ./deploy.sh for production testing
   npx playwright test
   ```
3. Verify all functionality works in local build
4. Commit and push changes

### Deploying to Production
1. Pull latest code on webserver:
   ```bash
   git pull origin main
   ```
2. Ensure config.yaml and .env.local are configured
3. Run deploy script:
   ```bash
   ./deploy.sh
   ```

## Troubleshooting

### Static Assets 404
If you see 404 errors for `_next/static/...`:
1. Ensure you pulled the latest code
2. Run `npm run build` to rebuild
3. Restart with `./deploy.sh`

### Port Already in Use
```bash
# Find process using port 3000
lsof -i :3000

# Kill it
kill -9 <PID>
```

### Send Button Not Working (Production)
If the send button is disabled on production:
1. Check browser console for JavaScript errors
2. Verify Next.js build completed successfully: `npm run build`
3. Check that static assets exist in `.next/static/`
4. Ensure the deploy script ran successfully
5. Restart with `./deploy.sh` to ensure fresh build is served
