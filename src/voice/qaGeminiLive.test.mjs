import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGeminiLiveSmoke,
  protocolAcceptance,
  redactSecrets,
} from '../../scripts/qa-gemini-live.mjs';

// ─────────────────────────────────────────────────────────────
// Helpers: mock fetch + mock WebSocket with controllable behavior.
// ─────────────────────────────────────────────────────────────

function tokenFetch({ token = 'mock-token', model = 'mock-model', choice = 'gemini-2.5' } = {}) {
  return async (url, options) => {
    tokenFetch.lastUrl = url;
    tokenFetch.lastOptions = options;
    return { ok: true, status: 200, json: async () => ({ token, model, choice, provider: 'gemini' }) };
  };
}

/** Deterministic socket that opens, acks setup, returns one audio turn, closes on request. */
class HappySocket {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sentFrames = [];
    this.closeRequests = [];
    this.closeEvent = null;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(frame) {
    this.sentFrames.push(JSON.parse(frame));
    const count = this.sentFrames.length;
    if (count === 1) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) }));
    if (count === 2) queueMicrotask(() => this.onmessage?.({
      data: JSON.stringify({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AA==' } }] },
          turnComplete: true,
        },
      }),
    }));
  }
  close(code = 1000, reason = '') {
    this.closeRequests.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeEvent = { code, reason, wasClean: true };
    queueMicrotask(() => this.onclose?.(this.closeEvent));
  }
}

// ─────────────────────────────────────────────────────────────
// protocolAcceptance contract (hardened)
// ─────────────────────────────────────────────────────────────

test('protocolAcceptance requires setupComplete plus audio or a substantive model response', () => {
  // Audio after setup passes.
  assert.equal(protocolAcceptance([
    { setupComplete: {} },
    { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AA==' } }] } } },
  ]).ok, true);

  // Substantive text part after setup passes.
  assert.equal(protocolAcceptance([
    { setupComplete: {} },
    { serverContent: { modelTurn: { parts: [{ text: 'Audio unavailable for this turn.' }] }, turnComplete: true } },
  ]).ok, true);

  // Tool call after setup passes.
  assert.equal(protocolAcceptance([
    { setupComplete: {} },
    { toolCall: { functionCalls: [{ name: 'annotate_map', args: {} }] } },
  ]).ok, true);

  // A bare turnComplete with no parts is NOT substantive — must fail.
  assert.equal(protocolAcceptance([
    { setupComplete: {} },
    { serverContent: { turnComplete: true } },
  ]).ok, false);
  assert.equal(protocolAcceptance([
    { setupComplete: {} },
    { serverContent: { modelTurn: { parts: [] }, turnComplete: true } },
  ]).ok, false);

  // No setupComplete → never ok, even with audio.
  assert.equal(protocolAcceptance([
    { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AA==' } }] } } },
  ]).ok, false);
  assert.equal(protocolAcceptance([{ setupComplete: {} }]).ok, false);
  assert.equal(protocolAcceptance([]).ok, false);
});

// ─────────────────────────────────────────────────────────────
// Whole-operation deadline
// ─────────────────────────────────────────────────────────────

test('whole-operation timeout: a hung token fetch aborts and fails within the deadline', { timeout: 5000 }, async () => {
  const signals = [];
  const hungFetch = async (url, options) => {
    signals.push(options?.signal);
    return new Promise(() => {});
  };
  await assert.rejects(
    createGeminiLiveSmoke({
      baseUrl: 'http://127.0.0.1:4173',
      timeoutMs: 150,
      fetchImpl: hungFetch,
      WebSocketClass: HappySocket,
    }),
    (error) => {
      assert.match(error.message, /timed out|abort|deadline/i);
      // The fetch must have been wired to an AbortController under the smoke's control,
      // and that controller must be aborted by the time the smoke rejects.
      assert.equal(signals[0] instanceof AbortSignal, true);
      assert.equal(signals[0].aborted, true);
      return true;
    },
  );
});

test('whole-operation timeout: a socket that never opens rejects within the deadline', { timeout: 5000 }, async () => {
  class NeverOpens {
    constructor() { this.readyState = 0; }
    send() {}
    close() {}
  }
  await assert.rejects(
    createGeminiLiveSmoke({
      baseUrl: 'http://127.0.0.1:4173',
      timeoutMs: 150,
      fetchImpl: tokenFetch(),
      WebSocketClass: NeverOpens,
    }),
    (error) => /timed out|deadline/i.test(error.message),
  );
});

test('setup is sent and acknowledged before clientContent under one deadline', async () => {
  const sockets = [];
  class GatedSocket extends HappySocket {
    constructor(url) { super(url); sockets.push(this); }
  }
  const result = await createGeminiLiveSmoke({
    baseUrl: 'http://127.0.0.1:4173',
    timeoutMs: 2000,
    fetchImpl: tokenFetch(),
    WebSocketClass: GatedSocket,
  });
  assert.equal(result.ok, true);
  const socket = sockets[0];
  // Exactly two frames, in protocol order: setup, then clientContent.
  assert.equal(socket.sentFrames.length, 2);
  assert.equal(socket.sentFrames[0].setup?.model, 'models/mock-model');
  assert.equal(socket.sentFrames[1].setup, undefined);
  // The live API rejects `content` (1007 'Unknown name content at
  // client_content.turns[0]'); turns must use `parts`.
  assert.equal(socket.sentFrames[1].clientContent?.turns?.[0]?.parts?.[0]?.text?.length > 0, true);
  assert.equal(socket.sentFrames[1].clientContent?.turns?.[0]?.content, undefined);
  assert.equal(socket.sentFrames[1].clientContent.turnComplete, true);
});

test('clientContent is held back when setupComplete never arrives', { timeout: 5000 }, async () => {
  const sockets = [];
  class NoSetupAckSocket {
    constructor() { this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); this.sentFrames = []; sockets.push(this); }
    send(frame) { this.sentFrames.push(JSON.parse(frame)); }
    close() { this.readyState = 3; }
  }
  await assert.rejects(
    createGeminiLiveSmoke({
      baseUrl: 'http://127.0.0.1:4173',
      timeoutMs: 150,
      fetchImpl: tokenFetch(),
      WebSocketClass: NoSetupAckSocket,
    }),
    (error) => /timed out/i.test(error.message),
  );
  assert.equal(sockets[0].sentFrames.length, 1, 'only the setup frame may be sent before setupComplete is observed');
  assert.equal(sockets[0].sentFrames[0].setup !== undefined, true);
});

test('setup repeats the setupConfig returned by the token route', { timeout: 5000 }, async () => {
  const sockets = [];
  class SetupCaptureSocket extends HappySocket {
    constructor(url) { super(url); sockets.push(this); }
  }
  const setupConfig = {
    systemInstruction: { parts: [{ text: 'You are GEV over watch.' }] },
    tools: [{ functionDeclarations: [{ name: 'fly_to', parameters: {} }] }],
  };
  const result = await createGeminiLiveSmoke({
    baseUrl: 'http://127.0.0.1:4173',
    timeoutMs: 2000,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'mock-token',
        model: 'mock-model',
        choice: 'gemini-2.5',
        provider: 'gemini',
        setupConfig,
      }),
    }),
    WebSocketClass: SetupCaptureSocket,
  });
  assert.equal(result.ok, true);
  const setup = sockets[0].sentFrames[0].setup;
  assert.equal(setup.model, 'models/mock-model');
  assert.deepEqual(setup.systemInstruction, setupConfig.systemInstruction);
  assert.deepEqual(setup.tools, setupConfig.tools);
});

// ─────────────────────────────────────────────────────────────
// Clean closure
// ─────────────────────────────────────────────────────────────

test('smoke closes with code 1000 and awaits the actual close event with bounded grace', async () => {
  const sockets = [];
  class SlowCloseSocket extends HappySocket {
    constructor(url) { super(url); sockets.push(this); }
    close(code, reason) {
      this.closeRequests.push({ code, reason });
      if (this.readyState === 3) return;
      // Defer the close event past close() returning, like a real socket.
      setTimeout(() => {
        this.readyState = 3;
        this.closeEvent = { code, reason, wasClean: true };
        this.onclose?.(this.closeEvent);
      }, 30);
    }
  }
  const result = await createGeminiLiveSmoke({
    baseUrl: 'http://127.0.0.1:4173',
    timeoutMs: 2000,
    fetchImpl: tokenFetch(),
    WebSocketClass: SlowCloseSocket,
  });
  assert.equal(result.ok, true);
  const socket = sockets[0];
  assert.equal(socket.closeRequests.length, 1);
  assert.equal(socket.closeRequests[0].code, 1000);
  // The smoke observed the real close event before resolving success.
  assert.equal(socket.closeEvent !== null && socket.closeEvent.code === 1000, true);
});

test('abnormal close before success rejects the smoke', { timeout: 5000 }, async () => {
  const sockets = [];
  class AbnormalCloseSocket {
    constructor() {
      this.readyState = 0;
      this.sentFrames = [];
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    send(frame) {
      this.sentFrames.push(JSON.parse(frame));
      if (this.sentFrames.length === 1) {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) }));
        queueMicrotask(() => {
          this.readyState = 3;
          this.onclose?.({ code: 1006, reason: 'abnormal', wasClean: false });
        });
      }
    }
    close() {}
  }
  await assert.rejects(
    createGeminiLiveSmoke({
      baseUrl: 'http://127.0.0.1:4173',
      timeoutMs: 2000,
      fetchImpl: tokenFetch(),
      WebSocketClass: AbnormalCloseSocket,
    }),
    (error) => {
      // The abnormal close code is surfaced, never swallowed into a success.
      assert.match(error.message, /1006|abnormal|closed/i);
      return true;
    },
  );
});

test('abnormal close before the setup acknowledgement rejects without sending the text turn', { timeout: 5000 }, async () => {
  const sockets = [];
  class CloseBeforeAckSocket {
    constructor() {
      this.readyState = 0;
      this.sentFrames = [];
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    send(frame) {
      this.sentFrames.push(JSON.parse(frame));
      if (this.sentFrames.length === 1) {
        queueMicrotask(() => {
          this.readyState = 3;
          this.onclose?.({ code: 1006, reason: 'abnormal', wasClean: false });
        });
      }
    }
    close() {}
  }
  await assert.rejects(
    createGeminiLiveSmoke({
      baseUrl: 'http://127.0.0.1:4173',
      timeoutMs: 1000,
      fetchImpl: tokenFetch(),
      WebSocketClass: CloseBeforeAckSocket,
    }),
    (error) => /1006|closed/i.test(error.message),
  );
  assert.equal(sockets[0].sentFrames.some((f) => f.clientContent !== undefined), false, 'clientContent must not be sent after an abnormal close');
});

test('every failure path still attempts socket closure', async () => {
  const events = [];
  class TrackingSocket extends HappySocket {
    close(code, reason) { events.push({ code, reason }); super.close(code, reason); }
  }
  // Failure injected after open: socket errors mid-handshake.
  class ErrorMidFlight {
    constructor() {
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
        queueMicrotask(() => this.onerror?.(new Error('boom after open')));
      });
    }
    send() {}
    close(code = 1000, reason = '') { events.push({ code, reason }); this.readyState = 3; }
  }
  await assert.rejects(createGeminiLiveSmoke({
    baseUrl: 'http://127.0.0.1:4173', timeoutMs: 500, fetchImpl: tokenFetch(), WebSocketClass: ErrorMidFlight,
  }));
  assert.equal(events.length, 1, 'cleanup must close the socket on failure');
  assert.equal(typeof events[0].code, 'number');
});

// ─────────────────────────────────────────────────────────────
// Credential redaction edge cases
// ─────────────────────────────────────────────────────────────

test('synchronous WebSocket constructor error containing the raw token URL is redacted', async () => {
  const token = 'auth_tokens/ctor-secret-987';
  class ThrowingConstructor {
    constructor(url) {
      // Synchronous throw with both raw and encoded token present, like ws does.
      throw new Error(`Invalid WebSocket URL: ${url} token=${token} encoded=${encodeURIComponent(token)}`);
    }
  }
  await assert.rejects(
    createGeminiLiveSmoke({
      baseUrl: 'http://127.0.0.1:4173',
      timeoutMs: 500,
      fetchImpl: tokenFetch({ token }),
      WebSocketClass: ThrowingConstructor,
    }),
    (error) => {
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes(encodeURIComponent(token)), false);
      assert.match(error.message, /REDACTED/);
      return true;
    },
  );
});

test('token in a WebSocket close reason is redacted', async () => {
  const token = 'auth_tokens/close-reason-secret';
  class CloseReasonSocket {
    constructor() {
      this.readyState = 0;
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    send(frame) {
      const parsed = JSON.parse(frame);
      if (parsed.setup) {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) }));
        queueMicrotask(() => {
          this.readyState = 3;
          this.onclose?.({ code: 1008, reason: `policy denied for ${token}`, wasClean: true });
        });
      }
    }
    close() {}
  }
  await assert.rejects(
    createGeminiLiveSmoke({
      baseUrl: 'http://127.0.0.1:4173',
      timeoutMs: 1000,
      fetchImpl: tokenFetch({ token }),
      WebSocketClass: CloseReasonSocket,
    }),
    (error) => {
      assert.equal(error.message.includes(token), false, `close reason leaked token: ${error.message}`);
      assert.match(error.message, /1008|closed/i);
      return true;
    },
  );
});

// ─────────────────────────────────────────────────────────────
// CLI output boundary
// ─────────────────────────────────────────────────────────────

test('CLI dry-run prints one redacted JSON document to stdout and nothing to stderr', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const scriptDir = new URL('.', import.meta.url).pathname;
  const repoRoot = `${scriptDir}../../`;
  const { stdout, stderr } = await execFileAsync(process.execPath, ['scripts/qa-gemini-live.mjs', '--dry-run'], {
    cwd: repoRoot,
  });
  assert.equal(stderr, '');
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.mode, 'dry/mock');
  assert.equal(parsed.ok, true);
  assert.doesNotMatch(stdout, /mock-token/);
  assert.doesNotMatch(stdout, /AIza/);
  // Boundary: stdout is exactly the JSON document, nothing before or after.
  assert.equal(stdout.trim().startsWith('{'), true);
  assert.equal(stdout.trim().endsWith('}'), true);
});

// ─────────────────────────────────────────────────────────────
// Kept from round 1: core redaction + dry-run contract
// ─────────────────────────────────────────────────────────────

test('redactSecrets removes access tokens, API keys, and known secret values', () => {
  const secret = 'auth_tokens/secret-value-123';
  const input = `wss://example.test/live?access_token=${encodeURIComponent(secret)} GEMINI_API_KEY=AIza-secret x-goog-api-key: *** ${secret}`;
  const output = redactSecrets(input, [secret]);
  assert.doesNotMatch(output, /secret-value|AIza-secret/);
  assert.match(output, /access_token=\[REDACTED\]/);
  assert.match(output, /GEMINI_API_KEY=\[REDACTED\]/);
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
      if (sent.length === 2) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AA==' } }] }, turnComplete: true } }) })); // eslint-disable-line
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

// ─────────────────────────────────────────────────────────────
// Binary server frames (Gemini Live sends JSON as BINARY WS frames)
// ─────────────────────────────────────────────────────────────

/** Deterministic socket whose two scripted frames use a chosen wire encoding. */
function binaryHappySocket(encode) {
  return class BinaryHappySocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sentFrames = [];
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    send(frame) {
      this.sentFrames.push(JSON.parse(frame));
      const count = this.sentFrames.length;
      const deliver = (payload) =>
        this.onmessage?.({ data: encode(JSON.stringify(payload)) });
      if (count === 1) queueMicrotask(() => deliver({ setupComplete: {} }));
      if (count === 2) queueMicrotask(() => deliver({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AA==' } }] },
          turnComplete: true,
        },
      }));
    }
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.({ code, reason, wasClean: true }));
    }
  };
}

test('smoke completes when server frames arrive as ArrayBuffer', async () => {
  const result = await createGeminiLiveSmoke({
    baseUrl: 'http://127.0.0.1:4173',
    timeoutMs: 2000,
    fetchImpl: tokenFetch(),
    WebSocketClass: binaryHappySocket((text) =>
      new TextEncoder().encode(text).buffer,
    ),
  });
  assert.equal(result.ok, true);
  assert.equal(result.audio, true);
});

test('smoke completes when server frames arrive as Blob', async () => {
  const result = await createGeminiLiveSmoke({
    baseUrl: 'http://127.0.0.1:4173',
    timeoutMs: 2000,
    fetchImpl: tokenFetch(),
    WebSocketClass: binaryHappySocket((text) => new Blob([text])),
  });
  assert.equal(result.ok, true);
  assert.equal(result.audio, true);
});

test('smoke still completes when server frames arrive as strings', async () => {
  const result = await createGeminiLiveSmoke({
    baseUrl: 'http://127.0.0.1:4173',
    timeoutMs: 2000,
    fetchImpl: tokenFetch(),
    WebSocketClass: binaryHappySocket((text) => text),
  });
  assert.equal(result.ok, true);
  assert.equal(result.audio, true);
});
