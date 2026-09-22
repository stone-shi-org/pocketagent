import { describe, it, expect } from 'vitest';
import { judgeUtterance, normalizeUtterance } from './utterance-harness.js';

/**
 * Word lists recorded from the live-stt deployment this feature runs against
 * (PA-85), not invented: the same 1.5s LibriSpeech fixture
 * `apps/server/src/voice/fixtures/test-utterance.ts` embeds, sent to
 * `/v1/audio/transcriptions` with `response_format=verbose_json` after LS-7
 * landed. Kept verbatim because the confidence thresholds are calibrated
 * against these numbers, so a future retune has real output to argue with
 * rather than guesses.
 */
const REAL_PARAKEET_WORDS = [
  { word: 'well', start: 0.8, end: 0.88, confidence: 0.9545999765396118 },
  { word: 'i', start: 0.96, end: 1.04, confidence: 0.9957000017166138 },
  { word: "don't", start: 0.96, end: 1.04, confidence: 0.6829000115394592 },
  { word: 'wish', start: 1.28, end: 1.36, confidence: 1.0 },
  { word: 'to', start: 1.44, end: 1.52, confidence: 0.9991999864578247 },
  { word: 'see', start: 1.44, end: 1.52, confidence: 0.9571999907493591 },
];

/** The same audio through `whisper-base.en-q8_0`, which appended a word that
 *  was never spoken — "a", at confidence 0.11. The single clearest piece of
 *  evidence that per-word confidence is the right discriminator. */
const REAL_WHISPER_WORDS = [
  { word: 'Well,', start: 0.0, end: 0.56, confidence: 0.6941959857940674 },
  { word: 'I', start: 0.56, end: 0.65, confidence: 0.9921309947967529 },
  { word: "don't", start: 0.65, end: 1.04, confidence: 0.9878100156784058 },
  { word: 'wish', start: 1.11, end: 1.49, confidence: 0.9922429919242859 },
  { word: 'to', start: 1.49, end: 1.49, confidence: 0.9920549988746643 },
  { word: 'see', start: 1.49, end: 1.49, confidence: 0.9298779964447021 },
  { word: 'a', start: 1.49, end: 1.49, confidence: 0.11036399751901627 },
];

describe('normalizeUtterance', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normalizeUtterance('  Oh!!  ')).toBe('oh');
    expect(normalizeUtterance('Run the   tests, please.')).toBe('run the tests please');
  });

  it('unwraps bracketed non-speech markers rather than stripping them to nothing', () => {
    expect(normalizeUtterance('[BLANK_AUDIO]')).toBe('blank audio');
    expect(normalizeUtterance('(silence)')).toBe('silence');
    expect(normalizeUtterance('<noise>')).toBe('noise');
  });

  it('keeps apostrophes, so a contraction is one token', () => {
    expect(normalizeUtterance("don't stop")).toBe("don't stop");
  });
});

describe('judgeUtterance — the reported bug', () => {
  it.each(['oh', 'Oh.', 'yeah', 'Yeah!', 'hmm', 'Hmm...', 'uh', 'um', 'mhm', 'er', 'huh'])(
    'drops the filler token %j that the ticket reported being sent to the agent',
    (text) => {
      expect(judgeUtterance({ text }).verdict).toBe('drop');
    },
  );

  it('drops multi-word filler, which a three-word minimum would have let through', () => {
    // The concrete counterexample to the ticket's second proposal.
    expect(judgeUtterance({ text: 'oh yeah okay' }).verdict).toBe('drop');
    expect(judgeUtterance({ text: 'um, yeah, well' }).verdict).toBe('drop');
  });

  it('drops known Whisper non-speech hallucinations', () => {
    for (const text of ['Thank you.', 'Thanks for watching!', '[BLANK_AUDIO]', '(silence)']) {
      expect(judgeUtterance({ text }).verdict).toBe('drop');
    }
  });

  it('names the reason, so a rejection is never silent', () => {
    expect(judgeUtterance({ text: 'oh' }).reason).toContain('filler');
    expect(judgeUtterance({ text: 'Thank you.' }).reason).toContain('non-speech');
  });
});

describe('judgeUtterance — short commands must survive', () => {
  it.each(['yes', 'no', 'stop', 'go', 'continue', 'approve', 'deny', 'run the tests'])(
    'sends %j',
    (text) => {
      expect(judgeUtterance({ text }).verdict).toBe('send');
    },
  );

  it('sends a one-word command even with no confidence data at all', () => {
    // An older live-stt reports no `words`. The harness must degrade to its
    // text rules, never to "reject anything I cannot measure".
    expect(judgeUtterance({ text: 'stop', durationMs: 300 }).verdict).toBe('send');
  });

  it('does not treat a real instruction containing a filler word as filler', () => {
    expect(judgeUtterance({ text: 'thank you for fixing the tests' }).verdict).toBe('send');
    expect(judgeUtterance({ text: 'okay now run the build' }).verdict).toBe('send');
  });
});

describe('judgeUtterance — the ambiguous middle', () => {
  it.each(['okay', 'ok', 'right', 'sure', 'alright'])(
    'parks %j for review rather than guessing',
    (text) => {
      expect(judgeUtterance({ text }).verdict).toBe('review');
    },
  );

  it('drops "yeah" but sends "yes" — the reporter named the first as noise', () => {
    expect(judgeUtterance({ text: 'yeah' }).verdict).toBe('drop');
    expect(judgeUtterance({ text: 'yes' }).verdict).toBe('send');
  });

  it('parks a lone "okay" specifically, since it might be a real reply', () => {
    const result = judgeUtterance({ text: 'Okay.' });
    expect(result.verdict).toBe('review');
    expect(result.reason).toContain('parked');
  });
});

describe('judgeUtterance — confidence, against real recorded output', () => {
  it('sends a genuine utterance', () => {
    const result = judgeUtterance({
      text: "well i don't wish to see",
      words: REAL_PARAKEET_WORDS,
      durationSec: 1.5,
    });
    expect(result.verdict).toBe('send');
  });

  it('sends whisper\'s transcript of the same audio despite one hallucinated word', () => {
    // The mean is still high — one low word among six good ones must not
    // reject a real sentence. This is the guard against over-tuning.
    const result = judgeUtterance({
      text: " Well, I don't wish to see a",
      words: REAL_WHISPER_WORDS,
      durationSec: 1.5,
    });
    expect(result.verdict).toBe('send');
  });

  it('drops an utterance whose words are all low confidence', () => {
    const result = judgeUtterance({
      text: 'shall we',
      words: [
        { word: 'shall', confidence: 0.2 },
        { word: 'we', confidence: 0.18 },
      ],
      durationSec: 1.2,
    });
    expect(result.verdict).toBe('drop');
    expect(result.reason).toContain('confidence');
  });

  it('parks a middling-confidence utterance rather than sending or dropping it', () => {
    const result = judgeUtterance({
      text: 'rerun that build',
      words: [
        { word: 'rerun', confidence: 0.5 },
        { word: 'that', confidence: 0.52 },
        { word: 'build', confidence: 0.55 },
      ],
      durationSec: 1.2,
    });
    expect(result.verdict).toBe('review');
  });

  it('ignores a language tag emitted as a word, which would otherwise skew the mean', () => {
    // Recorded from `nemotron-3.5-asr-streaming-0.6b`, which appends
    // `<en-US>` at confidence 0.9999. Two genuinely unconfident words plus
    // that tag must still read as unconfident.
    const result = judgeUtterance({
      text: 'shall we',
      words: [
        { word: 'shall', confidence: 0.2 },
        { word: 'we', confidence: 0.18 },
        { word: '<en-US>', confidence: 0.9998999834060669 },
      ],
      durationSec: 1.2,
    });
    expect(result.verdict).toBe('drop');
  });

  it('treats absent confidence as no signal, not as low confidence', () => {
    const result = judgeUtterance({
      text: 'run the tests',
      words: [{ word: 'run' }, { word: 'the' }, { word: 'tests' }],
      durationSec: 1.2,
    });
    expect(result.verdict).toBe('send');
  });
});

describe('judgeUtterance — speech rate catches a confident hallucination', () => {
  it('parks a transcript claiming more words than the audio could hold', () => {
    // Five confident words out of 0.4s is ~12 words/sec: not speech.
    const result = judgeUtterance({
      text: 'thanks for watching everyone today',
      words: [
        { word: 'thanks', confidence: 0.95 },
        { word: 'for', confidence: 0.95 },
        { word: 'watching', confidence: 0.95 },
        { word: 'everyone', confidence: 0.95 },
        { word: 'today', confidence: 0.95 },
      ],
      durationSec: 0.4,
    });
    expect(result.verdict).toBe('review');
    expect(result.reason).toContain('speech rate');
  });

  it('leaves a plausibly fast speaker alone', () => {
    const result = judgeUtterance({
      text: 'run the tests and then push',
      words: ['run', 'the', 'tests', 'and', 'then', 'push'].map((word) => ({ word, confidence: 0.9 })),
      durationSec: 1.5,
    });
    expect(result.verdict).toBe('send');
  });

  it('falls back to the endpointer duration when live-stt reports none', () => {
    const result = judgeUtterance({
      text: 'thanks for watching everyone today',
      words: ['thanks', 'for', 'watching', 'everyone', 'today'].map((word) => ({ word, confidence: 0.95 })),
      durationMs: 400,
    });
    expect(result.verdict).toBe('review');
  });

  it('never divides by a zero duration', () => {
    expect(() =>
      judgeUtterance({
        text: 'run the tests',
        words: ['run', 'the', 'tests'].map((word) => ({ word, confidence: 0.9 })),
        durationSec: 0,
      }),
    ).not.toThrow();
  });
});

/**
 * Recorded by sending synthetic non-speech audio to the real live-stt
 * deployment (PA-85 verification). These are the reported bug, reproduced:
 * the model this install actually runs turned a 350ms synthetic thump into
 * the word "yeah", which before this harness would have been sent to a
 * coding agent as a prompt.
 */
describe('judgeUtterance — non-speech, recorded from the real service', () => {
  it('drops the thump that the production model transcribed as "yeah"', () => {
    // `realtime_eou_120m-v1` (this deployment's default), 0.35s synthetic
    // transient: text "yeah", one word at confidence 0.19.
    const result = judgeUtterance({
      text: 'yeah',
      words: [{ word: 'yeah', confidence: 0.19 }],
      durationSec: 0.35,
    });
    expect(result.verdict).toBe('drop');
  });

  it('drops [BLANK_AUDIO], which whisper emits at HIGH confidence', () => {
    // whisper-base.en-q8_0 on digital silence: "[BLANK_AUDIO]" at 0.79.
    // The case that justifies keeping a phrase list *and* a confidence
    // check: a confidence-only filter would have sent this straight on,
    // and so would an LLM shown only the text "[BLANK_AUDIO]" with no
    // instruction about what to do with it.
    const result = judgeUtterance({
      text: ' [BLANK_AUDIO]',
      words: [{ word: '[BLANK_AUDIO]', confidence: 0.79 }],
      durationSec: 1.5,
    });
    expect(result.verdict).toBe('drop');
    expect(result.reason).toContain('non-speech');
  });

  it('parks whisper\'s "(water splashing)" rather than sending it', () => {
    // Loud hiss, 1.0s: two words at 0.32 and 0.73 — mean 0.52, the
    // borderline band. Not in any phrase list, so this is the case the
    // three-way verdict exists for.
    const result = judgeUtterance({
      text: ' (water splashing)',
      words: [
        { word: '(water', confidence: 0.32 },
        { word: 'splashing)', confidence: 0.73 },
      ],
      durationSec: 1.0,
    });
    expect(result.verdict).toBe('review');
  });

  it('drops an empty transcript, which is what most non-speech actually yields', () => {
    // Every model returned "" for silence, hiss and room noise. The
    // harness's cheapest rule handles the commonest case.
    expect(judgeUtterance({ text: '', words: [], durationSec: 1.5 }).verdict).toBe('drop');
  });
});

describe('judgeUtterance — degenerate input', () => {
  it('drops empty and punctuation-only text', () => {
    for (const text of ['', '   ', '...', '?!']) {
      expect(judgeUtterance({ text }).verdict).toBe('drop');
    }
  });

  it('reports the normalized form it judged, for the UI notice', () => {
    expect(judgeUtterance({ text: 'Oh!' }).normalized).toBe('oh');
  });
});

/**
 * PA-85 review fixes. Each of these was a way the harness could have failed
 * *silently* — either rejecting everything or checking nothing — which is the
 * failure mode a filter must not have.
 */
describe('judgeUtterance — robustness against a backend that changes units', () => {
  it('ignores negative confidences instead of dropping every utterance', () => {
    // A backend reporting log-probabilities is the anticipated shape of
    // change (the protocol comment says confidence is not comparable across
    // backends). Read naively, every mean falls under the drop threshold and
    // a working microphone sends nothing at all, forever.
    const result = judgeUtterance({
      text: 'run the tests',
      words: [
        { word: 'run', confidence: -0.12 },
        { word: 'the', confidence: -0.4 },
        { word: 'tests', confidence: -0.08 },
      ],
      voicedMs: 900,
    });
    expect(result.verdict).toBe('send');
  });

  it('ignores out-of-range confidences on a 0-100 scale', () => {
    const result = judgeUtterance({
      text: 'run the tests',
      words: [
        { word: 'run', confidence: 95 },
        { word: 'the', confidence: 88 },
        { word: 'tests', confidence: 91 },
      ],
      voicedMs: 900,
    });
    expect(result.verdict).toBe('send');
  });

  it('still uses the in-range subset when only some words are unusable', () => {
    const result = judgeUtterance({
      text: 'shall we',
      words: [
        { word: 'shall', confidence: 0.2 },
        { word: 'we', confidence: Number.NaN },
      ],
      voicedMs: 900,
    });
    expect(result.verdict).toBe('drop');
  });
});

describe('judgeUtterance — speech rate is measured against voiced time', () => {
  it('fires on a short blip, which it could not when the hangover was included', () => {
    // 4 words out of 200ms of actual speech. With the default 800ms hangover
    // folded in, this reported 4 words/sec and looked entirely ordinary —
    // so the check essentially never fired on the blips it was written for.
    const result = judgeUtterance({
      text: 'thanks for watching everyone',
      words: ['thanks', 'for', 'watching', 'everyone'].map((word) => ({ word, confidence: 0.95 })),
      voicedMs: 200,
      durationSec: 1.0,
    });
    expect(result.verdict).toBe('review');
    expect(result.reason).toContain('speech rate');
  });

  it('prefers voicedMs over live-stt duration when both are present', () => {
    const plausible = judgeUtterance({
      text: 'run the tests and then push',
      words: ['run', 'the', 'tests', 'and', 'then', 'push'].map((word) => ({ word, confidence: 0.9 })),
      voicedMs: 1500,
      durationSec: 0.3,
    });
    expect(plausible.verdict).toBe('send');
  });

  it('falls through a zero duration to the next measurement instead of skipping the check', () => {
    // `durationSec: 0` is not nullish, so `??` kept it and disabled the check
    // even though a usable measurement was sitting right beside it.
    const result = judgeUtterance({
      text: 'thanks for watching everyone',
      words: ['thanks', 'for', 'watching', 'everyone'].map((word) => ({ word, confidence: 0.95 })),
      durationSec: 0,
      durationMs: 300,
    });
    expect(result.verdict).toBe('review');
  });

  it('runs on a live-stt that reports no per-word data at all', () => {
    // The pre-LS-7 deployment the protocol documents as supported. Without
    // counting tokens instead of words, the only defence against a
    // *confident* hallucination was completely inoperative there.
    const result = judgeUtterance({
      text: 'thanks for watching everyone today',
      voicedMs: 300,
    });
    expect(result.verdict).toBe('review');
    expect(result.reason).toContain('speech rate');
  });
});
