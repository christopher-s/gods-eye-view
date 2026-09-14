import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  float32ToPcm16,
  resampleMono,
  pcm16ToBase64,
  base64ToPcm16,
  GeminiPcmAudioSession,
  PCM_CAPTURE_MODULE_URL,
  GEMINI_INPUT_SAMPLE_RATE,
  GEMINI_OUTPUT_SAMPLE_RATE,
} from './geminiAudio.js';

// ---------------------------------------------------------------------------
// Pure conversion functions
// ---------------------------------------------------------------------------

test('float32ToPcm16 clamps overshoot to the signed 16-bit range', () => {
  const pcm = float32ToPcm16([-2, -1, -0.5, 0, 0.5, 1, 2]);
  assert.ok(pcm instanceof Int16Array);
  assert.deepEqual([...pcm], [-32768, -32768, -16384, 0, 16384, 32767, 32767]);
});

test('float32ToPcm16 maps non-finite samples to safe values', () => {
  // NaN must never leak into PCM output; infinities clamp.
  assert.deepEqual(
    [...float32ToPcm16([NaN, Infinity, -Infinity])],
    [0, 32767, -32768],
  );
});

test('float32ToPcm16 emits little-endian PCM bytes for known values', () => {
  const pcm = float32ToPcm16([0, 1, -1, 0.25, -0.25]);
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  // 0 -> 0x0000, 1 -> 0x7FFF, -1 -> 0x8000, 0.25 -> 0x2000, -0.25 -> 0xE000
  assert.deepEqual(
    [...bytes],
    [0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x00, 0x20, 0x00, 0xe0],
  );
});

test('float32ToPcm16 accepts empty input and plain arrays', () => {
  assert.deepEqual([...float32ToPcm16([])], []);
  const fromArray = [...float32ToPcm16([0.5, -0.5])];
  const fromTyped = [...float32ToPcm16(Float32Array.of(0.5, -0.5))];
  assert.deepEqual(fromArray, fromTyped);
});

test('pcm16ToBase64 encodes known little-endian fixtures', () => {
  // Fixtures generated with Node Buffer for cross-validation.
  assert.equal(pcm16ToBase64([]), '');
  assert.equal(pcm16ToBase64([0]), 'AAA=');
  assert.equal(pcm16ToBase64([258]), 'AgE=');
  assert.equal(pcm16ToBase64([-32768, 32767]), 'AID/fw==');
  assert.equal(pcm16ToBase64([0, -16384]), 'AAAAwA==');
  assert.equal(pcm16ToBase64([0, 16384, -32768]), 'AAAAQACA');
  assert.equal(pcm16ToBase64(new Int16Array([0, 8192])), 'AAAAIA==');
});

test('base64ToPcm16 decodes known fixtures to signed little-endian PCM', () => {
  assert.deepEqual([...base64ToPcm16('')], []);
  assert.deepEqual([...base64ToPcm16('AAA=')], [0]);
  assert.deepEqual([...base64ToPcm16('AgE=')], [258]);
  assert.deepEqual([...base64ToPcm16('AID/fw==')], [-32768, 32767]);
  assert.deepEqual([...base64ToPcm16('AAAAQACA')], [0, 16384, -32768]);
  assert.ok(base64ToPcm16('AAA=') instanceof Int16Array);
});

test('pcm16ToBase64 and base64ToPcm16 round trip across the full range', () => {
  const samples = new Int16Array([
    -32768, -32767, -258, -1, 0, 1, 255, 256, 258, 16384, 32766, 32767,
  ]);
  assert.deepEqual([...base64ToPcm16(pcm16ToBase64(samples))], [...samples]);
});

test('float32ToPcm16, pcm16ToBase64, and base64ToPcm16 round trip', () => {
  const floats = Float32Array.of(0, 0.25, -0.25, 0.5, -0.5, 1, -1);
  const pcm = float32ToPcm16(floats);
  assert.deepEqual([...base64ToPcm16(pcm16ToBase64(pcm))], [...pcm]);
});

test('base64ToPcm16 rejects malformed input', () => {
  for (const value of [
    'A', // length not a multiple of 4
    'AAA', // length not a multiple of 4
    'AAAAA', // length not a multiple of 4
    'A===', // three padding characters
    'AA=A', // interior padding
    '====', // no data
    '!!!!', // invalid characters
    'AA==', // decodes to one byte: odd byte count
    ' AAAA', // whitespace is not tolerated
    'AAAA ', // trailing whitespace is not tolerated
    '=AAA', // leading padding
  ]) {
    assert.throws(
      () => base64ToPcm16(value),
      RangeError,
      `expected rejection for ${JSON.stringify(value)}`,
    );
  }
  for (const value of [undefined, null, 123, {}, []]) {
    assert.throws(() => base64ToPcm16(value), TypeError);
  }
});

test('base64ToPcm16 accepts lowercase standard-alphabet payloads', () => {
  // Gemini Live emits standard base64 whose alphabet includes lowercase.
  assert.equal(base64ToPcm16('aaa=').length, 1);
});

test('resampleMono decimates integer ratios by picking exact source samples', () => {
  // 8000 -> 4000, step 2: outputs are inputs 0 and 2.
  const out = resampleMono([0, 0.5, -0.5, 1], 8000, 4000);
  assert.ok(out instanceof Float32Array);
  assert.deepEqual([...out], [0, -0.5]);
});

test('resampleMono covers an odd input length without inventing trailing samples', () => {
  // 8000 -> 4000, 5 inputs -> ceil(5/2) = 3 outputs at positions 0, 2, 4.
  const out = resampleMono([0, 0.25, 0.5, 0.75, 1], 8000, 4000);
  assert.deepEqual([...out], [0, 0.5, 1]);
});

test('resampleMono interpolates fractionally positioned outputs deterministically', () => {
  // 12000 -> 8000, step 1.5: positions 0, 1.5, 3 with exact binary fractions.
  const out = resampleMono([0, 0.25, 0.5, 0.75], 12000, 8000);
  assert.deepEqual([...out], [0, 0.375, 0.75]);
});

test('resampleMono upsamples by holding the final sample at the boundary', () => {
  // 8000 -> 16000, step 0.5: 8 outputs, the last holds the final input sample.
  const out = resampleMono([0, 0.25, 0.5, 0.75], 8000, 16000);
  assert.deepEqual([...out], [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.75]);
});

test('resampleMono returns a copy when rates match', () => {
  const input = Float32Array.of(0.25, -0.75, 0.5);
  const out = resampleMono(input, 16000, 16000);
  assert.deepEqual([...out], [...input]);
  assert.notEqual(out, input);
  input[0] = 1;
  assert.equal(out[0], 0.25);
});

test('resampleMono handles empty input for matching and differing rates', () => {
  assert.deepEqual([...resampleMono([], 48000, 16000)], []);
  assert.deepEqual([...resampleMono([], 16000, 16000)], []);
});

test('resampleMono rejects invalid rates', () => {
  for (const rates of [
    [0, 16000],
    [48000, 0],
    [-48000, 16000],
    [48000, -16000],
    [NaN, 16000],
    [48000, NaN],
    [Infinity, 16000],
    [48000, Infinity],
    ['48000', 16000],
    [48000, '16000'],
    [undefined, 16000],
  ]) {
    assert.throws(() => resampleMono([0.5], rates[0], rates[1]), TypeError);
  }
});

// ---------------------------------------------------------------------------
// Web Audio fakes
// ---------------------------------------------------------------------------

/** Minimal deterministic AudioBuffer fake. */
class FakeAudioBuffer {
  constructor({ numberOfChannels, length, sampleRate }) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = [];
    for (let i = 0; i < numberOfChannels; i += 1) {
      this.channels.push(new Float32Array(length));
    }
  }

  getChannelData(channel) {
    return this.channels[channel];
  }
}

/** Records scheduling calls so tests can assert contiguous timing. */
class FakeBufferSource {
  constructor(registry) {
    this.registry = registry;
    this.buffer = null;
    this.startCalls = [];
    this.stopCalls = 0;
    this.onended = null;
    this.connectTargets = [];
    this.disconnected = false;
    registry.all.push(this);
  }

  connect(destination) {
    this.connectTargets.push(destination);
    return destination;
  }

  disconnect() {
    this.disconnected = true;
  }

  start(when) {
    this.startCalls.push(when);
    this.registry.starts.push(when);
  }

  stop() {
    this.stopCalls += 1;
  }
}

/**
 * Fake context whose createBuffer honours a subset of the two Web Audio
 * overloads, mirroring real host divergence: Chrome 153 rejects the
 * AudioBufferOptions dictionary form; hypothetical dictionary-only hosts
 * reject the positional form.
 *
 * @param {object} [options]
 * @param {number} [options.currentTime=0]
 * @param {number} [options.sampleRate=48000]
 * @param {Array<'positional'|'object'>} [options.createBufferForms] overloads to accept
 */
function createFakeContext({
  currentTime = 0,
  sampleRate = 48000,
  createBufferForms = ['positional', 'object'],
} = {}) {
  const state = { currentTime };
  const createdBuffers = [];
  const createBufferCalls = [];
  const context = {
    sampleRate,
    get currentTime() {
      return state.currentTime;
    },
    destination: { toString: () => 'destination' },
    createBuffer(numberOfChannels, length, bufferSampleRate) {
      if (arguments.length === 1) {
        if (!createBufferForms.includes('object')) {
          // Chrome 153 rejects the dictionary overload verbatim.
          throw new TypeError(
            "Failed to execute 'createBuffer' on 'BaseAudioContext': 3 arguments required, but only 1 present.",
          );
        }
        createBufferCalls.push('object');
        const buffer = new FakeAudioBuffer(numberOfChannels);
        createdBuffers.push(buffer);
        return buffer;
      }
      if (!createBufferForms.includes('positional')) {
        throw new TypeError(
          "Failed to execute 'createBuffer' on 'BaseAudioContext': no overload matched the provided arguments.",
        );
      }
      createBufferCalls.push('positional');
      const buffer = new FakeAudioBuffer({
        numberOfChannels,
        length,
        sampleRate: bufferSampleRate,
      });
      createdBuffers.push(buffer);
      return buffer;
    },
    createGain() {
      return {
        gain: { value: 1 },
        connectTargets: [],
        connect(target) {
          this.connectTargets.push(target);
          return target;
        },
        disconnect() {
          this.disconnected = true;
        },
      };
    },
    createMediaStreamSource(stream) {
      return {
        stream,
        connectTargets: [],
        connect(target) {
          this.connectTargets.push(target);
          return target;
        },
        disconnect() {
          this.disconnected = true;
        },
      };
    },
  };
  context.__state = state;
  context.__createdBuffers = createdBuffers;
  context.__createBufferCalls = createBufferCalls;
  return context;
}

function createFakeWorkletHost() {
  const listeners = new Map();
  const host = {
    connectTargets: [],
    disconnectCalls: 0,
    port: {
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      removeEventListener(type, handler) {
        const list = listeners.get(type) ?? [];
        const index = list.indexOf(handler);
        if (index !== -1) list.splice(index, 1);
      },
      __emit(message) {
        for (const handler of [...(listeners.get('message') ?? [])]) {
          handler({ data: message });
        }
      },
    },
    connect(target) {
      this.connectTargets.push(target);
      return target;
    },
    disconnect() {
      this.disconnectCalls += 1;
    },
  };
  host.__listeners = listeners;
  return host;
}

function fakeMediaStream(trackCount = 1) {
  const stopped = [];
  const audioTracks = [];
  for (let i = 0; i < trackCount; i += 1) {
    audioTracks.push({
      stop() {
        stopped.push(`audio-${i}`);
      },
    });
  }
  const videoTrack = {
    stop() {
      stopped.push('video-0');
    },
  };
  return {
    stopped,
    getAudioTracks: () => audioTracks,
    getVideoTracks: () => [videoTrack],
  };
}

/** Load the real worklet file into a sandbox with fake worklet globals. */
function loadWorkletProcessor({ sampleRate = 48000 } = {}) {
  const workletPath = fileURLToPath(
    new URL('../../public/audio-worklets/gev-pcm-capture.js', import.meta.url),
  );
  const source = readFileSync(workletPath, 'utf8');
  const posted = [];
  const registered = [];
  const sandbox = {
    // Host Float32Array so cross-realm instanceof works in assertions.
    Float32Array,
    sampleRate,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          postMessage: (message) => posted.push(message),
        };
      }
    },
    registerProcessor: (name, processorClass) =>
      registered.push({ name, processorClass }),
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { posted, registered };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('module exposes the Gemini Live sample rates and worklet module url', () => {
  assert.equal(GEMINI_INPUT_SAMPLE_RATE, 16000);
  assert.equal(GEMINI_OUTPUT_SAMPLE_RATE, 24000);
  assert.equal(PCM_CAPTURE_MODULE_URL, '/audio-worklets/gev-pcm-capture.js');
});

// ---------------------------------------------------------------------------
// Input capture
// ---------------------------------------------------------------------------

test('startInput frames worklet audio at 16 kHz and emits base64 PCM16 chunks', async () => {
  const context = createFakeContext({ sampleRate: 48000 });
  const workletHost = createFakeWorkletHost();
  const session = new GeminiPcmAudioSession({
    audioContext: context,
    createWorkletNode: () => workletHost,
  });

  const chunks = [];
  await session.startInput((chunk) => chunks.push(chunk));

  // 480 samples at 48 kHz resample to exactly 160 samples at 16 kHz.
  const frameA = Float32Array.from({ length: 480 }, (_, i) =>
    i % 2 === 0 ? 0.5 : -0.5,
  );
  workletHost.port.__emit({ type: 'pcm', samples: frameA });
  const frameB = Float32Array.from({ length: 480 }, () => 0.25);
  workletHost.port.__emit({ type: 'pcm', samples: frameB });

  assert.equal(chunks.length, 2);
  const decoded = base64ToPcm16(chunks[0]);
  assert.equal(decoded.length, 160);
  // Position i in the output reads source position i * 3.
  assert.equal(decoded[0], 16384);
  assert.equal(decoded[1], -16384);
  assert.deepEqual([...base64ToPcm16(chunks[1])].slice(0, 2), [8192, 8192]);
  await session.stop();
});

test('startInput resamples non-integer rate ratios to 16 kHz', async () => {
  const context = createFakeContext({ sampleRate: 44100 });
  const workletHost = createFakeWorkletHost();
  const session = new GeminiPcmAudioSession({
    audioContext: context,
    createWorkletNode: () => workletHost,
  });
  const chunks = [];
  await session.startInput((chunk) => chunks.push(chunk));
  // 441 samples at 44.1 kHz = 10 ms = 160 samples at 16 kHz.
  workletHost.port.__emit({
    type: 'pcm',
    samples: Float32Array.from({ length: 441 }, () => 0),
  });
  assert.equal(chunks.length, 1);
  assert.equal(base64ToPcm16(chunks[0]).length, 160);
  await session.stop();
});

test('startInput requires a context and rejects when the worklet factory fails', async () => {
  assert.throws(() => new GeminiPcmAudioSession({}), TypeError);
  const context = createFakeContext();
  const session = new GeminiPcmAudioSession({
    audioContext: context,
    createWorkletNode: () => {
      throw new Error('worklet unavailable');
    },
  });
  await assert.rejects(
    session.startInput(() => {}),
    /worklet unavailable/,
  );
  // Stopping after a failed start stays safe.
  session.stop();
});

test('startInput wires stream -> worklet -> zero-gain sink and ignores foreign messages', async () => {
  const context = createFakeContext({ sampleRate: 48000 });
  const workletHost = createFakeWorkletHost();
  const stream = fakeMediaStream(2);
  const session = new GeminiPcmAudioSession({
    audioContext: context,
    createWorkletNode: () => workletHost,
  });
  const chunks = [];
  const captureSource = await new Promise((resolve) => {
    const original = context.createMediaStreamSource;
    context.createMediaStreamSource = (mediaStream) => {
      const node = original(mediaStream);
      resolve(node);
      return node;
    };
    return session.startInput((chunk) => chunks.push(chunk), stream);
  });

  assert.equal(captureSource.connectTargets[0], workletHost);
  assert.equal(workletHost.connectTargets[0].gain.value, 0);
  assert.equal(
    workletHost.connectTargets[0].connectTargets[0],
    context.destination,
  );

  // Non-PCM messages never produce chunks.
  workletHost.port.__emit({ type: 'metadata' });
  workletHost.port.__emit(null);
  workletHost.port.__emit({ type: 'pcm', samples: [] });
  assert.equal(chunks.length, 0);

  await session.stop();
  // No chunks after stop even if a late message arrives.
  workletHost.port.__emit({
    type: 'pcm',
    samples: Float32Array.from({ length: 480 }, () => 0.5),
  });
  assert.equal(chunks.length, 0);
});

test('stop stops audio tracks, disconnects capture nodes, and is idempotent', async () => {
  const context = createFakeContext({ sampleRate: 48000 });
  const workletHost = createFakeWorkletHost();
  const stream = fakeMediaStream(2);
  const session = new GeminiPcmAudioSession({
    audioContext: context,
    createWorkletNode: () => workletHost,
  });
  const captureSource = context.createMediaStreamSource(stream);
  const original = context.createMediaStreamSource;
  context.createMediaStreamSource = () => captureSource;
  await session.startInput(() => {}, stream);
  context.createMediaStreamSource = original;

  const sink = workletHost.connectTargets[0];
  session.stop();
  session.stop();

  assert.deepEqual(stream.stopped, ['audio-0', 'audio-1']);
  assert.equal(captureSource.disconnected, true);
  assert.equal(workletHost.disconnectCalls, 1);
  assert.equal(sink.disconnected, true);
  assert.equal(workletHost.__listeners.get('message').length, 0);
});

test('stop without startInput is safe', () => {
  const session = new GeminiPcmAudioSession({
    audioContext: createFakeContext(),
  });
  session.stop();
  session.stop();
});

// ---------------------------------------------------------------------------
// Output scheduling
// ---------------------------------------------------------------------------

test('enqueueOutput decodes 24 kHz PCM16 and schedules chunks contiguously', () => {
  const context = createFakeContext({ sampleRate: 48000, currentTime: 10 });
  const registry = { all: [], starts: [] };
  const session = new GeminiPcmAudioSession({
    audioContext: context,
    createBufferSource: () => new FakeBufferSource(registry),
  });

  const chunkA = pcm16ToBase64(
    Int16Array.from({ length: 240 }, (_, i) => i * 25),
  );
  const chunkB = pcm16ToBase64(Int16Array.from({ length: 480 }, (_, i) => -i));
  session.enqueueOutput(chunkA);
  session.enqueueOutput(chunkB);

  assert.equal(registry.all.length, 2);
  const [sourceA, sourceB] = registry.all;
  assert.deepEqual(sourceA.startCalls, [10]);
  assert.equal(sourceA.buffer.sampleRate, 24000);
  assert.equal(sourceA.buffer.numberOfChannels, 1);
  assert.equal(sourceA.buffer.length, 240);
  // Chunk B follows chunk A with no gap: 10 + 240/24000.
  assert.deepEqual(sourceB.startCalls, [10.01]);
  assert.equal(sourceB.buffer.length, 480);
  assert.equal(sourceB.buffer.sampleRate, 24000);
  assert.equal(sourceA.connectTargets[0], context.destination);
  assert.equal(sourceB.connectTargets[0], context.destination);
  // PCM16 decodes to float by dividing by 32768.
  assert.equal(sourceA.buffer.getChannelData(0)[0], 0);
  assert.equal(sourceA.buffer.getChannelData(0)[1], 25 / 32768);
  assert.equal(sourceB.buffer.getChannelData(0)[1], -1 / 32768);
});

test('enqueueOutput never schedules in the past when the clock runs ahead', () => {
  const context = createFakeContext({ sampleRate: 48000, currentTime: 10 });
  const registry = { all: [], starts: [] };
  const session = new GeminiPcmAudioSession({
    audioContext: context,
    createBufferSource: () => new FakeBufferSource(registry),
  });
  session.enqueueOutput(pcm16ToBase64(new Int16Array(240)));
  // Queue tail is now 10.01, but the clock jumps to 11.
  context.__state.currentTime = 11;
  session.enqueueOutput(pcm16ToBase64(new Int16Array(240)));
  assert.deepEqual(registry.all[1].startCalls, [11]);
});

test('enqueueOutput schedules playback on a context that rejects the createBuffer dictionary overload', () => {
  // Chrome 153 accepts only the positional 3-argument createBuffer; the
  // dictionary (options-object) form throws before any audio can be
  // scheduled, silently zeroing Gemini playback.
  const context = createFakeContext({
    sampleRate: 48000,
    currentTime: 4,
    createBufferForms: ['positional'],
  });
  const registry = { all: [], starts: [] };
  const session = new GeminiPcmAudioSession({
    audioContext: context,
    createBufferSource: () => new FakeBufferSource(registry),
  });

  session.enqueueOutput(pcm16ToBase64(Int16Array.from({ length: 240 }, (_, i) => i)));

  assert.equal(registry.all.length, 1);
  const source = registry.all[0];
  assert.deepEqual(source.startCalls, [4]);
  assert.equal(source.buffer.numberOfChannels, 1);
  assert.equal(source.buffer.length, 240);
  assert.equal(source.buffer.sampleRate, GEMINI_OUTPUT_SAMPLE_RATE);
  assert.equal(source.buffer.getChannelData(0)[1], 1 / 32768);
  // The positional overload was used, never the rejected dictionary form.
  assert.deepEqual(context.__createBufferCalls, ['positional']);
});

test('enqueueOutput falls back to the createBuffer dictionary overload when positional throws', () => {
  // Hypothetical dictionary-only hosts: the positional form throws and the
  // dictionary form must still produce scheduled playback.
  const context = createFakeContext({
    sampleRate: 48000,
    currentTime: 0,
    createBufferForms: ['object'],
  });
  const registry = { all: [], starts: [] };
  const session = new GeminiPcmAudioSession({
    audioContext: context,
    createBufferSource: () => new FakeBufferSource(registry),
  });

  session.enqueueOutput(pcm16ToBase64(Int16Array.from({ length: 120 }, (_, i) => -i)));

  assert.equal(registry.all.length, 1);
  const source = registry.all[0];
  assert.deepEqual(source.startCalls, [0]);
  assert.equal(source.buffer.numberOfChannels, 1);
  assert.equal(source.buffer.length, 120);
  assert.equal(source.buffer.sampleRate, GEMINI_OUTPUT_SAMPLE_RATE);
  assert.equal(source.buffer.getChannelData(0)[1], -1 / 32768);
  // Positional was attempted first, then the dictionary fallback succeeded.
  assert.deepEqual(context.__createBufferCalls, ['object']);
  assert.equal(context.__createdBuffers.length, 1);
});

test('enqueueOutput ignores empty, malformed, and non-string chunks', () => {
  const context = createFakeContext({ currentTime: 0 });
  const registry = { all: [], starts: [] };
  const session = new GeminiPcmAudioSession({
    audioContext: context,
    createBufferSource: () => new FakeBufferSource(registry),
  });
  for (const value of [
    '',
    '!!!',
    'AA==',
    'AAAAA',
    null,
    undefined,
    1234,
    {},
    ['AAAA'],
  ]) {
    session.enqueueOutput(value);
  }
  assert.equal(registry.all.length, 0);
  assert.equal(context.__createdBuffers.length, 0);
});

test('enqueueOutput decodes without touching browser globals', () => {
  const context = createFakeContext({ currentTime: 0 });
  const registry = { all: [], starts: [] };
  const session = new GeminiPcmAudioSession({
    audioContext: context,
    createBufferSource: () => new FakeBufferSource(registry),
  });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'atob');
  Reflect.deleteProperty(globalThis, 'atob');
  try {
    session.enqueueOutput(pcm16ToBase64([1, -2, 3]));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'atob', descriptor);
  }
  assert.equal(registry.all.length, 1);
  assert.equal(registry.all[0].buffer.length, 3);
});

test('enqueueOutput after stop is a no-op', async () => {
  const context = createFakeContext({ currentTime: 0 });
  const registry = { all: [], starts: [] };
  const session = new GeminiPcmAudioSession({
    audioContext: context,
    createBufferSource: () => new FakeBufferSource(registry),
  });
  session.stop();
  session.enqueueOutput(pcm16ToBase64([1, -2]));
  assert.equal(registry.all.length, 0);
  assert.equal(context.__createdBuffers.length, 0);
  session.clearOutput();
});

test('clearOutput cancels queued sources and resets the schedule', () => {
  const context = createFakeContext({ currentTime: 5 });
  const registry = { all: [], starts: [] };
  const session = new GeminiPcmAudioSession({
    audioContext: context,
    createBufferSource: () => new FakeBufferSource(registry),
  });
  session.enqueueOutput(pcm16ToBase64(new Int16Array(240)));
  session.enqueueOutput(pcm16ToBase64(new Int16Array(240)));
  // First source finished on its own and must not be re-cancelled.
  registry.all[0].onended();

  session.clearOutput();

  assert.equal(registry.all[0].stopCalls, 0);
  assert.equal(registry.all[0].disconnected, false);
  assert.equal(registry.all[1].stopCalls, 1);
  assert.equal(registry.all[1].disconnected, true);
  // New audio starts from the current clock, not the cancelled tail.
  session.enqueueOutput(pcm16ToBase64(new Int16Array(240)));
  assert.deepEqual(registry.all[2].startCalls, [5]);
});

// ---------------------------------------------------------------------------
// AudioWorklet processor (real file under a fake worklet global)
// ---------------------------------------------------------------------------

test('worklet registers and posts fixed-size mono frames with remainder carry', () => {
  const { posted, registered } = loadWorkletProcessor({ sampleRate: 48000 });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'gev-pcm-capture');
  const processor = new registered[0].processorClass();

  // Default frame size 4096: 33 render quanta of 128 leave one full frame + 128.
  let sample = 0;
  for (let block = 0; block < 33; block += 1) {
    const channel = new Float32Array(128);
    for (let i = 0; i < channel.length; i += 1) {
      channel[i] = sample;
      sample += 1;
    }
    assert.equal(processor.process([[channel]]), true);
  }
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'pcm');
  assert.ok(posted[0].samples instanceof Float32Array);
  assert.equal(posted[0].samples.length, 4096);
  assert.equal(posted[0].samples[0], 0);
  assert.equal(posted[0].samples[4095], 4095);

  // Feed the remaining 31 quanta to complete a second frame.
  for (let block = 0; block < 31; block += 1) {
    const channel = new Float32Array(128);
    for (let i = 0; i < channel.length; i += 1) {
      channel[i] = sample;
      sample += 1;
    }
    processor.process([[channel]]);
  }
  assert.equal(posted.length, 2);
  // The second frame begins with the carried remainder sample 4096.
  assert.equal(posted[1].samples[0], 4096);
});

test('worklet honors a custom frame size and keeps only the first channel', () => {
  const { posted, registered } = loadWorkletProcessor({ sampleRate: 48000 });
  const processor = new registered[0].processorClass({
    processorOptions: { frameSize: 256 },
  });
  const left = Float32Array.from({ length: 128 }, (_, i) => i);
  const right = Float32Array.from({ length: 128 }, (_, i) => i + 1000);
  processor.process([[left, right]]);
  assert.equal(posted.length, 0);
  processor.process([[left, right]]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].samples.length, 256);
  assert.equal(posted[0].samples[0], 0);
  assert.equal(posted[0].samples[255], 127);
});

test('worklet stays alive through silent blocks without posting', () => {
  const { posted, registered } = loadWorkletProcessor({ sampleRate: 48000 });
  const processor = new registered[0].processorClass({
    processorOptions: { frameSize: 256 },
  });
  assert.equal(processor.process([]), true);
  assert.equal(processor.process([[]]), true);
  assert.equal(processor.process([[new Float32Array(0)]]), true);
  assert.equal(posted.length, 0);
});
