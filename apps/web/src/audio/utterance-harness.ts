/**
 * PA-85: decides whether a transcribed utterance is actually a command.
 *
 * The reported problem: in live-listen mode a non-speech sound ("not even a
 * word") is transcribed into a filler token — "oh", "yeah", "hmm" — and
 * forwarded to a coding agent as a prompt. Before this module the only gates
 * between `live-stt`'s answer and `handleSend` were a non-empty check and
 * `isSkipCommand`'s seven exact matches.
 *
 * Two filters were proposed on the ticket and both were rejected, which is
 * most of why this file looks the way it does:
 *
 *  - **A minimum word count** ("at least three words") fails in both
 *    directions. The most valuable utterances in a hands-free session are one
 *    word — "yes", "no", "stop", "approve", "continue" — and this app's first
 *    invariant is that nobody answers an approval on the user's behalf, so
 *    voice is exactly how you would answer one without reaching for the
 *    keyboard. Meanwhile "oh yeah okay" is three words of pure filler and
 *    would have sailed straight through. Word count is not correlated with
 *    the thing being measured, so `allFiller` below tests whether *every*
 *    token is a filler token instead of how many there are.
 *  - **A lightweight LLM classifier** puts a network round trip on the
 *    critical path of every utterance (immediacy is the entire point of
 *    live-listen), needs an endpoint a standalone install may not have
 *    configured, and when it is wrong it silently discards a real command.
 *    The ASR has already formed an opinion about its own output; asking a
 *    second model to re-judge the first model's text is strictly worse
 *    evidence than reading the confidence the first one computed.
 *
 * Everything here is pure — no browser APIs, no network, no clock — for the
 * same reason `vad.ts` and `voice-commands.ts` are: this environment has no
 * microphone and no real browser, so the only way this logic gets honest
 * coverage is as a function a unit test can drive directly.
 */

import type { TranscriptWord } from '@pocketagent/protocol';

/**
 * Three outcomes, not two. This is the part of PA-85 worth defending hardest:
 * whatever thresholds are chosen, a harness *will* eventually reject
 * something a human meant, and a silently dropped command is the worst
 * available failure — the user gets no feedback, concludes the microphone is
 * broken, and repeats themselves louder. So the borderline case is neither
 * sent nor discarded: it is parked in the composer, which is the affordance
 * PA-82 already built for push-to-talk's review mode.
 *
 * That also gives the thresholds an honest tuning story. Setting the gate too
 * tight degrades to "you have to tap send" rather than to "your words
 * vanished", which is a recoverable mistake instead of a mysterious one.
 */
export type UtteranceVerdict = 'send' | 'review' | 'drop';

export interface UtteranceJudgement {
  verdict: UtteranceVerdict;
  /**
   * Why, in words a person can read. Surfaced in the UI for a `drop` (a
   * rejection must never be invisible) and asserted on in the tests, so the
   * reason a given utterance was rejected is pinned behaviour rather than an
   * implementation detail that can drift.
   */
  reason: string;
  /** The utterance with non-lexical tokens removed — what would actually be
   *  sent or parked. Never used to *alter* a `send`, only to judge it: the
   *  agent receives the original text, since trimming a model's own output
   *  before handing it on is a second place for meaning to be lost. */
  normalized: string;
}

/**
 * Purely non-lexical vocalizations. An utterance consisting only of these is
 * dropped outright: there is no reading of "hmm" on its own under which a
 * coding agent should be given an instruction.
 *
 * Kept separate from `AMBIGUOUS_ACKS` below because the two deserve different
 * outcomes, which is the distinction a single denylist could not express.
 */
const FILLER_TOKENS: ReadonlySet<string> = new Set([
  'oh', 'ooh', 'ah', 'aah', 'ha', 'haha', 'hm', 'hmm', 'hmmm', 'huh',
  'uh', 'uhh', 'um', 'umm', 'er', 'err', 'erm', 'mm', 'mmm', 'mhm',
  'mmhmm', 'mhmm', 'uhhuh', 'uhhum', 'eh', 'ugh', 'oof', 'phew', 'tsk',
  // "yeah" and its variants sit here rather than in `AMBIGUOUS_ACKS` on the
  // reporter's own evidence: PA-85 names "oh, yeah, hum" as the words STT
  // invents out of sounds that were "not even a word". A deliberate "yeah"
  // is therefore sacrificed — and the asymmetry with "yes", which is not
  // filler and sends normally, is the whole point. "yes" is the word to say
  // when you mean it, and it is also the one that answers an approval.
  'yeah', 'yea', 'yeh', 'yep', 'yup', 'ya',
]);

/**
 * Words that are filler *in combination* but could be a deliberate reply on
 * their own. "okay" alone might be an acknowledgement nobody needed to send,
 * or it might be a person agreeing to something the agent asked — which this
 * module cannot tell apart and must not guess about, so a lone one goes to
 * review rather than being dropped or sent.
 *
 * In combination with `FILLER_TOKENS` they are treated as filler: "oh yeah
 * okay" is the multi-word filler case the rejected word-count proposal would
 * have let through.
 */
const AMBIGUOUS_ACKS: ReadonlySet<string> = new Set([
  'ok', 'okay', 'okey', 'right', 'sure', 'well', 'so', 'like', 'anyway',
  'alright',
]);

/**
 * Phrases Whisper-family decoders are known to emit for audio containing no
 * speech at all — training-set residue rather than a transcription of
 * anything. They are matched as whole utterances, never as substrings, for
 * the reason `voice-commands.ts` already records: "thank you for fixing the
 * tests" is a real instruction and must survive.
 *
 * `[BLANK_AUDIO]`, `(silence)` and friends arrive bracketed; `stripBrackets`
 * removes the brackets before this set is consulted, so the bare words are
 * what appear here.
 */
const HALLUCINATION_PHRASES: ReadonlySet<string> = new Set([
  'thank you', 'thanks', 'thank you very much', 'thanks for watching',
  'thanks for watching!', 'please subscribe', 'subscribe',
  'blank audio', 'blank_audio', 'silence', 'music', 'inaudible',
  'foreign', 'applause', 'laughter', 'noise', 'beep', 'bye', 'bye bye',
  'you', 'the', 'a',
]);

/**
 * Mean per-word confidence at or below which an utterance is discarded.
 *
 * Deliberately low. The failure this feature exists to stop is a *confident*
 * mis-transcription as often as an unconfident one, so confidence is a
 * supporting signal rather than the primary one — the filler and
 * hallucination sets above do most of the work. Set aggressively, this
 * threshold would start discarding accented or quiet real speech, which is
 * the silent-drop failure the three-way verdict exists to avoid.
 *
 * Calibrated against live-stt's actual output on this deployment rather than
 * guessed: a real utterance's words score 0.68-1.0, and a hallucinated
 * trailing word appended to one scored 0.11 (see the test fixtures, which are
 * recorded from the running service).
 */
const DROP_BELOW_MEAN_CONFIDENCE = 0.35;

/** Mean confidence below which an utterance is parked for review rather than
 *  sent. Between this and `DROP_BELOW_MEAN_CONFIDENCE` the transcript is
 *  probably words but not probably *these* words. */
const REVIEW_BELOW_MEAN_CONFIDENCE = 0.6;

/**
 * Words per second above which an utterance is treated as implausible.
 *
 * Conversational speech runs 2-4 words/sec and fast speech 5-6, so a
 * transcript claiming more than this against the audio's own measured
 * duration is reporting words that were not spoken — which is precisely the
 * shape of "Thanks for watching!" invented out of a fraction of a second of
 * noise. This is the one check that catches a *confident* hallucination, so
 * it earns its place beside the confidence thresholds rather than duplicating
 * them.
 */
const MAX_PLAUSIBLE_WORDS_PER_SECOND = 7;

/**
 * Non-lexical tokens live-stt's own output contains, which must not be
 * counted as words. Verified against the running service: the
 * `nemotron-3.5-asr-streaming-0.6b` backend emits a language tag as a word
 * entry (`<en-US>`, confidence 0.9999), so a naive word count is off by one
 * and — worse — its near-perfect confidence drags the mean up on exactly the
 * short utterances where the mean matters most.
 */
function isLexicalWord(word: string): boolean {
  const trimmed = word.trim();
  if (!trimmed) return false;
  if (/^<[^>]*>$/.test(trimmed)) return false;
  return /[\p{L}\p{N}]/u.test(trimmed);
}

/** Unwraps `[BLANK_AUDIO]`, `(silence)`, `<noise>` to their inner text, so a
 *  bracketed non-speech marker is judged by what it says rather than slipping
 *  through as punctuation the normalizer would strip to nothing. */
function stripBrackets(text: string): string {
  return text.replace(/[[({<]([^\])}>]*)[\])}>]/g, ' $1 ');
}

/** Lowercase, bracket-unwrapped, punctuation-stripped, whitespace-collapsed.
 *  Underscores are kept as spaces so `BLANK_AUDIO` normalizes to the same
 *  thing `blank audio` does. */
export function normalizeUtterance(text: string): string {
  return stripBrackets(text)
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when every token is filler or an ambiguous acknowledgement — the
 *  generalization of a filler denylist that the rejected word-count proposal
 *  could not express. */
function isAllFiller(tokens: string[]): boolean {
  return (
    tokens.length > 0 &&
    tokens.every((t) => FILLER_TOKENS.has(t.replace(/'/g, '')) || AMBIGUOUS_ACKS.has(t.replace(/'/g, '')))
  );
}

export interface HarnessInput {
  /** live-stt's transcript, exactly as returned. */
  text: string;
  /** Per-word confidence, when the service reported any (LS-7). Absent means
   *  "no signal", never "low confidence" — see `TranscriptWord`. */
  words?: TranscriptWord[];
  /** live-stt's own measurement of the uploaded audio's length. */
  durationSec?: number;
  /** The endpointer's measured voiced span, always available since it is
   *  computed in this browser. Used as the denominator for the speech-rate
   *  check when `durationSec` is absent. */
  durationMs?: number;
}

/**
 * The harness. Order matters: the cheap, deterministic text rules run before
 * the statistical ones, so a transcript that is *definitely* junk is reported
 * as junk with a precise reason rather than as "low confidence", which would
 * be both vaguer and less stable across ASR backends.
 */
export function judgeUtterance(input: HarnessInput): UtteranceJudgement {
  const normalized = normalizeUtterance(input.text);
  if (!normalized) {
    return { verdict: 'drop', reason: 'nothing intelligible', normalized };
  }

  if (HALLUCINATION_PHRASES.has(normalized)) {
    return { verdict: 'drop', reason: `non-speech artifact ("${normalized}")`, normalized };
  }

  const tokens = normalized.split(' ').filter(Boolean);
  const bareTokens = tokens.map((t) => t.replace(/'/g, ''));

  // A lone ambiguous acknowledgement is the one case that is neither clearly
  // junk nor clearly meant, so it is the one case that gets parked. Checked
  // before `isAllFiller`, which would otherwise drop it.
  if (tokens.length === 1 && AMBIGUOUS_ACKS.has(bareTokens[0]!) && !FILLER_TOKENS.has(bareTokens[0]!)) {
    return { verdict: 'review', reason: `just "${normalized}" — parked rather than sent`, normalized };
  }

  if (isAllFiller(tokens)) {
    return { verdict: 'drop', reason: `filler only ("${normalized}")`, normalized };
  }

  const lexical = input.words?.filter((w) => isLexicalWord(w.word)) ?? [];
  const confidences = lexical
    .map((w) => w.confidence)
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c));

  if (confidences.length > 0) {
    const mean = confidences.reduce((sum, c) => sum + c, 0) / confidences.length;
    if (mean <= DROP_BELOW_MEAN_CONFIDENCE) {
      return {
        verdict: 'drop',
        reason: `very low confidence (${mean.toFixed(2)})`,
        normalized,
      };
    }
    if (mean < REVIEW_BELOW_MEAN_CONFIDENCE) {
      return {
        verdict: 'review',
        reason: `low confidence (${mean.toFixed(2)}) — parked rather than sent`,
        normalized,
      };
    }
  }

  // Speech rate, as a check on a *confident* hallucination. Prefers
  // live-stt's own duration over the endpointer's, since the two measure
  // slightly different spans and the rate is only meaningful against the
  // audio the words were actually decoded from.
  const seconds = input.durationSec ?? (input.durationMs !== undefined ? input.durationMs / 1000 : undefined);
  if (lexical.length > 1 && seconds !== undefined && seconds > 0) {
    const wordsPerSecond = lexical.length / seconds;
    if (wordsPerSecond > MAX_PLAUSIBLE_WORDS_PER_SECOND) {
      return {
        verdict: 'review',
        reason: `implausible speech rate (${wordsPerSecond.toFixed(1)} words/sec) — parked rather than sent`,
        normalized,
      };
    }
  }

  return { verdict: 'send', reason: 'passed', normalized };
}
