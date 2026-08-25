// `__APP_VERSION__` and `__BUILD_TIME__` are `define`d by vite.config.ts at
// build (or dev server start) time — see that file and vite-env.d.ts.

/** First 8 chars of the git revision this bundle was built from, `-dev` suffixed if the tree was dirty. */
export const APP_VERSION = __APP_VERSION__;

/** ISO timestamp of when `vite build` (or `vite`/`vite preview`) started. */
export const BUILD_TIME = __BUILD_TIME__;

export function formatBuildInfo(): string {
  const when = new Date(BUILD_TIME);
  const stamp = Number.isNaN(when.getTime()) ? BUILD_TIME : when.toLocaleString();
  return `${APP_VERSION} · built ${stamp}`;
}
