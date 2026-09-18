import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Nothing host-scoped may reach for the default API client (PA-67).
 *
 * ## Why this is a source-grep test
 *
 * Because the failure it catches is invisible to everything else. Importing the
 * module-level `api` singleton instead of calling `useHostApi()` typechecks
 * perfectly, lints clean, and behaves *correctly in every single-host
 * deployment* — which is every deployment until a second host is registered.
 * Its symptom then is a page that silently reads and writes the wrong machine:
 * you open `#/h/dev02/hooks/<id>`, edit a webhook, and the change lands on
 * `local`. No unit test of a component can see it (the web test project runs in
 * `environment: 'node'` with no DOM — see `vitest.config.ts`), and the browser
 * demo can only cover the handful of screens it actually visits.
 *
 * So the invariant is enforced structurally: under `pages/` and `components/`,
 * `api` comes from the host context or not at all. The allowlist below is the
 * complete set of surfaces that are deliberately *not* per-host, each with the
 * reason it is exempt — which is the second thing this test is for: a future
 * addition to that list has to be argued for in the same place.
 */

/** Files that legitimately talk to the origin that served this bundle. */
const ALLOWED = new Map<string, string>([
  [
    'pages/LoginPage.tsx',
    'Authenticates to this origin. With a Hub in front that *is* the Hub, and single sign-on means there is no per-host login to scope.',
  ],
]);

const ROOT = new URL('..', import.meta.url).pathname;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

describe('host scoping', () => {
  it('no page or component imports the default API client', () => {
    const offenders: string[] = [];
    for (const rel of [...walk('pages'), ...walk('components')]) {
      if (ALLOWED.has(rel)) continue;
      const source = readFileSync(join(ROOT, rel), 'utf8');
      // `api` as a *named import* from the client module — `ApiError`,
      // `createApiClient` and the `ApiClient` type are all fine, and so is a
      // local `const api = useHostApi()`.
      if (/import \{[^}]*\bapi\b[^}]*\} from '\.\.\/api\/client\.js'/.test(source)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every file that calls an API method has a host-scoped client in scope', () => {
    const offenders: string[] = [];
    for (const rel of [...walk('pages'), ...walk('components')]) {
      if (ALLOWED.has(rel)) continue;
      const source = readFileSync(join(ROOT, rel), 'utf8');
      // Comments are stripped first: several doc comments legitimately *name*
      // `api.createSession(...)` while explaining a helper, and a grep that
      // counted those would force the prose to be reworded to satisfy a test.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      // A call through `api`, allowing for prettier having wrapped the line
      // between the identifier and the method (`api\n  .listProjects()`).
      const calls = /(^|[^.\w])api\s*\n?\s*\.\w/m.test(code);
      if (calls && !code.includes('useHostApi()')) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('documents why each allowlisted file is exempt', () => {
    for (const [, reason] of ALLOWED) expect(reason.length).toBeGreaterThan(40);
  });
});
