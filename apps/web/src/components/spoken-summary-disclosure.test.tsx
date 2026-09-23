import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  SPEAK_CLOSE_TAG,
  SPEAK_OPEN_TAG,
  extractSpokenSummary,
  stripSpokenSummary,
} from '@pocketagent/protocol';
import { Transcript } from './Transcript.js';
import { applyEvents, emptyTranscript } from '../agent/transcript.js';
import type { AgentEvent } from '@pocketagent/protocol';

/**
 * The markdown renderer sanitizes through DOMPurify, which needs a real DOM
 * this project deliberately does not load (`environment: 'node'`). Stubbing it
 * keeps that decision intact and keeps this test about the *disclosure*: what
 * markdown does with the reply body is a separate concern with its own
 * escaping rules, and pulling in jsdom to re-test it here would be the tail
 * wagging the dog. The stub escapes nothing, which only makes the
 * "never renders the tag markup" assertion below stricter.
 */
vi.mock('../agent/markdown.js', () => ({
  renderMarkdown: (text: string) => text,
}));

/**
 * PA-84: the "Spoken" disclosure on an assistant reply.
 *
 * The one component test in this app, and it earns the exception. Everything
 * else here is either pure (tested directly) or needs a real browser (the demo
 * scripts); this is neither — it is a *decision* about what to render, and its
 * two failure modes are both invisible to the pure tests underneath it. An
 * icon that never appears leaves the spoken text unreachable, which is the
 * whole point of the affordance; one that appears when it should not expands
 * to a duplicate of the message above it. `renderToStaticMarkup` is enough to
 * settle both, needs no jsdom and no new dependency, and keeps the assertion
 * about markup rather than about internal state.
 */

function render(replyText: string): string {
  const events: AgentEvent[] = [
    { kind: 'user_prompt', id: 'u1', text: 'do the thing' },
    { kind: 'text', id: 'm1', text: replyText },
  ];
  const state = applyEvents(emptyTranscript(), events);
  return renderToStaticMarkup(<Transcript state={state} />);
}

const TAGGED = `${SPEAK_OPEN_TAG}I fixed the auth bug.${SPEAK_CLOSE_TAG}\n\nThe change is in the handler.`;

describe('spoken-summary disclosure', () => {
  it('offers the toggle when the reply carried a spoken summary', () => {
    const html = render(TAGGED);
    expect(html).toContain('aria-label="Spoken summary"');
    expect(html).toContain('spoken-btn');
  });

  it('does not offer it on an ordinary reply', () => {
    const html = render('Just a normal answer, no tag anywhere.');
    expect(html).not.toContain('spoken-btn');
    expect(html).not.toContain('aria-label="Spoken summary"');
  });

  it('starts collapsed, so the paraphrase never competes with the reply', () => {
    const html = render(TAGGED);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('spoken-summary-label');
    // The written reply is what is on screen; the spoken text is not.
    expect(html).toContain('The change is in the handler.');
    expect(html).not.toContain('I fixed the auth bug.');
  });

  it('does not offer it when the model wrapped its whole reply', () => {
    // `stripSpokenSummary`'s empty-bubble guard already shows that content, so
    // expanding would duplicate the message directly above the button.
    const wrapped = `${SPEAK_OPEN_TAG}This is the entire answer.${SPEAK_CLOSE_TAG}`;
    expect(extractSpokenSummary(wrapped)).toBe(stripSpokenSummary(wrapped));
    const html = render(wrapped);
    expect(html).toContain('This is the entire answer.');
    expect(html).not.toContain('spoken-btn');
  });

  it('never renders the tag markup itself', () => {
    const html = render(TAGGED);
    expect(html).not.toContain(SPEAK_OPEN_TAG);
    expect(html).not.toContain(SPEAK_CLOSE_TAG);
    expect(html).not.toContain('speak');
  });
});
