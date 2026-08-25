/// <reference types="vite/client" />

// Injected by `vite.config.ts` via `define`, computed once at build (or dev
// server start) time. `tsc --noEmit` runs as a separate pass before `vite
// build` (see apps/web/package.json) and never evaluates vite.config.ts, so
// these ambient declarations are what let it type-check references to them.
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;
