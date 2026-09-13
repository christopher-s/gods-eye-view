import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGeminiLiveSmoke,
  protocolAcceptance,
  redactSecrets,
} from '../../scripts/qa-gemini-live.mjs';

test('redactSecrets removes access tokens, API keys, and known secret values', () => {
  const secret = 'auth_tokens/secret-value-123';
  const input = `wss://example.test/live?access_token=${encodeURIComponent(secret)} GEMINI_API_KEY=AIza-secret x-goog-api-key: key-value ${secret}`;
  const output = redactSecrets(input, [secret]);
  assert.doesNotMatch(output, /secret-value|AIza-secret|key-value/);
  assert.match(output, /access_token=\[REDACTED\]/);
  assert.match(output, /GEMINI_API_KEY=\[REDACTED\]/);
  assert.match(output, /x-goog-api-key: \[REDACTED\]/);
});

test('protocolAcceptance accepts setup plus audio or a documented valid model response', () => {
  assert.deepEqual(protocolAcceptance([
    { setupComplete: {} },
    { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AA==' } }] } } },
  ]), { ok: true, setupComplete: true, audio: true, validModelResponse: true });

  assert.equal(protocolAcceptance([
    { setupComplete: {} },
    { serverContent: { modelTurn: { parts: [{ text: 'Audio unavailable for this turn.' }] }, turnComplete: true } },
  ]).ok, true);
  assert.equal(protocolAcceptance([{ setupComplete: {} }]).ok, false);
});

test('dry smoke uses injected token/socket dependencies and closes cleanly', async () => {
  const sent = [];
  let closed = false;
  class MockSocket {
    static OPEN = 1;
    constructor(url) {
      assert.match(url, /access_token=mock-token/);
      this.readyState = 0;
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    send(value) {
      sent.push(JSON.parse(value));
      if (sent.length === 1) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) }));
      if (sent.length === 2) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AA==' } }] }, turnComplete: true } }) }));
    }
    close() { closed = true; this.readyState = 3; this.onclose?.({ code: 1000, reason: 'done' }); }
  }

  const result = await createGeminiLiveSmoke({
    baseUrl: 'http://127.0.0.1:4173',
    modelChoice: 'gemini-2.5',
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:4173/api/gemini-live/token?model=gemini-2.5');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers, undefined);
      return { ok: true, status: 200, json: async () => ({ token: 'mock-token', model: 'mock-model', choice: 'gemini-2.5', provider: 'gemini' }) };
    },
    WebSocketClass: MockSocket,
  });

  assert.equal(result.ok, true);
  assert.equal(result.audio, true);
  assert.equal(closed, true);
  assert.deepEqual(sent[0], { setup: { model: 'models/mock-model', generationConfig: { responseModalities: ['AUDIO'] } } });
  assert.equal(sent[1].clientContent.turnComplete, true);
  assert.doesNotMatch(JSON.stringify(result), /mock-token/);
});

test('smoke failures redact the minted token', async () => {
  const token = 'auth_tokens/top-secret';
  class BrokenSocket {
    constructor() { queueMicrotask(() => this.onerror?.(new Error(`failed ${token}?access_token=${token}`))); }
    close() {}
  }
  await assert.rejects(
    createGeminiLiveSmoke({
      baseUrl: 'http://localhost:4173', timeoutMs: 100,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ token, model: 'model', provider: 'gemini' }) }),
      WebSocketClass: BrokenSocket,
    }),
    (error) => !error.message.includes(token) && error.message.includes('[REDACTED]'),
  );
});
