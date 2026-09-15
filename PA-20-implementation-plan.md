# PA-20 Implementation Plan — Voice Input for Pocket Agent

Status: **DRAFT, revised after review round 1 — awaiting explicit go-ahead.** Nothing in this
plan is implemented yet.

**Revision note (round 1):** review answered §9's five open questions. #2/#4/#5 confirmed as
written ("sg"). #3 (skip mobile Safari for now) is done — split into a new follow-up,
**PA-54**, linked "Relates" to this ticket. #1 (review the real `live-stt` code) is done — I
read the actual service at `~/src/live-stt` (not just its Jira tickets) and it changed several
implementation details below (now marked **[confirmed from source]**); see §5 and §9 for the
diffs. None of this round's feedback was itself the literal "go ahead"/"approve"/`agent-ready`
signal the workflow requires before I start writing code, so I'm still holding at the plan
stage — flagging that explicitly at the end of this document.

## 0. What triggered this plan

PA-20 was reassigned to me with a comment: *"LS-1 has been completed. You can review LS-1 to
LS-5 for the latest change of live-stt. See if still any gap."* I reviewed all five:

| Ticket | Summary | Status | Relevance to PA-20 |
|---|---|---|---|
| LS-1 | Real-time TTS engine (`POST /v1/audio/speech`, streaming/chunked variant) | **Done** | **Clears PA-20's stated blocker.** Mode 2's talk-back half can now be built, not deferred. |
| LS-2 | Parakeet-TDT-0.6B-v3 as a third, batch-only ASR engine | Done | Not needed. PA-20 already targets `whisper-large-v3-turbo` for batch transcription; this is an alternative engine choice on the live-stt side, not a new capability PA-20's client needs. |
| LS-3 | Admin UI column-width tweak | Done | Irrelevant (live-stt's own admin dashboard). |
| LS-4 | Speaker diarization (Sortformer v2.1) exploration | Done | Not needed for single-user push-to-talk/listen. Noted as a possible future enhancement (see Open Questions), not in scope here. |
| LS-5 | Explore pre-built-backend distribution architecture for live-stt | **In Review**, not Done | Doesn't block PA-20 — it's about how live-stt packages/installs its own engines, not about the HTTP/gRPC surface PA-20's client calls. No action needed here. |

**Net effect: the ticket's stated blocker ("blocked on LS-1" for talk-back) is cleared.** This
plan covers the full original scope (both modes, including talk-back) rather than a
blocker-truncated slice.

I also read the actual PA-20 issue link: `PA-20 is blocked by LS-1` — that link can be resolved
once this work starts, since LS-1 is Done.

## 1. Codebase findings (why this plan differs from the ticket's literal "shared plumbing" section)

I investigated the current repo before designing anything. Relevant facts:

1. **No prior voice/audio/STT/TTS code exists anywhere** (`apps/web`, `apps/server`,
   `packages/protocol`, docs) — this is greenfield. The only "live-stt" hits in the repo are an
   unrelated Bamboo CI plan literally named `live-stt-docker` in webhook test fixtures.
2. **No gRPC anywhere in this repo.** No `@grpc/grpc-js`, no `.proto` files, no gRPC client
   pattern to build on. Introducing it would be a brand-new dependency and a brand-new
   integration shape with zero precedent (the closest analogues are the HTTP+SSE/JSON-RPC
   bridges to long-lived external processes — `apps/server/src/sessions/opencode-server.ts` and
   `codex-server.ts`).
3. **Binary WebSocket frames are explicitly rejected today**
   (`apps/server/src/ws/index.ts:432-435`: `if (isBinary) { sendError('bad_message', ...); return; }`).
   Any audio that goes over the existing WS would have to be base64 inside a JSON frame — the
   same convention `PromptImage` already uses (`packages/protocol/src/prompt-image.ts`:
   base64 `data` field, capped via `MAX_IMAGE_BASE64_CHARS`, checked against
   `LIMITS.maxMessageBytes` = 8 MiB).
4. **`text_delta` already exists and is agent-agnostic** — `sessions/normalize.ts` emits
   `{ kind: 'text_delta', id, text }` from all four backends' native streaming shapes
   (Claude SDK, agy, opencode, codex), and `agent-events.ts:37` defines `TextDeltaEvent`. This is
   the exact hook Mode 2's sentence-chunked TTS needs, and it requires **no changes** to add.
5. **`interrupt` already exists** (`ws/index.ts:613`, `requireStructured` + `session.interrupt()`)
   — Mode 2's barge-in can reuse it verbatim, per the ticket's own suggestion.
6. **The composer's active-session input is `apps/web/src/components/PromptBox.tsx`**, not
   `ComposerPage.tsx` (which is the pre-session "start a chat" screen). `PromptBox` already
   models turn-in-flight (`busy`/`onInterrupt` props) and has an existing image-attach button —
   the mic button and live-listen toggle belong here, following that same affordance style.
7. **The per-session persistent-disclosure pattern is established**: `SessionInfo.skipPermissionsEnabled`
   and `providerDisclosure` (`packages/protocol/src/session.ts:100-112`) are surfaced on *every*
   view of a session, not just at creation — the exact treatment PA-20's own acceptance criteria
   ask for ("mic-active state is always visibly indicated").
8. **A capability-advertisement field already exists at the agent level** (`AgentInfo`, e.g.
   `supportsSkipPermissions`) — the natural place to add `supportsVoice`.

## 2. Recommended scope decisions (deviations from the ticket's literal architecture — flagging for explicit sign-off)

These change *how* PA-20 is built, not *what* it delivers — every acceptance criterion in the
ticket is still met. I'm calling them out explicitly rather than silently deciding, since they
depart from the ticket's "What to build" section as written.

**D1 — Drop the gRPC bridge; use live-stt's HTTP surface exclusively, for both modes.**
Re-reading the ticket's own mode descriptions: Mode 1 says gRPC streaming is *optional*
("buffer captured audio (**or** open a live gRPC stream for interim feedback)") and the actual
submission is always the batch HTTP endpoint; Mode 2 explicitly says "no live captions, no need
for word-by-word partials," and its own submission step is also the batch HTTP endpoint. gRPC's
only possible use in this ticket is live partial-transcript UI feedback while still speaking —
a feature the ticket does not actually require. Cutting it removes a brand-new dependency
(`@grpc/grpc-js`), a brand-new proto-management problem (we'd need live-stt's `.proto` file,
which lives in that project, not this one), and an entire "browser can't do bidirectional gRPC"
bridge layer — while still meeting every acceptance criterion. If real-time partial captions are
wanted later, that's a clean, additive follow-up (see Open Questions).

**D2 — No new WS frames for audio *up* in either mode; use a single buffered-utterance HTTP
upload instead.** Because neither mode needs interim feedback (per D1), the browser never needs
to stream audio continuously to the server — it only ever needs to hand over *one already-VAD-
or-button-bounded utterance* per turn (client-side VAD does the endpointing for Mode 2; the
button does it for Mode 1). That is a single request/response, not a stream, so it is a plain
authenticated `POST /api/sessions/:id/voice/transcribe` with base64 PCM in the JSON body —
exactly the existing `PromptImage` precedent (D1's items 3 above), sized for a ≤60s utterance
(well inside `LIMITS.maxMessageBytes`, and a new dedicated cap will be added regardless — see
§4.1). This drops the "new WS message types for streaming mic audio up" line from the ticket's
plumbing section entirely.

**D3 — TTS audio *down* (Mode 2 only) does go over the existing session WebSocket**, as new
server→client frames, because that traffic is genuinely incremental (one chunk per completed
sentence, arriving throughout a streaming reply) and the session socket is already the channel
carrying that reply's `text_delta`/`text` events. This is the one place a WS protocol change is
still needed.

**D4 — Mode 2 (live-listen/talk-back) is scoped to structured-transport sessions only** for all
five phases. Barge-in reuses `interrupt`, which already `requireStructured`s; talk-back depends
on `text_delta`, which only structured sessions emit. Mode 1 (push-to-talk) has no such
dependency — submitting a transcript is just calling the same prompt path any transport already
uses — so it is **not** transport-restricted (it works for terminal sessions too, gated by
`AgentInfo.supportsVoice`... actually gated by live-stt being configured at all, see §4.1 — the
capability is "can this server reach live-stt," not "is this a structured session").

None of D1-D4 change the acceptance criteria, the UI/UX described, or the privacy posture. If
review prefers the ticket's literal gRPC/streaming-frames design (e.g. because real-time partial
captions are wanted from day one), say so and I will replan Phases 2-3 around it.

**D5 — [new, round 1] Call live-stt's plain (non-streaming) `/v1/audio/speech` once per our own
sentence chunk, rather than using live-stt's own `stream: true` mode.** Reading the real
`tts_http.py`/`admin_http.py` source: `stream: true` doesn't return one continuous encoded audio
stream — it hand-writes HTTP chunked-transfer framing where **each chunk is an independently
re-synthesized, independently encoded audio file per sentence** (its own WAV/container header
each time), because live-stt does its own internal sentence-splitting for that mode. Since our
own TTS pipeline (§5.4) already sentence-chunks `text_delta` and calls `synthesize()` per chunk,
using live-stt's `stream: true` on top would mean chunking twice and then having to re-split
live-stt's concatenated multi-file byte stream back apart on our end — genuinely fragile for
non-self-delimiting formats. Calling the plain single-shot endpoint once per *our* sentence
gets one clean, correctly-`Content-Length`'d response per call, for free, with strictly simpler
code. No loss of the "speak each sentence as soon as it's ready" behavior — that's still true
here, since we still fire the call as soon as our chunker completes a sentence.

**D6 — [new, round 1] Request `response_format=pcm` from `/v1/audio/speech`, not the default
`mp3`.** Reading `tts.py:289-321`: `mp3`/`opus`/`aac`/`flac` are produced by piping a WAV through
`ffmpeg`, and **on ffmpeg failure the code silently falls back to raw WAV bytes while still
labelling `Content-Type` as `audio/mpeg`/`audio/<fmt>`** — a real landmine for a client that
trusts the header. Raw `pcm` (int16 mono at the model's fixed sample rate — 24000 Hz for
`kokoro-82m-v1`, 22050 Hz for `piper-en-us`) sidesteps that entirely: no optional `ffmpeg`
dependency in the path at all, and the browser can build a Web Audio `AudioBuffer` directly from
the sample data without a container-format decode step (`decodeAudioData`, which has its own
cross-browser quirks for less-common codecs). `wav` would also avoid the ffmpeg bug but adds a
trivial RIFF-header-skip the client would have to do for no benefit over `pcm`.

## 3. Configuration

New, all following `.env.example`'s existing conventions (grouped section, commented out by
default, doc comment explaining "unset" behavior):

```
# --- Voice input (PA-20) ---
# Base URL of the self-hosted live-stt service (see the LS Jira project). Reachable only from
# this server, never from the browser — live-stt has no auth on its own HTTP/gRPC/admin surface.
# Unset disables the voice feature entirely (mic button and live-listen toggle are hidden), the
# same "absence of a related var means the feature doesn't exist" convention as
# POCKETAGENT_SETTINGS_ENC_KEY / POCKETAGENT_CODE_SERVER_URL.
# POCKETAGENT_LIVE_STT_URL=http://10.100.0.50:PORT
```

One URL, not two: per LS-1, `/v1/audio/speech` was wired into live-stt's *existing*
`admin_http.py` `ThreadingHTTPServer` — the same host:port already serving
`/v1/audio/transcriptions`. No secret is needed (live-stt has no auth today; that is a
documented, out-of-scope gap on the LS side, not something this feature should paper over by
inventing a credential live-stt can't check).

No per-user or per-session model override for the MVP — use live-stt's defaults
(`whisper-large-v3-turbo` for transcription, LS-1's default TTS model) rather than exposing a
model picker; can be added later the same way `AgentInfo.cachedModels` was.

## 4. Protocol changes (`packages/protocol`)

### 4.1 New leaf module `packages/protocol/src/voice-audio.ts` (parallel to `prompt-image.ts`)

```ts
export const MAX_VOICE_AUDIO_BYTES = 10 * 1024 * 1024; // ~60s of 16kHz mono PCM16 plus headroom
export const MAX_VOICE_AUDIO_BASE64_CHARS = Math.ceil((MAX_VOICE_AUDIO_BYTES * 4) / 3);

export const VoiceAudioUpload = z.object({
  /** Base64 16kHz mono PCM16 (or a container the server/live-stt can decode; TBD in Phase 1 spike). */
  data: z.string().min(1).max(MAX_VOICE_AUDIO_BASE64_CHARS),
  mimeType: z.string(),
  durationMs: z.number().nonnegative(),
});
```

### 4.2 `packages/protocol/src/http.ts`

- `VoiceTranscribeRequest = z.object({ audio: VoiceAudioUpload })`
- `VoiceTranscribeResponse = z.object({ text: z.string() })`
- Route: `POST /api/sessions/:id/voice/transcribe` — auth like every other session route,
  `requireStructured`-equivalent is **not** applied here (Mode 1 works on any transport, per D4);
  the only gate is "is `POCKETAGENT_LIVE_STT_URL` configured" (503/feature-disabled otherwise).

### 4.3 `packages/protocol/src/session.ts`

- `AgentInfo.supportsVoice: z.boolean()` — actually this should be a server-global capability
  (live-stt configured or not), not per-agent, since any agent/transport can submit a
  transcribed prompt. Correcting my own first instinct here: this becomes
  `GET /api/agents`-adjacent config exposed once (e.g. folded into the existing settings/config
  response the client already fetches at boot) rather than duplicated onto every `AgentInfo` row.
  Concretely: add `voiceEnabled: z.boolean()` to whatever response already tells the client
  which optional features are on (I'll confirm the exact existing "server capabilities" response
  during implementation — likely alongside where `globalSkipPermissions`'s current value is
  surfaced today).
- `SessionInfo.voiceModeEnabled: z.boolean()` — persistent, mirrored on every view, exactly like
  `skipPermissionsEnabled` (§1 item 7). Structured sessions only (Mode 2 gate, D4).

### 4.4 `packages/protocol/src/ws.ts` — bump `PROTOCOL_VERSION` to 16

New client→server message:
```ts
export const VoiceModeMessage = z.object({
  type: z.literal('voice_mode'),
  sessionId: SessionId,
  enabled: z.boolean(),
});
```
(add to the `ClientMessage` union; server rejects it for a non-structured session or when
live-stt isn't configured, same style as the `model`/`effort` `canSetX` guards)

New server→client messages:
```ts
export const VoiceModeChangedEvent = z.object({
  type: z.literal('voice_mode_changed'),
  sessionId: SessionId,
  enabled: z.boolean(),
});

export const TtsAudioMessage = z.object({
  type: z.literal('tts_audio'),
  sessionId: SessionId,
  turnId: z.string(),      // correlates chunks to the reply/turn they belong to, for discard-on-interrupt
  sentenceSeq: z.number().int().nonnegative(),
  data: z.string(),        // base64 audio chunk
  mimeType: z.string(),
  done: z.boolean(),       // true on the final chunk of this turn's speech
});
```
(add both to the `ServerMessage` union)

Doc-comment addition to the existing versioned history block, matching its established voice
(no pun intended) and density:
> `v16` added the `voice_mode` client message and `voice_mode_changed`/`tts_audio` server
> messages (PA-20). An older bundle doesn't know `tts_audio` and would otherwise silently
> discard talk-back audio while continuing on the same socket — same reasoning as `v10`'s
> `rate_limit` event.

## 5. Server-side changes (`apps/server`)

### 5.1 `apps/server/src/voice/live-stt-client.ts` (new)

A thin HTTP client for live-stt's two endpoints. **[confirmed from source, round 1 — the spike
originally planned for Phase 1 is done; no more open questions here]**:

- `transcribe(pcm16: Buffer): Promise<string>` — wraps the raw 16kHz mono PCM16 the browser
  already captured/uploaded as a proper WAV file (live-stt requires **exactly** 16kHz/mono/16-bit
  PCM, `400`s on anything else — `transcribe_http.py:92-104`), then POSTs it as
  `multipart/form-data` to `{LIVE_STT_URL}/v1/audio/transcriptions` with fields `file` (the WAV)
  and `response_format=json` (default `whisper-large-v3-turbo`-equivalent model key from
  `live_stt/models.py`; no need to pass `model` explicitly unless we want to override it later).
  Response: `{"text": "..."}`. This is a **plain request/response**, not SSE — even
  `stream=true` on this endpoint answers with the whole transcript in one `data:` line, not
  incremental partials (confirming D1/D2 lose nothing: there is no real partial-transcript mode
  to give up).
- `synthesize(text: string): Promise<{ pcm: Buffer; sampleRateHz: number }>` — POSTs JSON
  `{ input: text, response_format: 'pcm' }` (per D6) to `{LIVE_STT_URL}/v1/audio/speech`, no
  `stream` field (per D5 — we call this once per our own already-chunked sentence). Returns raw
  PCM16 bytes plus the fixed sample rate for whichever model answered (24000 Hz for the
  `kokoro-82m-v1` default).
- **Error handling, both endpoints**: `503` means "insufficient VRAM," "at capacity," or
  "draining" — all genuinely retryable-later, never retried automatically here (no
  timeout-into-retry-storm, consistent with this app's existing no-decay posture). **The two
  endpoints' error-body shapes differ and the client must not assume one schema for both**:
  transcribe answers `{"error": {"message": "..."}}`, speech answers the flatter
  `{"error": "..."}` — verified directly against `transcribe_http.py`/`tts_http.py`, not
  assumed. A `503` from either surfaces to the browser as a distinct "voice service busy, try
  again" state, not a generic error.

Config resolution follows the existing "unset disables the feature" convention
(`parseSettingsEncKey` in `crypto/secret-box.ts` is the precedent): `POCKETAGENT_LIVE_STT_URL`
unset ⇒ `LiveSttClient` is `null` server-wide. **[confirmed]** the value should point at
`http://<host>:8000` — live-stt's HTTP admin surface (`LSTT_ADMIN_PORT`, default `8000`) serves
both endpoints; its gRPC port (`LSTT_GRPC_PORT`, default `50051`) is irrelevant to this plan
(D1). **[confirmed]** no auth exists on either surface — a direct `grep` across live-stt's HTTP/
gRPC server setup found nothing, matching what the Jira tickets claimed.

One caveat surfaced during the code review, not fully resolved: the live-stt checkout has
several other git worktrees (`feature-architecture`, `feature-model-support`,
`feature-web-ui`) beside its main branch. Everything above is read from the main worktree, which
I'm treating as "what's actually deployed" since LS-1 is marked Done there — flagging in case
that assumption is wrong.

Config resolution follows the existing "unset disables the feature" convention
(`parseSettingsEncKey` in `crypto/secret-box.ts` is the precedent): `POCKETAGENT_LIVE_STT_URL`
unset ⇒ `LiveSttClient` is `null` server-wide, routes/WS handlers answer "voice not configured"
rather than throwing, and the frontend hides all voice UI.

### 5.2 `routes/voice.ts` (new) — `POST /api/sessions/:id/voice/transcribe`

Validates session ownership/existence (same pattern as other session routes), decodes the
base64 audio, calls `LiveSttClient.transcribe`, returns `{ text }`. **Does not itself submit a
prompt** — mirrors the ticket's "goes through the *same* prompt path `ComposerPage`/
`setPendingPrompt` already use" instruction: the transcript is handed back to the browser, and
the browser calls `PromptBox`'s existing `onSend(text)` exactly as if the user had typed it. No
new "voice prompt" concept anywhere server-side.

### 5.3 `ws/index.ts` — two new `case` arms alongside `case 'prompt'`/`case 'interrupt'`

- `case 'voice_mode':` — `requireStructured`, checks `LiveSttClient` is configured, flips
  `SessionInfo.voiceModeEnabled` (persisted on the session row, mirrored like
  `skipPermissionsEnabled`), emits `voice_mode_changed` back.
- No new case is needed for audio upload (that's the REST route, §5.2, per D2) or for barge-in
  (that's the *existing* `case 'interrupt'`, per D3/§1 item 5).

### 5.4 TTS pipeline (Mode 2 talk-back) — lives in `sessions/manager.ts` or a new
`sessions/voice-tts.ts` subscriber

- Subscribes to a structured session's `AgentEvent` stream (the same stream `ws/index.ts`
  already forwards to the browser as `AgentEventMessage`) only while `voiceModeEnabled` is true.
- Buffers `text_delta` text, sentence-chunks on `. ! ?` plus a max-length/timeout fallback (so a
  long clause without punctuation doesn't block indefinitely), and calls
  `LiveSttClient.synthesize(sentence)` per chunk, streaming the resulting audio back out as
  `tts_audio` WS frames tagged with the current `turnId` and an incrementing `sentenceSeq`.
- **On `interrupt`**: aborts any in-flight `synthesize()` call for that `turnId` and stops
  emitting further `tts_audio` frames for it — closes the race where audio already queued for a
  just-interrupted turn would otherwise play late after the user has started talking again. This
  is the one genuinely new piece of logic in the whole feature (everything else is composing
  existing primitives); it needs its own focused unit test (see §7).

### 5.5 `sessions/env.ts`

Confirm `POCKETAGENT_LIVE_STT_URL` is **not** forwarded into any spawned agent child process —
it's server-only config, same treatment as every other `POCKETAGENT_*` var per the existing
stripping invariant.

## 6. Frontend changes (`apps/web`)

### 6.1 `apps/web/src/audio/` (new directory)

- `capture.ts` — `getUserMedia({ audio: { echoCancellation: true } })` + `AudioWorkletNode`
  producing 16kHz mono PCM16, buffered client-side. One capture path shared by both modes.
- `vad.ts` — Silero VAD via WASM (per the ticket's own recommendation), wrapping start/end-of-
  speech callbacks. Only loaded/instantiated when Mode 2 is toggled on (no cost for push-to-talk
  users or voice-disabled deployments).
- `playback.ts` — Web Audio API playback of incoming `tts_audio` chunks, exposing a `stop()`
  used on barge-in.

### 6.2 `apps/web/src/components/PromptBox.tsx`

- New hold-to-record mic button (Mode 1), visible whenever the server has advertised
  `voiceEnabled` (§4.3). On press: start capture. On release: stop capture, `POST
  /api/sessions/:id/voice/transcribe`, then call the existing `onSend(text)` with the returned
  transcript — no new submission path.
- New live-listen toggle (Mode 2), visible only for structured sessions with `voiceEnabled`.
  Sends the new `voice_mode` WS message; renders a **persistent, always-visible "mic is live"**
  indicator whenever `SessionInfo.voiceModeEnabled` is true (never only at the moment it was
  turned on — same discipline as `skipPermissionsEnabled`'s badge, per the ticket's own privacy
  requirement). Off by default on every session, every time — no persisted "last used" default.
- When live-listen is on: VAD end-of-turn → same transcribe-then-`onSend` path as Mode 1.
  Incoming `tts_audio` frames are queued and played; VAD keeps running during playback for
  barge-in, and on new speech detected, playback stops (`playback.stop()`) and the *existing*
  `onInterrupt` callback fires (which already sends the `interrupt` WS message today).

### 6.3 `apps/web/src/agent/pending-prompt.ts` / `ComposerPage.tsx`

Explicitly **out of scope for this plan's phases** — voice input on the pre-session "start a
chat" screen has no live session to submit into yet, and the ticket's acceptance criteria are
all phrased in terms of an active session. Flagging as a natural, small follow-up rather than
silently expanding scope.

## 7. Phased delivery (keeps the ticket's own phase numbering and independence guarantees)

- **Phase 1 — Push-to-talk, no TTS, ships independently of anything else.**
  §4.1, §4.2 (transcribe route + schemas only), §5.1 (transcribe half only), §5.2, §6.1
  (`capture.ts` only), §6.2 (mic button only). No `PROTOCOL_VERSION` bump needed yet (REST-only).
  Includes the live-stt request/response spike (§8 #1) since it gates everything downstream.
- **Phase 2 — Live-listen loop, text-only reply (no TTS yet), validates VAD before audio output.**
  §6.1 (`vad.ts`), §6.2 (live-listen toggle, wired to reuse Phase 1's transcribe path on
  VAD end-of-turn). `PROTOCOL_VERSION` bump to 16 lands here for `voice_mode`/`voice_mode_changed`
  (§4.4, §5.3) — `tts_audio` schema can be added in the same bump even though nothing emits it
  yet, to avoid a second version bump for Phase 3.
- **Phase 3 — Sentence-chunked TTS wiring + playback.**
  §5.4 (happy path only, no interrupt-cancellation yet), §6.1 (`playback.ts`), §6.3's frame
  handling in the WS client. This is where the live-stt `/v1/audio/speech` streaming spike
  (§8 #1) gets exercised for real.
- **Phase 4 — Barge-in / interruption handling.**
  §5.4's abort-in-flight-synthesis logic, §6.2's VAD-during-playback wiring to the existing
  `onInterrupt`. This is the phase with the actual race condition to get right (§5.4's note) and
  should get disproportionate test attention relative to its size.
- **(Ticket's original Phase 5 is folded into Phase 4 here — barge-in is a single coherent unit
  of work once §5.4 exists; splitting it further doesn't reduce risk.)**

Each phase is independently shippable and independently reviewable, same as the ticket asked
for — Phase 1 in particular ships with zero dependency on live-stt's TTS half at all.

## 8. Testing & verification plan

Per this repo's own convention (`CLAUDE.md`'s "Live demos" section): the unit suite cannot cover
real audio capture, a real VAD model, or a real TTS voice, so this feature needs both layers.

**Unit/integration (`pnpm test`):**
- `voice/live-stt-client.test.ts` — against a local fake HTTP server (same style as this repo's
  other "fake subprocess"/fake-endpoint tests), covering timeout, malformed-response, and
  live-stt-unreachable paths (must degrade to a clean error, never hang a turn).
- `ws/voice.test.ts` — `voice_mode` gating (rejected for non-structured sessions, rejected when
  unconfigured), `SessionInfo.voiceModeEnabled` persistence and mirroring on reconnect.
- `sessions/voice-tts.test.ts` — sentence-chunking boundary cases (no punctuation, very short
  deltas, very long unpunctuated run-ons) and, most importantly, the interrupt-cancellation race
  from §5.4: assert that a `tts_audio` frame is never emitted for a `turnId` that was already
  interrupted, using fake timers to force the race deterministically.
- `routes/voice.test.ts` — the transcribe route's size cap, feature-disabled response shape.

**Live demo (new, following the `pnpm demo:*` pattern exactly):**
- `pnpm demo:voice-ptt` — real Chrome (Playwright), a real mic input (pre-recorded WAV fixture
  fed into `getUserMedia` via Chrome's fake-device flags, the standard way this repo would need
  to do it since there's no real microphone in CI), asserts the mic button produces a submitted
  prompt end-to-end against a scratch server.
- `pnpm demo:voice-live` — same fixture-audio approach, exercises VAD end-of-turn detection,
  TTS playback, and a scripted barge-in (a second fixture utterance played partway through the
  reply) to prove interrupt actually stops audio and cancels the turn.
- Both require `POCKETAGENT_LIVE_STT_URL` pointed at a **real** live-stt instance for at least
  one manual run each before calling a phase done — per this org's demonstrated "verified for
  real, not just wired up" standard (see every LS-1/LS-2 ticket's own phased acceptance
  criteria). Fixture/mocked runs are fine for CI-friendly regression coverage after that.

## 9. Risks / open questions

1. **RESOLVED (round 1).** Read the real `live-stt` source (`~/src/live-stt`) rather than
   spiking blind in Phase 1. `/v1/audio/transcriptions` is `multipart/form-data` with a `file`
   field (strict 16kHz/mono/16-bit WAV, `400` otherwise); `/v1/audio/speech` is JSON with `input`
   (or `text`), `response_format`, `stream`. Full details folded into §5.1, and D5/D6 above are
   new design decisions this uncovered. No further spike needed before Phase 1.
2. **CONFIRMED, no change (round 1: "sg").** live-stt's own documented ~1% dropped-audio bug on
   stream restart — low exposure here since D1/D2 mean this feature never opens a long-lived
   streaming session, only short discrete batch calls, which don't hit the rotation path that
   triggers it.
3. **SPLIT OUT (round 1: "please skip mobile as of now and write a new follow up ticket").**
   Mobile Safari's `AudioWorkletNode`/autoplay-policy support for TTS playback is now tracked in
   **PA-54** (linked "Relates" to this ticket) rather than blocking this plan. This plan proceeds
   without mobile Safari verification; PA-54 is the explicit record of that gap.
4. **CONFIRMED, no change (round 1: "sg").** Diarization (LS-4) and multi-speaker scenarios stay
   explicitly out of scope — a possible future enhancement, not a gap in the current single-user
   design.
5. **CONFIRMED and detailed (round 1: "sg").** live-stt's VRAM/capacity admission returns `503`
   from both endpoints, but — confirmed from source, not assumed — **with different error-body
   shapes per endpoint** (`{"error":{"message":...}}` for transcribe vs. `{"error":"..."}` for
   speech). `live-stt-client.ts` (§5.1) now explicitly handles both shapes and surfaces a `503`
   as "voice service busy, try again," never an automatic retry.
6. **[new, round 1]** live-stt's own checkout has multiple other git worktrees
   (`feature-architecture`, `feature-model-support`, `feature-web-ui`) besides the one this plan
   was read from. I've treated the main worktree as "what's actually deployed," consistent with
   LS-1 being marked Done there — flagging in case that assumption needs correcting.

## 10. Acceptance-criteria traceability

- *"Push-to-talk: hold, speak, release → accurate transcript submitted as the prompt, end to
  end, on a real phone browser."* → Phase 1 + §8's `demo:voice-ptt` real-device run.
- *"Natural mode: speak without touching anything → turn detected, transcribed, submitted; the
  agent's reply is heard, not just displayed; interrupting mid-reply by speaking again audibly
  stops playback and cancels the turn."* → Phases 2-4 + §8's `demo:voice-live` real-device run.
- *"Mic-active state is always visibly indicated; voice mode (either flavor) is opt-in, never
  default-on."* → §6.2's persistent indicator + `voiceModeEnabled` defaulting false on every
  session, every time (§4.3).

---

*Round 1 revision: also reviewed the real `live-stt` source at `~/src/live-stt`, and created/
linked PA-54 for the deferred mobile-Safari scope. No code has been changed. Awaiting review —
please confirm sign-off on §2's D1-D6 (six now, D5/D6 new this round), and reply "go ahead"/
"approve" (or tag `agent-ready`) when ready for me to start Phase 1 — this round's answers
resolved open questions but didn't include that signal yet, so I'm holding here.*
