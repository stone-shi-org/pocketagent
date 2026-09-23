import { describe, expect, it } from 'vitest';
import {
  SPEAK_CLOSE_TAG,
  SPEAK_OPEN_TAG,
  SPOKEN_SUMMARY_INSTRUCTION,
  appendSpokenSummaryInstruction,
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
