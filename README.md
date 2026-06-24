# Collaborator

A personal, self-hosted web application with local inference.

## Development

### Prerequisites
- Node.js >= 20
- Local LLM inference endpoint (same as Pi)

### Setup

```bash
# Install dependencies
npm install

# Run development server
npm run dev
```

### Testing

```bash
npm test
npm run test:watch
npm run test:coverage
```

### Build

```bash
npm run build
```

## Deployment

This project is designed for self-hosted deployment. The web UI is served from a separate machine on the local network.

### Deployment Steps

1. Build the project: `npm run build`
2. Deploy to your server
3. Configure environment variables
4. Start the service

## Project Structure

```
src/
├── components/      # Reusable UI components
├── pages/          # Page components (Next.js) or routes
├── services/       # API and external service integrations
├── utils/          # Utility functions
└── styles/         # Global styles and CSS modules
```

## Principles

- **Minimal dependencies** - Only include what's necessary
- **Privacy-first** - No external services unless explicitly requested
- **Self-hosted everything** - Full control over infrastructure

## License

MIT
