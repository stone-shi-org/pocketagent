import { describe, expect, it } from 'vitest';
import { SpokenTextExtractor } from '../src/voice/spoken-text-extractor.js';
import { SpokenTextPipeline } from '../src/voice/spoken-text-pipeline.js';

/**
 * PA-84. Two properties carry this feature, and both are asserted here rather
 * than described: a tagged reply speaks *only* its `<speak>` block, and an
 * untagged one still speaks — with the unspeakable parts removed — because
 * silence would read as a broken microphone.
 *
 * Every case feeds text one delta at a time, because delta boundaries are
 * streaming timing rather than syntax: the interesting bugs are all a tag or a
 * fence split across two of them.
 */

/** Feeds deltas and returns everything the extractor released, turn included. */
function speak(extractor: SpokenTextExtractor, deltas: string[]): string {
  let out = '';
  for (const delta of deltas) out += extractor.push(delta);
  out += extractor.flush();
  return out;
}

/** Splits text into `size`-character deltas — the pathological streaming case. */
function chop(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}

describe('SpokenTextExtractor — tagged replies', () => {
  it('speaks only the tagged summary, never the written reply', () => {
    const out = speak(new SpokenTextExtractor(), [
      '<speak>I fixed the auth bug by adding a null check.</speak>\n\n',
      "Here's the change:\n\n```ts\nif (user == null) return;\n```\n",
      'It lives in `apps/server/src/auth/index.ts`.\n',
    ]);
    expect(out.trim()).toBe('I fixed the auth bug by adding a null check.');
  });

  it('survives an opening tag split across deltas', () => {
    const out = speak(new SpokenTextExtractor(), ['<spe', 'ak>', 'All done.', '</speak>rest']);
    expect(out.trim()).toBe('All done.');
  });

  it('survives a closing tag split across deltas, and never speaks the markup', () => {
    const out = speak(new SpokenTextExtractor(), ['<speak>All done.</', 'speak>', 'the reply']);
    expect(out.trim()).toBe('All done.');
    expect(out).not.toContain('speak');
  });

  it('survives the whole reply arriving one character at a time', () => {
    const out = speak(
      new SpokenTextExtractor(),
      chop('<speak>Tests pass.</speak>\nDetails in `foo/bar.ts`.\n', 1),
    );
    expect(out.trim()).toBe('Tests pass.');
  });

  it('speaks several tagged blocks in order', () => {
    const out = speak(new SpokenTextExtractor(), [
      '<speak>First part done.</speak>\nnoise\n<speak>Second part too.</speak>\nmore noise',
    ]);
    expect(out.replace(/\s+/g, ' ').trim()).toBe('First part done. Second part too.');
  });

  it('flushes the content of a tag the turn ended before closing', () => {
    // An interrupted or truncated reply still said something worth hearing.
    const out = speak(new SpokenTextExtractor(), ['<speak>I was part way through']);
    expect(out.trim()).toBe('I was part way through');
  });

  it('tolerates leading whitespace before the tag', () => {
    const out = speak(new SpokenTextExtractor(), ['\n\n  <speak>Fine.</speak>\nbody']);
    expect(out.trim()).toBe('Fine.');
  });

  it('speaks tagged summary when tag arrives after short greeting in same delta', () => {
    const out = speak(new SpokenTextExtractor(), [
      'Sure! <speak>Today in Kirkland is sunny with a high of 66.</speak>\n\n',
      'Here is the detailed weather forecast:\n',
      '- Wind: 5mph\n- Humidity: 40%\n',
    ]);
    expect(out.trim()).toBe('Today in Kirkland is sunny with a high of 66.');
  });

  it('switches to tagged mode and drops post-tag prose if speak tag appears in a later delta', () => {
    const out = speak(new SpokenTextExtractor(), [
      'I will look that up for you.\n',
      '<speak>Found the result: everything passed.</speak>\n',
      'Details in log files.\n',
    ]);
    expect(out).toContain('Found the result: everything passed.');
    expect(out).not.toContain('Details in log files');
  });
});

describe('SpokenTextExtractor — untagged fallback', () => {
  it('speaks prose mid-turn, before any turn_complete (PA-20 stays incremental)', () => {
    // The regression that matters most: a reply must not be held back waiting
    // to see whether a tag shows up later.
    const extractor = new SpokenTextExtractor();
    expect(extractor.push('Once only. ')).toContain('Once only.');
  });

  it('drops a fenced code block but keeps the prose around it', () => {
    const out = speak(new SpokenTextExtractor(), [
      'I updated the handler.\n',
      '```ts\nconst x = 1;\nif (x) throw new Error("boom");\n```\n',
      'That should do it.\n',
    ]);
    expect(out).toContain('I updated the handler.');
    expect(out).toContain('That should do it.');
    expect(out).not.toContain('throw');
    expect(out).not.toContain('const');
  });

  it('drops a fence whose delimiter is split across deltas', () => {
    const out = speak(new SpokenTextExtractor(), [
      'Before.\n',
      '``',
      '`js\n',
      'secret_code_line();\n',
      '```\n',
      'After.\n',
    ]);
    expect(out).toContain('Before.');
    expect(out).toContain('After.');
    expect(out).not.toContain('secret_code_line');
  });

  it('keeps a word-like inline code span and drops a path-like one', () => {
    const out = speak(new SpokenTextExtractor(), [
      'I added a `null` check in `apps/server/src/auth/index.ts` today.\n',
    ]);
    expect(out).toContain('null');
    expect(out).not.toContain('apps/server');
  });

  it('drops URLs and reads a link as its text', () => {
    const out = speak(new SpokenTextExtractor(), [
      'See [the docs](https://example.com/a/b) or https://example.com/raw for more.\n',
    ]);
    expect(out).toContain('the docs');
    expect(out).not.toContain('example.com');
  });

  it('drops table rows and markdown furniture', () => {
    const out = speak(new SpokenTextExtractor(), [
      '## Summary\n',
      '| file | change |\n| --- | --- |\n| a.ts | edited |\n',
      '- Fixed the parser\n',
      '1. Ran the tests\n',
    ]);
    expect(out).toContain('Summary');
    expect(out).toContain('Fixed the parser');
    expect(out).toContain('Ran the tests');
    expect(out).not.toContain('|');
    expect(out).not.toContain('-');
    expect(out).not.toContain('#');
  });

  it('speaks nothing for a reply that is only code', () => {
    // Documented consequence rather than an accident: there is no prose to say.
    const out = speak(new SpokenTextExtractor(), ['```sh\nrm -rf /tmp/x\n```\n']);
    expect(out.trim()).toBe('');
  });

  it('strips the markup when a model emits the tag late instead of first', () => {
    // The accepted cost of deciding early: both halves are spoken, but the
    // tag itself is never pronounced as letters.
    const out = speak(new SpokenTextExtractor(), [
      'Sure thing. ',
      '<speak>The build is green.</speak>\n',
    ]);
    expect(out).toContain('The build is green.');
    expect(out).not.toContain('speak>');
    expect(out).not.toContain('<');
  });

  it('holds a partial path until it is whole, never speaking half of one', () => {
    const extractor = new SpokenTextExtractor();
    const out =
      extractor.push('Look at `apps/ser') + extractor.push('ver/x.ts` now. ') + extractor.flush();
    expect(out).not.toContain('apps');
    expect(out).toContain('Look at');
    expect(out).toContain('now.');
  });
});

describe('SpokenTextExtractor — reset', () => {
  it('does not let a turn interrupted inside a fence mute the next turn', () => {
    // The PA-83 shape of bug, in a new place: fence state surviving a stop
    // would swallow the whole next reply and read as talk-back dying for good.
    const extractor = new SpokenTextExtractor();
    extractor.push('Working on it.\n```ts\nconst partial = ');
    extractor.reset();

    const out = speak(extractor, ['The next turn speaks normally.\n']);
    expect(out).toContain('The next turn speaks normally.');
  });

  it('does not let a tagged turn leak its mode into the next one', () => {
    const extractor = new SpokenTextExtractor();
    extractor.push('<speak>First turn.');
    extractor.reset();

    // With the tagged mode left set, an untagged second turn would be silent.
    const out = speak(extractor, ['Second turn, no tag at all.\n']);
    expect(out).toContain('Second turn, no tag at all.');
  });
});

describe('SpokenTextPipeline', () => {
  it('yields whole sentences from a tagged summary', () => {
    const pipeline = new SpokenTextPipeline();
    const sentences = [
      ...pipeline.push('<speak>Tests pass. I pushed the fix.</speak>\n'),
      ...pipeline.flush(),
    ];
    expect(sentences).toEqual(['Tests pass.', 'I pushed the fix.']);
  });

  it('reset() clears both stages, so a stopped turn leaves nothing behind', () => {
    const pipeline = new SpokenTextPipeline();
    pipeline.push('<speak>Half a sentence');
    pipeline.reset();
    expect(pipeline.flush()).toEqual([]);
  });

  it('flushes a short untagged reply that never hit a sentence boundary', () => {
    const pipeline = new SpokenTextPipeline();
    pipeline.push('no punctuation here');
    expect(pipeline.flush()).toEqual(['no punctuation here']);
  });
});

/**
 * PA-89. Reproduced from prod planner chat 83251c3c: the model narrated
 * "I need to fetch the URL…" before calling a tool, which was streamed as
 * `text_delta` but never emitted as a `text` event (`driveLoop` drops the
 * content of a round trip that ends in tool calls). Speaking it also latched
 * the extractor into fallback for the rest of the turn, so the final reply's
 * `<speak>` summary was ignored and the whole written answer was read out.
 */
describe('SpokenTextPipeline — untagged text is held until the turn settles', () => {
  const PRE_TOOL = ['I need ', 'to fetch ', 'the URL ', 'for the forecast. '];
  const TAGGED_REPLY =
    '<speak>Today in Kirkland is looking nice, with a high of 66 degrees.</speak>\n\n' +
    "**Today's weather in Kirkland, WA:**\n\n- **High:** 66F\n";

  it('says nothing while untagged text is still only maybe the reply', () => {
    const pipeline = new SpokenTextPipeline();
    const spoken = PRE_TOOL.flatMap((d) => pipeline.push(d));
    // Complete sentences, deliberately withheld: a tool call may yet prove
    // they were a scratchpad.
    expect(spoken).toEqual([]);
  });

  it('a tool_use discards the scratchpad, and only the summary is spoken', () => {
    const pipeline = new SpokenTextPipeline();
    const spoken = PRE_TOOL.flatMap((d) => pipeline.push(d));
    pipeline.reset(); // what the `tool_use` handler does
    spoken.push(...pipeline.push(TAGGED_REPLY), ...pipeline.flush());
    expect(spoken).toEqual([
      'Today in Kirkland is looking nice, with a high of 66 degrees.',
    ]);
    expect(spoken.join(' ')).not.toContain('fetch the URL');
    // The bug's third symptom: the written reply narrated verbatim.
    expect(spoken.join(' ')).not.toContain('66F');
  });

  it('a late tag supersedes the prose that preceded it, with no tool_use at all', () => {
    const pipeline = new SpokenTextPipeline();
    const spoken = PRE_TOOL.flatMap((d) => pipeline.push(d));
    spoken.push(...pipeline.push(TAGGED_REPLY), ...pipeline.flush());
    expect(spoken).toEqual([
      'Today in Kirkland is looking nice, with a high of 66 degrees.',
    ]);
  });

  it('still speaks an untagged reply — a silent turn reads as a dead mic', () => {
    const pipeline = new SpokenTextPipeline();
    const spoken = [
      ...pipeline.push('The tests pass. '),
      ...pipeline.push('I pushed the fix.'),
      ...pipeline.flush(),
    ];
    expect(spoken).toEqual(['The tests pass.', 'I pushed the fix.']);
  });

  it('speaks a tagged lede immediately, so a long tool turn is not silent', () => {
    const pipeline = new SpokenTextPipeline();
    // PA-84's whole latency argument: this must not wait for `flush()`.
    expect(pipeline.push('<speak>Let me look up the weather.</speak>')).toEqual([
      'Let me look up the weather.',
    ]);
  });
});
