/**
 * PA-121: turning a tool call's raw argument string into the object a tool's
 * `execute` receives — or into an error the model can act on.
 *
 * Before this, `safeParseArgs` turned anything it could not parse into `{}`
 * and the tool ran anyway: a model that emitted `{"path": "a.txt"` (one brace
 * short) got "No path provided." back, had no way to learn that its own JSON
 * was the problem, and the transcript recorded the call as `{}`, so even the
 * next round trip could not see what had actually been sent. pi
 * (`earendil-works/pi`, `ai/src/utils/validation.ts`) validates against the
 * tool's schema before executing and hands the model the exact field and the
 * arguments it sent; this is the same idea, sized to the schemas this
 * catalog actually uses.
 *
 * Deliberately a small hand-rolled validator rather than a JSON Schema
 * library. Every planner tool's `parameters` uses only `type`, `properties`,
 * `required`, `enum`, `items` and `additionalProperties`, and the two things
 * that matter most here are not what a strict validator does anyway:
 *
 * - **It coerces before it complains.** Models routinely send `"5"` for a
 *   number and `"true"` for a boolean; pi coerces those (`Value.Convert`)
 *   rather than burning a round trip on a refusal, and so does this.
 * - **It drops unknown keys rather than refusing them.** `additionalProperties:
 *   false` is how this catalog tells the model "these are the fields", not a
 *   security boundary — every tool already ignores what it does not read.
 *   Refusing an extra key would turn a harmless habit into a failed call;
 *   a misspelled *required* key is still caught, because the real one is then
 *   missing.
 *
 * Anything the validator does not understand (a schema keyword it does not
 * know, a property with no `type`) passes through untouched: an unknown
 * schema shape must never make a working tool unusable.
 */

/** What a caller gets back: arguments ready for `execute`, or one message
    explaining what was wrong, written for the model to read. */
export type PreparedToolArguments =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; message: string };

/** How much of a malformed argument string is echoed back to the model —
    enough to recognise its own mistake, not a second copy of a huge payload. */
const RAW_ARGUMENT_ECHO_CHARS = 2_000;

type JsonSchema = Record<string, unknown>;

/**
 * Parses and validates one tool call's arguments against `schema` (a tool's
 * `parameters`). An empty string means "no arguments" and is treated as `{}`,
 * which is what OpenAI-compatible providers send for a parameterless call.
 */
export function prepareToolArguments(
  toolName: string,
  schema: JsonSchema | undefined,
  rawArguments: string,
): PreparedToolArguments {
  const parsed = parseToolArgumentJson(rawArguments);
  if (!parsed.ok) {
    return {
      ok: false,
      message:
        `Invalid JSON in the arguments for tool "${toolName}": ${parsed.error}. ` +
        `Re-issue the call with a valid JSON object.\n\nReceived arguments:\n${echo(rawArguments)}`,
    };
  }
  if (!schema) return { ok: true, args: parsed.value };

  const errors: string[] = [];
  const coerced = coerceValue(parsed.value, schema, '', errors);
  if (errors.length > 0) {
    return {
      ok: false,
      message:
        `Validation failed for tool "${toolName}":\n${errors.map((e) => `  - ${e}`).join('\n')}\n\n` +
        `Received arguments:\n${echo(JSON.stringify(parsed.value, null, 2))}`,
    };
  }
  return { ok: true, args: coerced as Record<string, unknown> };
}

/**
 * The parse half alone, for callers that only need "what did the model send"
 * — the persisted `tool_use.input` and the permission card. Never throws.
 * A non-object JSON value (`"x"`, `[1]`) is a failure too: every tool takes
 * an object.
 */
export function parseToolArgumentJson(
  rawArguments: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!rawArguments || rawArguments.trim().length === 0) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `expected a JSON object, got ${describeType(parsed)}` };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * The key a `tool_use.input` carries when the model's arguments were not
 * valid JSON. The raw string is kept (truncated) so the next round trip, and
 * a human reading the transcript, see what was actually sent rather than an
 * empty `{}` — and it is wrapped in an object, rather than replayed verbatim,
 * because some providers reject a history whose `tool_calls[].arguments` is
 * not itself valid JSON.
 */
export const INVALID_ARGUMENTS_KEY = '_invalidArguments';

/** `tool_use.input` for a call: the parsed object, or the raw string wrapped
    under `INVALID_ARGUMENTS_KEY` when it was not valid JSON. */
export function toolUseInput(rawArguments: string): Record<string, unknown> {
  const parsed = parseToolArgumentJson(rawArguments);
  if (parsed.ok) return parsed.value;
  return { [INVALID_ARGUMENTS_KEY]: rawArguments.slice(0, RAW_ARGUMENT_ECHO_CHARS) };
}

function echo(text: string): string {
  return text.length > RAW_ARGUMENT_ECHO_CHARS
    ? `${text.slice(0, RAW_ARGUMENT_ECHO_CHARS)}…(${text.length - RAW_ARGUMENT_ECHO_CHARS} more characters)`
    : text;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function label(path: string): string {
  return path.length > 0 ? path : '(arguments)';
}

/**
 * Coerces `value` toward `schema`, appending a message to `errors` for
 * anything it cannot fix. Returns the (possibly coerced) value either way so
 * one pass can report every problem at once rather than one per round trip.
 */
function coerceValue(value: unknown, schema: JsonSchema, path: string, errors: string[]): unknown {
  const type = typeof schema.type === 'string' ? schema.type : undefined;
  let result = value;

  switch (type) {
    case 'object':
      result = coerceObject(value, schema, path, errors);
      break;
    case 'array':
      result = coerceArray(value, schema, path, errors);
      break;
    case 'string':
      if (typeof value === 'number' || typeof value === 'boolean') result = String(value);
      else if (typeof value !== 'string') errors.push(`${label(path)}: expected a string, got ${describeType(value)}`);
      break;
    case 'number':
    case 'integer':
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) result = Number(value);
      else if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${label(path)}: expected a number, got ${describeType(value)}`);
      }
      // A non-integer for an `integer` is accepted: every such field here is
      // floored or rounded by its tool, and refusing 2.5 for a timeout would
      // cost a round trip for nothing.
      break;
    case 'boolean':
      if (value === 'true' || value === 1) result = true;
      else if (value === 'false' || value === 0) result = false;
      else if (typeof value !== 'boolean') errors.push(`${label(path)}: expected a boolean, got ${describeType(value)}`);
      break;
    default:
      // No `type`, or one this validator does not model: pass through.
      break;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(result)) {
    errors.push(`${label(path)}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  return result;
}

function coerceObject(value: unknown, schema: JsonSchema, path: string, errors: string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label(path)}: expected an object, got ${describeType(value)}`);
    return value;
  }
  const input = value as Record<string, unknown>;
  const properties =
    schema.properties && typeof schema.properties === 'object' ? (schema.properties as Record<string, JsonSchema>) : null;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((k) => typeof k === 'string') : [];
  const dropUnknown = schema.additionalProperties === false && properties !== null;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    const propSchema = properties?.[key];
    if (!propSchema) {
      if (!dropUnknown) out[key] = raw;
      continue;
    }
    // `null` for an optional property means "not given" — pi's
    // `normalizeOptionalNulls` — rather than a type error.
    if (raw === null && !required.includes(key)) continue;
    out[key] = coerceValue(raw, propSchema, path ? `${path}.${key}` : key, errors);
  }
  for (const key of required as string[]) {
    if (out[key] === undefined || out[key] === null) {
      errors.push(`${path ? `${path}.${key}` : key}: is required`);
    }
  }
  return out;
}

function coerceArray(value: unknown, schema: JsonSchema, path: string, errors: string[]): unknown {
  // A model sometimes sends an array as its JSON string.
  let input = value;
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      if (Array.isArray(parsed)) input = parsed;
    } catch {
      /* fall through to the type error below */
    }
  }
  if (!Array.isArray(input)) {
    errors.push(`${label(path)}: expected an array, got ${describeType(value)}`);
    return value;
  }
  const items = schema.items && typeof schema.items === 'object' ? (schema.items as JsonSchema) : null;
  if (!items) return input;
  return input.map((item, index) => coerceValue(item, items, `${path}[${index}]`, errors));
}
