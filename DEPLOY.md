# Collaborator Deployment Guide

## Quick Start on Webserver

1. Clone the repository
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
- `server.backend_port`: Change if 8000 is occupied
- `memory.db_path`: Database location

### .env.local
Set `NEXT_PUBLIC_BACKEND_URL` to your production domain.

## Port Conflicts

If ports 8000/3000 are occupied, change in `config.yaml`:
```yaml
server:
  backend_port: 8001
```

And set PORT environment variable:
```bash
PORT=3003 ./deploy.sh
```
