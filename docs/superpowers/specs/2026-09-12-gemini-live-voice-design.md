# Gemini Live Voice Provider Design

**Status:** Approved for implementation  
**Date:** 2026-09-12

## Objective

Add Gemini Live as a second voice provider to God's Eye View whilst preserving the existing OpenAI Realtime integration. The MIC panel exposes separate provider and model selectors. Gemini 2.5 Flash Native Audio Dialog is the default Gemini model, with Gemini 3 Flash Live also selectable.

## Product behaviour

### Provider selector

The MIC panel offers:

- **Gemini Live**
- **OpenAI Realtime**

The selected provider is persisted in local storage and applies to the next voice session. A provider change cannot mutate an active session.

### Model selector

The model selector is independent of provider. Its choices depend on the selected provider:

| Provider | Label | Model ID |
|---|---|---|
| Gemini Live | Gemini 2.5 Flash Native Audio Dialog | `gemini-2.5-flash-native-audio-preview-12-2025` |
| Gemini Live | Gemini 3 Flash Live | `gemini-3.1-flash-live-preview` |
| OpenAI Realtime | Standard | existing `gpt-realtime-2` mapping |
| OpenAI Realtime | Mini | existing `gpt-realtime-2.1-mini` mapping |

Gemini 2.5 Flash Native Audio Dialog is the default for a new Gemini selection. Exact Gemini IDs remain server-overridable through `GEMINI_LIVE_MODEL` and `GEMINI_LIVE_MODEL_3` because both are preview surfaces.

### Existing behaviour

The following interfaces and behaviours remain available:

- `initGevVoiceCommands({ viewer, styleManager, dataManager, sceneDirector, annotations })`
- `window.__gevVoiceCommands`
- `window.__gevVoiceCommands.runner`
- `window.__gevVoiceCommands.getDiagnostics()`
- `window.__gevVoiceCommands.sendTextCommand(text)`
- `window.__gevVoiceCommands.stop(...)`
- Push-to-talk, tool execution, radio ducking, stale-turn rejection, interruption handling, diagnostics, and visual context.

## Architecture

### Provider-neutral controller

`GevRealtimeController` remains the public controller and MIC owner. Provider-specific networking and audio protocol code lives behind transport adapters. A transport normalizes provider events into controller callbacks for:

- connection state;
- user activity and interruption;
- assistant audio activity;
- completed or failed turns;
- function calls;
- usage metadata;
- fatal and recoverable errors.

OpenAI's existing WebRTC/data-channel implementation is preserved behind an OpenAI transport boundary. Gemini uses a WebSocket transport and a PCM audio pipeline.

### Provider and model registry

A focused registry owns:

- valid provider IDs;
- valid model-choice IDs per provider;
- display labels;
- defaults;
- local-storage validation;
- server query values.

Unknown, corrupt, or hostile stored/query values resolve to approved defaults. Browser input is never forwarded as an arbitrary upstream model ID.

### Gemini server plugin

A Vite provider plugin installs `POST /api/gemini-live/token`.

The handler:

1. applies a per-client rate limit;
2. requires `GEMINI_API_KEY`;
3. resolves the requested Gemini model through an allowlist;
4. builds Gemini function declarations from `GEV_REALTIME_TOOLS`;
5. reuses `realtimeInstructions(annotationGuidance)`;
6. requests a constrained ephemeral token from `POST https://generativelanguage.googleapis.com/v1beta/auth_tokens` using `x-goog-api-key`;
7. constrains the token to one use, a short connection-start window, the selected model, `AUDIO` response modality, system instructions, and tool declarations where supported;
8. returns only the ephemeral token and resolved model metadata;
9. emits sanitized errors and never returns or logs the permanent key.

The permanent Gemini API key remains server-side in `.env` with mode `0600` on overmind-4.

### Gemini browser transport

The browser connects to:

`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=<ephemeral-token>`

The first message is `setup`. Audio and events then use Gemini Live's JSON WebSocket protocol.

#### Input audio

- microphone source: browser `MediaStream`;
- encoding: mono signed PCM16 little-endian;
- target sample rate: 16 kHz;
- MIME type: `audio/pcm;rate=16000`;
- conversion and resampling occur in a focused audio module;
- capture resources are stopped and disconnected on session teardown.

#### Output audio

- decode base64 signed PCM16 little-endian;
- source rate: 24 kHz;
- schedule chunks through Web Audio without overlap or avoidable gaps;
- expose playback activity to existing visualizer/radio-ducking behaviour;
- clear queued audio on interruption and stop.

### Tool calling

OpenAI's `GEV_REALTIME_TOOLS` remain the canonical schema. Gemini declarations remove the OpenAI `type: "function"` envelope and retain `name`, `description`, and JSON parameters.

For each Gemini function call:

1. dispatch `runner(name, args, { signal, isCurrent })`;
2. preserve monotonic session epochs, per-call abort controllers, deduplication, and stale-turn refusal;
3. return the JSON-serializable result unchanged in `toolResponse.functionResponses[]` with Gemini call ID and name;
4. support multiple calls in one event.

### Visual context and text commands

Provider-specific adapters encode screenshot/image context and text commands into their native conversation format. OpenAI item creation/deletion remains OpenAI-only. Gemini image parts and client content are sent through Gemini's protocol without pretending OpenAI item IDs exist.

### Usage and cost

OpenAI cost metering remains unchanged. Gemini usage metadata is recorded in diagnostics where available. The UI does not claim an accurate Gemini dollar cost or enforce a dollar cap until verified Gemini Live pricing and modality accounting are implemented. Existing session-duration and safety stops still apply.

## Security

- `GEMINI_API_KEY` is never included in browser code, token responses, logs, commits, or test fixtures.
- Gemini token minting is same-origin and rate-limited.
- Ephemeral tokens have one use, a short start window, bounded expiry, an allowlisted model, audio-only response modality, and locked configuration where the API permits.
- Provider/model values are validated through registries.
- Errors exposed to clients exclude upstream credentials and raw authorization headers.
- `.env.example` documents variable names with empty values only.

## Environment

```dotenv
GEMINI_API_KEY=
GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025
GEMINI_LIVE_MODEL_3=gemini-3.1-flash-live-preview
GEV_RATELIMIT_GEMINI_PER_MIN=10
```

## Testing strategy

Implementation follows red-green-refactor cycles. Required coverage includes:

- provider/model registry validation, defaults, and persistence;
- independent provider/model selector behaviour;
- Gemini token constraints, allowlisting, rate limiting, and key secrecy;
- OpenAI tool-schema to Gemini declaration conversion;
- PCM float-to-PCM16 conversion and 16 kHz resampling;
- 24 kHz output scheduling and queue clearing;
- Gemini setup and event normalization;
- multiple function calls and tool responses;
- interruption, cancellation, close, token expiry, and teardown;
- text commands and visual context;
- existing OpenAI regression tests;
- complete unit suite, formatting, boundary checks, and production build;
- a credentialed Gemini Live smoke session;
- browser acceptance through `http://gods-eye-view.lan` after deployment.

## Deployment

The tested feature branch is pushed to `christopher-s/gods-eye-view`. Overmind-4 deploys the verified commit to `/home/overmind/apps/gods-eye-view`, preserves its existing `.env`, installs production dependencies under a supported Node version, builds, restarts `gods-eye-view.service`, and verifies the service plus the LAN route.

## Acceptance criteria

1. The MIC panel has separate provider and model selectors.
2. Gemini Live and OpenAI Realtime can each start, stop, reconnect, receive speech, return speech, and execute GEV tools.
3. Gemini 2.5 is the default Gemini choice; Gemini 3.1 Live is selectable under the requested **Gemini 3 Flash Live** label.
4. Provider/model preferences persist and hostile values fall back safely.
5. The permanent Gemini key remains server-side.
6. Existing OpenAI tests and behaviour remain operational.
7. Focused tests, full tests, formatting, boundaries, build, credentialed smoke test, and deployed LAN browser acceptance pass.
