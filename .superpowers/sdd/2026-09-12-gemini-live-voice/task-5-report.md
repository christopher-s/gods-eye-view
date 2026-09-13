# Task 5 Report: Independent MIC provider and model selectors

## Status

Complete on `feat/gemini-live-voice`.

## Inherited state

Recovered an intentionally dirty worktree from an interrupted worker. The inherited changes were a partial selector test, two selector queries in `createVoiceControl`, and untracked scratch file `src/voice/gev-template-tmp.html`. The useful intent was retained and expanded into complete failing coverage. The scratch file was removed before commit.

## RED evidence

Docker Node 24.14.0:

```text
docker run --rm -v "$PWD":/app -w /app node:24.14.0 node --test src/voice/gevRealtime.test.mjs
```

Initial inherited RED: 176 tests, 175 passed, 1 failed because the Provider selector was absent.

After completing the test scaffolding, RED failed at module load because `voiceControlMarkup` and the selector behaviour did not exist yet. Production implementation followed that verified failure.

## Implementation

- Added separate, labelled native `<select>` controls for Provider and Model.
- Provider options are Gemini Live and OpenAI Realtime.
- Model options are populated from `modelsForProvider(provider)` with exact required labels.
- Gemini 2.5 is the default Gemini choice.
- Native change events call `setVoiceProvider` and `setVoiceModelChoice`.
- Provider changes restore that provider's persisted valid choice or registry default.
- Pending changes leave `activeVoiceSelection`, transport, and live cost tracker unchanged.
- Help text distinguishes active and next-session selections when they differ.
- Diagnostics expose active and pending provider/model selections separately.
- Existing MIC button, push-to-talk, visualizer, cost/tier compatibility, status, and teardown behaviour remain wired.
- Gemini usage continues to avoid dollar-cost claims.
- Added command-dock styling for usable labelled selectors.

## Files

- `src/voice/gevRealtime.js`
- `src/voice/gevRealtime.test.mjs`
- `style.css`

Removed:

- `src/voice/gev-template-tmp.html`

## GREEN evidence

Docker Node 24.14.0 focused tests:

```text
docker run --rm -v "$PWD":/app -w /app node:24.14.0 node --test src/voice/gevRealtime.test.mjs src/voice/voiceProviders.test.mjs
```

Result: 183 tests, 183 passed, 0 failed.

Additional verification:

```text
npm run format:check
Checked 116 adopted files.

git diff --check
exit 0
```

Scratch-file absence was also verified.

## Commit

`530cbae3bbe6ac7be83eb6dfde115a9bb66cd087` — `feat(voice): add provider and model selectors`

## Self-review

- Exact labels and provider-dependent options are registry-driven rather than duplicated in controller logic.
- Native selects retain keyboard and screen-reader behaviour through explicit labels and descriptive help.
- Active selection is captured only at session start; pending mutations do not rebind live state.
- Event listeners are removed during full UI teardown.
- OpenAI tier helpers remain available for compatibility.

## Concerns

The focused automated tests and formatting checks pass. No browser layout acceptance was requested for this task; the selector tray styling should still receive visual QA with the full command dock during later integration/browser acceptance.

## Fix Round 1

### RED evidence

Docker Node 24.14.0, production code unchanged after adding regression coverage:

```text
docker run --rm -v "$PWD":/app -w /app node:24.14.0 node --test src/voice/gevRealtime.test.mjs
186 tests, 180 passed, 6 failed
```

Expected failures reproduced:

- Idle/default Gemini used the OpenAI preview tracker.
- Gemini provider changes and cost-limit updates did not build the unavailable-cost tracker.
- Idle help omitted the active-off state and active help abbreviated the pending label.
- Idle compatibility diagnostics mixed pending provider with the OpenAI tracker model.
- Provider/model restoration through real selector handlers failed.

The listener-cleanup test initially exposed an incomplete UI fake (`root.remove` absent); after correcting the fake, the existing cleanup behavior passed without production changes.

### Fix

- Added one pending-selection tracker factory shared by construction, settled provider/model changes, and settled cost-limit updates.
- Gemini pending selection now consistently uses `createGeminiVoiceCostTracker`, displaying `N/A` and retaining the pending Gemini model ID.
- Live session tracker and transport identity remain unchanged when pending selection changes.
- Help always emits separate `Active:` and `Next session:` statements, including `Active: Off` while idle.
- Diagnostics compatibility fields now describe only the active selection and are both `null` while idle; structured pending and active selections remain available.
- Added handler-driven coverage for provider-specific model restoration, hostile fallback/UI resync, listener cleanup, copy, diagnostics, transport/tracker stability, and idle Gemini cost behavior. Existing MIC click/push-to-talk coverage remains green.

### GREEN evidence

```text
docker run --rm -v "$PWD":/app -w /app node:24.14.0 node --test src/voice/gevRealtime.test.mjs src/voice/voiceProviders.test.mjs src/voice/geminiLiveTransport.test.mjs src/voice/voiceCost.test.mjs
299 tests, 299 passed, 0 failed

npm run format:check
Checked 116 adopted files.

git diff --check
exit 0
```
