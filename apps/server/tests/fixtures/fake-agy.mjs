#!/usr/bin/env node
// A stand-in for the `agy` CLI used by agy-session.test.ts. Real agy costs
// real inference and network access, so this fixture emits the same line
// shapes captured from live probes (v1.1.12 for the event shapes, v1.2.6 for
// the stream-input handshake) without either.
//
// It answers in three modes, matching the three ways `AgySession` invokes the
// real binary:
//
//   `models`                       -> the plain-text model catalogue
//   `--input-format stream-json`   -> the session's long-lived child: one
//                                     NDJSON prompt per line on stdin, one
//                                     turn each, process stays up in between
//   `-p <prompt>`                  -> a one-shot turn, for `/help` and any
//                                     other slash command agy answers itself
import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const providedConversationId = argVal('--conversation');
const conversationId = providedConversationId ?? crypto.randomUUID();
const model = argVal('--model');
const streamInput = argVal('--input-format') === 'stream-json';

// Records the argv of *every* invocation (one JSON array per line), so a test
// can assert on flags real agy would only ever reveal through behaviour we
// cannot reproduce here — specifically `--add-dir`, which is what actually
// binds agy to the session's directory rather than its own scratch project.
// Off unless the test asks for it, since most tests don't care.
if (process.env.AGY_FIXTURE_ARGV_FILE) {
  fs.appendFileSync(process.env.AGY_FIXTURE_ARGV_FILE, JSON.stringify(args) + '\n');
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitInit(tools) {
  emit({
    event: 'init',
    conversation_id: conversationId,
    init: { cwd: process.cwd(), tools, permission_mode: 'always-proceed' },
  });
}

// Real agy's `result` figures are cumulative over the *conversation*, not
// per turn, once a driver holds one process open across several — confirmed
// live against v1.2.6 (`input_tokens` 15047 then 30176 for two trivial turns,
// `num_turns` 1 then 2, `duration_seconds` climbing past a turn's own
// runtime). Reproduced here so `AgySession.makeStatsPerTurn` is actually
// exercised; a fixture reporting flat per-turn numbers would make that
// conversion untestable and let the transcript footer silently regress.
let totalInputTokens = 0;
let totalOutputTokens = 0;
let totalTurns = 0;
let totalDurationSeconds = 0;

function emitResult(extra) {
  totalInputTokens += 10;
  totalOutputTokens += 5;
  totalTurns += 1;
  totalDurationSeconds += 30;
  emit({
    event: 'result',
    result: {
      conversation_id: conversationId,
      status: 'SUCCESS',
      response: '',
      duration_seconds: totalDurationSeconds,
      num_turns: totalTurns,
      usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
      ...extra,
    },
  });
}

/** A `result` line reporting agy's own error text, the way every live failure does. */
function emitErrorResult(error, extra) {
  emitResult({ status: 'ERROR', error, duration_seconds: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 }, ...extra });
}

// `agy models` is a genuine top-level subcommand, not print mode — plain
// text, one `<id>\t<label>` pair per line on stdout (its "Fetching..." status
// line goes to stderr), captured live against v1.1.12.
// `AgySession.fetchInitialModels()` spawns exactly this.
//
// Deliberately waits for stdin to close before answering: the real `agy
// models` was confirmed live to hang forever — zero output, not even its own
// status line — reading an open, unclosed stdin pipe (Node's default `spawn`
// leaves one). `fetchInitialModels()` fixes this with `child.stdin.end()`
// right after spawning; without this `await`, that bug could regress with
// nothing here to catch it, since every other branch in this fixture answers
// immediately regardless of stdin.
if (args[0] === 'models') {
  process.stdin.resume();
  process.stdin.on('end', () => {
    process.stderr.write('Fetching available models...\n');
    process.stdout.write('gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n');
    process.stdout.write('claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n');
    process.exit(0);
  });
} else if (streamInput) {
  runStreamMode();
} else {
  runOneShot(argVal('-p') ?? '');
}

/**
 * The session's long-lived child.
 *
 * The load-bearing difference from the one-shot path: a turn finishing does
 * **not** end this process. `AgySession` relies on that — it is the whole
 * point of using `--input-format stream-json` (see its class doc comment) —
 * so a fixture that exited per turn would make every regression it guards
 * against invisible. Only `FAIL` exits, standing in for a genuine crash.
 */
function runStreamMode() {
  emitInit(['run_command', 'view_file']);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    // Mirrors the real validator, which rejects a frame with no `event` and a
    // `user` event with no `message`.
    if (!parsed || parsed.event !== 'user' || !parsed.message) {
      emitErrorResult('stream input message is missing the "event" field');
      return;
    }
    const text = (parsed.message.content ?? [])
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('');
    runTurn(text, { exitWhenDone: false });
  });
  // agy exits on stdin EOF — confirmed live, and what `terminate()` relies on
  // for a clean shutdown ahead of its SIGTERM.
  rl.on('close', () => process.exit(0));
}

/** One `-p <prompt>` invocation: one turn, then the process is done. */
function runOneShot(prompt) {
  runTurn(prompt, { exitWhenDone: true, emitInit: true });
}

function runTurn(prompt, { exitWhenDone, emitInit: wantInit = false }) {
  const done = () => {
    if (exitWhenDone) process.exit(0);
  };

  if (prompt === 'FAIL') {
    // A genuine crash: no `result` line at all, a reason on stderr, non-zero
    // exit. In stream mode this kills the long-lived child mid-turn, which is
    // the one death `AgySession.onChildClose` has to report and recover from.
    process.stderr.write('simulated failure\n');
    process.exit(1);
  }

  // Mirrors a live-captured quota failure: agy reports the real reason in
  // `result.error` and writes nothing to stderr. `AgySession` must surface
  // `result.error`, not the opaque `agy exited with code 1` fallback that an
  // empty stderr would otherwise leave it with.
  if (prompt === 'QUOTA') {
    emitErrorResult(
      'Eligibility check failed: RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).',
    );
    done();
    return;
  }

  // Same shape, but with error text `AgySession.TRANSIENT_ERROR_PATTERN`
  // recognizes as worth retrying automatically instead of surfacing straight
  // to the user. `TIMEOUT_ALWAYS` fails every attempt, to exercise giving up
  // once the retry budget runs out.
  if (prompt === 'TIMEOUT_ALWAYS') {
    emitErrorResult('timeout waiting for response');
    done();
    return;
  }

  // The same, but only for the *first* attempt — later attempts succeed.
  // State lives in a scratch file rather than in this process, because the
  // one-shot path genuinely is a fresh process per attempt; the test passes
  // its path via `AGY_FIXTURE_TIMEOUT_ONCE_FILE`.
  const onceErrors = {
    TIMEOUT_ONCE: 'timeout waiting for response',
    CONTEXT_CANCELED_ONCE: 'context canceled',
    STREAM_INTERRUPTED_ONCE: 'The stream was interrupted. Please continue the task you were working on.',
  };
  if (onceErrors[prompt]) {
    const stateFile = process.env.AGY_FIXTURE_TIMEOUT_ONCE_FILE;
    if (stateFile && !fs.existsSync(stateFile)) {
      fs.writeFileSync(stateFile, 'seen');
      emitErrorResult(onceErrors[prompt]);
      done();
      return;
    }
    // Falls through to the normal echo turn below once the state file exists.
  }

  // Mirrors a permanently wedged conversation, captured live: replaying a turn
  // against a specific `--conversation <id>` twice outside PocketAgent, both
  // times, finished in a few seconds with the model's answer already in
  // `result.response` — yet `result.status` was `ERROR`/`"context canceled"`
  // and `result.duration_seconds` sat above 600 and climbed by wall-clock time
  // rather than either replay's own runtime, pointing at a deadline attached
  // to the conversation itself. No amount of retrying that same
  // `--conversation` id ever succeeds; only dropping it for a fresh one does —
  // this fixture fails whenever a `--conversation` was actually passed, and
  // answers normally the moment one isn't (see `AgySession`'s
  // conversation-reset path, which discards the child bound to that id).
  if (prompt === 'WEDGED_CONVERSATION' && providedConversationId) {
    if (wantInit) emitInit(['run_command']);
    emitErrorResult('context canceled', { response: 'OK', duration_seconds: 608.19, num_turns: 7 });
    done();
    return;
  }

  // `/help` resolves locally in real agy — no `init` line, no tool step, zero
  // tokens/duration — captured live against v1.1.12. `fetchInitialCommands()`
  // sends exactly this and expects exactly this shape.
  if (prompt === '/help') {
    emit({
      event: 'command_result',
      command: {
        name: 'help',
        data: {
          commands: [
            { name: 'agents', description: 'List available custom agents' },
            { name: 'model', description: 'Set a model' },
            { name: 'usage', aliases: ['quota'], description: 'View model quota usage' },
          ],
        },
      },
    });
    emitResult({
      response: '/agents\tList available custom agents\n/model\tSet a model\n/usage (quota)\tView model quota usage\n',
      duration_seconds: 0,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    done();
    return;
  }

  // Any other slash command agy answers itself. Reached only through the
  // one-shot path, because `AgySession.runSlashTurn` is what sends it — the
  // real CLI refuses a slash command on the stream-json input entirely.
  if (prompt.startsWith('/')) {
    emitResult({ response: `handled ${prompt} locally`, duration_seconds: 0, num_turns: 0 });
    done();
    return;
  }

  // Stands in for agy's own background tasks: `run_command` converts anything
  // still running past `WaitMsBeforeAsync` into a task that the *turn* does
  // not wait for. The timer here outlives the turn exactly as such a task
  // does, so it only ever fires if the process is still alive afterwards —
  // which is precisely the regression this fixture exists to catch.
  if (prompt === 'BACKGROUND_TASK') {
    const taskFile = process.env.AGY_FIXTURE_BACKGROUND_TASK_FILE;
    if (taskFile) {
      setTimeout(() => {
        try {
          fs.writeFileSync(taskFile, 'FINISHED');
        } catch {
          /* the test already tore down */
        }
      }, 500);
    }
    emitResult({ response: 'Started it in the background; waiting for it to finish.' });
    done();
    return;
  }

  // `invoke_subagent`'s real shape, captured live: its own step marks itself
  // `DONE` almost immediately (a premature "launched" acknowledgment, not the
  // sub-agent's actual completion — see `normalizeAgyStepUpdate`'s doc
  // comment), well before the turn's `result` line, which is delayed here to
  // give a test room to observe "still pending" in between.
  if (prompt === 'SUBAGENT') {
    const subagentInfo = {
      subagents: [
        {
          type_name: 'self',
          role: 'File Writer',
          initial_prompt: 'write stuff',
          conversation_id: 'sub-1',
          log_uri: 'file:///tmp/sub-1/transcript.jsonl',
        },
      ],
    };
    for (const state of ['ACTIVE', 'DONE']) {
      emit({
        event: 'step_update',
        step_update: {
          conversation_id: conversationId,
          step_index: 1,
          state,
          step_type: 'subagent',
          tool_name: 'invoke_subagent',
          subagent_info: subagentInfo,
        },
      });
    }
    setTimeout(() => {
      emitText('The sub-agent finished.');
      emitResult({ response: 'The sub-agent finished.', duration_seconds: 0.2 });
      done();
    }, 150);
    return;
  }

  if (wantInit) emitInit(['run_command', 'view_file']);

  emit({
    event: 'step_update',
    step_update: {
      conversation_id: conversationId,
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' } },
    },
  });
  emit({
    event: 'step_update',
    step_update: {
      conversation_id: conversationId,
      step_index: 1,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, output: 'hi\n' },
    },
  });

  const respond = () => {
    // Echoes the `--model` flag (when present) into the response text, so a
    // test can confirm `AgySession.setModel()` actually reached the *next*
    // child's argv rather than just recording it internally.
    const text = model ? `echo: ${prompt} model=${model}` : `echo: ${prompt}`;
    emitText(text);
    emitResult({ response: text });
    done();
  };

  if (prompt === 'SLOW') {
    // Long enough for a test to call interrupt()/terminate() before this fires.
    setTimeout(respond, 5000);
  } else {
    respond();
  }
}

function emitText(text) {
  emit({
    event: 'step_update',
    step_update: {
      conversation_id: conversationId,
      step_index: 3,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: text,
    },
  });
}
