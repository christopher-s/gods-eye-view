/**
 * Gemini Live WebSocket transport.
 *
 * Owns the provider-specific networking for a Gemini voice session: ephemeral
 * token minting (same-origin POST), the constrained BidiGenerateContent
 * WebSocket, the setup message, 16 kHz realtime PCM input, 24 kHz PCM output
 * scheduling (through an injected GeminiPcmAudioSession), normalization of
 * Gemini server events into controller callbacks, and the function-call
 * bridge. Every dependency is injectable so the whole protocol surface is
 * testable under Node without network or browser globals.
 *
 * SECURITY: the ephemeral token only ever appears in the WebSocket URL. It is
 * never placed in a log payload, an error record, or a callback argument.
 */

import { resolveVoiceModelChoice } from './voiceProviders.js';
import {
  GeminiPcmAudioSession,
  PCM_CAPTURE_MODULE_URL,
} from './geminiAudio.js';

/** Same-origin endpoint that mints constrained ephemeral tokens. */
export const GEMINI_TOKEN_URL = '/api/gemini-live/token';

// Mirrors server/providers/gemini/constants.js (src must not import server/).
export const GEMINI_LIVE_WEBSOCKET_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

const GEMINI_INPUT_MIME_TYPE = 'audio/pcm;rate=16000';

// How long a processed function-call ID stays in the dedupe memory, and a
// hard ceiling on that memory so a pathological stream of distinct calls
// cannot grow it without bound (mirrors the controller's CALL_DEDUPE_MS).
const GEMINI_CALL_DEDUPE_MS = 2500;
const GEMINI_CALL_DEDUPE_MEMORY_MAX = 64;

function defaultFetch() {
  if (typeof fetch !== 'function') {
    throw new Error('Gemini Live requires fetch support');
  }
  return fetch;
}

function defaultWebSocket() {
  const WebSocketClass = globalThis.WebSocket;
  if (typeof WebSocketClass !== 'function') {
    throw new Error('Gemini Live requires WebSocket support');
  }
  return WebSocketClass;
}

function defaultCreateAudioContext() {
  const AudioContextClass =
    globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioContextClass !== 'function') {
    throw new Error('Gemini Live requires Web Audio (AudioContext) support');
  }
  return new AudioContextClass();
}

function defaultCreateAudioSession(audioContext) {
  return new GeminiPcmAudioSession({ audioContext });
}

/**
 * Mint an ephemeral token for the requested registry model choice.
 *
 * The choice is resolved through the provider registry first, so a hostile or
 * unknown value can never be forwarded as an arbitrary upstream model id.
 * The live API rejects liveConnectConstraints, so the token is unconstrained;
 * the route's setupConfig carries the session config the browser must repeat
 * in its setup message.
 *
 * @returns {{token: string, model: string, choice: string, setupConfig: Object|null}}
 * @throws {Error} with the server's sanitized reason on failure
 */
async function mintGeminiToken(choice, fetchImpl) {
  const resolvedChoice = resolveVoiceModelChoice('gemini', choice).choice;
  const url = `${GEMINI_TOKEN_URL}?model=${encodeURIComponent(resolvedChoice)}`;
  const response = await fetchImpl(url, { method: 'POST', cache: 'no-store' });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const reason =
      typeof data?.error === 'string' ? data.error : data?.error?.message;
    throw new Error(
      reason || `Gemini Live token failed: HTTP ${response.status}`,
    );
  }
  if (data?.provider !== undefined && data.provider !== 'gemini') {
    throw new Error(
      'Gemini Live token endpoint returned a non-Gemini provider',
    );
  }
  if (typeof data?.token !== 'string' || !data.token) {
    throw new Error('Gemini Live token response did not include a token');
  }
  const setupConfig =
    data?.setupConfig && typeof data.setupConfig === 'object'
      ? data.setupConfig
      : null;
  return {
    token: data.token,
    model: typeof data?.model === 'string' && data.model ? data.model : null,
    choice: resolvedChoice,
    setupConfig,
  };
}

/** Normalize one raw functionCall entry: always {id, name, args-object}. */
function normalizeFunctionCall(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id =
    typeof entry.id === 'string' || typeof entry.id === 'number'
      ? String(entry.id)
      : '';
  const name = typeof entry.name === 'string' ? entry.name : '';
  return { id, name, args: normalizeArguments(entry.args) };
}

/** Gemini args must be a JSON object; anything else degrades to `{}`. */
function normalizeArguments(value) {
  if (value == null) return {};
  if (typeof value === 'object') {
    return Array.isArray(value) ? {} : value;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** A result the wire can carry; unserializable results become terminal errors. */
function ensureTransportableResult(result, toolName) {
  if (result === undefined || result === null) {
    return { ok: false, error: 'Tool returned no result', tool: toolName };
  }
  try {
    JSON.stringify(result);
    return result;
  } catch {
    return {
      ok: false,
      error: 'Tool result was not JSON-serializable',
      tool: toolName,
    };
  }
}

/**
 * A cost surface for Gemini Live sessions.
 *
 * Gemini usage metadata is recorded for diagnostics only: without verified
 * Gemini Live pricing and modality accounting the UI must not claim a dollar
 * cost or enforce a dollar cap, so totals stay at zero and the cap can never
 * trip. Session-duration and safety stops live in the controller.
 *
 * @param {{modelId?: string, limits?: {warnUsd?: number, capUsd?: number}}} [options]
 */
export function createGeminiVoiceCostTracker(options = {}) {
  const modelId =
    typeof options.modelId === 'string' && options.modelId
      ? options.modelId
      : resolveVoiceModelChoice('gemini').modelId;
  const limits = {
    warnUsd: Number.isFinite(options.limits?.warnUsd)
      ? options.limits.warnUsd
      : Infinity,
    capUsd: Number.isFinite(options.limits?.capUsd)
      ? options.limits.capUsd
      : Infinity,
  };
  let responses = 0;
  let lastUsage = null;
  const snapshot = () => ({
    provider: 'gemini',
    tier: 'gemini',
    modelId,
    costAvailable: false,
    ratesRecognized: false,
    totalUsd: 0,
    responses,
    warnUsd: limits.warnUsd,
    capUsd: limits.capUsd,
    level: 'ok',
    warnCrossed: false,
    capCrossed: false,
    capReached: false,
    incomplete: false,
    usage: lastUsage,
    display: 'N/A',
    note: 'Gemini Live usage is recorded for diagnostics only; dollar cost is not available for this provider.',
  });
  return {
    limits,
    record(usage) {
      if (usage) {
        responses += 1;
        lastUsage = usage;
      }
      return snapshot();
    },
    state: () => snapshot(),
    markIncomplete() {
      return snapshot();
    },
    reset() {
      responses = 0;
      lastUsage = null;
      return snapshot();
    },
  };
}

/**
 * Gemini Live session transport.
 *
 * Lifecycle: `start()` mints the token immediately before opening the
 * constrained WebSocket, sends `setup` as the first message, wires the PCM
 * capture pipeline, then resolves. `stop(reason)` is an idempotent, complete
 * teardown. Server events are normalized into the constructor callbacks:
 *
 * - `onState({phase})` — 'connecting' | 'open' | 'closed'
 * - `onInterrupted()` — user barge-in / interruption
 * - `onAssistantTurnStart()` — first model output of a turn (any part/tool call)
 * - `onAssistantAudio(base64Chunk)` — one 24 kHz PCM chunk for playback
 * - `onTurnComplete()` — assistant turn finished
 * - `onUsage(usageMetadata)` — usage telemetry, untouched
 * - `onStatus(status, detail)` — controller status mapping
 * - `onError(error, info)` — fatal transport errors ({fatal: true, ...})
 * - `onToolResult(result)` — final result of each call (awaited before response)
 * - `onAfterToolResponses(results)` — after a toolResponse was sent
 * - `onLog(event, payload)` — diagnostics; never token-bearing
 * - `onAudioContext(context)` — the session's AudioContext, for visualizers
 */
export class GeminiLiveTransport {
  #options;
  #readyState = 'idle';
  #started = false;
  #intentionalStop = false;
  #finalized = false;
  #socket = null;
  #audioContext = null;
  #session = null;
  #servedModel = null;
  #assistantTurnActive = false;
  #processedCalls = new Map();
  #activeToolControllers = new Set();
  #openSettled = null;
  #earlyFatalError = null;

  constructor(options = {}) {
    if (typeof options.runner !== 'function') {
      throw new TypeError('GeminiLiveTransport requires a runner function');
    }
    this.#options = {
      runner: options.runner,
      isCurrent:
        typeof options.isCurrent === 'function'
          ? options.isCurrent
          : () => true,
      onState: options.onState || (() => {}),
      onInterrupted: options.onInterrupted || (() => {}),
      onAssistantTurnStart: options.onAssistantTurnStart || (() => {}),
      onAssistantAudio: options.onAssistantAudio || (() => {}),
      onTurnComplete: options.onTurnComplete || (() => {}),
      onUsage: options.onUsage || (() => {}),
      onStatus: options.onStatus || (() => {}),
      onError: options.onError || (() => {}),
      onToolResult: options.onToolResult || (() => {}),
      onAfterToolResponses: options.onAfterToolResponses || (() => {}),
      onLog: options.onLog || (() => {}),
      onAudioContext: options.onAudioContext || (() => {}),
      fetchImpl: options.fetchImpl || defaultFetch(),
      WebSocketClass: options.WebSocketClass || defaultWebSocket(),
      createAudioContext:
        options.createAudioContext || defaultCreateAudioContext,
      createAudioSession:
        options.createAudioSession || defaultCreateAudioSession,
      now: options.now || (() => Date.now()),
    };
  }

  /** The model id the token endpoint resolved for this session. */
  get servedModel() {
    return this.#servedModel;
  }

  /** 'idle' | 'connecting' | 'open' | 'closed'. */
  get readyState() {
    return this.#readyState;
  }

  #isOpen() {
    return this.#readyState === 'open';
  }

  #log(event, payload = {}) {
    this.#options.onLog(event, { at: this.#options.now(), ...payload });
  }

  #setState(phase, detail = null) {
    this.#readyState = phase;
    this.#options.onState({ phase, detail });
  }

  /**
   * Mint the token, open the constrained WebSocket, and start capture.
   *
   * @param {{modelChoice?: string, mediaStream?: unknown}} [options]
   */
  async start({ modelChoice, mediaStream = null } = {}) {
    if (this.#started || this.#readyState === 'closed') {
      throw new Error('GeminiLiveTransport.start() has already been called');
    }
    this.#started = true;
    this.#setState('connecting', 'Requesting Gemini Live session');
    try {
      const minted = await mintGeminiToken(
        modelChoice,
        this.#options.fetchImpl,
      );
      this.#rejectIfFinalized();
      this.#servedModel =
        minted.model ||
        resolveVoiceModelChoice('gemini', minted.choice).modelId;
      this.#log('gemini.token.minted', {
        model: this.#servedModel,
        choice: minted.choice,
      });

      this.#openSocket(minted.token);
      await this.#openSettled.promise;
      this.#rejectIfFinalized();

      // The first message on a Gemini Live socket is always setup. The live
      // auth_tokens endpoint rejects liveConnectConstraints, so the ephemeral
      // token carries NO session config; the token route's setupConfig
      // supplies systemInstruction and tools, and setup repeats them here or
      // the session would run without instructions and tools.
      const setup = {
        model: `models/${this.#servedModel}`,
        generationConfig: { responseModalities: ['AUDIO'] },
      };
      if (minted.setupConfig) {
        if (minted.setupConfig.systemInstruction) {
          setup.systemInstruction = minted.setupConfig.systemInstruction;
        }
        if (Array.isArray(minted.setupConfig.tools)) {
          setup.tools = minted.setupConfig.tools;
        }
      }
      this.#sendJson({ setup });
      this.#log('gemini.setup.sent', { model: this.#servedModel });

      const audioContext = this.#createAudioContextChecked();
      this.#audioContext = audioContext;
      this.#options.onAudioContext(audioContext);
      this.#resumeAudioContext();
      if (typeof audioContext.audioWorklet?.addModule !== 'function') {
        throw new Error(
          'Gemini Live requires audioWorklet support to capture microphone PCM',
        );
      }
      await audioContext.audioWorklet.addModule(PCM_CAPTURE_MODULE_URL);
      this.#rejectIfFinalized();
      this.#log('gemini.audio.module_loaded', {
        moduleUrl: PCM_CAPTURE_MODULE_URL,
      });

      this.#session = this.#options.createAudioSession(audioContext);
      await this.#session.startInput(
        (chunk) => this.#sendMicChunk(chunk),
        mediaStream,
      );
      this.#rejectIfFinalized();

      this.#setState('open', 'Gemini Live session open');
      this.#log('gemini.session.open', { model: this.#servedModel });
    } catch (error) {
      this.#abortToolControllers();
      this.#teardownAudio();
      this.#closeSocketIntentionally('start-failed');
      this.#finalize('closed');
      throw error;
    }
  }

  #createAudioContextChecked() {
    const context = this.#options.createAudioContext();
    if (!context || typeof context.createBuffer !== 'function') {
      throw new Error('Gemini Live requires a functional AudioContext');
    }
    return context;
  }

  /**
   * Fire-and-forget autoplay resume. Chrome creates AudioContexts in a
   * 'suspended' state until unlocked by a user gesture; start() runs from
   * the mic-button click, but without an explicit resume() the scheduled
   * playback sources stay silent. Resumed defensively at start() and again
   * lazily before scheduling audio; failures are non-fatal because
   * scheduling into a still-suspended context is safe and the promise is
   * never awaited.
   */
  #resumeAudioContext() {
    const context = this.#audioContext;
    if (!context || context.state === 'running') return;
    Promise.resolve(context.resume?.()).catch(() => {});
  }

  #openSocket(token) {
    const WebSocketClass = this.#options.WebSocketClass;
    const socket = new WebSocketClass(
      `${GEMINI_LIVE_WEBSOCKET_ENDPOINT}?access_token=${encodeURIComponent(token)}`,
    );
    this.#socket = socket;
    let settled = false;
    this.#openSettled = Promise.withResolvers();
    const settleOpen = (resolution) => {
      if (settled) return;
      settled = true;
      resolution();
    };
    socket.onopen = () => {
      settleOpen(this.#openSettled.resolve);
    };
    socket.onerror = (event) => {
      const error =
        event instanceof Error
          ? event
          : new Error('Gemini Live WebSocket error before the session opened');
      if (!settled) {
        settleOpen(() => this.#openSettled.reject(error));
        return;
      }
      // After open, close follows; nothing to do here.
    };
    socket.onclose = (event) => {
      if (!settled) {
        settleOpen(() =>
          this.#openSettled.reject(
            new Error(
              `Gemini Live WebSocket closed before the session opened (code ${event?.code ?? 'unknown'})`,
            ),
          ),
        );
        return;
      }
      this.#handleUnexpectedClose(event);
    };
    socket.onmessage = (event) => this.#handleMessage(event);
  }

  #sendJson(message) {
    const socket = this.#socket;
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  #sendMicChunk(chunk) {
    if (!this.#isOpen() || typeof chunk !== 'string' || !chunk) return;
    this.#sendJson({
      realtimeInput: {
        audio: { data: chunk, mimeType: GEMINI_INPUT_MIME_TYPE },
      },
    });
  }

  /**
   * Send a typed user turn. `turnComplete: false` injects context without
   * soliciting a reply (annotation notifications).
   * @returns {boolean} whether the message was sent
   */
  sendText(text, { turnComplete = true } = {}) {
    if (!this.#isOpen()) return false;
    const cleanText = String(text ?? '');
    if (!cleanText.trim()) return false;
    const sent = this.#sendJson({
      clientContent: {
        // The live API rejects `content` on a turn (1007 'Unknown name
        // content at client_content.turns[0]'); turns use `parts`.
        turns: [{ role: 'user', parts: [{ text: cleanText }] }],
        turnComplete,
      },
    });
    if (sent && turnComplete) {
      // A completing user turn supersedes any assistant turn that was still
      // marked active locally (e.g. typed input or barge-in before turnComplete).
      // The first output of the new turn must emit a fresh start edge.
      this.#assistantTurnActive = false;
    }
    return sent;
  }

  /**
   * Send an inline image part ({mimeType, data: base64}) as user context.
   * @returns {boolean} whether the message was sent
   */
  sendImage(imagePart) {
    if (!this.#isOpen()) return false;
    const mimeType =
      typeof imagePart?.mimeType === 'string' ? imagePart.mimeType : '';
    const data = typeof imagePart?.data === 'string' ? imagePart.data : '';
    if (!mimeType || !data) return false;
    return this.#sendJson({
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [{ inlineData: { mimeType, data } }],
          },
        ],
        turnComplete: false,
      },
    });
  }

  /**
   * Send already-shaped function responses (`{id, name, response}` entries),
   * unchanged, in one toolResponse message.
   * @returns {boolean} whether the message was sent
   */
  sendToolResponse(functionResponses) {
    if (
      !this.#isOpen() ||
      !Array.isArray(functionResponses) ||
      !functionResponses.length
    ) {
      return false;
    }
    return this.#sendJson({ toolResponse: { functionResponses } });
  }

  #handleMessage(event) {
    // The server can speak before start() has promoted the session to 'open'
    // (e.g. a setup rejection racing our own audio wiring). Messages in that
    // window are accepted once the socket itself is open — dropping them
    // would lose the only copy of the failure reason.
    const socketOpen = this.#socket?.readyState === 1;
    if (!this.#isOpen() && !socketOpen) return;
    let payload = null;
    try {
      payload = JSON.parse(event?.data);
    } catch {
      this.#log('gemini.server.malformed_message');
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      return;
    this.#log('gemini.server.event', { keys: Object.keys(payload) });

    if (payload.goAway) {
      this.#fatal('go_away', 'Gemini Live session is expiring (goAway)');
      return;
    }
    if (payload.error) {
      const message =
        typeof payload.error?.message === 'string' && payload.error.message
          ? payload.error.message
          : 'Gemini Live reported an error';
      this.#fatal(`server_error_${payload.error?.code ?? 'unknown'}`, message);
      return;
    }

    const content = payload.serverContent;
    if (content && typeof content === 'object') {
      if (content.interrupted) {
        this.#session?.clearOutput?.();
        this.#assistantTurnActive = false;
        this.#options.onInterrupted();
      }
      const parts = content.modelTurn?.parts;
      if (Array.isArray(parts) && parts.length) {
        // ANY model output begins a turn: audio, text, or another part kind.
        // A turn whose only output is a tool call has no modelTurn at all, so
        // the turn-start edge for that case is reported in the toolCall
        // branch below.
        this.#beginAssistantTurn();
        for (const part of parts) {
          const data = part?.inlineData?.data;
          if (typeof data !== 'string' || !data) continue;
          this.#resumeAudioContext();
          this.#session?.enqueueOutput?.(data);
          this.#options.onAssistantAudio(data);
        }
      }
      if (content.turnComplete) {
        this.#assistantTurnActive = false;
        this.#options.onTurnComplete();
      }
    }

    if (payload.usageMetadata && typeof payload.usageMetadata === 'object') {
      this.#options.onUsage(payload.usageMetadata);
    }

    if (Array.isArray(payload.toolCall?.functionCalls)) {
      // A tool call is itself model output: on a tool-only turn this is the
      // first (and only) serverContent-free evidence that a turn began.
      this.#beginAssistantTurn();
      void this.#dispatchToolCalls(payload.toolCall.functionCalls);
    }
  }

  /** Report the turn-start edge once per turn, for any part kind. */
  #beginAssistantTurn() {
    if (this.#assistantTurnActive) return;
    this.#assistantTurnActive = true;
    this.#options.onAssistantTurnStart();
  }

  /**
   * Bound the dedupe memory around each incoming event: entries older than the
   * dedupe window expire and oldest entries are evicted past the hard ceiling.
   */
  #pruneProcessedCalls() {
    const cutoff = this.#options.now() - GEMINI_CALL_DEDUPE_MS;
    for (const [key, at] of this.#processedCalls) {
      if (at < cutoff) this.#processedCalls.delete(key);
    }
    while (this.#processedCalls.size > GEMINI_CALL_DEDUPE_MEMORY_MAX) {
      this.#processedCalls.delete(this.#processedCalls.keys().next().value);
    }
  }

  #handleUnexpectedClose(event) {
    if (this.#readyState !== 'open') {
      // A close while still connecting belongs to the start() rejection path
      // (the socket error already rejected the open promise); reporting it
      // here as well would surface one failure twice.
      this.#finalize('closed');
      return;
    }
    if (this.#intentionalStop || this.#readyState === 'closed') {
      this.#finalize('closed');
      return;
    }
    const code = event?.code ?? null;
    const reason =
      typeof event?.reason === 'string' && event.reason ? event.reason : null;
    this.#abortToolControllers();
    this.#teardownAudio();
    this.#closeSocketIntentionally('closed');
    this.#finalize('closed');
    const error = new Error(
      `Gemini Live connection closed (code ${code ?? 'unknown'}${reason ? `: ${reason}` : ''})`,
    );
    this.#log('gemini.closed.unexpected', { code });
    this.#options.onError(error, { fatal: true, code, reason });
  }

  #fatal(code, message) {
    // Capture openness BEFORE the teardown below finalizes the state.
    const wasOpen = this.#isOpen();
    this.#log('gemini.fatal', { code });
    this.#abortToolControllers();
    this.#teardownAudio();
    this.#closeSocketIntentionally('fatal');
    this.#finalize('closed');
    const error = new Error(message);
    if (wasOpen) {
      this.#options.onError(error, { fatal: true, code });
      return;
    }
    // Mid-start: the pending start() owns this failure — it rethrows the
    // server's reason instead of surfacing one failure twice (rejection AND
    // onError), mirroring the close-during-connect precedent.
    this.#earlyFatalError = error;
  }

  /** Reject a start() still in flight when the session was torn down. */
  #rejectIfFinalized() {
    if (!this.#finalized) return;
    throw (
      this.#earlyFatalError ||
      new Error('Gemini Live session closed before start completed')
    );
  }

  #abortToolControllers() {
    for (const controller of this.#activeToolControllers) {
      try {
        controller.abort();
      } catch {
        /* no-op */
      }
    }
    this.#activeToolControllers.clear();
  }

  #teardownAudio() {
    if (this.#session) {
      try {
        this.#session.stop();
      } catch {
        /* no-op */
      }
      this.#session = null;
    }
    if (this.#audioContext) {
      const context = this.#audioContext;
      this.#audioContext = null;
      Promise.resolve(context.close?.()).catch(() => {});
    }
  }

  #closeSocketIntentionally(reason) {
    const socket = this.#socket;
    this.#socket = null;
    this.#intentionalStop = true;
    if (!socket) return;
    try {
      socket.close(1000, reason);
    } catch {
      /* no-op */
    }
  }

  #finalize(phase) {
    if (this.#finalized) return;
    this.#finalized = true;
    this.#setState(phase, 'Gemini Live session closed');
  }

  /** Abort in-flight tools while keeping the transport/session alive. */
  abortTools(reason = 'superseded') {
    this.#log('gemini.tools.abort', { reason });
    this.#abortToolControllers();
  }

  /** Idempotent full teardown of the session. */
  stop(reason = 'stopped') {
    this.#log('gemini.stop', { reason });
    this.#abortToolControllers();
    this.#teardownAudio();
    this.#closeSocketIntentionally(reason);
    this.#finalize('closed');
  }

  async #dispatchToolCalls(functionCalls) {
    this.#pruneProcessedCalls();
    const entries = functionCalls.map((raw) => normalizeFunctionCall(raw));
    const responses = new Array(entries.length);
    const duplicates = new Array(entries.length).fill(false);
    const pending = [];
    let dispatched = 0;

    entries.forEach((call, index) => {
      const dedupeKey = call.id || `${call.name}|${JSON.stringify(call.args)}`;
      if (this.#processedCalls.has(dedupeKey)) {
        duplicates[index] = true;
        return;
      }
      this.#processedCalls.set(dedupeKey, this.#options.now());

      if (!call.name) {
        responses[index] = {
          id: call.id,
          name: '',
          response: { ok: false, error: 'Function call missing name' },
        };
        return;
      }
      // A newer user turn or a stopped session makes this call stale intent —
      // refuse it without dispatching, but still answer it terminally so the
      // model is never left waiting on a function response.
      if (!this.#options.isCurrent() || !this.#isOpen()) {
        this.#log('gemini.tool.refused_stale', {
          name: call.name,
          callId: call.id,
        });
        responses[index] = {
          id: call.id,
          name: call.name,
          response: {
            ok: false,
            stale: true,
            action: call.name,
            error:
              'Refused: the voice session moved on before this call could run.',
          },
        };
        return;
      }
      dispatched += 1;
      pending.push(
        this.#runToolCall(call).then((response) => {
          responses[index] = response;
        }),
      );
    });
    // Retain only a bounded recent suffix after admitting this batch.
    this.#pruneProcessedCalls();

    if (duplicates.every(Boolean)) {
      // Everything was a duplicate — nothing to answer.
      return;
    }

    if (dispatched > 0) {
      this.#options.onStatus('executing', 'Running command');
    }
    await Promise.allSettled(pending);
    if (responses.some((response) => response === undefined)) {
      // Defensive: #runToolCall always resolves, so fill any gap terminally.
      entries.forEach((call, index) => {
        if (responses[index] === undefined) {
          responses[index] = {
            id: call.id,
            name: call.name,
            response: { ok: false, error: 'Tool call was not completed' },
          };
        }
      });
    }
    const finalResponses = entries
      .map((_call, index) => responses[index])
      .filter(Boolean);

    if (this.#isOpen()) {
      this.sendToolResponse(finalResponses);
    }
    if (dispatched > 0) {
      this.#options.onAfterToolResponses(
        finalResponses.map((response) => response.response),
      );
      if (this.#isOpen()) {
        this.#options.onStatus('listening', 'Ask or command');
      }
    }
  }

  async #runToolCall(call) {
    const controller = new AbortController();
    this.#activeToolControllers.add(controller);
    this.#log('gemini.tool.call', {
      name: call.name,
      callId: call.id,
      arguments: call.args,
    });
    let result;
    try {
      result = await this.#options.runner(call.name, call.args, {
        signal: controller.signal,
        isCurrent: () =>
          !controller.signal.aborted &&
          this.#isOpen() &&
          this.#options.isCurrent(),
      });
    } catch (error) {
      result = {
        ok: false,
        error: error?.message || 'GEV command failed',
        tool: call.name,
      };
    } finally {
      this.#activeToolControllers.delete(controller);
    }
    const finalResult = ensureTransportableResult(result, call.name);
    try {
      // Controller hooks may attach provider context (e.g. Gemini inline image)
      // that must reach the model before this call's toolResponse continues the
      // turn. Await async hooks while keeping their failure non-fatal.
      await this.#options.onToolResult(finalResult);
    } catch (error) {
      this.#log('gemini.tool.result_callback_failed', {
        name: call.name,
        callId: call.id,
        error: error?.message || String(error),
      });
    }
    this.#log('gemini.tool.result', { name: call.name, callId: call.id });
    return { id: call.id, name: call.name, response: finalResult };
  }
}
