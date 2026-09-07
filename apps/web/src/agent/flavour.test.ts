import { describe, expect, it } from 'vitest';
import { makeFlavour, parseFlavour } from './flavour.js';

describe('flavour round-trip', () => {
  it('parses a plain agent id', () => {
    expect(parseFlavour(makeFlavour('claude', 'structured'))).toEqual({
      agentId: 'claude',
      transport: 'structured',
    });
  });

  it('parses an agent id that itself contains a colon (PA-28 regression)', () => {
    // The exact shape that broke: a custom Claude provider's id is
    // `custom-claude:<slug>-<hex>`. Before this fix, `flavour.split(':')`
    // took the first two of three parts, producing agent id `custom-claude`
    // and transport `omniroute` — a zod enum violation on session create.
    expect(parseFlavour(makeFlavour('custom-claude:omniroute', 'structured'))).toEqual({
      agentId: 'custom-claude:omniroute',
      transport: 'structured',
    });
  });

  it('parses an agent id with multiple colons', () => {
    expect(parseFlavour(makeFlavour('custom-claude:my-provider:extra', 'terminal'))).toEqual({
      agentId: 'custom-claude:my-provider:extra',
      transport: 'terminal',
    });
  });

  it('returns empty strings for an empty flavour', () => {
    expect(parseFlavour('')).toEqual({ agentId: '', transport: '' });
  });
});
