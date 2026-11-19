// Quran Firm Plant - ASR Web Worker
// Runs the Tarteel-tuned Whisper model (ONNX) fully in-browser via transformers.js.
// Keeping inference in a worker keeps the UI thread responsive.

import { pipeline, LogitsProcessor, LogitsProcessorList } from '@huggingface/transformers';
import { speedUpFeatureExtraction } from './whisper-features.js';

const MODEL_ID = 'eventhorizon0/tarteel-ai-onnx-whisper-base-ar-quran';
const SAMPLE_RATE = 16000;

// The Tarteel fine-tune ships without a usable generation config: no language/task
// prompt tokens, no <|notimestamps|> id, no suppress list, and max_length 1024 although
// the decoder only has 448 positions. Left alone, transformers.js prompts the decoder
// with <|startoftranscript|> only and the model has to guess the rest of the prompt.
// These are the standard multilingual-Whisper token ids (see the repo's added_tokens.json).
const TOKEN = { endOfText: 50257, ar: 50272, translate: 50358, transcribe: 50359, noTimestamps: 50363, space: 220 };

// From openai/whisper-base's generation_config.json: symbol/punctuation tokens a
// transcript never needs (music notes, brackets, ...) plus the special tokens.
const SUPPRESS_TOKENS = [
  1, 2, 7, 8, 9, 10, 14, 25, 26, 27, 28, 29, 31, 58, 59, 60, 61, 62, 63, 90, 91, 92, 93,
  359, 503, 522, 542, 873, 893, 902, 918, 922, 931, 1350, 1853, 1982, 2460, 2627, 3246,
  3253, 3268, 3536, 3846, 3961, 4183, 4667, 6585, 6647, 7273, 9061, 9383, 10428, 10929,
  11938, 12033, 12331, 12562, 13793, 14157, 14635, 15265, 15618, 16553, 16604, 18362,
  18956, 20075, 21675, 22520, 26130, 26161, 26435, 28279, 29464, 31650, 32302, 32470,
  36865, 42863, 47425, 49870, 50254, 50258, 50358, 50359, 50360, 50361, 50362,
];

const GENERATION_CONFIG = {
  is_multilingual: true,
  language: 'ar',
  task: 'transcribe',
  lang_to_id: { '<|ar|>': TOKEN.ar },
  task_to_id: { transcribe: TOKEN.transcribe, translate: TOKEN.translate },
  no_timestamps_token_id: TOKEN.noTimestamps,
  return_timestamps: false,
  suppress_tokens: SUPPRESS_TOKENS,
  // Whisper normally forbids <|endoftext|> as the first text token. Allowing it lets the
  // model return nothing for a half-word or unclear audio instead of inventing a word.
  begin_suppress_tokens: [TOKEN.space],
};

// 448 decoder positions minus the 4-token prompt, with a little headroom.
const MAX_NEW_TOKENS = 440;
// Vowelled recitation text runs ~7 tokens per word; this bounds runaway repetition
// loops by the clip length without cutting off fast recitation.
const TOKENS_PER_SECOND = 25;
// Longer clips are split into 20 s windows so each window's text fits the decoder.
const LONG_CLIP_S = 24;

// Device plans, best first. On an Intel iGPU the fixed 30 s encoder pass drops from
// ~15 s (single-threaded WASM: the page isn't cross-origin isolated) to ~2-3 s on
// WebGPU, while this model's merged decoder is pathologically slow on WebGPU (~0.8 s per
// token vs ~50 ms on WASM). So: encoder on the GPU when there is one, decoder on WASM.
async function devicePlans(allowWebGPU) {
  const plans = [];
  if (allowWebGPU && (await hasWebGPU())) {
    plans.push({ backend: 'webgpu', device: { encoder_model: 'webgpu', decoder_model_merged: 'wasm' }, dtype: 'fp32' });
  }
  plans.push({ backend: 'wasm', device: 'wasm', dtype: 'fp32' });
  // Smaller quantized weights for low-memory devices.
  plans.push({ backend: 'wasm', device: 'wasm', dtype: 'q8' });
  return plans;
}

async function hasWebGPU() {
  try {
    return !!(self.navigator?.gpu && (await self.navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

let transcriber = null;
let backend = null;
let loadPromise = null;

function loadModel({ allowWebGPU = true } = {}) {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    let lastError = null;
    for (const plan of await devicePlans(allowWebGPU)) {
      // Report download progress across all files, not per file, so the bar doesn't
      // jump back and forth between the encoder and decoder downloads.
      const files = new Map();
      const progress_callback = (data) => {
        if (data.status !== 'progress' || !data.total) return;
        files.set(data.file, { loaded: data.loaded, total: data.total });
        let loaded = 0;
        let total = 0;
        for (const f of files.values()) {
          loaded += f.loaded;
          total += f.total;
        }
        self.postMessage({ type: 'load-progress', progress: Math.min(100, Math.round((loaded / total) * 100)) });
      };

      let candidate;
      try {
        candidate = await pipeline('automatic-speech-recognition', MODEL_ID, {
          dtype: plan.dtype,
          device: plan.device,
          progress_callback,
        });
      } catch (e) {
        // Nothing has run yet, so the next plan can still be tried in this worker.
        lastError = e;
        console.warn(`ASR worker: ${plan.backend}/${plan.dtype} unavailable`, e);
        continue;
      }

      // The first pass compiles GPU shaders and allocates buffers (several seconds); pay
      // that now rather than on the user's first recitation. It also proves the plan
      // actually runs on this device before we commit to it.
      try {
        self.postMessage({ type: 'load-status', phase: 'warming' });
        const warmup = new Float32Array(SAMPLE_RATE);
        for (let i = 0; i < warmup.length; i++) warmup[i] = (Math.random() - 0.5) * 1e-3;
        await candidate(warmup, { ...GENERATION_CONFIG, max_new_tokens: 4 });
      } catch (e) {
        // A failed run leaves transformers.js's shared inference chain rejected, so
        // nothing else can run in this worker: the main thread starts a fresh worker.
        console.warn(`ASR worker: ${plan.backend}/${plan.dtype} failed its first run`, e);
        loadPromise = null;
        const err = new Error(String(e?.message || e));
        err.retryWithoutWebGPU = plan.backend === 'webgpu';
        throw err;
      }

      transcriber = candidate;
      backend = plan.backend;
      makeCancellable(transcriber);
      speedUpFeatureExtraction(transcriber);
      return;
    }
    loadPromise = null;
    throw lastError || new Error('No ASR backend available');
  })();

  return loadPromise;
}

// --- Cancellation -------------------------------------------------------------
// Live-preview passes are superseded the moment the user stops recording. The WASM
// decoder never yields to the event loop on its own, so a "final" request couldn't even
// be received until the preview pass had finished. Yield before every model call so the
// request is seen, then end the cancelled pass by forcing <|endoftext|> on its next
// decoding step. (Throwing out of session.run isn't an option: transformers.js chains
// every run on one shared promise, and a rejection there breaks all later runs.)
let runningJob = null;

const yieldChannel = new MessageChannel();
const yieldResolvers = [];
yieldChannel.port1.onmessage = () => yieldResolvers.shift()?.();
function yieldToEventLoop() {
  return new Promise((resolve) => {
    yieldResolvers.push(resolve);
    yieldChannel.port2.postMessage(null);
  });
}

function makeCancellable(pipe) {
  for (const session of Object.values(pipe.model?.sessions || {})) {
    const run = session.run.bind(session);
    session.run = async (...args) => {
      await yieldToEventLoop();
      return run(...args);
    };
  }
}

class EndWhenCancelled extends LogitsProcessor {
  constructor(job) {
    super();
    this.job = job;
  }

  _call(input_ids, logits) {
    if (this.job.cancelled) {
      for (let i = 0; i < input_ids.length; i++) {
        const scores = /** @type {Float32Array} */ (logits[i].data);
        scores.fill(-Infinity);
        scores[TOKEN.endOfText] = 0;
      }
    }
    return logits;
  }
}

// --- Transcript clean-up ----------------------------------------------------------
// A recitation transcript only contains Arabic script.
const NON_ARABIC = /[^؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿\s]/g;

function sameWords(words, a, b, n) {
  for (let k = 0; k < n; k++) if (words[a + k] !== words[b + k]) return false;
  return true;
}

// Whisper's classic failure mode is looping on a word or phrase. Collapse a 1-6 word
// phrase repeated 3+ times in a row to a single copy; genuine Quranic doubles such as
// "دَكًّا دَكًّا" (two in a row) are left alone.
function collapseRepeats(words) {
  for (let n = 1; n <= 6; n++) {
    const out = [];
    let i = 0;
    while (i < words.length) {
      let reps = 1;
      while (i + (reps + 1) * n <= words.length && sameWords(words, i, i + reps * n, n)) reps++;
      if (reps >= 3) {
        out.push(...words.slice(i, i + n));
        i += reps * n;
      } else {
        out.push(words[i]);
        i++;
      }
    }
    words = out;
  }
  return words;
}

function cleanTranscript(text) {
  const words = text.replace(NON_ARABIC, ' ').split(/\s+/).filter(Boolean);
  return collapseRepeats(words).join(' ');
}

async function transcribe(job) {
  const seconds = job.audio.length / SAMPLE_RATE;
  const long = seconds > LONG_CLIP_S;
  const windowSeconds = long ? 20 : seconds;
  const logits_processor = new LogitsProcessorList();
  logits_processor.push(new EndWhenCancelled(job));
  const output = await transcriber(job.audio, {
    ...GENERATION_CONFIG,
    max_new_tokens: Math.min(MAX_NEW_TOKENS, Math.ceil(windowSeconds * TOKENS_PER_SECOND) + 16),
    chunk_length_s: long ? 20 : 0,
    stride_length_s: long ? 4 : undefined,
    logits_processor,
  });
  return cleanTranscript(output?.text || '');
}

// --- Job queue ----------------------------------------------------------------------
// One pass at a time (the ONNX sessions aren't re-entrant). A final transcription
// cancels queued and running live-preview passes so the user isn't kept waiting.
let queue = Promise.resolve();
const waitingJobs = new Set();

function cancelPreviews() {
  for (const job of waitingJobs) if (job.interim) job.cancelled = true;
  if (runningJob?.interim) runningJob.cancelled = true;
}

async function runJob(job) {
  waitingJobs.delete(job);
  if (job.cancelled) {
    self.postMessage({ type: 'result', id: job.id, text: '', cancelled: true });
    return;
  }
  runningJob = job;
  try {
    await loadModel();
    const text = await transcribe(job);
    self.postMessage({ type: 'result', id: job.id, text: job.cancelled ? '' : text, cancelled: job.cancelled });
  } catch (err) {
    self.postMessage({ type: 'error', id: job.id, error: String(err?.message || err) });
  } finally {
    runningJob = null;
  }
}

self.onmessage = async (e) => {
  const { type, id } = e.data;

  if (type === 'load') {
    try {
      await loadModel({ allowWebGPU: e.data.allowWebGPU !== false });
      self.postMessage({ type: 'loaded', id, backend });
    } catch (err) {
      self.postMessage({ type: 'error', id, error: String(err?.message || err), retryWithoutWebGPU: !!err?.retryWithoutWebGPU });
    }
    return;
  }

  if (type === 'cancel-previews') {
    cancelPreviews();
    return;
  }

  if (type === 'transcribe') {
    // `audio` is a Float32Array of 16kHz mono PCM that already contains speech.
    const job = { id, audio: e.data.audio, interim: !!e.data.interim, cancelled: false };
    if (!job.interim) cancelPreviews();
    waitingJobs.add(job);
    queue = queue.then(() => runJob(job));
  }
};
