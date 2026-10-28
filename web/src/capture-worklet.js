/*
 * tonedrop capture — runs on the audio thread and hands the microphone to the
 * page in 4096-sample chunks through its port.
 *
 * The port queues every chunk while the page is busy decoding, so a slow frame
 * delays what follows it instead of overwriting it. A ScriptProcessor keeps
 * only two buffers and refills them whether or not the page has read them.
 */

const CHUNK_SAMPLES = 4096;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(CHUNK_SAMPLES);
    this.filled = 0;
    this.live = true;
    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.live = false;
    };
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!this.live || !samples) return this.live;
    for (let at = 0; at < samples.length; ) {
      const n = Math.min(samples.length - at, CHUNK_SAMPLES - this.filled);
      this.chunk.set(samples.subarray(at, at + n), this.filled);
      this.filled += n;
      at += n;
      if (this.filled === CHUNK_SAMPLES) {
        this.port.postMessage(this.chunk, [this.chunk.buffer]);
        this.chunk = new Float32Array(CHUNK_SAMPLES);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('tonedrop-capture', CaptureProcessor);
