import { describe, expect, it } from 'vitest';
import {
  INVALID_ARGUMENTS_KEY,
  parseToolArgumentJson,
  prepareToolArguments,
  toolUseInput,
} from '../src/planner/tool-args.js';
import { PLANNER_TOOLS } from '../src/planner/tools.js';

/** PA-121: argument parsing and validation before a planner tool runs. */

const schema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    limit: { type: 'number' },
    recursive: { type: 'boolean' },
    kind: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['path'],
  additionalProperties: false,
};

describe('prepareToolArguments', () => {
  it('passes valid arguments through unchanged', () => {
    expect(prepareToolArguments('t', schema, '{"path":"a.txt","limit":3}')).toEqual({
      ok: true,
      args: { path: 'a.txt', limit: 3 },
    });
  });

  it('treats an empty argument string as no arguments', () => {
    expect(prepareToolArguments('t', { type: 'object', properties: {} }, '')).toEqual({ ok: true, args: {} });
  });

  it('reports invalid JSON with the raw text, instead of running with {}', () => {
    const result = prepareToolArguments('read_file', schema, '{"path": "a.txt"');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/^Invalid JSON in the arguments for tool "read_file"/);
    expect(result.message).toContain('Received arguments:\n{"path": "a.txt"');
  });

  it('refuses a JSON value that is not an object', () => {
    const result = prepareToolArguments('t', schema, '["a.txt"]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('expected a JSON object, got an array');
  });

  it('names every missing required field and wrong type at once, with the arguments received', () => {
    const result = prepareToolArguments('t', schema, '{"limit":"lots","recursive":"maybe","kind":"c"}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('Validation failed for tool "t":');
    expect(result.message).toContain('  - limit: expected a number, got a string');
    expect(result.message).toContain('  - recursive: expected a boolean, got a string');
    expect(result.message).toContain('  - kind: must be one of "a", "b"');
    expect(result.message).toContain('  - path: is required');
    expect(result.message).toContain('Received arguments:');
  });

  it('coerces the common model mistakes rather than refusing them', () => {
    const result = prepareToolArguments('t', schema, '{"path":42,"limit":"5","recursive":"true","tags":"[\\"x\\"]"}');
    expect(result).toEqual({ ok: true, args: { path: '42', limit: 5, recursive: true, tags: ['x'] } });
  });

  it('drops unknown keys under additionalProperties:false, and null optional fields', () => {
    const result = prepareToolArguments('t', schema, '{"path":"a","bogus":1,"limit":null}');
    expect(result).toEqual({ ok: true, args: { path: 'a' } });
  });

  it('keeps unknown keys when the schema does not forbid them', () => {
    const open = { type: 'object', properties: { tool: { type: 'string' } } };
    expect(prepareToolArguments('call_mcp_tool', open, '{"tool":"x","arguments":{"q":1}}')).toEqual({
      ok: true,
      args: { tool: 'x', arguments: { q: 1 } },
    });
  });

  it('passes through a schema shape it does not model', () => {
    const odd = { type: 'object', properties: { v: { oneOf: [{ type: 'string' }, { type: 'number' }] } } };
    expect(prepareToolArguments('t', odd, '{"v":[1]}')).toEqual({ ok: true, args: { v: [1] } });
  });

  it('accepts every real tool called with arguments built from its own schema', () => {
    // A regression net for the validator against the actual catalog: a
    // required field of each declared type must validate cleanly.
    const sample = (prop: Record<string, unknown>): unknown => {
      if (Array.isArray(prop.enum)) return prop.enum[0];
      switch (prop.type) {
        case 'string':
          return 'x';
        case 'number':
        case 'integer':
          return 1;
        case 'boolean':
          return true;
        case 'array':
          return [];
        case 'object':
          return {};
        default:
          return 'x';
      }
    };
    for (const tool of PLANNER_TOOLS) {
      const props = (tool.parameters.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = (tool.parameters.required ?? []) as string[];
      const args = Object.fromEntries(required.map((k) => [k, sample(props[k] ?? {})]));
      const result = prepareToolArguments(tool.name, tool.parameters, JSON.stringify(args));
      expect(result, tool.name).toMatchObject({ ok: true });
    }
  });
});

describe('toolUseInput / parseToolArgumentJson', () => {
  it('keeps the raw text of invalid JSON under a marker key, so history shows what was sent', () => {
    expect(toolUseInput('{"path": ')).toEqual({ [INVALID_ARGUMENTS_KEY]: '{"path": ' });
    expect(toolUseInput('{"path":"a"}')).toEqual({ path: 'a' });
  });

  it('never throws', () => {
    expect(parseToolArgumentJson('nope')).toMatchObject({ ok: false });
    expect(parseToolArgumentJson('null')).toMatchObject({ ok: false });
    expect(parseToolArgumentJson('   ')).toEqual({ ok: true, value: {} });
  });
});
