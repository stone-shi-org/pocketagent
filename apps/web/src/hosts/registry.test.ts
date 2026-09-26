import { afterEach, describe, expect, it, vi } from 'vitest';
import { isHubHostId } from '@pocketagent/protocol';
import { hostEndpoint, normalizeBasePath } from '../api/host.js';
import {
  addLocalHost,
  defaultBasePathFor,
  generateHostId,
  loadLocalHosts,
  localHostProblem,
  removeLocalHost,
  saveLocalHosts,
  slugifyHostName,
} from './registry.js';

/** A minimal in-memory stand-in for the real `localStorage`. */
function fakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

describe('local host registry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips added hosts and normalizes their prefix', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const next = addLocalHost({ id: 'dev02', label: '  Second box  ', basePath: 'h/dev02/' }, []);
    expect(next).toEqual([{ id: 'dev02', label: 'Second box', basePath: '/h/dev02' }]);
    expect(loadLocalHosts()).toEqual(next);
  });

  it('proposes the same prefix the Hub would serve', () => {
    // A host registered by hand today keeps its address once a Hub is put in
    // front of the same backends.
    expect(defaultBasePathFor('dev02')).toBe('/h/dev02');
  });

  it('removes by id', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    let rows = addLocalHost({ id: 'a', label: 'A', basePath: '/h/a' }, []);
    rows = addLocalHost({ id: 'b', label: 'B', basePath: '/h/b' }, rows);
    expect(removeLocalHost('a', rows)).toEqual([{ id: 'b', label: 'B', basePath: '/h/b' }]);
  });

  it('cannot be made to point at another origin, even deliberately', () => {
    // The security property behind storing a *path*: a hand-edited or hostile
    // value can only produce same-origin requests that 404. It can neither
    // redirect the session cookie elsewhere nor widen what it is sent to.
    expect(normalizeBasePath('https://evil.example')).toBe('/https:/evil.example');
    expect(normalizeBasePath('//evil.example')).toBe('/evil.example');
    expect(hostEndpoint('x', 'https://evil.example').basePath.startsWith('/')).toBe(true);
  });

  it('drops malformed or duplicate stored rows instead of failing the whole list', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem(
      'pocketagent:hosts',
      JSON.stringify([
        { id: 'dev02', label: 'Second', basePath: '/h/dev02' },
        { id: 'dev02', label: 'Duplicate', basePath: '/h/other' },
        { id: 'Dev03', label: 'Bad id', basePath: '/h/dev03' },
        { id: 'dev04', label: '', basePath: '/h/dev04' },
        // An empty prefix *is* the host serving this bundle, which is
        // synthesized separately and must never be duplicated by a row.
        { id: 'dev05', label: 'Root', basePath: '/' },
        'not even an object',
        null,
      ]),
    );
    expect(loadLocalHosts()).toEqual([{ id: 'dev02', label: 'Second', basePath: '/h/dev02' }]);
  });

  it('treats invalid JSON and missing storage as no extra hosts', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem('pocketagent:hosts', '{not json');
    expect(loadLocalHosts()).toEqual([]);

    vi.stubGlobal('localStorage', undefined);
    expect(() => saveLocalHosts([{ id: 'a', label: 'A', basePath: '/h/a' }])).not.toThrow();
    expect(loadLocalHosts()).toEqual([]);
  });
});

describe('localHostProblem', () => {
  const existing = [{ id: 'dev02', label: 'Second', basePath: '/h/dev02' }];

  it('accepts a well-formed entry', () => {
    expect(localHostProblem({ id: 'dev03', label: 'Third', basePath: '/h/dev03' }, existing, ['local'])).toBeNull();
  });

  it('rejects an id that could not appear in a URL path unescaped', () => {
    for (const id of ['Dev03', 'dev 03', 'dev/03', '-dev', '']) {
      expect(localHostProblem({ id, label: 'x', basePath: '/h/x' }, existing, ['local'])).not.toBeNull();
    }
  });

  it('rejects a taken or reserved id', () => {
    expect(localHostProblem({ id: 'dev02', label: 'x', basePath: '/h/x' }, existing, ['local'])).toContain(
      'already taken',
    );
    expect(localHostProblem({ id: 'local', label: 'x', basePath: '/h/x' }, existing, ['local'])).toContain(
      'already taken',
    );
  });

  it('rejects an empty prefix, which is this server', () => {
    expect(localHostProblem({ id: 'dev03', label: 'x', basePath: ' / ' }, existing, ['local'])).toContain(
      'cannot be empty',
    );
  });
});

describe('generateHostId (PA-107)', () => {
  it('slugifies the name a human typed', () => {
    expect(generateHostId('Second workstation', [])).toBe('second-workstation');
    expect(generateHostId('  Stone’s Dev-01!! ', [])).toBe('stone-s-dev-01');
    expect(generateHostId('Büro Rechner', [])).toBe('buro-rechner');
  });

  it('truncates to the id pattern, never ending on a hyphen', () => {
    const id = generateHostId(`${'a'.repeat(39)} b`, []);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(isHubHostId(id)).toBe(true);
    expect(id).toBe('a'.repeat(39));
  });

  it('suffixes past a collision, including the reserved default id', () => {
    expect(generateHostId('dev', ['dev'])).toBe('dev-2');
    expect(generateHostId('dev', ['dev', 'dev-2', 'dev-3'])).toBe('dev-4');
    expect(generateHostId('Local', ['local'])).toBe('local-2');
  });

  it('keeps a suffixed long id inside 40 characters', () => {
    const long = 'x'.repeat(40);
    const id = generateHostId(long, [long]);
    expect(id).toBe(`${'x'.repeat(38)}-2`);
    expect(isHubHostId(id)).toBe(true);
  });

  it('falls back to a random slug when nothing survives slugifying', () => {
    expect(slugifyHostName('開発機')).toBe('');
    let n = 0;
    const seq = [0, 0, 0, 0, 0, 0, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99];
    const random = (): number => seq[n++ % seq.length]!;
    // The first candidate is taken, so the second draw is used.
    expect(generateHostId('開発機', ['host-aaaaaa'], random)).toBe('host-999999');
    expect(isHubHostId(generateHostId('!!!', []))).toBe(true);
  });

  it('always produces a valid id', () => {
    for (const name of ['a', '-', 'A--B', '9', 'ü', 'x'.repeat(300), 'dev 02 (backup)']) {
      expect(isHubHostId(generateHostId(name, []))).toBe(true);
    }
  });
});
