// Quran Firm Plant - ASR Web Worker
// Runs the Tarteel-tuned Whisper model (ONNX) fully in-browser via transformers.js.
// Keeping inference in a worker keeps the UI thread responsive.

import { pipeline } from '@huggingface/transformers';

const MODEL_ID = 'eventhorizon0/tarteel-ai-onnx-whisper-base-ar-quran';

let transcriber = null;
let loadPromise = null;

function loadModel() {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const progress_callback = (data) => {
      // Forward file download progress to the main thread
      if (data.status === 'progress' && data.total) {
        self.postMessage({
          type: 'load-progress',
          file: data.file,
          progress: Math.round((data.loaded / data.total) * 100)
        });
      }
    };

    // Prefer full-precision weights for the best transcription quality; fall
    // back to the smaller quantized weights if fp32 fails to load (e.g. on a
    // low-memory device or if the repo doesn't ship that variant).
    const dtypes = ['fp32', 'q8'];
    let lastError = null;
    for (const dtype of dtypes) {
      try {
        transcriber = await pipeline('automatic-speech-recognition', MODEL_ID, {
          dtype,
          device: 'wasm',
          progress_callback
        });
        return;
      } catch (e) {
        lastError = e;
        console.warn(`ASR worker: failed to load with dtype=${dtype}`, e);
      }
    }
    loadPromise = null;
    throw lastError;
  })();

  return loadPromise;
}

self.onmessage = async (e) => {
  const { type, id, audio } = e.data;

  if (type === 'load') {
    try {
      await loadModel();
      self.postMessage({ type: 'loaded', id });
    } catch (err) {
      self.postMessage({ type: 'error', id, error: String(err?.message || err) });
    }
    return;
  }

  if (type === 'transcribe') {
    try {
      await loadModel();
      // `audio` is a Float32Array of 16kHz mono PCM.
      // Note: this fine-tune is Arabic-only, so no language/task options —
      // passing them throws ("Cannot specify task/language for an English-only model").
      const output = await transcriber(audio, {
        chunk_length_s: 30
      });
      self.postMessage({ type: 'result', id, text: (output?.text || '').trim() });
    } catch (err) {
      self.postMessage({ type: 'error', id, error: String(err?.message || err) });
    }
  }
};
