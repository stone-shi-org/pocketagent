/**
 * `artifact:` references in a Pocket Agent's reply (PA-177).
 *
 * The model writes into its workspace's `artifacts/` folder and is told to
 * point at a file as `![caption](artifact:diagram.svg)` or
 * `[report](artifact:report.md)`. It cannot be given the real URL: that
 * depends on the chat id and, behind a Hub, on the `/h/<hostId>/` prefix —
 * neither is the model's business, and a URL it composed would be one it could
 * aim anywhere. So the reference is a *name*, and the page turns it into the
 * host-scoped artifact route (`AttachmentHrefContext`'s sibling,
 * `ArtifactResolver`). Two spellings are accepted because models write both
 * unprompted: the scheme, and a path relative to the workspace
 * (`artifacts/diagram.svg`).
 *
 * Left as they were, both were dead links: DOMPurify strips an `href` with an
 * unknown scheme, and a relative path resolves against the SPA's own URL. Now
 * a reference either resolves, or renders as plain text naming the file — never
 * as a link that goes nowhere.
 */

/** How the page turns an artifact name into a URL; `null` when it cannot. */
export type ArtifactResolver = (name: string) => string | null;

const SCHEME = 'artifact:';
const DIR_PREFIX = /^(?:\.\/)?artifacts\//;

/** Types an `<img>` can show. SVG is safe there: an image context runs no script. */
const INLINE_IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg)$/i;

/**
 * The artifact name an href refers to, or `null` if it is not an artifact
 * reference at all. `{ invalid: true }` is a reference that tried to leave the
 * folder (or is otherwise unusable) — shown as text, never requested. The
 * server re-checks containment regardless; this only keeps the browser from
 * asking.
 */
export function parseArtifactRef(href: string): { name: string } | { invalid: true } | null {
  let raw: string;
  if (href.toLowerCase().startsWith(SCHEME)) {
    raw = href.slice(SCHEME.length).replace(/^\/+/, '');
  } else if (DIR_PREFIX.test(href)) {
    raw = href.replace(DIR_PREFIX, '');
  } else {
    return null;
  }
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return { invalid: true };
  }
  name = name.split(/[?#]/, 1)[0] ?? '';
  if (
    !name ||
    name.length > 512 ||
    name.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    name.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
  ) {
    return { invalid: true };
  }
  return { name };
}

export function isInlineImageArtifact(name: string): boolean {
  return INLINE_IMAGE_EXT.test(name);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function basename(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

/** A reference that cannot become a link: the file name, as text. */
function unresolved(name: string, label: string): string {
  const shown = label && label !== name ? `${escapeHtml(label)} ` : '';
  return `<span class="artifact-ref-missing" title="Artifact not available here">${shown}<code>${escapeHtml(name)}</code></span>`;
}

function openLink(url: string, inner: string, className: string): string {
  return `<a class="${className}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
}

/**
 * HTML for `![alt](href)` when href is an artifact reference, else `null`
 * (render as an ordinary image). An image type is shown inline *and* gets a
 * link under it, so the file can always be opened at full size or saved; any
 * other type becomes a link, since an `<img>` of a Markdown file shows nothing.
 */
export function renderArtifactImage(href: string, alt: string, resolve: ArtifactResolver | null): string | null {
  const ref = parseArtifactRef(href);
  if (!ref) return null;
  if ('invalid' in ref) return unresolved(href, alt);
  const url = resolve?.(ref.name) ?? null;
  if (!url) return unresolved(ref.name, alt);
  const label = escapeHtml(basename(ref.name));
  if (!isInlineImageArtifact(ref.name)) {
    return openLink(url, `${escapeHtml(alt || basename(ref.name))}`, 'artifact-link');
  }
  const img = `<img class="artifact-image" src="${escapeHtml(url)}" alt="${escapeHtml(alt || ref.name)}" loading="lazy">`;
  return (
    `<span class="artifact-figure">${openLink(url, img, 'artifact-image-link')}` +
    `${openLink(url, label, 'artifact-link')}</span>`
  );
}

/** HTML for `[text](href)` when href is an artifact reference, else `null`. */
export function renderArtifactLink(href: string, innerHtml: string, resolve: ArtifactResolver | null): string | null {
  const ref = parseArtifactRef(href);
  if (!ref) return null;
  if ('invalid' in ref) return unresolved(href, '');
  const url = resolve?.(ref.name) ?? null;
  if (!url) return `<span class="artifact-ref-missing" title="Artifact not available here">${innerHtml}</span>`;
  return openLink(url, innerHtml, 'artifact-link');
}
