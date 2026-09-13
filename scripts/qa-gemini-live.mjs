#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CLOSE_GRACE_MS = 5_000;
const DEFAULT_MODEL_CHOICE = 'gemini-2.5';
const PROMPT = 'Reply with one very short spoken sentence, under five seconds.';

export function redactSecrets(value, knownSecrets = []) {
  let output = String(value ?? '');
  for (const secret of knownSecrets.filter((item) => typeof item === 'string' && item)) {
    output = output.replaceAll(secret, '[REDACTED]');
    output = output.replaceAll(encodeURIComponent(secret), '[REDACTED]');
  }
  output = output
    .replace(/([?&]access_token=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/(GEMINI_API_KEY\s*[=:]\s*)[^\s,"']+/gi, '$1[REDACTED]')
    .replace(/(x-goog-api-key\s*[:=]\s*)[^\s,"']+/gi, '$1[REDACTED]')
    .replace(/(AIza)[A-Za-z0-9_-]{10,}/g, '[REDACTED]');
  return output;
}

/**
 * Acceptance contract: setupComplete plus audio OR a substantive model response
 * (non-empty parts or a tool call). A bare turnComplete with no payload is not
 * evidence the model replied, so it can never pass on its own.
 */
export function protocolAcceptance(messages) {
  let setupComplete = false;
  let audio = false;
  let validModelResponse = false;
  for (const message of messages) {
    if (message?.setupComplete !== undefined) setupComplete = true;
    const content = message?.serverContent;
    const parts = content?.modelTurn?.parts || [];
    const hasSubstantivePart = parts.some((part) => (
      (typeof part?.text === 'string' && part.text.trim())
      || (typeof part?.inlineData?.data === 'string' && part.inlineData.data)
      || part?.functionCall
      || part?.functionResponse
    ));
    const hasToolCall = Boolean(message?.toolCall?.functionCalls?.length);
    if (hasSubstantivePart || hasToolCall) validModelResponse = true;
    if (parts.some((part) => typeof part?.inlineData?.data === 'string' && /^audio\//i.test(part?.inlineData?.mimeType || ''))) {
      audio = true;
    }
  }
  return { ok: setupComplete && (audio || validModelResponse), setupComplete, audio, validModelResponse };
}

function parseMessage(raw) {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : raw.toString());
  } catch {
    return null;
  }
}

function socketOn(socket, name, handler) {
  if (typeof socket.on === 'function') socket.on(name, handler);
  else socket[`on${name}`] = handler;
}

function socketOff(socket, name, handler) {
  if (typeof socket.off === 'function') socket.off(name, handler);
  else if (socket[`on${name}`] === handler) socket[`on${name}`] = null;
}

function cleanError(error, secrets) {
  const safe = new Error(redactSecrets(error?.message || error, secrets));
  if (error?.code) safe.code = error.code;
  return safe;
}

export async function createGeminiLiveSmoke({
  baseUrl,
  modelChoice = DEFAULT_MODEL_CHOICE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  WebSocketClass = WebSocket,
} = {}) {
  const parsedBase = new URL(baseUrl || 'http://127.0.0.1:4173');
  if (!['http:', 'https:'].includes(parsedBase.protocol)) throw new Error('Base URL must use http or https');
  const tokenUrl = new URL('/api/gemini-live/token', parsedBase);
  tokenUrl.searchParams.set('model', modelChoice);

  const secrets = [];
  let socket;
  let graceTimer;
  const controller = new AbortController();
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  // One overall deadline: it starts before the token fetch and socket
  // construction and covers handshake, setup, the response turn, and closure.
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(new Error(`Gemini Live smoke timed out after ${timeoutMs}ms (whole operation)`));
  }, timeoutMs);

  try {
    // ── Stage 1: mint an ephemeral token under the overall deadline ──
    const response = await Promise.race([
      fetchImpl(tokenUrl.href, { method: 'POST', cache: 'no-store', signal: controller.signal }),
      deadline,
    ]);
    const body = await Promise.race([response.json().catch(() => null), deadline]);
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `Token route returned HTTP ${response.status}`);
    if (body?.provider !== undefined && body.provider !== 'gemini') throw new Error('Token route returned a non-Gemini provider');
    if (typeof body?.token !== 'string' || !body.token) throw new Error('Token route returned no token');
    secrets.push(body.token);
    const model = typeof body.model === 'string' && body.model ? body.model : null;
    if (!model) throw new Error('Token route returned no model');

    // ── Stage 2: constrained WebSocket handshake under the same deadline ──
    const messages = [];
    let fatal = null;
    let closeEvent = null;
    let activeWaiter = null;
    const pump = () => {
      const waiter = activeWaiter;
      if (!waiter) return;
      if (fatal) {
        activeWaiter = null;
        waiter.reject(fatal);
        return;
      }
      if (closeEvent) {
        activeWaiter = null;
        if (waiter.expectClose) waiter.resolve(closeEvent);
        else {
          const reason = closeEvent?.reason ? `, reason "${closeEvent.reason}"` : '';
          waiter.reject(new Error(`Gemini Live WebSocket closed before ${waiter.stage} (code ${closeEvent?.code ?? 'unknown'}${reason})`));
        }
        return;
      }
      const value = waiter.test();
      if (value) {
        activeWaiter = null;
        waiter.resolve(value);
      }
    };
    const waitFor = (stage, test, expectClose = false) => new Promise((resolve, reject) => {
      activeWaiter = { stage, test, expectClose, resolve, reject };
      pump();
    });

    socket = new WebSocketClass(`${ENDPOINT}?access_token=${encodeURIComponent(body.token)}`);
    await Promise.race([
      new Promise((resolve, reject) => {
        const fail = (error) => reject(error instanceof Error ? error : new Error('Gemini Live WebSocket failed before opening'));
        const refused = (event) => reject(new Error(`Gemini Live WebSocket closed before opening (code ${event?.code ?? 'unknown'})`));
        const open = () => { socketOff(socket, 'error', fail); socketOff(socket, 'close', refused); resolve(); };
        socketOn(socket, 'error', fail);
        socketOn(socket, 'close', refused);
        socketOn(socket, 'open', open);
      }),
      deadline,
    ]);

    socketOn(socket, 'message', (event) => {
      const message = parseMessage(event?.data ?? event);
      if (!message) return;
      messages.push(message);
      pump();
    });
    socketOn(socket, 'error', (error) => {
      fatal = fatal || (error instanceof Error ? error : new Error('Gemini Live WebSocket error'));
      pump();
    });
    socketOn(socket, 'close', (event) => {
      closeEvent = event || { code: null };
      pump();
    });

    // ── Stage 3: setup first; clientContent waits for the acknowledgement ──
    // The token carries no session constraints (the live auth_tokens endpoint
    // rejects liveConnectConstraints), so setup repeats the route's
    // setupConfig when present.
    const setup = {
      model: `models/${model}`,
      generationConfig: { responseModalities: ['AUDIO'] },
    };
    if (body?.setupConfig && typeof body.setupConfig === 'object') {
      if (body.setupConfig.systemInstruction) {
        setup.systemInstruction = body.setupConfig.systemInstruction;
      }
      if (Array.isArray(body.setupConfig.tools)) {
        setup.tools = body.setupConfig.tools;
      }
    }
    socket.send(JSON.stringify({ setup }));
    await Promise.race([
      waitFor('setup acknowledgement', () => (messages.some((message) => message?.setupComplete !== undefined) ? true : null)),
      deadline,
    ]);

    // ── Stage 4: bounded text turn under the same deadline ──
    if (socket.readyState === 3) {
      throw new Error(`Gemini Live WebSocket closed before the text turn (code ${closeEvent?.code ?? 'unknown'})`);
    }
    socket.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: PROMPT }] }], turnComplete: true } }));
    const accepted = await Promise.race([
      waitFor('a valid model response', () => {
        const state = protocolAcceptance(messages);
        return state.ok ? state : null;
      }),
      deadline,
    ]);

    // ── Stage 5: clean close with code 1000, awaiting the real close event ──
    if (socket.readyState !== 3) socket.close(1000, 'qa-complete');
    const closeGraceMs = Math.min(DEFAULT_CLOSE_GRACE_MS, timeoutMs);
    await Promise.race([
      waitFor('socket closure', () => null, true),
      new Promise((_, reject) => {
        graceTimer = setTimeout(() => reject(new Error(`Gemini Live socket close was not acknowledged within ${closeGraceMs}ms`)), closeGraceMs);
      }),
      deadline,
    ]);

    return { ok: true, baseUrl: parsedBase.origin, model, choice: body.choice || modelChoice, ...accepted };
  } catch (error) {
    throw cleanError(error, secrets);
  } finally {
    clearTimeout(timer);
    if (graceTimer) clearTimeout(graceTimer);
    controller.abort();
    try {
      if (socket && socket.readyState !== 3) socket.close(1000, 'qa-cleanup');
    } catch {}
  }
}

function getOpt(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

async function runCli() {
  const dryRun = hasFlag('--dry-run') || hasFlag('--mock');
  const options = {
    baseUrl: getOpt('--base-url', getOpt('--url', 'http://127.0.0.1:4173')),
    modelChoice: getOpt('--model', DEFAULT_MODEL_CHOICE),
    timeoutMs: Number(getOpt('--timeout-ms', String(DEFAULT_TIMEOUT_MS))),
  };
  if (dryRun) {
    let sent = 0;
    class MockSocket {
      static OPEN = 1;
      constructor() { this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
      send() {
        sent += 1;
        if (sent === 1) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) }));
        if (sent === 2) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AA==' } }] }, turnComplete: true } }) })); // eslint-disable-line no-unused-vars
      }
      close(code = 1000, reason = '') { this.readyState = 3; this.onclose?.({ code, reason, wasClean: true }); }
    }
    options.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ token: 'mock-token', model: 'gemini-2.5-flash-native-audio-preview-12-2025', choice: options.modelChoice, provider: 'gemini' }) });
    options.WebSocketClass = MockSocket;
  }
  const result = await createGeminiLiveSmoke(options);
  console.log(JSON.stringify({ mode: dryRun ? 'dry/mock' : 'credentialed', ...result }, null, 2));
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invoked) {
  runCli().catch((error) => {
    console.error(redactSecrets(error?.message || error));
    process.exitCode = 1;
  });
}
