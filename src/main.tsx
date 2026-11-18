import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

/**
 * Service Worker: production builds only. In development a caching worker would serve stale
 * modules. A new version waits until the user chooses to reload (no forced skipWaiting), so an
 * open tab never ends up running old code against freshly deleted assets mid-transfer.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js', { scope: '/' })
      .then((registration) => {
        const announce = (worker: ServiceWorker | null) => {
          if (worker && navigator.serviceWorker.controller) {
            window.dispatchEvent(new CustomEvent('flashdrop:update-ready', { detail: worker }));
          }
        };
        announce(registration.waiting);
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          installing?.addEventListener('statechange', () => {
            if (installing.state === 'installed') announce(installing);
          });
        });
        // Check for a new version when the app regains focus (bounded to once per hour)
        let lastCheck = Date.now();
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && Date.now() - lastCheck > 3_600_000) {
            lastCheck = Date.now();
            void registration.update().catch(() => undefined);
          }
        });
      })
      .catch(() => {
        // Registration can fail in private modes or restricted iframes; the app still works online.
      });
  });
}

createRoot(document.getElementById('root')!).render(<App />);
