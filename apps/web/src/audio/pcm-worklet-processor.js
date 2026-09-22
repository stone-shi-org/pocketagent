// PA-20 push-to-talk capture worklet.
//
// Plain JS, not TypeScript: this file runs in the separate
// AudioWorkletGlobalScope (no DOM lib, its own global types), loaded via
// `audioContext.audioWorklet.addModule(new URL('./pcm-worklet-processor.js',
// import.meta.url))` in `capture.ts` — Vite's `new URL(..., import.meta.url)`
// asset handling serves it as a static file, which sidesteps needing this
// build to carry AudioWorklet's own lib types just for one small file.
//
// Deliberately does no resampling here: it just forwards each 128-frame
// render quantum's mono channel data to the main thread as-is (at the
// AudioContext's native sample rate). All resampling/PCM16 conversion
// happens once, on the fully buffered utterance, in `capture.ts`/`pcm.ts` —
// simpler and more testable than carrying resampler state across `process()`
// calls, and push-to-talk already buffers the whole utterance before
// uploading, so there is no real-time deadline being missed by waiting.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      // Float32Array from `inputs` is reused by the audio graph on the next
      // call, so a copy has to cross the port, not the original.
      this.port.postMessage(channel.slice());
    }
    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
