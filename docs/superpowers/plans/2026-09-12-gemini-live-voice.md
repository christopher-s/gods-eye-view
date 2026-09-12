# Gemini Live Voice Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add production-ready Gemini Live speech beside OpenAI Realtime with independent provider/model selectors, secure ephemeral credentials, shared GEV tool execution, and verified LAN deployment.

**Architecture:** Keep `GevRealtimeController` as the stable public voice surface and introduce provider/model registries plus transport adapters. The server mints constrained Gemini ephemeral tokens; the browser Gemini adapter streams 16 kHz PCM microphone audio over WebSocket, schedules 24 kHz PCM output, and normalizes Live events into the existing controller semantics.

**Tech Stack:** JavaScript ES modules, Vite middleware plugins, Node test runner, WebRTC, WebSocket, Web Audio API, Gemini Live v1beta.

**Spec:** `docs/superpowers/specs/2026-09-12-gemini-live-voice-design.md`

## Global Constraints

- Preserve `initGevVoiceCommands({ viewer, styleManager, dataManager, sceneDirector, annotations })` and the existing `window.__gevVoiceCommands` debug surface.
- Keep `GEV_REALTIME_TOOLS` and `realtimeInstructions(annotationGuidance)` canonical across providers.
- Provider and model are independent validated preferences; changes apply to the next session.
- Gemini labels and default IDs are exactly `Gemini 2.5 Flash Native Audio Dialog` → `gemini-2.5-flash-native-audio-preview-12-2025` and `Gemini 3 Flash Live` → `gemini-3.1-flash-live-preview`.
- `GEMINI_LIVE_MODEL` and `GEMINI_LIVE_MODEL_3` are authoritative server overrides.
- Never expose, log, commit, or return `GEMINI_API_KEY`.
- Gemini browser audio is mono PCM16 little-endian, 16 kHz input and 24 kHz output.
- Preserve OpenAI Realtime behaviour and existing tests.
- Do not claim Gemini dollar cost or apply the OpenAI dollar cap to Gemini until verified pricing support exists.
- Use red-green-refactor and commit each task independently.

---

### Task 1: Provider and model registry with persisted preferences

**Files:**
- Create: `src/voice/voiceProviders.js`
- Create: `src/voice/voiceProviders.test.mjs`
- Modify: `src/voice/gevRealtime.js`
- Modify: `src/voice/gevRealtime.test.mjs`

**Interfaces:**
- Consumes: existing `resolveVoiceModel(tier)` for OpenAI tier IDs.
- Produces: `VOICE_PROVIDERS`, `resolveVoiceProvider(value)`, `resolveVoiceModelChoice(provider, value)`, `modelsForProvider(provider)`, `readStoredVoiceSelection(storage)`, `writeStoredVoiceSelection(selection, storage)`.

- [ ] **Step 1: Write failing registry tests**

Cover Gemini as the default provider for new selections, Gemini 2.5 as its default model, exact labels/IDs, OpenAI standard/mini mapping, provider-specific hostile-value fallback, corrupt local storage, and non-throwing writes.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test src/voice/voiceProviders.test.mjs`

Expected: FAIL because `voiceProviders.js` does not exist.

- [ ] **Step 3: Implement the registry and persistence**

Use separate storage keys `gev.voice.provider` and `gev.voice.model.<provider>`. Return frozen plain objects containing `provider`, `choice`, `label`, and `modelId`; never accept an arbitrary model ID as a valid choice.

- [ ] **Step 4: Integrate pending selection into the controller**

Replace the controller's OpenAI-only pending tier field with provider plus per-provider model choice whilst retaining compatibility helpers required by existing tests. Selection mutation during a live session updates pending state only.

- [ ] **Step 5: Run focused tests**

Run: `node --test src/voice/voiceProviders.test.mjs src/voice/gevRealtime.test.mjs src/voice/voiceCost.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/voice/voiceProviders.js src/voice/voiceProviders.test.mjs src/voice/gevRealtime.js src/voice/gevRealtime.test.mjs
git commit -m "feat(voice): add provider and model preferences"
```

### Task 2: Secure Gemini ephemeral-token endpoint

**Files:**
- Create: `server/providers/gemini.js`
- Create: `server/providers/gemini/constants.js`
- Create: `server/providers/gemini/live.js`
- Create: `server/providers/gemini/tools.js`
- Modify: `server/providers/local.js`
- Modify: `server/providers/rate-limit.js`
- Modify: `src/tooling/localServices.test.mjs`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `GEV_REALTIME_TOOLS`, `realtimeInstructions(annotationGuidance)`, model choices from `src/voice/voiceProviders.js`.
- Produces: `geminiLiveProxy()` and `createGeminiLiveTokenHandler({ annotationGuidance, fetchImpl })`; route `POST /api/gemini-live/token?model=<choice>` returning `{ token, model, choice, provider: "gemini" }`.

- [ ] **Step 1: Write failing server tests**

Test plugin registration, POST-only handling, missing-key 503, allowlisted fallback, env overrides, converted function declarations, audio-only token constraints, one-use/short-lived token values, sanitized upstream errors, rate limiting, and absence of the permanent key from response bodies/headers.

- [ ] **Step 2: Run the server tests and verify failure**

Run: `node --test src/tooling/localServices.test.mjs`

Expected: FAIL because the Gemini plugin and route are absent.

- [ ] **Step 3: Implement schema conversion and constants**

Export `geminiFunctionDeclarations(tools = GEV_REALTIME_TOOLS)`, retaining only `name`, `description`, and `parameters`. Define exact default models and the constrained WebSocket endpoint in `constants.js`.

- [ ] **Step 4: Implement token minting**

POST to `https://generativelanguage.googleapis.com/v1beta/auth_tokens` with `x-goog-api-key`. Construct `uses: 1`, bounded `expireTime`, short `newSessionExpireTime`, allowlisted `liveConnectConstraints.model`, `responseModalities: ["AUDIO"]`, instructions, and tools. Parse the returned ephemeral token without forwarding arbitrary upstream data.

- [ ] **Step 5: Register the plugin and document environment values**

Add `geminiLiveProxy()` beside `openAiRealtimeProxy()` and empty/default entries to `.env.example`, including `GEV_RATELIMIT_GEMINI_PER_MIN=10`.

- [ ] **Step 6: Run focused tests**

Run: `node --test src/tooling/localServices.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/providers/gemini.js server/providers/gemini server/providers/local.js server/providers/rate-limit.js src/tooling/localServices.test.mjs .env.example
git commit -m "feat(voice): mint constrained Gemini Live tokens"
```

### Task 3: Gemini PCM capture and playback primitives

**Files:**
- Create: `src/voice/geminiAudio.js`
- Create: `src/voice/geminiAudio.test.mjs`
- Create: `public/audio-worklets/gev-pcm-capture.js`

**Interfaces:**
- Produces: `float32ToPcm16(samples)`, `resampleMono(samples, fromRate, toRate)`, `pcm16ToBase64(samples)`, `base64ToPcm16(value)`, and `GeminiPcmAudioSession` with `startInput(onChunk)`, `enqueueOutput(base64Chunk)`, `clearOutput()`, `stop()`.

- [ ] **Step 1: Write deterministic failing conversion tests**

Cover clamping at -1/1, little-endian PCM bytes, known downsample fixtures, empty input, malformed base64 rejection, and round trips.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test src/voice/geminiAudio.test.mjs`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement pure conversion functions**

Use auditable typed-array code. Resample mono audio deterministically and avoid browser globals in pure functions.

- [ ] **Step 4: Write failing lifecycle/scheduling tests with injected Web Audio fakes**

Assert 16 kHz capture framing, 24 kHz output buffers, contiguous scheduling, queue cancellation, track stopping, node disconnection, and idempotent teardown.

- [ ] **Step 5: Implement the AudioWorklet and session wrapper**

The worklet posts mono Float32 frames. The wrapper resamples input, emits base64 PCM16, decodes output, and schedules buffers from `max(currentTime, nextStartTime)`.

- [ ] **Step 6: Run focused tests**

Run: `node --test src/voice/geminiAudio.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/voice/geminiAudio.js src/voice/geminiAudio.test.mjs public/audio-worklets/gev-pcm-capture.js
git commit -m "feat(voice): add Gemini PCM audio pipeline"
```

### Task 4: Gemini Live WebSocket transport and tool bridge

**Files:**
- Create: `src/voice/geminiLiveTransport.js`
- Create: `src/voice/geminiLiveTransport.test.mjs`
- Modify: `src/voice/gevRealtime.js`
- Modify: `src/voice/gevRealtime.test.mjs`

**Interfaces:**
- Consumes: `GeminiPcmAudioSession`, `/api/gemini-live/token`, `runner(name, args, { signal, isCurrent })`.
- Produces: `GeminiLiveTransport` implementing `start({ modelChoice, mediaStream })`, `stop(reason)`, `sendText(text)`, `sendImage(imagePart)`, `sendToolResponse(responses)`, and normalized callbacks supplied to its constructor.

- [ ] **Step 1: Write failing protocol tests**

Using injected `fetch`, `WebSocket`, audio session, and clock fakes, assert token URL model choice, constrained WebSocket URL, first `setup` message, 16 kHz realtime audio messages, text/image client content, close/error/token-expiry handling, and deterministic teardown.

- [ ] **Step 2: Write failing Gemini event/tool tests**

Cover `serverContent.modelTurn.parts[].inlineData` audio, `turnComplete`, `interrupted`, `usageMetadata`, one and multiple `toolCall.functionCalls`, malformed arguments, deduplication, abort/stale refusal, and `toolResponse.functionResponses` preserving runner results.

- [ ] **Step 3: Run tests and verify failure**

Run: `node --test src/voice/geminiLiveTransport.test.mjs`

Expected: FAIL because the transport is absent.

- [ ] **Step 4: Implement transport state and protocol mapping**

Mint the token immediately before connection. Send setup before any media. Normalize activity, audio, turn completion, usage, interruption, and errors. Never log token-bearing URLs.

- [ ] **Step 5: Implement tool dispatch**

Use one abort controller per call, call IDs for dedupe, the controller's current-session predicate, multi-call `Promise.allSettled`, and a terminal response for every received call.

- [ ] **Step 6: Wire transport selection into `GevRealtimeController`**

Choose OpenAI or Gemini from the pending selection at `start()`. Preserve start epochs, stop semantics, radio handoff, visualizer state, diagnostics, `sendTextCommand`, and annotation notifications. Mark Gemini cost as unavailable rather than applying OpenAI rates.

- [ ] **Step 7: Run focused regression tests**

Run: `node --test src/voice/geminiLiveTransport.test.mjs src/voice/gevRealtime.test.mjs src/voice/gevActions.test.mjs src/voice/voiceCost.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/voice/geminiLiveTransport.js src/voice/geminiLiveTransport.test.mjs src/voice/gevRealtime.js src/voice/gevRealtime.test.mjs
git commit -m "feat(voice): connect Gemini Live transport"
```

### Task 5: Independent MIC provider and model selectors

**Files:**
- Modify: `src/voice/gevRealtime.js`
- Modify: `src/voice/gevRealtime.test.mjs`
- Modify: relevant voice styles discovered beside the existing MIC controls

**Interfaces:**
- Consumes: `modelsForProvider(provider)`, controller pending/live selection state.
- Produces: accessible provider and model selectors in the MIC panel, each announcing that changes apply to the next session.

- [ ] **Step 1: Write failing UI tests**

Assert two distinct labelled controls, exact option labels, provider-specific model options, Gemini 2.5 default, persisted restoration, keyboard operation, disabled/next-session semantics, and unchanged MIC button behaviour.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test src/voice/gevRealtime.test.mjs`

Expected: FAIL because the separate controls are absent.

- [ ] **Step 3: Implement selectors using existing MIC panel patterns**

Render provider and model as distinct controls. On provider change, restore that provider's prior valid model or its default. Update pending diagnostics immediately; bind the active transport only on next `start()`.

- [ ] **Step 4: Update help and status copy**

Show the active provider/model separately from the pending next-session selection. For Gemini, show duration/usage diagnostics without a dollar amount.

- [ ] **Step 5: Run focused tests and format check**

Run: `node --test src/voice/gevRealtime.test.mjs src/voice/voiceProviders.test.mjs && npm run format:check`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/voice/gevRealtime.js src/voice/gevRealtime.test.mjs src/styles
git commit -m "feat(voice): add provider and model selectors"
```

### Task 6: Credentialed QA, complete verification, and deployment

**Files:**
- Create: `scripts/qa-gemini-live.mjs`
- Modify: `scripts/qa-voice-routing.mjs`
- Modify: `scripts/qa-voice-wav.mjs`
- Modify: `package.json`
- Modify: `README.md` or voice documentation section found during implementation

**Interfaces:**
- Consumes: public debug surface, selectors, Gemini token endpoint, deployed `GEMINI_API_KEY`.
- Produces: `npm run qa:gemini-live`, credentialed protocol smoke coverage, and deployment evidence.

- [ ] **Step 1: Add a credentialed smoke script**

Mint an ephemeral token from the local GEV server, connect through the constrained Gemini WebSocket, send setup plus a bounded text turn requesting a short audio reply, assert setup completion/audio or a valid model response, close cleanly, and redact tokens from all errors.

- [ ] **Step 2: Extend browser routing QA**

Exercise independent provider/model controls and `window.__gevVoiceCommands` without requiring a physical microphone. Keep the existing OpenAI routing path covered.

- [ ] **Step 3: Run focused QA under a supported Node release**

Run:

```bash
npm ci
node --test src/voice/voiceProviders.test.mjs src/voice/geminiAudio.test.mjs src/voice/geminiLiveTransport.test.mjs src/voice/gevRealtime.test.mjs src/tooling/localServices.test.mjs
npm run qa:gemini-live
```

Expected: PASS with no credential printed.

- [ ] **Step 4: Run the complete repository gates**

Run:

```bash
npm run format:check
npm run check:boundaries
npm test
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit QA and documentation**

```bash
git add scripts package.json README.md
git commit -m "test(voice): verify Gemini Live integration"
```

- [ ] **Step 6: Push the feature branch after approval gate**

Push the reviewed branch to `origin`; do not merge to `main` without explicit approval.

- [ ] **Step 7: Deploy the reviewed commit to overmind-4**

Preserve `/home/overmind/apps/gods-eye-view/.env`, update the checkout to the reviewed commit, install/build under Node 24.14.x or Node 26.x, restart the user service, and verify its exact commit and active state.

- [ ] **Step 8: Verify LAN acceptance**

Check HTTP 200 and app title at `http://gods-eye-view.lan`, run the Gemini credentialed smoke against the deployed route, and use browser automation to confirm both selectors, exact options, default Gemini 2.5 selection, session connection, returned audio activity, and at least one GEV tool call.
