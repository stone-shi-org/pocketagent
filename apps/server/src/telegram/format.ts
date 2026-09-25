/**
 * PA-105: the model's Markdown → Telegram's HTML subset, and the splitter
 * that decides where one Telegram message ends and the next begins.
 *
 * Both are pure, and both exist because Telegram renders formatting only
 * when `sendMessage` is given a `parse_mode`, and what it renders is not the
 * Markdown an LLM writes. It has no headings, tables or real lists.
 *
 * **HTML, not MarkdownV2.** MarkdownV2 needs 18 characters escaped everywhere
 * outside formatting. One missed `.` or `-` makes Telegram answer
 * `400 can't parse entities`, and nothing is delivered. HTML needs `&`, `<`
 * and `>` escaped and nothing else, so a converter bug is far less likely to
 * cost a message. The sender (`send.ts`) still falls back to plain text when
 * one does.
 *
 * **Emit-only allowlist, never a sanitiser.** Model output and tool
 * arguments are untrusted (a webhook-driven chat can carry Jira text). So
 * every run of source text is escaped *before* any tag exists, and the only
 * markup that can appear in the output is what this file writes: `b i s code
 * pre a blockquote`. An `<a href>` is written only for an `http:`/`https:`
 * URL. HTML in the source is never passed through, because there is no path
 * that could pass it. That is also why this is hand-rolled rather than
 * `marked` (a web dependency). A general renderer's output would have to be
 * sanitised back down, and "render everything, then remove the dangerous
 * parts" is the posture this file exists to avoid.
 *
 * Every tag is opened and closed by the same call, so the output is balanced
 * by construction. That is what lets the splitter cut the *Markdown* and
 * convert each piece independently: no tag can span two messages.
 */

/** Telegram's hard cap on one message, counted in UTF-16 code units of the
    text *after* entities are parsed out. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** What the splitter aims for. The slack below the hard cap is for a cut
    landing next to a multi-unit character, and for anything this file
    counts differently from Telegram. */
export const TELEGRAM_CHUNK_LIMIT = 3800;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

/**
 * The length Telegram will count for `html`: tags removed, entities
 * decoded. This is exact for this file's own output, because escaped text
 * cannot contain a literal `<`, so every `<…>` is a tag this file wrote.
 */
export function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&(?:lt|gt|amp|quot);/g, '_').length;
}

// ---- inline --------------------------------------------------------------

type InlineMode = 'html' | 'plain';

/** CommonMark's backslash-escapable set. */
const ESCAPABLE = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
const WORD_CHAR = /[\p{L}\p{N}]/u;
const HTTP_URL = /^https?:\/\/[^\s<>]+$/i;

function runLength(src: string, at: number, ch: string): number {
  let n = 0;
  while (src[at + n] === ch) n++;
  return n;
}

/** Index of a backtick run of exactly `run` characters at or after `from`,
    or -1. A longer or shorter run does not close a code span. */
function findBacktickClose(src: string, from: number, run: number): number {
  let j = from;
  while (j < src.length) {
    if (src[j] === '`') {
      const n = runLength(src, j, '`');
      if (n === run) return j;
      j += n;
    } else {
      j++;
    }
  }
  return -1;
}

/**
 * Where an emphasis opened at `from` with `delim` closes, or -1. Code spans
 * and backslash escapes are skipped, so a `*` inside backticks never closes
 * anything. The closer must be a run of exactly `delim.length`, must follow
 * non-whitespace, and, for `_`, must not be followed by a letter or digit.
 * That last rule is what keeps `snake_case_names` literal.
 */
function findEmphasisClose(src: string, from: number, delim: string): number {
  const ch = delim[0]!;
  let j = from;
  while (j < src.length) {
    const c = src[j]!;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') {
      const run = runLength(src, j, '`');
      const close = findBacktickClose(src, j + run, run);
      j = close >= 0 ? close + run : j + run;
      continue;
    }
    if (c === ch) {
      const run = runLength(src, j, ch);
      const prev = src[j - 1];
      const next = src[j + run];
      if (
        run === delim.length &&
        j > from &&
        prev !== undefined &&
        !/\s/.test(prev) &&
        !(ch === '_' && next !== undefined && WORD_CHAR.test(next))
      ) {
        return j;
      }
      j += run;
      continue;
    }
    j++;
  }
  return -1;
}

interface ParsedLink {
  text: string;
  url: string;
  end: number;
}

/** `[text](url "title")` starting at `src[at] === '['`, brackets and parens
    matched by depth so `[a [b]](https://x/(y))` parses whole. */
function parseLink(src: string, at: number): ParsedLink | null {
  let depth = 0;
  let j = at;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) break;
  }
  if (j >= src.length || src[j + 1] !== '(') return null;
  const textEnd = j;
  depth = 0;
  let k = j + 1;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) break;
  }
  if (k >= src.length) return null;
  let url = src.slice(textEnd + 2, k).trim();
  if (url.startsWith('<')) {
    const close = url.indexOf('>');
    url = close >= 0 ? url.slice(1, close) : url;
  } else {
    url = url.split(/\s+/)[0] ?? '';
  }
  return { text: src.slice(at + 1, textEnd), url, end: k + 1 };
}

const EMPHASIS_TAGS: Record<string, Record<number, string[]>> = {
  '*': { 1: ['i'], 2: ['b'], 3: ['b', 'i'] },
  _: { 1: ['i'], 2: ['b'], 3: ['b', 'i'] },
  '~': { 2: ['s'] },
};

function wrap(tags: string[], inner: string): string {
  return (
    tags.map((t) => `<${t}>`).join('') +
    inner +
    [...tags]
      .reverse()
      .map((t) => `</${t}>`)
      .join('')
  );
}

function renderInline(src: string, mode: InlineMode, inLink = false): string {
  const text = (s: string) => (mode === 'html' ? escapeHtml(s) : s);
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.has(src[i + 1]!)) {
      out += text(src[i + 1]!);
      i += 2;
      continue;
    }

    if (ch === '`') {
      const run = runLength(src, i, '`');
      const close = findBacktickClose(src, i + run, run);
      if (close >= 0) {
        let code = src.slice(i + run, close);
        if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) {
          code = code.slice(1, -1);
        }
        out += mode === 'html' ? `<code>${escapeHtml(code)}</code>` : code;
        i = close + run;
        continue;
      }
      // An unmatched backtick run is literal text, never an open code span.
      out += text(src.slice(i, i + run));
      i += run;
      continue;
    }

    if (!inLink && (ch === '[' || (ch === '!' && src[i + 1] === '['))) {
      const link = parseLink(src, ch === '!' ? i + 1 : i);
      if (link) {
        const label = renderInline(link.text, mode, true);
        if (HTTP_URL.test(link.url)) {
          out +=
            mode === 'html'
              ? `<a href="${escapeAttr(link.url)}">${label || escapeHtml(link.url)}</a>`
              : `${label} (${link.url})`;
        } else {
          // Not http(s): keep both halves as text, so nothing is lost and
          // nothing becomes a link. `javascript:` ends up as words.
          out += link.url ? `${label} (${text(link.url)})` : label;
        }
        i = link.end;
        continue;
      }
    }

    if (!inLink && ch === '<') {
      const auto = /^<(https?:\/\/[^\s<>]+)>/i.exec(src.slice(i));
      if (auto) {
        const url = auto[1]!;
        out += mode === 'html' ? `<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>` : url;
        i += auto[0].length;
        continue;
      }
    }

    const tagsByLen = EMPHASIS_TAGS[ch];
    if (tagsByLen) {
      const run = runLength(src, i, ch);
      const prev = src[i - 1];
      let matched = false;
      for (const len of [3, 2, 1]) {
        const tags = tagsByLen[len];
        if (!tags || len > run) continue;
        const next = src[i + len];
        if (next === undefined || /\s/.test(next)) continue;
        if (ch === '_' && prev !== undefined && WORD_CHAR.test(prev)) continue;
        const close = findEmphasisClose(src, i + len, ch.repeat(len));
        if (close < 0) continue;
        const inner = renderInline(src.slice(i + len, close), mode, inLink);
        out += mode === 'html' ? wrap(tags, inner) : inner;
        i = close + len;
        matched = true;
        break;
      }
      if (matched) continue;
      out += text(src.slice(i, i + run));
      i += run;
      continue;
    }

    out += text(ch);
    i++;
  }
  return out;
}

/** Inline Markdown rendered with its markers removed, for places a tag is
    not allowed (a table inside `<pre>`, a plain-text fallback). */
export function markdownInlineToPlain(src: string): string {
  return renderInline(src, 'plain');
}

// ---- blocks --------------------------------------------------------------

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>/;
const TABLE_SEP_CELL = /^\s*:?-+:?\s*$/;

interface Fence {
  indent: number;
  marker: string;
  lang: string | null;
}

function parseFenceOpen(line: string): Fence | null {
  const m = FENCE_OPEN.exec(line);
  if (!m) return null;
  const marker = m[2]!;
  const info = m[3]!.trim();
  // A backtick fence's info string may not contain a backtick, or
  // ```` ```code``` ```` on one line would open a fence.
  if (marker[0] === '`' && info.includes('`')) return null;
  const lang = /^[A-Za-z0-9_+#.-]{1,32}/.exec(info)?.[0] ?? null;
  return { indent: m[1]!.length, marker, lang };
}

function isFenceClose(line: string, fence: Fence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return !!m && m[1]![0] === fence.marker[0] && m[1]!.length >= fence.marker.length;
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isTableSeparator(line: string | undefined): boolean {
  if (line === undefined || !line.includes('-')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => TABLE_SEP_CELL.test(c));
}

function isTableStart(lines: string[], i: number): boolean {
  return lines[i]!.includes('|') && isTableSeparator(lines[i + 1]);
}

/** Code points rather than UTF-16 units, so an emoji is one column. East
    Asian wide characters still misalign; `<pre>` is best effort there. */
function displayWidth(s: string): number {
  return [...s].length;
}

function renderTable(header: string, sep: string, rows: string[]): string {
  const align = splitTableRow(sep).map((c) => {
    const t = c.trim();
    if (t.startsWith(':') && t.endsWith(':')) return 'center';
    return t.endsWith(':') ? 'right' : 'left';
  });
  const grid = [header, ...rows].map((r) => splitTableRow(r).map(markdownInlineToPlain));
  const cols = Math.max(...grid.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(1, ...grid.map((r) => displayWidth(r[c] ?? ''))),
  );
  const pad = (s: string, c: number) => {
    const gap = widths[c]! - displayWidth(s);
    if (align[c] === 'right') return ' '.repeat(gap) + s;
    if (align[c] === 'center')
      return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(Math.ceil(gap / 2));
    return s + ' '.repeat(gap);
  };
  const line = (r: string[]) =>
    widths
      .map((_, c) => pad(r[c] ?? '', c))
      .join(' | ')
      .trimEnd();
  const body = [
    line(grid[0]!),
    widths.map((w) => '-'.repeat(w)).join('-+-'),
    ...grid.slice(1).map(line),
  ];
  return `<pre>${escapeHtml(body.join('\n'))}</pre>`;
}

/** One line that is not part of a fence, table or quote. */
function renderLine(line: string): string {
  if (HR.test(line)) return '──────────';
  const heading = HEADING.exec(line);
  if (heading) {
    const inner = renderInline(heading[2]!, 'html');
    return inner ? `<b>${inner}</b>` : '';
  }
  const bullet = BULLET.exec(line);
  if (bullet) {
    const indent = '  '.repeat(Math.floor(bullet[1]!.replace(/\t/g, '    ').length / 2));
    let item = bullet[2]!;
    let marker = '•';
    const task = /^\[([ xX])\]\s+/.exec(item);
    if (task) {
      marker = task[1] === ' ' ? '☐' : '☑';
      item = item.slice(task[0].length);
    }
    return `${indent}${marker} ${renderInline(item, 'html')}`;
  }
  const ordered = ORDERED.exec(line);
  if (ordered) {
    const indent = '  '.repeat(Math.floor(ordered[1]!.replace(/\t/g, '    ').length / 2));
    return `${indent}${ordered[2]}. ${renderInline(ordered[3]!, 'html')}`;
  }
  return renderInline(line, 'html');
}

/**
 * Convert one message's worth of Markdown to Telegram HTML.
 *
 * Inline formatting is matched within a line, never across one: an LLM
 * writes paragraphs as single lines, and a `**` left open on one line must
 * not swallow the rest of the message.
 */
export function markdownToTelegramHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const fence = parseFenceOpen(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i]!, fence)) {
        const l = lines[i]!;
        body.push(l.slice(Math.min(fence.indent, l.length - l.trimStart().length)));
        i++;
      }
      i++; // the closing fence, or past the end when it was never closed
      const code = body.join('\n');
      if (code.trim()) {
        out.push(
          fence.lang
            ? `<pre><code class="language-${escapeAttr(fence.lang)}">${escapeHtml(code)}</code></pre>`
            : `<pre>${escapeHtml(code)}</pre>`,
        );
      }
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = line;
      const sep = lines[i + 1]!;
      const rows: string[] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|'))
        rows.push(lines[i++]!);
      out.push(renderTable(header, sep, rows));
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        inner.push(renderLine(lines[i]!.replace(/^ {0,3}> ?/, '')));
        i++;
      }
      const joined = inner.join('\n').replace(/^\n+|\n+$/g, '');
      // Quote content is rendered line by line (no fences or tables) so a
      // `<pre>` never lands inside a `<blockquote>`.
      if (visibleLength(joined) > 0) out.push(`<blockquote>${joined}</blockquote>`);
      continue;
    }

    out.push(line.trim() ? renderLine(line.trimEnd()) : '');
    i++;
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- splitting -----------------------------------------------------------

interface Block {
  lines: string[];
  /** Lines every piece of this block must repeat when it is split: a
      fence's opener and closer, a table's header and separator. */
  prefix: string[];
  suffix: string[];
}

function toBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let text: string[] = [];
  const flushText = () => {
    if (text.length === 0) return;
    if (text.length >= 2 && isTableStart(text, 0)) {
      blocks.push({ prefix: text.slice(0, 2), lines: text.slice(2), suffix: [] });
    } else {
      blocks.push({ prefix: [], lines: text, suffix: [] });
    }
    text = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = parseFenceOpen(line);
    if (fence) {
      flushText();
      const body: string[] = [];
      i++;
      let close = fence.marker;
      while (i < lines.length && !isFenceClose(lines[i]!, fence)) body.push(lines[i++]!);
      if (i < lines.length) close = lines[i]!;
      i++;
      blocks.push({ prefix: [line], lines: body, suffix: [close] });
      continue;
    }
    if (!line.trim()) flushText();
    else text.push(line);
    i++;
  }
  flushText();
  return blocks;
}

function blockText(prefix: string[], lines: string[], suffix: string[]): string {
  return [...prefix, ...lines, ...suffix].join('\n');
}

/** Cut `s` into slices of at most `max` UTF-16 units, preferring whitespace
    and never splitting a surrogate pair. */
function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, '');
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Split `md` into pieces that each fit one Telegram message, on block
 * boundaries: paragraphs first, never inside a fence (an oversized fence
 * becomes several complete fences with the same language), a table's
 * header repeated on every piece. Only a single line longer than a whole
 * message is cut mid-line.
 *
 * A piece fits when *both* its raw length and its converted visible length
 * are under `limit`. The raw bound is what the plain-text fallback sends;
 * the converted one is what Telegram counts, and a padded table can be
 * longer than its source.
 *
 * `rich: false` measures raw length only, for text that is sent plain.
 */
export function splitMarkdownForTelegram(
  md: string,
  opts: { limit?: number; rich?: boolean } = {},
): string[] {
  const limit = opts.limit ?? TELEGRAM_CHUNK_LIMIT;
  const rich = opts.rich ?? true;
  const measure = (s: string) =>
    rich ? Math.max(s.length, visibleLength(markdownToTelegramHtml(s))) : s.length;
  const trimmed = md.trim();
  if (!trimmed) return [];
  if (measure(trimmed) <= limit) return [trimmed];

  const pieces: string[] = [];
  for (const block of toBlocks(trimmed)) {
    const whole = blockText(block.prefix, block.lines, block.suffix);
    if (measure(whole) <= limit) {
      pieces.push(whole);
      continue;
    }
    const frame = blockText(block.prefix, [], block.suffix).length + 2;
    // A line that could never fit, even alone in its frame, is cut first.
    const lineMax = Math.max(1, limit - frame);
    const lines = block.lines.flatMap((l) => (l.length > lineMax ? hardSplit(l, lineMax) : [l]));
    let current: string[] = [];
    for (const line of lines) {
      const candidate = [...current, line];
      if (current.length > 0 && measure(blockText(block.prefix, candidate, block.suffix)) > limit) {
        pieces.push(blockText(block.prefix, current, block.suffix));
        current = [line];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) pieces.push(blockText(block.prefix, current, block.suffix));
  }

  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    const candidate = current ? `${current}\n\n${piece}` : piece;
    if (current && measure(candidate) > limit) {
      chunks.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
