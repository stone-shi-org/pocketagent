import { copyText } from './clipboard.js';

const COPY_SVG =
  '<svg class="copy-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span class="copy-label">Copy</span>';

const CHECK_SVG =
  '<svg class="copy-icon check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg><span class="copy-label">Copied!</span>';

/**
 * Enhances all `<pre>` code blocks inside a rendered markdown answer:
 * - Wraps `<pre>` in a `.code-block-container`
 * - Adds a `.code-block-header` with detected language badge and a copy button
 */
export function enhanceCodeBlocks(container: HTMLElement | null): void {
  if (!container || typeof document === 'undefined') return;
  const pres = container.querySelectorAll('pre');
  pres.forEach((pre) => {
    if (pre.parentElement?.classList.contains('code-block-container')) return;

    const codeEl = pre.querySelector('code');
    const langMatch = codeEl?.className.match(/language-([a-zA-Z0-9_+-]+)/);
    const lang = langMatch ? langMatch[1] : '';

    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-container';

    const header = document.createElement('div');
    header.className = 'code-block-header';

    const langSpan = document.createElement('span');
    langSpan.className = 'code-block-lang';
    langSpan.textContent = lang || 'code';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'code-copy-btn';
    copyBtn.setAttribute('aria-label', 'Copy code block');
    copyBtn.setAttribute('title', 'Copy code');
    copyBtn.innerHTML = COPY_SVG;

    header.appendChild(langSpan);
    header.appendChild(copyBtn);

    pre.parentNode?.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
  });
}

/**
 * Handles click on copy button within an enhanced code block container via event delegation.
 */
export function handleCodeBlockClick(e: React.MouseEvent<HTMLElement> | MouseEvent): void {
  const target = e.target as HTMLElement | null;
  const btn = target?.closest<HTMLButtonElement>('.code-copy-btn');
  if (!btn) return;

  const wrapper = btn.closest('.code-block-container');
  const pre = wrapper?.querySelector('pre');
  if (!pre) return;

  const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
  void copyText(code).then((ok) => {
    if (ok) {
      btn.classList.add('copied');
      btn.innerHTML = CHECK_SVG;
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = COPY_SVG;
      }, 1600);
    }
  });
}
