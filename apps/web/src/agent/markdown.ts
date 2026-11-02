import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { renderArtifactImage, renderArtifactLink, type ArtifactResolver } from './artifact-refs.js';

/**
 * One configured `marked` per resolver, because `artifact:` references need
 * the page's resolver at render time and `marked`'s global options are shared
 * by every caller. The `null` instance still recognises a reference — so a
 * transcript with no artifact route (a coding session, an approval sheet)
 * shows the file name as text rather than a link that goes nowhere.
 */
const instances = new WeakMap<ArtifactResolver, Marked>();
let plainInstance: Marked | null = null;

function markedFor(resolve: ArtifactResolver | null): Marked {
  if (resolve) {
    const cached = instances.get(resolve);
    if (cached) return cached;
  } else if (plainInstance) {
    return plainInstance;
  }
  const instance = new Marked({ gfm: true, breaks: true });
  instance.use({
    renderer: {
      image(token: Tokens.Image) {
        return renderArtifactImage(token.href, token.text, resolve) ?? false;
      },
      link(token: Tokens.Link) {
        const inner = this.parser.parseInline(token.tokens);
        return renderArtifactLink(token.href, inner, resolve) ?? false;
      },
    },
  });
  if (resolve) instances.set(resolve, instance);
  else plainInstance = instance;
  return instance;
}

/** Markdown to HTML, unsanitized. Exported for tests; render with `renderMarkdown`. */
export function markdownToHtml(source: string, resolveArtifact: ArtifactResolver | null = null): string {
  return markedFor(resolveArtifact).parse(source, { async: false });
}

/**
 * Render agent prose to HTML.
 *
 * The output is model-generated and may contain anything, so it is sanitized
 * before it reaches the DOM — this is untrusted content even though it comes
 * from our own server. `ADD_ATTR: target` lets links open in a new tab without
 * the sanitizer stripping the attribute. `resolveArtifact` turns a Pocket
 * Agent's `artifact:<name>` reference into its artifact route (see
 * `artifact-refs.ts`); the sanitizer still runs over the result.
 */
export function renderMarkdown(source: string, resolveArtifact: ArtifactResolver | null = null): string {
  const html = markdownToHtml(source, resolveArtifact);
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel', 'loading'],
    FORBID_TAGS: ['style', 'form', 'input', 'button'],
    FORBID_ATTR: ['style', 'onerror', 'onload'],
  });
}

/** Plain-text preview for notifications and list rows. */
export function toPlainText(source: string, max = 140): string {
  const text = source
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/[*_`#>]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
