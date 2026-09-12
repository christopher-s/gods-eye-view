/**
 * Gemini Live PCM audio pipeline.
 *
 * Pure conversion helpers in this file avoid browser globals so they run
 * identically under Node tests and in the browser bundle. The session class
 * at the bottom receives its Web Audio dependencies by injection.
 */

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * Convert mono Float32 samples to signed little-endian PCM16.
 *
 * Samples are clamped to [-1, 1] before scaling; NaN maps to silence and
 * infinities clamp to the extremes. Accepts a Float32Array or array-like.
 *
 * @param {Float32Array|number[]} samples
 * @returns {Int16Array}
 */
export function float32ToPcm16(samples) {
  const source = Array.isArray(samples) ? Float32Array.from(samples) : samples;
  const output = new Int16Array(source.length);
  for (let i = 0; i < source.length; i += 1) {
    const value = source[i];
    output[i] =
      Number.isNaN(value) || value === 0
        ? 0
        : value < 0
          ? Math.max(-32768, Math.round(value * 32768))
          : Math.min(32767, Math.round(value * 32767));
  }
  return output;
}

/**
 * Resample mono audio between two sample rates using linear interpolation.
 *
 * Output sample i is read from source position i * fromRate / toRate;
 * positions past the end hold the final sample. Deterministic for the same
 * inputs on every platform.
 *
 * @param {Float32Array|number[]} samples
 * @param {number} fromRate positive finite source sample rate
 * @param {number} toRate positive finite target sample rate
 * @returns {Float32Array}
 * @throws {TypeError} when either rate is not a positive finite number
 */
export function resampleMono(samples, fromRate, toRate) {
  for (const rate of [fromRate, toRate]) {
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new TypeError(
        `Sample rates must be positive finite numbers; received ${String(rate)}`,
      );
    }
  }
  const source = Array.isArray(samples) ? Float32Array.from(samples) : samples;
  const outputLength = Math.ceil((source.length * toRate) / fromRate);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const position = (i * fromRate) / toRate;
    const index = Math.floor(position);
    if (index >= source.length - 1) {
      output[i] = source.length ? source[source.length - 1] : 0;
      continue;
    }
    const fraction = position - index;
    output[i] = source[index] + (source[index + 1] - source[index]) * fraction;
  }
  return output;
}

/**
 * Encode PCM16 samples as standard base64 with little-endian bytes.
 *
 * @param {Int16Array|number[]} samples
 * @returns {string}
 */
export function pcm16ToBase64(samples) {
  const pcm = ArrayBuffer.isView(samples)
    ? samples
    : Int16Array.from(samples ?? []);
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_ALPHABET[(triplet >> 18) & 63];
    out += BASE64_ALPHABET[(triplet >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64_ALPHABET[(triplet >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? BASE64_ALPHABET[triplet & 63] : '=';
  }
  return out;
}

/**
 * Decode standard base64 to signed little-endian PCM16 samples.
 *
 * Strict validation: length must be a multiple of four, padding may only
 * appear as a trailing suffix, whitespace is rejected, and the decoded byte
 * count must align to two-byte samples.
 *
 * @param {string} value
 * @returns {Int16Array}
 * @throws {TypeError} when the value is not a string
 * @throws {RangeError} when the value is malformed base64 or misaligned
 */
export function base64ToPcm16(value) {
  if (typeof value !== 'string') {
    throw new TypeError('base64ToPcm16 expects a string');
  }
  if (value.length % 4 !== 0) {
    throw new RangeError('base64ToPcm16 length must be a multiple of four');
  }
  const length = value.length;
  let padding = 0;
  if (value.charCodeAt(length - 1) === 61) padding = 1;
  if (padding > 0 && value.charCodeAt(length - 2) === 61) padding = 2;
  if (padding > 1 && value.charCodeAt(length - 3) === 61) padding = 3;
  // '=' may only form a trailing run of at most two characters.
  if (padding === 3 || value.slice(0, length - padding).includes('=')) {
    throw new RangeError('base64ToPcm16 has invalid padding');
  }
  const significant = length - padding;
  if (significant % 4 === 1) {
    throw new RangeError('base64ToPcm16 has an invalid significant length');
  }
  const byteLength = Math.floor((significant * 3) / 4);
  if (byteLength % 2 !== 0) {
    throw new RangeError('base64ToPcm16 must decode to whole 16-bit samples');
  }
  const bytes = new Uint8Array(byteLength);
  let accumulator = 0;
  let bits = 0;
  let byteIndex = 0;
  for (let i = 0; i < significant; i += 1) {
    const code = value.charCodeAt(i);
    const sixBits = code < 128 ? BASE64_LOOKUP[code] : -1;
    if (sixBits < 0) {
      throw new RangeError(
        `base64ToPcm16 contains an invalid character at ${i}`,
      );
    }
    accumulator = (accumulator << 6) | sixBits;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[byteIndex] = (accumulator >> bits) & 0xff;
      byteIndex += 1;
    }
  }
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

// ---------------------------------------------------------------------------
// Gemini Live session rates and capture module
// ---------------------------------------------------------------------------

/** Gemini Live input contract: 16 kHz mono signed PCM16 little-endian. */
export const GEMINI_INPUT_SAMPLE_RATE = 16000;

/** Gemini Live output audio arrives as 24 kHz PCM16. */
export const GEMINI_OUTPUT_SAMPLE_RATE = 24000;

/** Public URL of the PCM capture AudioWorklet module. */
export const PCM_CAPTURE_MODULE_URL = '/audio-worklets/gev-pcm-capture.js';

const PCM_CAPTURE_PROCESSOR_NAME = 'gev-pcm-capture';

function defaultCreateWorkletNode(audioContext) {
  const audioWorkletNodeClass = globalThis.AudioWorkletNode;
  if (typeof audioWorkletNodeClass !== 'function') {
    throw new Error(
      'GeminiPcmAudioSession requires a createWorkletNode factory when AudioWorkletNode is unavailable',
    );
  }
  return new audioWorkletNodeClass(audioContext, PCM_CAPTURE_PROCESSOR_NAME);
}

/**
 * Owns Gemini Live capture and playback audio resources for one session.
 *
 * All Web Audio dependencies are injectable so scheduling is testable under
 * Node. Input: a worklet node posts mono Float32 frames which are resampled
 * to {@link GEMINI_INPUT_SAMPLE_RATE} and emitted as base64 PCM16. Output:
 * base64 PCM16 chunks at {@link GEMINI_OUTPUT_SAMPLE_RATE} are decoded and
 * scheduled back-to-back from `max(currentTime, nextStartTime)`.
 */
export class GeminiPcmAudioSession {
  #audioContext;
  #createWorkletNode;
  #createBufferSource;
  #createMediaStreamSource;
  #createGain;
  #input = null;
  #stopped = false;
  #nextStartTime = 0;
  #activeSources = new Set();

  constructor({
    audioContext,
    createWorkletNode,
    createBufferSource,
    createMediaStreamSource,
    createGain,
  } = {}) {
    if (!audioContext || typeof audioContext.createBuffer !== 'function') {
      throw new TypeError('GeminiPcmAudioSession requires an audio context');
    }
    this.#audioContext = audioContext;
    this.#createWorkletNode = createWorkletNode ?? defaultCreateWorkletNode;
    this.#createBufferSource =
      createBufferSource ?? ((context) => context.createBufferSource());
    this.#createMediaStreamSource =
      createMediaStreamSource ??
      ((context, stream) => context.createMediaStreamSource(stream));
    this.#createGain = createGain ?? ((context) => context.createGain());
  }

  /**
   * Begin capturing microphone audio.
   *
   * @param {(base64Chunk: string) => void} onChunk receives base64 PCM16 at 16 kHz
   * @param {MediaStream} [stream] microphone stream to route through the worklet
   */
  async startInput(onChunk, stream) {
    if (typeof onChunk !== 'function') {
      throw new TypeError('startInput requires a chunk callback');
    }
    this.#teardownInput();
    this.#stopped = false;

    const audioContext = this.#audioContext;
    const workletNode = this.#createWorkletNode(audioContext);

    let captureSource = null;
    if (stream) {
      captureSource = this.#createMediaStreamSource(audioContext, stream);
      captureSource.connect(workletNode);
    }

    // A zero-gain sink keeps the worklet pulled by the audio graph without
    // echoing the microphone to the speakers.
    const sink = this.#createGain(audioContext);
    sink.gain.value = 0;
    workletNode.connect(sink);
    sink.connect(audioContext.destination);

    const handler = (event) => {
      if (this.#stopped) return;
      const data = event?.data;
      if (!data || data.type !== 'pcm') return;
      const samples = data.samples;
      if (!ArrayBuffer.isView(samples) && !Array.isArray(samples)) return;
      if (samples.length === 0) return;
      const resampled = resampleMono(
        samples,
        audioContext.sampleRate,
        GEMINI_INPUT_SAMPLE_RATE,
      );
      const chunk = pcm16ToBase64(float32ToPcm16(resampled));
      if (chunk) onChunk(chunk);
    };
    workletNode.port.addEventListener('message', handler);

    this.#input = { workletNode, captureSource, sink, stream, handler };
  }

  /**
   * Schedule one base64 PCM16 chunk for playback at 24 kHz.
   *
   * Malformed or empty input is ignored. Buffers are scheduled contiguously
   * starting from `max(currentTime, nextStartTime)` so chunks never overlap
   * or drift into the past.
   *
   * @param {string} base64Chunk
   */
  enqueueOutput(base64Chunk) {
    if (this.#stopped) return;
    let pcm;
    try {
      pcm = base64ToPcm16(base64Chunk);
    } catch {
      return;
    }
    if (!pcm.length) return;

    const audioContext = this.#audioContext;
    const buffer = audioContext.createBuffer({
      numberOfChannels: 1,
      length: pcm.length,
      sampleRate: GEMINI_OUTPUT_SAMPLE_RATE,
    });
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) {
      channel[i] = pcm[i] / 32768;
    }

    const source = this.#createBufferSource(audioContext);
    source.buffer = buffer;
    source.connect(audioContext.destination);
    const startAt = Math.max(audioContext.currentTime, this.#nextStartTime);
    source.start(startAt);
    this.#nextStartTime = startAt + pcm.length / GEMINI_OUTPUT_SAMPLE_RATE;
    this.#activeSources.add(source);
    source.onended = () => {
      this.#activeSources.delete(source);
    };
  }

  /** Stop and disconnect every queued playback source and reset the schedule. */
  clearOutput() {
    for (const source of this.#activeSources) {
      source.stop();
      source.disconnect();
    }
    this.#activeSources.clear();
    this.#nextStartTime = 0;
  }

  /** Tear down capture and playback resources. Safe to call repeatedly. */
  stop() {
    this.#stopped = true;
    this.#teardownInput();
    this.clearOutput();
  }

  #teardownInput() {
    const input = this.#input;
    if (!input) return;
    this.#input = null;
    input.workletNode.port.removeEventListener('message', input.handler);
    if (input.captureSource) input.captureSource.disconnect();
    if (input.stream) {
      for (const track of input.stream.getAudioTracks?.() ?? []) track.stop();
    }
    input.sink.disconnect();
    input.workletNode.disconnect();
  }
}
