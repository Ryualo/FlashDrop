import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * After the build, writes the list of emitted files and a content hash into dist/service-worker.js
 * so the worker precaches exactly this build and uses a per-build cache name.
 */
function injectOfflinePrecache(): Plugin {
  return {
    name: 'flashdrop-offline-precache',
    apply: 'build',
    closeBundle() {
      const distDir = path.resolve(projectRoot, 'dist');
      const workerPath = path.join(distDir, 'service-worker.js');
      if (!fs.existsSync(workerPath)) throw new Error('dist/service-worker.js is missing (public/service-worker.js not copied)');

      const skip = new Set(['/service-worker.js', '/_headers', '/_redirects']);
      const assets: string[] = ['/'];
      const hash = createHash('sha256');
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else {
            const rel = '/' + path.relative(distDir, full).split(path.sep).join('/');
            if (skip.has(rel) || rel.endsWith('.map')) continue;
            assets.push(rel);
            hash.update(rel).update(fs.readFileSync(full));
          }
        }
      };
      walk(distDir);
      const buildId = hash.digest('hex').slice(0, 16);
      const source = fs.readFileSync(workerPath, 'utf8');
      const updated = source
        .replace(/const BUILD_ID = '[^']*';/, `const BUILD_ID = '${buildId}';`)
        .replace(/const CORE_ASSETS = \[.*?\];/s, `const CORE_ASSETS = ${JSON.stringify([...new Set(assets)])};`);
      if (updated === source) throw new Error('Could not inject the precache manifest into service-worker.js');
      fs.writeFileSync(workerPath, updated);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), injectOfflinePrecache()],
  resolve: {
    alias: { '@': projectRoot },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: ['es2022', 'safari16', 'chrome109', 'firefox115'],
    sourcemap: false,
  },
  server: {
    // Reachable from a phone on the LAN. Note: phones only allow camera access over HTTPS,
    // so test cameras via a deploy preview or an HTTPS tunnel (see README).
    host: true,
    port: 3000,
  },
});
