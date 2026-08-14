#!/usr/bin/env node
// A stand-in for `agy --output-format stream-json` used by agy-session.test.ts.
// Real agy costs real inference and network access, so this fixture emits the
// same line shapes captured from a live probe of v1.1.12 without either.
import crypto from 'node:crypto';

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

} // end of the `args[0] !== 'models'` branch opened above
