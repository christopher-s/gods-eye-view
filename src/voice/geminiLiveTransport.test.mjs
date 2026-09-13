// GeminiLiveTransport unit tests — protocol wiring, PCM plumbing, event
// normalization, and the tool bridge, all driven through injected fetch /
// WebSocket / audio-session / clock fakes (no network, no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GeminiLiveTransport,
  GEMINI_LIVE_WEBSOCKET_ENDPOINT,
  GEMINI_TOKEN_URL,
  createGeminiVoiceCostTracker,
} from './geminiLiveTransport.js';
import {
  GeminiPcmAudioSession,
  PCM_CAPTURE_MODULE_URL,
  float32ToPcm16,
  pcm16ToBase64,
  resampleMono,
} from './geminiAudio.js';

const DEFAULT_SERVED_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

// Mirrors the transport's time-based dedupe window; the tests pin expiry by
// observable re-dispatch rather than inspecting private memory.
const CALL_DEDUPE_MS = 2500;

function tokenResponse({
  token = 'ephemeral-token-abc123',
  model = DEFAULT_SERVED_MODEL,
  choice = 'gemini-2.5',
  provider = 'gemini',
} = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ token, model, choice, provider }),
    headers: { get: () => null },
  };
}

function errorResponse(status, body) {
  return {
    ok: false,
    status,
    json: async () => body,
    headers: { get: () => null },
  };
}

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closeCalls = [];
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('WebSocket is not open');
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000, reason = '') {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    const event = { code, reason, wasClean: true };
    this.onclose?.(event);
  }

  // --- test-side drivers -------------------------------------------------
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  message(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  rawMessage(text) {
    this.onmessage?.({ data: text });
  }

  fail(error = new Error('socket error')) {
    this.onerror?.(error);
  }

  serverClose(code = 1006, reason = 'unexpected') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: false });
  }
}

function createAudioContextFake({ sampleRate = 48000 } = {}) {
  const context = {
    sampleRate,
    currentTime: 0,
    destination: { id: 'destination' },
    modules: [],
    closed: false,
    audioWorklet: {
      async addModule(url) {
        context.modules.push(url);
      },
    },
    createBuffer({ numberOfChannels, length, sampleRate: rate }) {
      return {
        numberOfChannels,
        length,
        sampleRate: rate,
        channels: Array.from(
          { length: numberOfChannels },
          () => new Float32Array(length),
        ),
        getChannelData(index) {
          return this.channels[index];
        },
      };
    },
    createBufferSource() {
      return {
        buffer: null,
        connections: [],
        connect(node) {
          this.connections.push(node);
        },
        disconnect() {
          this.connections.length = 0;
        },
        start() {},
        stop() {},
        onended: null,
      };
    },
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    },
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    },
    createAnalyser() {
      return {
        fftSize: 0,
        smoothingTimeConstant: 0,
        frequencyBinCount: 32,
        getByteFrequencyData() {},
      };
    },
    async close() {
      context.closed = true;
    },
  };
  return context;
}

function createSessionFake() {
  return {
    started: false,
    stopped: false,
    cleared: 0,
    enqueued: [],
    onChunk: null,
    stream: null,
    async startInput(onChunk, stream) {
      this.onChunk = onChunk;
      this.stream = stream;
      this.started = true;
    },
    enqueueOutput(chunk) {
      this.enqueued.push(chunk);
    },
    clearOutput() {
      this.cleared += 1;
    },
    stop() {
      this.stopped = true;
    },
  };
}

function createHarness(overrides = {}) {
  const callbacks = {
    states: [],
    interrupted: 0,
    assistantTurnStarts: 0,
    assistantAudio: [],
    turnCompletes: 0,
    usage: [],
    statuses: [],
    errors: [],
    logs: [],
    toolResults: [],
    afterToolResponses: [],
    audioContexts: [],
  };
  const fetchLog = [];
  const contexts = [];
  const sessions = [];
  const sockets = [];
  const contextPool = [createAudioContextFake(), createAudioContextFake()];
  let contextIndex = 0;
  const harness = {
    callbacks,
    fetchLog,
    contexts,
    sessions,
    sockets,
    contextPool,
    fetchImpl:
      overrides.fetchImpl ||
      (async (url, options) => {
        fetchLog.push({ url, options });
        return tokenResponse();
      }),
    WebSocketClass: class extends FakeWebSocket {
      constructor(url) {
        super(url);
        sockets.push(this);
      }
    },
    createAudioContext:
      overrides.createAudioContext || (() => contextPool[contextIndex++]),
    createAudioSession:
      overrides.createAudioSession ||
      ((audioContext) => {
        const session = createSessionFake();
        sessions.push(session);
        return session;
      }),
    now: overrides.now || (() => 0),
  };
  const transport = new GeminiLiveTransport({
    runner: overrides.runner || (async () => ({ ok: true })),
    isCurrent: overrides.isCurrent || (() => true),
    onState: (state) => callbacks.states.push(state),
    onInterrupted: () => {
      callbacks.interrupted += 1;
    },
    onAssistantTurnStart: () => {
      callbacks.assistantTurnStarts += 1;
    },
    onAssistantAudio: (chunk) => {
      callbacks.assistantAudio.push(chunk);
    },
    onTurnComplete: () => {
      callbacks.turnCompletes += 1;
    },
    onUsage: (usage) => {
      callbacks.usage.push(usage);
    },
    onStatus: (status, detail) => callbacks.statuses.push({ status, detail }),
    onError: (error, info) => callbacks.errors.push({ error, info }),
    onToolResult: (result) => callbacks.toolResults.push(result),
    onAfterToolResponses: (results) =>
      callbacks.afterToolResponses.push(results),
    onLog: (event, payload) => callbacks.logs.push({ event, payload }),
    onAudioContext: (context) => callbacks.audioContexts.push(context),
    fetchImpl: harness.fetchImpl,
    WebSocketClass: harness.WebSocketClass,
    createAudioContext: harness.createAudioContext,
    createAudioSession: harness.createAudioSession,
    now: harness.now,
  });
  harness.transport = transport;
  harness.connect = async ({
    modelChoice = 'gemini-2.5',
    mediaStream = { id: 'mic' },
  } = {}) => {
    const starting = transport.start({ modelChoice, mediaStream });
    await new Promise((resolve) => setImmediate(resolve));
    const socket = sockets.at(-1);
    socket?.open();
    await starting;
    return socket;
  };
  return harness;
}

const flush = async (times = 4) => {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const AUDIO_CHUNK = pcm16ToBase64(
  float32ToPcm16(Float32Array.from([0.25, -0.5, 0.75, -0.125])),
);

// ---------------------------------------------------------------------------
// Token minting and WebSocket URL
// ---------------------------------------------------------------------------

test('start() mints a token via POST with the registry model choice', async () => {
  const f = createHarness();
  await f.connect({ modelChoice: 'gemini-3' });

  assert.equal(f.fetchLog.length, 1);
  assert.equal(f.fetchLog[0].url, `${GEMINI_TOKEN_URL}?model=gemini-3`);
  assert.equal(f.fetchLog[0].options.method, 'POST');
});

test('start() rejects hostile model choices down to the approved default', async () => {
  const f = createHarness();
  await f.connect({ modelChoice: 'gpt-4o-playbook' });

  assert.equal(f.fetchLog[0].url, `${GEMINI_TOKEN_URL}?model=gemini-2.5`);
});

test('connects to the constrained BidiGenerateContent endpoint with the ephemeral token', async () => {
  const f = createHarness({
    fetchImpl: async () => tokenResponse({ token: 'tok-XYZ' }),
  });
  await f.connect();

  const socket = f.sockets.at(-1);
  assert.equal(
    socket.url,
    `${GEMINI_LIVE_WEBSOCKET_ENDPOINT}?access_token=tok-XYZ`,
  );
});

test('the token is minted immediately before the connection is opened', async () => {
  let releaseFetch;
  const gate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const order = [];
  const f = createHarness({
    fetchImpl: async () => {
      order.push('fetch');
      await gate;
      order.push('fetchResolved');
      return tokenResponse({ token: 'late-token' });
    },
  });
  const starting = f.transport.start({
    modelChoice: 'gemini-2.5',
    mediaStream: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['fetch']);
  assert.equal(f.sockets.length, 0, 'no socket before the token resolves');
  releaseFetch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['fetch', 'fetchResolved']);
  assert.ok(f.sockets.length, 'socket constructed right after the mint');
  f.sockets.at(-1).open();
  await starting;
});

test('a token endpoint failure rejects start() with the server reason and opens nothing', async () => {
  const f = createHarness({
    fetchImpl: async () =>
      errorResponse(503, { error: 'Gemini Live is not configured' }),
  });
  await assert.rejects(
    f.transport.start({ modelChoice: 'gemini-2.5' }),
    /Gemini Live is not configured/,
  );
  assert.equal(f.sockets.length, 0);
});

test('a token response without a token rejects start()', async () => {
  const f = createHarness({
    fetchImpl: async () => tokenResponse({ token: '' }),
  });
  await assert.rejects(
    f.transport.start({ modelChoice: 'gemini-2.5' }),
    /did not include a token/i,
  );
});

test('a non-Gemini provider echo rejects start()', async () => {
  const f = createHarness({
    fetchImpl: async () => tokenResponse({ provider: 'openai' }),
  });
  await assert.rejects(
    f.transport.start({ modelChoice: 'gemini-2.5' }),
    /non-Gemini provider/i,
  );
});

test('start() can only be called once per transport', async () => {
  const f = createHarness();
  const first = f.connect();
  await assert.rejects(
    f.transport.start({ modelChoice: 'gemini-2.5' }),
    /already been called/i,
  );
  await first;
});

// ---------------------------------------------------------------------------
// Setup message and audio wiring
// ---------------------------------------------------------------------------

test('the first message after open is setup with the served model and AUDIO modality', async () => {
  const f = createHarness();
  const socket = await f.connect();

  assert.equal(socket.sent.length, 1);
  assert.deepEqual(socket.sent[0], {
    setup: {
      model: `models/${DEFAULT_SERVED_MODEL}`,
      generationConfig: { responseModalities: ['AUDIO'] },
    },
  });
});

test('setup carries the server-resolved model, not the browser choice string', async () => {
  const f = createHarness({
    fetchImpl: async () =>
      tokenResponse({ model: 'env-overridden-model-x', choice: 'gemini-3' }),
  });
  const socket = await f.connect({ modelChoice: 'gemini-3' });

  assert.equal(socket.sent[0].setup.model, 'models/env-overridden-model-x');
  assert.equal(f.transport.servedModel, 'env-overridden-model-x');
});

test('the PCM capture worklet module is loaded before startInput', async () => {
  const order = [];
  const context = createAudioContextFake();
  context.audioWorklet.addModule = async (url) => {
    order.push('addModule');
    context.modules.push(url);
  };
  const session = createSessionFake();
  session.startInput = async (onChunk, stream) => {
    order.push('startInput');
    session.onChunk = onChunk;
    session.stream = stream;
    session.started = true;
  };
  const f = createHarness({
    createAudioContext: () => context,
    createAudioSession: () => session,
  });
  await f.connect();

  assert.deepEqual(
    order,
    ['addModule', 'startInput'],
    'the worklet module loads before capture starts',
  );
  assert.deepEqual(context.modules, [PCM_CAPTURE_MODULE_URL]);
  assert.ok(session.started, 'session input started');
  assert.deepEqual(session.stream, { id: 'mic' });
});

test('microphone chunks are sent as realtimeInput 16 kHz PCM after setup', async () => {
  const f = createHarness();
  const socket = await f.connect();
  const session = f.sessions.at(-1);

  session.onChunk(AUDIO_CHUNK);
  assert.equal(socket.sent.length, 2, 'setup, then the mic chunk');
  assert.ok(socket.sent[0].setup, 'setup remains the first message');
  assert.equal(socket.sent[0].setup.model, `models/${DEFAULT_SERVED_MODEL}`);
  assert.deepEqual(socket.sent[1], {
    realtimeInput: {
      audio: { data: AUDIO_CHUNK, mimeType: 'audio/pcm;rate=16000' },
    },
  });
});

test('mic chunks captured through the real GeminiPcmAudioSession reach the wire as 16 kHz PCM', async () => {
  const listeners = new Map();
  const workletNode = {
    port: {
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
      post(type, event) {
        for (const fn of listeners.get(type) ?? []) fn(event);
      },
    },
    connect() {},
    disconnect() {},
  };
  const context = createAudioContextFake({ sampleRate: 48000 });
  const f = createHarness({
    createAudioContext: () => context,
    createAudioSession: (audioContext) =>
      new GeminiPcmAudioSession({
        audioContext,
        createWorkletNode: () => workletNode,
      }),
  });
  const socket = await f.connect();
  assert.deepEqual(context.modules, [PCM_CAPTURE_MODULE_URL]);

  const samples = Float32Array.from([0.5, -0.25, 0.75, -0.9, 0.1, -0.6, 0.33]);
  workletNode.port.post('message', { data: { type: 'pcm', samples } });

  const expected = pcm16ToBase64(
    float32ToPcm16(resampleMono(samples, 48000, 16000)),
  );
  assert.deepEqual(socket.sent.at(-1), {
    realtimeInput: {
      audio: { data: expected, mimeType: 'audio/pcm;rate=16000' },
    },
  });
});

// ---------------------------------------------------------------------------
// Server event normalization
// ---------------------------------------------------------------------------

test('modelTurn inlineData audio is enqueued for playback and reports activity once per turn', async () => {
  const f = createHarness();
  const socket = await f.connect();
  const session = f.sessions.at(-1);

  socket.message({
    serverContent: {
      modelTurn: {
        parts: [
          {
            inlineData: { data: AUDIO_CHUNK, mimeType: 'audio/pcm;rate=24000' },
          },
        ],
      },
    },
  });
  socket.message({
    serverContent: {
      modelTurn: {
        parts: [
          {
            inlineData: { data: AUDIO_CHUNK, mimeType: 'audio/pcm;rate=24000' },
          },
        ],
      },
    },
  });

  assert.deepEqual(session.enqueued, [AUDIO_CHUNK, AUDIO_CHUNK]);
  assert.deepEqual(f.callbacks.assistantAudio, [AUDIO_CHUNK, AUDIO_CHUNK]);
  assert.equal(
    f.callbacks.assistantTurnStarts,
    1,
    'turn start reported once per model turn',
  );
});

test('a tool-only turn (no audio part) reports its turn start', async () => {
  const f = createHarness({
    runner: async () => ({ ok: true }),
  });
  const socket = await f.connect();

  socket.message({
    toolCall: { functionCalls: [{ id: 't1', name: 'fly_to', args: {} }] },
  });
  await flush();

  assert.equal(
    f.callbacks.assistantTurnStarts,
    1,
    'a turn whose only output is a tool call still begins',
  );
});

test('a completing client text turn resets an older assistant turn before tool-only output', async () => {
  const calls = [];
  const f = createHarness({
    runner: async (name) => {
      calls.push(name);
      return { ok: true };
    },
  });
  const socket = await f.connect();
  socket.message({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: AUDIO_CHUNK } }] },
    },
  });
  assert.equal(f.callbacks.assistantTurnStarts, 1, 'old turn started');

  f.transport.sendText('fly to Tokyo');
  socket.message({
    toolCall: { functionCalls: [{ id: 't2', name: 'fly_to', args: {} }] },
  });
  await flush();

  assert.equal(f.callbacks.assistantTurnStarts, 2, 'new tool-only turn started');
  assert.deepEqual(calls, ['fly_to']);
});

test('a text-only modelTurn part reports its turn start', async () => {
  const f = createHarness();
  const socket = await f.connect();
  const session = f.sessions.at(-1);

  socket.message({
    serverContent: {
      modelTurn: { parts: [{ text: 'Tokyo, on it.' }] },
    },
  });

  assert.equal(f.callbacks.assistantTurnStarts, 1);
  assert.deepEqual(
    session.enqueued,
    [],
    'no audio part means nothing is scheduled for playback',
  );
});

test('turnComplete closes the assistant turn and a later modelTurn reopens one', async () => {
  const f = createHarness();
  const socket = await f.connect();

  socket.message({ serverContent: { turnComplete: true } });
  assert.equal(f.callbacks.turnCompletes, 1);
  socket.message({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: AUDIO_CHUNK } }] },
    },
  });
  assert.equal(f.callbacks.assistantTurnStarts, 1);
});

test('interrupted clears queued playback and reports the interruption', async () => {
  const f = createHarness();
  const socket = await f.connect();
  const session = f.sessions.at(-1);

  socket.message({ serverContent: { interrupted: true } });

  assert.equal(session.cleared, 1);
  assert.equal(f.callbacks.interrupted, 1);
});

test('usageMetadata is surfaced through onUsage untouched', async () => {
  const f = createHarness();
  const socket = await f.connect();
  const usage = {
    inputTokenCount: 12,
    outputTokenCount: 34,
    totalTokenCount: 46,
  };

  socket.message({
    usageMetadata: usage,
    serverContent: { turnComplete: true },
  });

  assert.deepEqual(f.callbacks.usage, [usage]);
});

test('malformed server messages are ignored without throwing', async () => {
  const f = createHarness();
  const socket = await f.connect();

  socket.rawMessage('not json');
  socket.rawMessage('null');
  socket.rawMessage('"just a string"');
  socket.message({ serverContent: { modelTurn: { parts: 'nope' } } });

  assert.equal(f.callbacks.errors.length, 0);
  assert.equal(f.callbacks.assistantTurnStarts, 0);
});

// ---------------------------------------------------------------------------
// Client content: text and images
// ---------------------------------------------------------------------------

test('sendText sends a clientContent user turn that completes the turn', async () => {
  const f = createHarness();
  const socket = await f.connect();

  f.transport.sendText('show me flights over Austin');
  assert.deepEqual(socket.sent.at(-1), {
    clientContent: {
      turns: [
        { role: 'user', content: [{ text: 'show me flights over Austin' }] },
      ],
      turnComplete: true,
    },
  });
});

test('sendImage sends inline image data as context without completing a turn', async () => {
  const f = createHarness();
  const socket = await f.connect();

  f.transport.sendImage({ mimeType: 'image/jpeg', data: 'aGVsbG8=' });
  assert.deepEqual(socket.sent.at(-1), {
    clientContent: {
      turns: [
        {
          role: 'user',
          content: [
            { inlineData: { mimeType: 'image/jpeg', data: 'aGVsbG8=' } },
          ],
        },
      ],
      turnComplete: false,
    },
  });
});

test('a fatal setup rejection arriving before start() resolves is not lost', async () => {
  const f = createHarness();
  const starting = f.transport.start({ modelChoice: 'gemini-2.5' });
  await new Promise((resolve) => setImmediate(resolve));
  const socket = f.sockets.at(-1);

  // The server can speak first: a rejected setup closes the socket while our
  // own start() is still between the open handshake and its audio wiring.
  socket.open();
  socket.message({
    error: { code: 400, message: 'invalid setup payload' },
  });

  await assert.rejects(starting, /invalid setup payload/);
  assert.equal(
    f.callbacks.errors.length,
    0,
    'the start rejection owns connect-time failures (no duplicate onError)',
  );
});

test('client content before the socket opens is refused, not queued', async () => {
  const f = createHarness();
  const starting = f.transport.start({ modelChoice: 'gemini-2.5' });
  await new Promise((resolve) => setImmediate(resolve));
  const socket = f.sockets.at(-1);
  assert.equal(f.transport.sendText('early'), false);
  socket.open();
  await starting;
  assert.deepEqual(
    socket.sent.filter((m) => m.clientContent),
    [],
  );
});

test('sendToolResponse preserves function responses unchanged on the wire', async () => {
  const f = createHarness();
  const socket = await f.connect();
  const responses = [
    {
      id: 'call-1',
      name: 'get_current_view_state',
      response: { ok: true, zoom: 12 },
    },
  ];

  assert.equal(f.transport.sendToolResponse(responses), true);
  assert.deepEqual(socket.sent.at(-1), {
    toolResponse: { functionResponses: responses },
  });
});

// ---------------------------------------------------------------------------
// Tool bridge
// ---------------------------------------------------------------------------

test('a single function call dispatches the runner and returns its result in a toolResponse', async () => {
  const calls = [];
  const f = createHarness({
    runner: async (name, args) => {
      calls.push({ name, args });
      return { ok: true, action: 'get_current_view_state', zoom: 9 };
    },
  });
  const socket = await f.connect();

  socket.message({
    toolCall: {
      functionCalls: [
        { id: 'c1', name: 'get_current_view_state', args: { detailed: true } },
      ],
    },
  });
  await flush();

  assert.deepEqual(calls, [
    { name: 'get_current_view_state', args: { detailed: true } },
  ]);
  assert.deepEqual(socket.sent.at(-1), {
    toolResponse: {
      functionResponses: [
        {
          id: 'c1',
          name: 'get_current_view_state',
          response: { ok: true, action: 'get_current_view_state', zoom: 9 },
        },
      ],
    },
  });
  assert.deepEqual(f.callbacks.statuses, [
    { status: 'executing', detail: 'Running command' },
    { status: 'listening', detail: 'Ask or command' },
  ]);
  assert.deepEqual(f.callbacks.toolResults, [
    { ok: true, action: 'get_current_view_state', zoom: 9 },
  ]);
});

test('the runner receives a per-call abort signal and an isCurrent predicate', async () => {
  let observed = null;
  const f = createHarness({
    runner: async (_name, _args, options) => {
      observed = options;
      return { ok: true };
    },
  });
  const socket = await f.connect();

  socket.message({
    toolCall: { functionCalls: [{ id: 'c1', name: 'x', args: {} }] },
  });
  await flush();

  assert.ok(observed.signal, 'abort signal supplied');
  assert.equal(typeof observed.isCurrent, 'function');
  assert.equal(observed.isCurrent(), true, 'current while the call runs');
  f.transport.stop('test');
  assert.equal(observed.isCurrent(), false, 'stale after stop');
});

test('multiple calls in one event run concurrently and answer in order', async () => {
  const started = [];
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const f = createHarness({
    runner: async (name) => {
      started.push(name);
      const gate = gates[started.length - 1];
      await gate.promise;
      return { ok: true, action: name };
    },
  });
  const socket = await f.connect();

  const dispatch = (async () => {
    socket.message({
      toolCall: {
        functionCalls: [
          { id: 'a', name: 'first_tool', args: {} },
          { id: 'b', name: 'second_tool', args: {} },
        ],
      },
    });
  })();
  await flush();
  assert.deepEqual(
    started,
    ['first_tool', 'second_tool'],
    'both calls started before either resolved',
  );

  gates[0].resolve({ ok: true });
  await flush();
  assert.equal(
    socket.sent.filter((m) => m.toolResponse).length,
    0,
    'no response until every call settles',
  );
  gates[1].resolve({ ok: true });
  await dispatch;
  await flush();

  const responses = socket.sent.filter((m) => m.toolResponse).at(-1)
    .toolResponse.functionResponses;
  assert.deepEqual(
    responses.map((r) => r.name),
    ['first_tool', 'second_tool'],
  );
  assert.deepEqual(
    responses.map((r) => r.response.action),
    ['first_tool', 'second_tool'],
  );
});

test('duplicate call IDs are deduplicated to one dispatch and one response', async () => {
  const calls = [];
  const f = createHarness({
    runner: async (name) => {
      calls.push(name);
      return { ok: true };
    },
  });
  const socket = await f.connect();
  const event = {
    toolCall: { functionCalls: [{ id: 'same', name: 'tool_x', args: {} }] },
  };

  socket.message(event);
  await flush();
  socket.message(event);
  await flush();

  assert.deepEqual(calls, ['tool_x']);
  assert.equal(socket.sent.filter((m) => m.toolResponse).length, 1);
});

test('the processed-call dedupe memory expires old IDs', async () => {
  const calls = [];
  let clock = 0;
  const f = createHarness({
    now: () => clock,
    runner: async (name) => {
      calls.push(name);
      return { ok: true };
    },
  });
  const socket = await f.connect();
  const event = {
    toolCall: { functionCalls: [{ id: 'reused-id', name: 'tool_x', args: {} }] },
  };

  socket.message(event);
  await flush();
  clock += CALL_DEDUPE_MS + 1;
  socket.message(event);
  await flush();

  assert.deepEqual(
    calls,
    ['tool_x', 'tool_x'],
    'the old dedupe entry expired so the later call could dispatch',
  );
  assert.equal(socket.sent.filter((m) => m.toolResponse).length, 2);
});

test('the processed-call dedupe memory evicts the oldest ID at its hard ceiling', async () => {
  const calls = [];
  const f = createHarness({
    runner: async (_name, args) => {
      calls.push(args.index);
      return { ok: true };
    },
  });
  const socket = await f.connect();
  const batch = Array.from({ length: 65 }, (_, index) => ({
    id: `dense-${index}`,
    name: 'tool_x',
    args: { index },
  }));

  socket.message({ toolCall: { functionCalls: batch } });
  await flush();
  socket.message({
    toolCall: {
      functionCalls: [{ id: 'dense-0', name: 'tool_x', args: { index: 0 } }],
    },
  });
  await flush();

  assert.equal(
    calls.length,
    66,
    'the oldest ID was evicted, so reusing it dispatches again',
  );
});

test('malformed arguments are normalized and malformed calls still get a terminal response', async () => {
  const calls = [];
  const f = createHarness({
    runner: async (name, args) => {
      calls.push({ name, args });
      return { ok: true };
    },
  });
  const socket = await f.connect();

  socket.message({
    toolCall: {
      functionCalls: [
        { id: 'bad-json', name: 'tool_a', args: '{not json' },
        { id: 'array-args', name: 'tool_b', args: [1, 2] },
        { id: 'no-name', args: {} },
      ],
    },
  });
  await flush();

  assert.deepEqual(
    calls.map((c) => c.args),
    [{}, {}],
    'unparseable args become {} and dispatch continues',
  );
  const responses = socket.sent.filter((m) => m.toolResponse).at(-1)
    .toolResponse.functionResponses;
  assert.equal(responses.length, 3, 'every received call is answered');
  const nameless = responses.find((r) => r.id === 'no-name');
  assert.equal(nameless.response.ok, false);
  assert.match(nameless.response.error, /missing name/i);
  assert.equal(nameless.name, '');
});

test('stale calls are refused without dispatch and answered terminally', async () => {
  const calls = [];
  const f = createHarness({
    isCurrent: () => false,
    runner: async (name) => {
      calls.push(name);
      return { ok: true };
    },
  });
  const socket = await f.connect();

  socket.message({
    toolCall: { functionCalls: [{ id: 'stale', name: 'tool_z', args: {} }] },
  });
  await flush();

  assert.deepEqual(calls, [], 'stale call never dispatched');
  const responses = socket.sent.filter((m) => m.toolResponse).at(-1)
    .toolResponse.functionResponses;
  assert.equal(responses[0].response.ok, false);
  assert.equal(responses[0].response.stale, true);
  assert.equal(
    f.callbacks.statuses.filter((s) => s.status === 'executing').length,
    0,
  );
});

test('a runner rejection becomes a terminal error response, not a dropped call', async () => {
  const f = createHarness({
    runner: async () => {
      throw new Error('layer unavailable');
    },
  });
  const socket = await f.connect();

  socket.message({
    toolCall: { functionCalls: [{ id: 'boom', name: 'tool_q', args: {} }] },
  });
  await flush();

  const responses = socket.sent.filter((m) => m.toolResponse).at(-1)
    .toolResponse.functionResponses;
  assert.equal(responses[0].response.ok, false);
  assert.equal(responses[0].response.error, 'layer unavailable');
});

test('a non-JSON-serializable result is replaced with a terminal placeholder', async () => {
  const circular = {};
  circular.self = circular;
  const f = createHarness({
    runner: async () => circular,
  });
  const socket = await f.connect();

  socket.message({
    toolCall: { functionCalls: [{ id: 'c', name: 'tool_c', args: {} }] },
  });
  await flush();

  const responses = socket.sent.filter((m) => m.toolResponse).at(-1)
    .toolResponse.functionResponses;
  assert.equal(responses[0].response.ok, false);
  assert.match(responses[0].response.error, /not JSON-serializable/i);
});

test('abortTools() cancels in-flight calls without closing the session', async () => {
  let signal = null;
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = createHarness({
    runner: async (_name, _args, options) => {
      signal = options.signal;
      await gate;
      return { ok: false, stale: true };
    },
  });
  const socket = await f.connect();
  socket.message({
    toolCall: { functionCalls: [{ id: 'old', name: 'slow_tool', args: {} }] },
  });
  await flush();

  f.transport.abortTools('new-user-turn');

  assert.equal(signal.aborted, true, 'the old tool received an abort');
  assert.equal(f.transport.readyState, 'open', 'the voice session stays open');
  release();
  await flush();
});

test('stop() aborts in-flight tool calls and skips their responses once closed', async () => {
  let signal = null;
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = createHarness({
    runner: async (_name, _args, options) => {
      signal = options.signal;
      await gate;
      return { ok: true };
    },
  });
  const socket = await f.connect();

  socket.message({
    toolCall: { functionCalls: [{ id: 'long', name: 'slow_tool', args: {} }] },
  });
  await flush();
  f.transport.stop('test');
  assert.equal(signal.aborted, true, 'stop aborts the running call');
  release();
  await flush();

  assert.equal(
    socket.sent.filter((m) => m.toolResponse).length,
    0,
    'closed socket sends nothing',
  );
});

test('onAfterToolResponses receives the raw results after responses are sent', async () => {
  const f = createHarness({
    runner: async () => ({ ok: true, action: 'get_entity_context' }),
  });
  const socket = await f.connect();

  socket.message({
    toolCall: {
      functionCalls: [{ id: 'v', name: 'get_entity_context', args: {} }],
    },
  });
  await flush();

  assert.equal(f.callbacks.afterToolResponses.length, 1);
  assert.equal(
    f.callbacks.afterToolResponses[0][0].action,
    'get_entity_context',
  );
  assert.ok(socket.sent.some((m) => m.toolResponse));
});

// ---------------------------------------------------------------------------
// Close, error, expiry, and teardown
// ---------------------------------------------------------------------------

test('an unexpected server close is a fatal error and tears the session down', async () => {
  const f = createHarness();
  const socket = await f.connect();
  const session = f.sessions.at(-1);

  socket.serverClose(1006, 'token expired');

  assert.equal(f.callbacks.errors.length, 1);
  assert.equal(f.callbacks.errors[0].info.fatal, true);
  assert.match(f.callbacks.errors[0].error.message, /closed/i);
  assert.equal(session.stopped, true);
  assert.equal(f.transport.readyState, 'closed');
  assert.equal(f.callbacks.states.at(-1)?.phase, 'closed');
});

test('a socket error before open rejects start() without invoking onError', async () => {
  const f = createHarness();
  const starting = f.transport.start({ modelChoice: 'gemini-2.5' });
  await new Promise((resolve) => setImmediate(resolve));
  const socket = f.sockets.at(-1);

  socket.fail(new Error('dns'));
  socket.serverClose(1006, 'dns');
  await assert.rejects(starting, /closed before the session opened|dns/i);
  assert.equal(f.callbacks.errors.length, 0);
  assert.equal(f.transport.readyState, 'closed');
});

test('goAway is treated as a fatal session-expiry error', async () => {
  const f = createHarness();
  const socket = await f.connect();

  socket.message({ goAway: { reason: 'quota' } });

  assert.equal(f.callbacks.errors.length, 1);
  assert.equal(f.callbacks.errors[0].info.fatal, true);
  assert.equal(f.callbacks.errors[0].info.code, 'go_away');
});

test('a server error message is fatal and sanitized', async () => {
  const f = createHarness();
  const socket = await f.connect();

  socket.message({ error: { code: 400, message: 'invalid setup payload' } });

  assert.equal(f.callbacks.errors.length, 1);
  assert.equal(f.callbacks.errors[0].info.fatal, true);
  assert.equal(f.callbacks.errors[0].error.message, 'invalid setup payload');
});

test('stop(reason) closes the socket, stops audio, closes the context, and is idempotent', async () => {
  const f = createHarness();
  const socket = await f.connect();
  const session = f.sessions.at(-1);
  const context = f.contextPool[0];
  const states = [];
  f.callbacks.states.length = 0;

  f.transport.stop('controller.stop');
  f.transport.stop('controller.stop');

  assert.deepEqual(socket.closeCalls, [
    { code: 1000, reason: 'controller.stop' },
  ]);
  assert.equal(session.stopped, true);
  assert.equal(context.closed, true);
  assert.equal(
    f.callbacks.states.filter((s) => s.phase === 'closed').length,
    1,
  );
  assert.equal(f.transport.readyState, 'closed');
});

test('messages and mic chunks after stop are ignored', async () => {
  const f = createHarness();
  const socket = await f.connect();
  const session = f.sessions.at(-1);
  f.transport.stop('test');
  session.onChunk(AUDIO_CHUNK);
  socket.message({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { data: AUDIO_CHUNK } }] },
    },
  });

  assert.equal(f.callbacks.assistantTurnStarts, 0);
  assert.deepEqual(session.enqueued, []);
  assert.equal(socket.sent.filter((m) => m.realtimeInput).length, 0);
});

test('token-bearing URLs never reach the log stream', async () => {
  const f = createHarness({
    fetchImpl: async () => tokenResponse({ token: 'SECRET-Ephemeral-Token' }),
  });
  const socket = await f.connect({ modelChoice: 'gemini-2.5' });
  socket.serverClose(1006, 'boom');
  f.transport.stop('test');

  const serialized =
    JSON.stringify(f.callbacks.logs) +
    JSON.stringify(
      f.callbacks.errors.map((e) => ({
        message: e.error.message,
        info: e.info,
      })),
    );
  assert.equal(serialized.includes('SECRET-Ephemeral-Token'), false);
});

test('a missing audioWorklet capability rejects start() descriptively', async () => {
  const context = createAudioContextFake();
  delete context.audioWorklet;
  const f = createHarness({ createAudioContext: () => context });
  const starting = f.transport.start({ modelChoice: 'gemini-2.5' });
  await new Promise((resolve) => setImmediate(resolve));
  f.sockets.at(-1).open();
  await assert.rejects(starting, /audioWorklet/i);
});

// ---------------------------------------------------------------------------
// Gemini cost tracker — dollars are unavailable, usage is diagnostic
// ---------------------------------------------------------------------------

test('the Gemini cost tracker reports unavailable dollars without applying OpenAI rates', () => {
  const tracker = createGeminiVoiceCostTracker({
    modelId: 'gemini-3.1-flash-live-preview',
    limits: { warnUsd: 2, capUsd: 5 },
  });
  const before = tracker.state();
  assert.equal(before.costAvailable, false);
  assert.equal(before.provider, 'gemini');
  assert.equal(before.modelId, 'gemini-3.1-flash-live-preview');
  assert.equal(before.totalUsd, 0);
  assert.equal(before.capReached, false);

  const after = tracker.record({ inputTokenCount: 10, outputTokenCount: 20 });
  assert.equal(after.totalUsd, 0);
  assert.equal(after.capReached, false);
  assert.equal(after.responses, 1);
  assert.deepEqual(after.usage, { inputTokenCount: 10, outputTokenCount: 20 });
  assert.notEqual(after.display, '~$0.00');
  tracker.markIncomplete();
  assert.equal(tracker.state().incomplete, false);
});

test('the Gemini cost tracker falls back to the registry default model', () => {
  const state = createGeminiVoiceCostTracker().state();
  assert.equal(state.modelId, DEFAULT_SERVED_MODEL);
});
