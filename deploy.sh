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

# Check Python dependencies
echo "Checking Python dependencies..."
python3 -c "import fastapi" 2>/dev/null || {
    echo "Installing Python dependencies..."
    pip install --quiet fastapi uvicorn pydantic requests pyyaml
}

# Check Node.js dependencies
echo "Checking Node.js dependencies..."
if [ ! -d "node_modules" ]; then
    echo "Installing Node.js dependencies..."
    npm install
fi

# Build frontend (production)
echo "Building frontend..."
npm run build || {
    echo "Build failed - trying with dev"
    npm install
    npm run build
}

# Start backend (production)
echo "Starting Collaborator Backend on $(grep -o 'backend_port.*[0-9]*' config.yaml | grep -o '[0-9]*')..."
python3 backend/main.py
