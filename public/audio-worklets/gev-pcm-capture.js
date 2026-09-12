/**
 * GEV PCM capture AudioWorklet processor.
 *
 * Collects mono Float32 samples from the first input channel into fixed-size
 * frames and posts each complete frame to the main thread, carrying any
 * remainder into the next frame. Rate-agnostic: resampling to 16 kHz happens
 * on the main thread.
 */

const DEFAULT_FRAME_SIZE = 4096;

class GevPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requested = options?.processorOptions?.frameSize;
    this.frameSize =
      Number.isInteger(requested) && requested > 0
        ? requested
        : DEFAULT_FRAME_SIZE;
    this.frame = new Float32Array(this.frameSize);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs && inputs[0];
    if (input && input.length) {
      const channel = input[0];
      if (channel && channel.length) {
        let offset = 0;
        while (offset < channel.length) {
          const copy = Math.min(
            this.frameSize - this.filled,
            channel.length - offset,
          );
          this.frame.set(channel.subarray(offset, offset + copy), this.filled);
          this.filled += copy;
          offset += copy;
          if (this.filled === this.frameSize) {
            this.port.postMessage({ type: 'pcm', samples: this.frame.slice() });
            this.filled = 0;
          }
        }
      }
    }
    return true;
  }
}

registerProcessor('gev-pcm-capture', GevPcmCaptureProcessor);
