#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MODEL_CHOICE = 'gemini-2.5';
const PROMPT = 'Reply with one very short spoken sentence, under five seconds.';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

export function protocolAcceptance(messages) {
  let setupComplete = false;
  let audio = false;
  let validModelResponse = false;
  for (const message of messages) {
    if (message?.setupComplete !== undefined) setupComplete = true;
    const content = message?.serverContent;
    const parts = content?.modelTurn?.parts || [];
    if (parts.length || content?.turnComplete === true || message?.toolCall?.functionCalls?.length) {
      validModelResponse = true;
    }
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
  let timer;
  try {
    const response = await fetchImpl(tokenUrl.href, { method: 'POST', cache: 'no-store' });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `Token route returned HTTP ${response.status}`);
    if (body?.provider !== undefined && body.provider !== 'gemini') throw new Error('Token route returned a non-Gemini provider');
    if (typeof body?.token !== 'string' || !body.token) throw new Error('Token route returned no token');
    secrets.push(body.token);
    const model = typeof body.model === 'string' && body.model ? body.model : null;
    if (!model) throw new Error('Token route returned no model');

    const messages = [];
    const wsUrl = `${ENDPOINT}?access_token=${encodeURIComponent(body.token)}`;
    socket = new WebSocketClass(wsUrl);
    await new Promise((resolve, reject) => {
      const fail = (error) => reject(error instanceof Error ? error : new Error('WebSocket failed before opening'));
      const close = (event) => reject(new Error(`WebSocket closed before opening (code ${event?.code ?? 'unknown'})`));
      const open = () => { socketOff(socket, 'error', fail); socketOff(socket, 'close', close); resolve(); };
      socketOn(socket, 'error', fail);
      socketOn(socket, 'close', close);
      socketOn(socket, 'open', open);
    });

    const accepted = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Gemini Live smoke timed out after ${timeoutMs}ms`)), timeoutMs);
      const finish = () => {
        const state = protocolAcceptance(messages);
        if (state.ok) { clearTimeout(timer); resolve(state); }
      };
      socketOn(socket, 'error', (error) => reject(error instanceof Error ? error : new Error('Gemini Live WebSocket error')));
      socketOn(socket, 'close', (event) => {
        const state = protocolAcceptance(messages);
        if (state.ok) resolve(state);
        else reject(new Error(`Gemini Live WebSocket closed before a valid response (code ${event?.code ?? 'unknown'})`));
      });
      socketOn(socket, 'message', (event) => {
        const message = parseMessage(event?.data ?? event);
        if (!message) return;
        messages.push(message);
        finish();
      });
      socket.send(JSON.stringify({ setup: { model: `models/${model}`, generationConfig: { responseModalities: ['AUDIO'] } } }));
      socket.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', content: [{ text: PROMPT }] }], turnComplete: true } }));
    });

    if (socket?.readyState === (WebSocketClass.OPEN ?? 1)) socket.close(1000, 'qa-complete');
    return { ok: true, baseUrl: parsedBase.origin, model, choice: body.choice || modelChoice, ...accepted };
  } catch (error) {
    throw cleanError(error, secrets);
  } finally {
    if (timer) clearTimeout(timer);
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
        if (sent === 2) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AA==' } }] }, turnComplete: true } }) }));
      }
      close(code = 1000, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
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
