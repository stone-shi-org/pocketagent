import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  gfm: true,
  breaks: true,
});

/**
 * Render agent prose to HTML.
 *
 * The output is model-generated and may contain anything, so it is sanitized
 * before it reaches the DOM — this is untrusted content even though it comes
 * from our own server. `ADD_ATTR: target` lets links open in a new tab without
 * the sanitizer stripping the attribute.
 */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false });
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
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
