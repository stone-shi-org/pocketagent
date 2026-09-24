import { describe, expect, it } from 'vitest';
import {
  SPEAK_CLOSE_TAG,
  SPEAK_OPEN_TAG,
  SPOKEN_SUMMARY_INSTRUCTION,
  appendSpokenSummaryInstruction,
  SpeakTagScanner,
  extractSpokenSummary,
  stripSpokenSummary,
  stripSpokenSummaryInstruction,
} from '@pocketagent/protocol';

/**
 * PA-84. The tag grammar lives in `packages/protocol` because the server
 * decides what to *speak* and the browser decides what to *hide* — the same
 * rule `cron-expr.ts` and `webhook-template.ts` follow. These cases pin the
 * browser's half, since the visible failure of a disagreement is `<speak>`
 * showing up in the chat or the paraphrase being read out twice.
 */

describe('stripSpokenSummary', () => {
  it('removes the tag and its content, leaving the written reply', () => {
    const reply = `${SPEAK_OPEN_TAG}I fixed the bug.${SPEAK_CLOSE_TAG}\n\nHere is the change:\n\nconst x = 1;`;
    expect(stripSpokenSummary(reply)).toBe('Here is the change:\n\nconst x = 1;');
  });

  it('leaves a reply with no tag completely untouched', () => {
    const reply = 'Just a normal answer with `code` and a list:\n- one\n- two';
    expect(stripSpokenSummary(reply)).toBe(reply);
  });

  it('hides a half-arrived tag rather than flashing it mid-stream', () => {
    // Every streaming prefix of a tagged reply has to render cleanly, or the
    // markup blinks on screen as the reply is typed.
    const full = `${SPEAK_OPEN_TAG}All good.${SPEAK_CLOSE_TAG}\nThe details.`;
    for (let i = 1; i <= full.length; i++) {
      const shown = stripSpokenSummary(full.slice(0, i));
      expect(shown).not.toContain('<speak');
      expect(shown).not.toContain('</spea');
    }
  });

  it('drops everything from an unclosed tag onward — the summary is still arriving', () => {
    expect(stripSpokenSummary(`${SPEAK_OPEN_TAG}Still writ`)).toBe('');
  });

  it('shows the content rather than an empty bubble when the model wraps everything', () => {
    // A blank turn reads as a failed one, so tag compliance must never cost
    // the user the reply itself.
    const reply = `${SPEAK_OPEN_TAG}This is the entire answer.${SPEAK_CLOSE_TAG}`;
    expect(stripSpokenSummary(reply)).toBe('This is the entire answer.');
  });

  it('handles several blocks in one reply', () => {
    const reply = `${SPEAK_OPEN_TAG}A${SPEAK_CLOSE_TAG}first${SPEAK_OPEN_TAG}B${SPEAK_CLOSE_TAG}second`;
    expect(stripSpokenSummary(reply)).toBe('firstsecond');
  });
});

describe('stripSpokenSummary — a tag in code is only a mention', () => {
  // Prod session Axd2XlzNSf5d: a reply explaining this feature mentioned the
  // tag in inline code with no closing tag, and the chat cut it off at the
  // backtick — 492 of 8,452 characters shown. This is that reply's shape.
  const mention =
    'The pipeline:\n\n' +
    '3. **The prompt:** it goes into the agent, with the `<speak>` instruction added in `ws/index.ts`.\n' +
    '4. **Speech back:** `VoiceTtsService` pulls out the `<speak>` text and synthesizes it.\n\n' +
    'If you want, I can start on Phase 1.';

  it('shows a reply that mentions the tag in inline code, whole', () => {
    expect(stripSpokenSummary(mention)).toBe(mention);
    expect(stripSpokenSummary(mention, { streaming: false })).toBe(mention);
    expect(extractSpokenSummary(mention)).toBeNull();
  });

  it('never hides a mention at any streaming prefix', () => {
    // While streaming, only a *trailing* partial tag may be hidden, and a
    // mention inside an open backtick span is not one.
    for (let i = 1; i <= mention.length; i++) {
      const prefix = mention.slice(0, i);
      expect(stripSpokenSummary(prefix).length).toBeGreaterThanOrEqual(prefix.length - 1);
    }
  });

  it('ignores a tag inside a fenced block, and a fence of tildes or longer ticks', () => {
    for (const fence of ['```', '~~~', '````']) {
      const reply = `Example:\n\n${fence}html\n<speak>Hi</speak>\n<speak>unclosed\n${fence}\n\nDone.`;
      expect(stripSpokenSummary(reply)).toBe(reply);
    }
  });

  it('ignores a tag inside a double-backtick span', () => {
    const reply = 'Wrap it as ``<speak>`...`` and move on.';
    expect(stripSpokenSummary(reply)).toBe(reply);
  });

  it('still honours a real lede in a reply that later mentions the tag', () => {
    const reply = `${SPEAK_OPEN_TAG}I explained the tag.${SPEAK_CLOSE_TAG}\n\nThe \`<speak>\` tag leads the reply.`;
    expect(stripSpokenSummary(reply)).toBe('The `<speak>` tag leads the reply.');
    expect(extractSpokenSummary(reply)).toBe('I explained the tag.');
  });

  it('an inline span closes at a paragraph break, so a later real tag still counts', () => {
    const reply = `A stray \` backtick.\n\n${SPEAK_OPEN_TAG}Said.${SPEAK_CLOSE_TAG}Shown.`;
    expect(stripSpokenSummary(reply)).toBe('A stray ` backtick.\n\nShown.');
  });
});

describe('stripSpokenSummary — a finished reply is never cut off', () => {
  it('shows an unclosed block once the reply has stopped streaming', () => {
    const reply = `Intro. ${SPEAK_OPEN_TAG}the model never closed this`;
    expect(stripSpokenSummary(reply)).toBe('Intro.');
    expect(stripSpokenSummary(reply, { streaming: false })).toBe('Intro. the model never closed this');
  });

  it('shows a trailing partial tag once finished, and hides it while streaming', () => {
    expect(stripSpokenSummary('Compare a < b and <spe')).toBe('Compare a < b and ');
    expect(stripSpokenSummary('Compare a < b and <spe', { streaming: false })).toBe('Compare a < b and <spe');
  });
});

describe('SpeakTagScanner', () => {
  it('finds a tag split across chunks, and none inside a span split across chunks', () => {
    const scanner = new SpeakTagScanner();
    const tokens = ['<spe', 'ak>Hi</sp', 'eak> use `', '<speak', '>` here'].flatMap((c) => scanner.push(c));
    expect(tokens.filter((t) => t.kind !== 'text').map((t) => t.kind)).toEqual(['open', 'close']);
    const text = tokens.map((t) => (t.kind === 'text' ? t.text : '|')).join('');
    expect(text).toBe('|Hi| use `<speak>` here');
  });
});

describe('extractSpokenSummary', () => {
  // What the transcript's "Spoken" disclosure shows. Without it the paraphrase
  // is invisible everywhere — stripped from the reply and gone after playback —
  // so there is no way to check what was actually read aloud.
  it('returns the tagged text', () => {
    const reply = `${SPEAK_OPEN_TAG}I fixed the bug.${SPEAK_CLOSE_TAG}\n\nHere is the diff.`;
    expect(extractSpokenSummary(reply)).toBe('I fixed the bug.');
  });

  it('returns null for a reply that carried no tag', () => {
    expect(extractSpokenSummary('An ordinary answer.')).toBeNull();
  });

  it('returns null while the summary is still streaming', () => {
    // A half-written summary is not yet a summary; revealing it mid-stream
    // would show text that is still changing.
    expect(extractSpokenSummary(`${SPEAK_OPEN_TAG}I am still writ`)).toBeNull();
  });

  it('joins several blocks in order', () => {
    const reply = `${SPEAK_OPEN_TAG}First.${SPEAK_CLOSE_TAG}x${SPEAK_OPEN_TAG}Second.${SPEAK_CLOSE_TAG}`;
    expect(extractSpokenSummary(reply)).toBe('First. Second.');
  });

  it('returns null for an empty block rather than an empty disclosure', () => {
    expect(extractSpokenSummary(`${SPEAK_OPEN_TAG}   ${SPEAK_CLOSE_TAG}rest`)).toBeNull();
  });

  it('agrees with the strip when a model wraps its whole reply', () => {
    // The UI hides the toggle in exactly this case: the guard in
    // `stripSpokenSummary` already showed this content, so a disclosure would
    // expand to a duplicate of the message above it.
    const reply = `${SPEAK_OPEN_TAG}The entire answer.${SPEAK_CLOSE_TAG}`;
    expect(extractSpokenSummary(reply)).toBe(stripSpokenSummary(reply));
  });

  it('never returns text the reply still shows', () => {
    const reply = `${SPEAK_OPEN_TAG}Tests pass.${SPEAK_CLOSE_TAG}\n\nThe written reply.`;
    expect(stripSpokenSummary(reply)).not.toContain('Tests pass.');
    expect(extractSpokenSummary(reply)).not.toContain('The written reply.');
  });
});

describe('spoken-summary instruction', () => {
  it('appends to a prompt and strips back to exactly the original', () => {
    const typed = 'run the tests and fix whatever breaks';
    const sent = appendSpokenSummaryInstruction(typed);
    expect(sent).toContain(SPOKEN_SUMMARY_INSTRUCTION);
    expect(stripSpokenSummaryInstruction(sent)).toBe(typed);
  });

  it('is idempotent, so a re-sent queued prompt cannot accumulate copies', () => {
    // A queued prompt is persisted with the instruction already in it and
    // re-sent verbatim; injecting again would stack them.
    const once = appendSpokenSummaryInstruction('do the thing');
    expect(appendSpokenSummaryInstruction(once)).toBe(once);
  });

  it('survives an image-only prompt, which has no text of its own', () => {
    expect(appendSpokenSummaryInstruction('')).toBe(SPOKEN_SUMMARY_INSTRUCTION);
    expect(stripSpokenSummaryInstruction(SPOKEN_SUMMARY_INSTRUCTION)).toBe('');
  });

  it('leaves a prompt that never carried it untouched', () => {
    expect(stripSpokenSummaryInstruction('plain prompt')).toBe('plain prompt');
  });

  it('asks for the tag first, which is what keeps talk-back incremental', () => {
    // If this instruction ever stops asking for the summary up front, the
    // extractor's cheap decision stops working and talk-back goes silent for
    // the length of a turn — see SpokenTextExtractor's header.
    expect(SPOKEN_SUMMARY_INSTRUCTION).toMatch(/begin your reply/i);
    expect(SPOKEN_SUMMARY_INSTRUCTION).toContain(SPEAK_OPEN_TAG);
    expect(SPOKEN_SUMMARY_INSTRUCTION).toContain(SPEAK_CLOSE_TAG);
  });
});
