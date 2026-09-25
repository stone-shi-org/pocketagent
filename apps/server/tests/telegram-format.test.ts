import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_MESSAGE_LIMIT,
  escapeHtml,
  markdownToTelegramHtml,
  splitMarkdownForTelegram,
  visibleLength,
} from '../src/telegram/format.js';

/**
 * PA-105: the Markdown → Telegram HTML converter and the block-aware
 * splitter. Both are pure, so everything is driven directly. The fixtures
 * are shaped like real Pocket Agent replies (headings, a checklist, a table,
 * a fenced block) because that is the Markdown an LLM actually writes, and
 * none of it exists in Telegram's own subset.
 */

const ALLOWED_TAGS = new Set(['b', 'i', 's', 'code', 'pre', 'a', 'blockquote']);

/** Asserts `html` contains only allowlisted tags, correctly nested, and
    that every attribute is one this converter may write. A converter bug
    that produced anything else would be a Telegram 400, or worse, markup
    from the source reaching the output. */
function assertWellFormed(html: string): void {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z]+)([^>]*)>/g)) {
    const [, closing, tag, attrs] = m;
    expect(ALLOWED_TAGS.has(tag!), `unexpected tag <${tag}>`).toBe(true);
    if (closing) {
      expect(stack.pop(), `mismatched </${tag}>`).toBe(tag);
    } else {
      if (tag === 'a') expect(attrs).toMatch(/^ href="https?:\/\/[^"]*"$/);
      else if (tag === 'code') expect(attrs).toMatch(/^(| class="language-[A-Za-z0-9_+#.-]+")$/);
      else expect(attrs).toBe('');
      stack.push(tag!);
    }
  }
  expect(stack).toEqual([]);
  // Every `<` / `>` / `&` outside a tag is escaped.
  const text = html.replace(/<[^>]*>/g, '');
  expect(text).not.toMatch(/[<>]/);
  expect(text).not.toMatch(/&(?!(?:lt|gt|amp|quot);)/);
}

function decode(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// A reply in the shape the planner model writes: recorded from a Pocket
// Agent chat and trimmed.
const RECORDED_REPLY = `## Summary

I fixed **two bugs** in \`bridge.ts\` and _one_ in snake_case_file.py:

1. The \`sendChunked\` loop split *inside* fences.
2. See [the Bot API docs](https://core.telegram.org/bots/api#html-style).

- [x] tests pass
- [ ] docs
  - nested ~~old~~ item

| File | Lines |
|------|------:|
| **bridge.ts** | 12 |
| format.ts | 400 |

> Note: 2 * 3 < 7 & a_b

\`\`\`ts
const x = a < b && c > d; // **not bold**
\`\`\`

Done!`;

describe('markdownToTelegramHtml', () => {
  it('renders a recorded reply into Telegram-legible HTML', () => {
    expect(markdownToTelegramHtml(RECORDED_REPLY)).toBe(
      [
        '<b>Summary</b>',
        '',
        'I fixed <b>two bugs</b> in <code>bridge.ts</code> and <i>one</i> in snake_case_file.py:',
        '',
        '1. The <code>sendChunked</code> loop split <i>inside</i> fences.',
        '2. See <a href="https://core.telegram.org/bots/api#html-style">the Bot API docs</a>.',
        '',
        '☑ tests pass',
        '☐ docs',
        '  • nested <s>old</s> item',
        '',
        '<pre>File      | Lines',
        '----------+------',
        'bridge.ts |    12',
        'format.ts |   400</pre>',
        '',
        '<blockquote>Note: 2 * 3 &lt; 7 &amp; a_b</blockquote>',
        '',
        '<pre><code class="language-ts">const x = a &lt; b &amp;&amp; c &gt; d; // **not bold**</code></pre>',
        '',
        'Done!',
      ].join('\n'),
    );
  });

  it('delivers <, &, _, *, . and unmatched backticks intact', () => {
    const src =
      'if a < b && c > d: x_y = 2 * 3. Use ` or ``` here, 1.5 * 2_000 and _leading and trailing_ ok.';
    const html = markdownToTelegramHtml(src);
    assertWellFormed(html);
    // `_leading and trailing_` is legitimately italic; everything else is text.
    expect(decode(html)).toBe(src.replace('_leading and trailing_', 'leading and trailing'));
  });

  it('escapes HTML in the source instead of passing any of it through', () => {
    const html = markdownToTelegramHtml(
      '<b>hi</b> <a href="javascript:x">y</a> <script>alert(1)</script> &amp;',
    );
    assertWellFormed(html);
    expect(html).toBe(
      '&lt;b&gt;hi&lt;/b&gt; &lt;a href="javascript:x"&gt;y&lt;/a&gt; &lt;script&gt;alert(1)&lt;/script&gt; &amp;amp;',
    );
  });

  it('links only http(s) URLs, and keeps the others as text', () => {
    expect(markdownToTelegramHtml('[a](https://x.test/p?q=1&r="2")')).toBe(
      '<a href="https://x.test/p?q=1&amp;r=&quot;2&quot;">a</a>',
    );
    expect(markdownToTelegramHtml('[click](javascript:alert(1))')).toBe(
      'click (javascript:alert(1))',
    );
    expect(markdownToTelegramHtml('[f](file:///etc/passwd)')).toBe('f (file:///etc/passwd)');
    expect(markdownToTelegramHtml('<https://x.test>')).toBe(
      '<a href="https://x.test">https://x.test</a>',
    );
    expect(markdownToTelegramHtml('[](https://x.test)')).toBe(
      '<a href="https://x.test">https://x.test</a>',
    );
    expect(markdownToTelegramHtml('arr[0] and [not a link]')).toBe('arr[0] and [not a link]');
  });

  it('never parses inside code, and sanitises the fence language', () => {
    expect(markdownToTelegramHtml('`**x** <y>`')).toBe('<code>**x** &lt;y&gt;</code>');
    expect(markdownToTelegramHtml('```"><script>\nx\n```')).toBe('<pre>x</pre>');
    expect(markdownToTelegramHtml('~~~python extra words\nprint(1)\n~~~')).toBe(
      '<pre><code class="language-python">print(1)</code></pre>',
    );
  });

  it('renders an unclosed fence to the end rather than dropping it', () => {
    expect(markdownToTelegramHtml('before\n```\nstill code\n**x**')).toBe(
      'before\n<pre>still code\n**x**</pre>',
    );
  });

  it('honours backslash escapes and leaves unmatched markers literal', () => {
    expect(markdownToTelegramHtml('\\*not italic\\* and **open')).toBe('*not italic* and **open');
    expect(markdownToTelegramHtml('a ~single~ tilde')).toBe('a ~single~ tilde');
  });

  it('does not let an emphasis marker close inside a code span', () => {
    const html = markdownToTelegramHtml('*a `*` b*');
    assertWellFormed(html);
    expect(html).toBe('<i>a <code>*</code> b</i>');
  });

  it('stays well-formed on adversarial input', () => {
    // Deterministic pseudo-random soup of every marker the converter reacts to.
    const alphabet = [
      '*',
      '_',
      '~',
      '`',
      '[',
      ']',
      '(',
      ')',
      '<',
      '>',
      '&',
      '#',
      '|',
      '-',
      '\\',
      '"',
      'a',
      ' ',
      '\n',
      'https://x.y',
      ':',
      '!',
    ];
    let seed = 105;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let n = 0; n < 300; n++) {
      let src = '';
      for (let k = 0; k < 80; k++) src += alphabet[Math.floor(rand() * alphabet.length)];
      assertWellFormed(markdownToTelegramHtml(src));
    }
  });

  it('escapeHtml touches exactly &, < and >', () => {
    expect(escapeHtml(`<&>"'_*.`)).toBe(`&lt;&amp;&gt;"'_*.`);
  });
});

describe('splitMarkdownForTelegram', () => {
  const fits = (chunk: string) => {
    expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(visibleLength(markdownToTelegramHtml(chunk))).toBeLessThanOrEqual(
      TELEGRAM_MESSAGE_LIMIT,
    );
  };
  const fenceCount = (chunk: string) => chunk.split('\n').filter((l) => /^```/.test(l)).length;

  it('returns a short message unchanged, and nothing for blank input', () => {
    expect(splitMarkdownForTelegram('  hello  ')).toEqual(['hello']);
    expect(splitMarkdownForTelegram('   \n ')).toEqual([]);
  });

  it('splits on paragraph boundaries and loses no text', () => {
    const paragraphs = Array.from(
      { length: 30 },
      (_, i) => `Paragraph ${i} ` + 'word '.repeat(60).trim(),
    );
    const chunks = splitMarkdownForTelegram(paragraphs.join('\n\n'));
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach(fits);
    expect(chunks.join('\n\n')).toBe(paragraphs.join('\n\n'));
  });

  it('never cuts inside a fence; an oversized one becomes several complete fences', () => {
    const code = Array.from({ length: 900 }, (_, i) => `print("line ${i}")`).join('\n');
    const md = `Intro text.\n\n\`\`\`python\n${code}\n\`\`\`\n\nOutro text.`;
    const chunks = splitMarkdownForTelegram(md);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      fits(chunk);
      expect(fenceCount(chunk) % 2).toBe(0);
      assertWellFormed(markdownToTelegramHtml(chunk));
    }
    const fenced = chunks.filter((c) => c.includes('```python'));
    expect(fenced.length).toBeGreaterThan(1);
    // Every code line arrives exactly once, in order.
    const lines = chunks.flatMap((c) => c.split('\n')).filter((l) => l.startsWith('print('));
    expect(lines).toEqual(code.split('\n'));
    expect(chunks[0]!.startsWith('Intro text.')).toBe(true);
    expect(chunks.at(-1)!.endsWith('Outro text.')).toBe(true);
  });

  it("repeats a split table's header on every piece", () => {
    const rows = Array.from({ length: 400 }, (_, i) => `| row ${i} | ${'v'.repeat(10)} |`);
    const md = ['| Name | Value |', '|---|---|', ...rows].join('\n');
    const chunks = splitMarkdownForTelegram(md);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      fits(chunk);
      expect(chunk.startsWith('| Name | Value |\n|---|---|\n')).toBe(true);
      expect(markdownToTelegramHtml(chunk).startsWith('<pre>')).toBe(true);
    }
  });

  it('measures the converted length too, since a padded table can outgrow its source', () => {
    // Narrow source cells, one very wide one: padding every row to that
    // width makes the rendered table several times longer than the Markdown.
    const rows = Array.from({ length: 120 }, (_, i) => `|${i}|x|`);
    const md = ['|a|b|', '|-|-|', `|${'w'.repeat(40)}|y|`, ...rows].join('\n');
    expect(md.length).toBeLessThan(TELEGRAM_MESSAGE_LIMIT);
    const chunks = splitMarkdownForTelegram(md, { limit: 1000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(visibleLength(markdownToTelegramHtml(chunk))).toBeLessThanOrEqual(1000);
    }
  });

  it('hard-splits only a single line longer than a whole message, without breaking a surrogate pair', () => {
    const line = '😀'.repeat(3000); // 6000 UTF-16 units, no whitespace
    const chunks = splitMarkdownForTelegram(line);
    expect(chunks.length).toBe(2);
    chunks.forEach(fits);
    expect(chunks.join('')).toBe(line);
    for (const c of chunks) expect(c).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
  });

  it('plain mode measures raw length only', () => {
    const md = Array.from({ length: 20 }, () => 'x'.repeat(300)).join('\n\n');
    const chunks = splitMarkdownForTelegram(md, { rich: false, limit: 1000 });
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(1000));
    expect(chunks.join('\n\n')).toBe(md);
  });
});
