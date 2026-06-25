#!/bin/bash
# Deploy script for Collaborator

set -e

echo "=== Collaborator Deployment ==="

# Check if backend directory exists
if [ ! -d "backend" ]; then
    echo "Error: backend directory not found"
    exit 1
fi

# Check if config.yaml exists
if [ ! -f "config.yaml" ]; then
    echo "Error: config.yaml not found"
    echo "Please create config.yaml based on config.yaml.example"
    exit 1
fi

# Create and activate Python venv if needed
echo "Setting up Python virtual environment..."
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi

# Use venv Python and pip
VENV_PYTHON=".venv/bin/python3"
VENV_PIP=".venv/bin/pip"

# Install Python dependencies
echo "Installing Python dependencies..."
$VENV_PIP install --quiet fastapi uvicorn pydantic requests pyyaml

# Check Node.js dependencies
echo "Checking Node.js dependencies..."
if [ ! -d "node_modules" ]; then
    echo "Installing Node.js dependencies..."
    npm install
fi

# Build frontend (production)
echo "Building frontend..."
npm run build || {
    echo "Build failed, retrying with npm install..."
    npm install
    npm run build
}

# Determine port from config or use defaults
BACKEND_PORT=$(grep -E '^\s*backend_port:' config.yaml 2>/dev/null | grep -oE '[0-9]+' || echo "8001")
PORT=${PORT:-3000}

# Start the standalone Next.js server (serves both static assets and API proxy)
echo "Starting Collaborator with Next.js standalone server..."
echo "Frontend: http://localhost:$PORT"
echo "Backend API (via Next.js proxy): http://localhost:$BACKEND_PORT"

# Run the standalone server
exec node .next/standalone/server.js
