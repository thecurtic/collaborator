# Collaborator Deployment Guide

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
