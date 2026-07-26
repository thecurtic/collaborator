import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { probeCapabilities } from './lib/capabilities';
import { setupPWA } from './pwa';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Register the service worker (no-op in dev — devOptions is disabled).
setupPWA();

// Learn the backend's voice capabilities before anyone opens Settings/a call.
probeCapabilities();
