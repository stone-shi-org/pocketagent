import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.POCKETAGENT_API ?? 'http://127.0.0.1:8787';

/**
 * Set when this dev server is reached through a TLS-terminating reverse proxy
 * under a hostname other than localhost (e.g. a Traefik domain so a phone or
 * another machine can reach it) — never set for a plain `pnpm dev` on one box.
 * Two things break without it: Vite's own host-header allowlist 403s a
 * `Host` it doesn't recognize, and the HMR client — which otherwise assumes
 * it can reconnect on the same host/port it loaded from — needs to be told
 * the public host/port/scheme explicitly, or live-reload silently stops
 * working the moment the page loads through the proxy's TLS hop.
 */
const PUBLIC_HOST = process.env.VITE_PUBLIC_HOST;

// Computed once per `vite build` (or dev server start), not per request, so
// it reflects the checkout that produced this bundle rather than drifting
// while the dev server stays up. Falls back to 'unknown' outside a git
// checkout (e.g. an extracted release tarball) instead of failing the build.
function appVersion(): string {
  try {
    const sha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .slice(0, 8);
    const dirty =
      execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
        .trim().length > 0;
    return dirty ? `${sha}-dev` : sha;
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [react()],
  server: {
    host: process.env.VITE_HOST ?? '127.0.0.1',
    port: 5173,
    ...(PUBLIC_HOST ? { allowedHosts: [PUBLIC_HOST] } : {}),
    ...(PUBLIC_HOST ? { hmr: { host: PUBLIC_HOST, protocol: 'wss', clientPort: 443 } } : {}),
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false, ws: true },
      '/health': { target: API_TARGET, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'],
        },
      },
    },
  },
});
