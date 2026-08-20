#!/usr/bin/env node
// A stand-in for `agy --output-format stream-json` used by agy-session.test.ts.
// Real agy costs real inference and network access, so this fixture emits the
// same line shapes captured from a live probe of v1.1.12 without either.
import crypto from 'node:crypto';
import fs from 'node:fs';

const args = process.argv.slice(2);
function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const prompt = argVal('-p') ?? '';
const conversationId = argVal('--conversation') ?? crypto.randomUUID();
const model = argVal('--model');

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// `agy models` is a genuine top-level subcommand, not `-p` print mode — plain
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
}
// Never reaches the rest of this file for `models`, since everything below
// requires `-p`/`--conversation`/etc. — this early-returns via the `end`
// handler above once stdin closes, rather than falling through.
else {

if (prompt === 'FAIL') {
  process.stderr.write('simulated failure\n');
  process.exit(1);
}

// Mirrors a live-captured quota failure: agy prints a well-formed `result`
// line with the real reason in `result.error`, writes nothing to stderr, and
// still exits 1. `AgySession` must surface `result.error`, not the opaque
// `agy exited with code 1` fallback that an empty stderr would otherwise
// leave it with.
if (prompt === 'QUOTA') {
  emit({
    event: 'result',
    result: {
      conversation_id: conversationId,
      status: 'ERROR',
      response: '',
      error:
        'Eligibility check failed: RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).',
      duration_seconds: 0,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  process.exit(1);
}

// Mirrors a live-captured infrastructure hiccup: a network/backend timeout
// talking to the Antigravity service, reported the same way as `QUOTA`
// (a well-formed `result` line, empty stderr, non-zero exit) but with error
// text `AgySession.TRANSIENT_ERROR_PATTERN` recognizes as worth retrying
// automatically instead of surfacing straight to the user. `TIMEOUT_ALWAYS`
// fails every attempt, to exercise giving up once retry budget runs out.
if (prompt === 'TIMEOUT_ALWAYS') {
  emit({
    event: 'result',
    result: {
      conversation_id: conversationId,
      status: 'ERROR',
      response: '',
      error: 'timeout waiting for response',
      duration_seconds: 0,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  process.exit(1);
}

// Same shape as `TIMEOUT_ALWAYS`, but only for the *first* attempt — later
// invocations (retries) succeed normally. Statefulness across attempts has
// to live outside the process, since each retry is a fresh `agy` spawn: the
// test passes a scratch file path via `AGY_FIXTURE_TIMEOUT_ONCE_FILE`, and
// this fixture's own presence/absence of that file is the counter.
if (prompt === 'TIMEOUT_ONCE') {
  const stateFile = process.env.AGY_FIXTURE_TIMEOUT_ONCE_FILE;
  if (stateFile && !fs.existsSync(stateFile)) {
    fs.writeFileSync(stateFile, 'seen');
    emit({
      event: 'result',
      result: {
        conversation_id: conversationId,
        status: 'ERROR',
        response: '',
        error: 'timeout waiting for response',
        duration_seconds: 0,
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    process.exit(1);
  }
  // Falls through to the normal echo turn below once the state file exists.
}

if (prompt === 'CONTEXT_CANCELED_ONCE') {
  const stateFile = process.env.AGY_FIXTURE_TIMEOUT_ONCE_FILE;
  if (stateFile && !fs.existsSync(stateFile)) {
    fs.writeFileSync(stateFile, 'seen');
    emit({
      event: 'result',
      result: {
        conversation_id: conversationId,
        status: 'ERROR',
        response: '',
        error: 'context canceled',
        duration_seconds: 0,
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    process.exit(1);
  }
}

// `/help` resolves locally in real agy — no `init` line, no tool step, zero
// tokens/duration — captured live against v1.1.12. Handled before the normal
// turn shape below since `AgySession.fetchInitialCommands()` sends exactly
// this and expects exactly this response shape.
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
  emit({
    event: 'result',
    result: {
      conversation_id: conversationId,
      status: 'SUCCESS',
      response: '/agents\tList available custom agents\n/model\tSet a model\n/usage (quota)\tView model quota usage\n',
      duration_seconds: 0,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  process.exit(0);
}

// `invoke_subagent`'s real shape, captured live: its own step marks itself
// `DONE` almost immediately (a premature "launched" acknowledgment, not the
// sub-agent's actual completion — see `normalizeAgyStepUpdate`'s doc
// comment), well before the turn's `result` line, which is delayed here to
// give a test room to observe "still pending" in between.
if (prompt === 'SUBAGENT') {
  emit({
    event: 'init',
    conversation_id: conversationId,
    init: { cwd: process.cwd(), tools: ['invoke_subagent'], permission_mode: 'always-proceed' },
  });
  emit({
    event: 'step_update',
    step_update: {
      conversation_id: conversationId,
      step_index: 1,
      state: 'ACTIVE',
      step_type: 'subagent',
      tool_name: 'invoke_subagent',
      subagent_info: {
        subagents: [
          {
            type_name: 'self',
            role: 'File Writer',
            initial_prompt: 'write stuff',
            conversation_id: 'sub-1',
            log_uri: 'file:///tmp/sub-1/transcript.jsonl',
          },
        ],
      },
    },
  });
  emit({
    event: 'step_update',
    step_update: {
      conversation_id: conversationId,
      step_index: 1,
      state: 'DONE',
      step_type: 'subagent',
      tool_name: 'invoke_subagent',
      subagent_info: {
        subagents: [
          {
            type_name: 'self',
            role: 'File Writer',
            initial_prompt: 'write stuff',
            conversation_id: 'sub-1',
            log_uri: 'file:///tmp/sub-1/transcript.jsonl',
          },
        ],
      },
    },
  });
  setTimeout(() => {
    emit({
      event: 'step_update',
      step_update: {
        conversation_id: conversationId,
        step_index: 2,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'The sub-agent finished.',
      },
    });
    emit({
      event: 'result',
      result: {
        conversation_id: conversationId,
        status: 'SUCCESS',
        response: 'The sub-agent finished.',
        duration_seconds: 0.2,
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    process.exit(0);
  }, 150);
} else {

emit({
  event: 'init',
  conversation_id: conversationId,
  init: {
    cwd: process.cwd(),
    tools: ['run_command', 'view_file'],
    permission_mode: 'always-proceed',
  },
});

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
    tool_info: {
      name: 'run_command',
      parameters: { CommandLine: 'echo hi' },
      output: 'hi\n',
    },
  },
});

function respond() {
  // Echoes the `--model` flag (when present) into the response text, so a
  // test can confirm `AgySession.setModel()` actually reached the *next*
  // turn's argv rather than just recording it internally.
  const text = model ? `echo: ${prompt} model=${model}` : `echo: ${prompt}`;
  emit({
    event: 'step_update',
    step_update: {
      conversation_id: conversationId,
      step_index: 2,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: text,
    },
  });
  emit({
    event: 'result',
    result: {
      conversation_id: conversationId,
      status: 'SUCCESS',
      response: text,
      duration_seconds: 0.01,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  });
  process.exit(0);
}

if (prompt === 'SLOW') {
  // Long enough for a test to call interrupt()/terminate() before this fires.
  setTimeout(respond, 5000);
} else {
  respond();
}

} // end of the `prompt === 'SUBAGENT'` branch opened above

} // end of the `args[0] !== 'models'` branch opened above
