// Quran Firm Plant - Quranic Speech Recognition Service
// Records microphone audio and transcribes it locally with the Tarteel-tuned
// Whisper model running in a web worker (see workers/asr-worker.js).
// Works in any modern browser and fully offline once the model is cached.

const SAMPLE_RATE = 16000;

// Live transcription is incremental: a phrase that ends in a real pause is transcribed
// once and then kept ("committed"); every later pass, including the final one when the
// user taps stop, only transcribes the speech after the last committed phrase. Each pass
// costs a few seconds, so passes are lined up with the reciter's pauses: one starts when
// a phrase ends, or after a few seconds of continuous speech it hasn't seen yet.
const RECORDER_TIMESLICE_MS = 250;
const PREVIEW_MIN_NEW_CHUNKS = 2; // re-check every 0.5 s of new audio
const PREVIEW_POLL_MS = 300;
// Most phrases end in a pause well before this, so they are committed rather than
// previewed; only a long unbroken stretch gets a (non-final) preview.
const PREVIEW_MAX_UNSEEN = Math.round(4.5 * SAMPLE_RATE);
// Committing needs a clear pause (breath/waqf), never a gap between two words, and
// enough speech that the model isn't guessing from a fragment.
const COMMIT_PAUSE = Math.round(0.6 * SAMPLE_RATE);
const MIN_COMMIT_SPEECH = Math.round(0.5 * SAMPLE_RATE);
// One Whisper window; a longer unbroken stretch previews its latest part only.
const PREVIEW_MAX_SECONDS = 24;

// --- Speech detection ---------------------------------------------------------------
// Whisper invents words for silence and background noise (pure silence comes out as
// "وَالْمُؤْمِنِينَ"), so it must never be handed audio without speech, and long silent
// stretches at either end are trimmed. Measured frame RMS: speech ~0.03-0.25, a quiet
// room ~0.001.
const FRAME = 320; // 20 ms at 16 kHz
const MIN_VOICED_FRAMES = 12; // ~0.25 s
const PAD_BEFORE = Math.round(0.25 * SAMPLE_RATE);
const PAD_AFTER = Math.round(0.35 * SAMPLE_RATE);
// Voiced audio this close to the end of a snapshot means the reciter is mid-word.
const MID_SPEECH_GAP = Math.round(0.2 * SAMPLE_RATE);

// Speech in `pcm` at or after sample `from`. The voiced-frame threshold comes from the
// whole recording (its pauses and the moment before the reciter started give the noise
// floor), so a stretch that is all speech can't make quiet syllables look like a pause.
export function detectSpeech(pcm, from = 0) {
  const n = Math.floor(pcm.length / FRAME);
  const rms = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = f * FRAME, end = i + FRAME; i < end; i++) sum += pcm[i] * pcm[i];
    rms[f] = Math.sqrt(sum / FRAME);
  }
  if (n < MIN_VOICED_FRAMES) return { hasSpeech: false, rms };

  const sorted = rms.slice().sort();
  const noiseFloor = sorted[Math.floor(n * 0.1)];
  const peak = sorted[Math.floor(n * 0.98)];
  // Well above the noise floor, and not a faint murmur next to the loudest speech.
  const threshold = Math.max(0.008, noiseFloor * 3.5, peak * 0.1);

  let first = -1;
  let last = -1;
  let voiced = 0;
  for (let f = Math.ceil(from / FRAME); f < n; f++) {
    if (rms[f] > threshold) {
      if (first < 0) first = f;
      last = f;
      voiced++;
    }
  }
  if (voiced < MIN_VOICED_FRAMES) return { hasSpeech: false, rms };
  return { hasSpeech: true, start: first * FRAME, end: (last + 1) * FRAME, rms, threshold };
}

// Where the last finished phrase after sample `from` ends: the last voiced frame that is
// followed by at least COMMIT_PAUSE of quiet, or -1. Looking back over the whole open
// part (rather than only at its end) catches pauses that were already over by the time
// the recording was checked. A lone voiced frame (a click, a breath) doesn't break a pause.
function lastPhraseEnd(speech, from, length) {
  const { rms, threshold } = speech;
  const pauseFrames = Math.round(COMMIT_PAUSE / FRAME);
  let quiet = 0;
  for (let f = Math.floor(length / FRAME) - 1; f >= Math.ceil(from / FRAME); f--) {
    const voiced = rms[f] > threshold && (rms[f - 1] > threshold || rms[f + 1] > threshold);
    if (!voiced) {
      quiet++;
    } else if (quiet >= pauseFrames) {
      return (f + 1) * FRAME;
    } else {
      quiet = 0;
    }
  }
  return -1;
}

// The part of `pcm` worth transcribing: the speech plus a little padding (never reaching
// back before `from`), limited to the latest `maxSeconds`. A limited window starts at the
// quietest point near its start, because the model garbles a word that is cut in half.
function speechSegment(pcm, speech, from = 0, maxSeconds = Infinity) {
  let start = Math.max(from, speech.start - PAD_BEFORE);
  const end = Math.min(pcm.length, speech.end + PAD_AFTER);
  let truncated = false;
  if (end - start > maxSeconds * SAMPLE_RATE) {
    start = quietestPointAfter(speech.rms, end - maxSeconds * SAMPLE_RATE);
    truncated = true;
  }
  return { audio: pcm.slice(start, end), end, truncated };
}

function withoutLastWord(text) {
  return text.split(' ').slice(0, -1).join(' ');
}

function quietestPointAfter(rms, from) {
  const first = Math.ceil(from / FRAME);
  const last = Math.min(rms.length - 3, first + Math.round((2 * SAMPLE_RATE) / FRAME));
  let best = first;
  let bestEnergy = Infinity;
  for (let f = first; f <= last; f++) {
    const energy = rms[f] + rms[f + 1] + rms[f + 2]; // 60 ms around the cut
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = f + 1;
    }
  }
  return best * FRAME;
}

export class QuranASR {
  constructor() {
    this.worker = null;
    this.modelReady = false;
    this.loadingPromise = null;
    this.backend = null; // 'webgpu' (encoder on the GPU) or 'wasm', once loaded
    this.nextRequestId = 1;
    this.pending = new Map(); // requestId -> {resolve, reject}

    // Recording state
    this.mediaRecorder = null;
    this.mediaStream = null;
    this.chunks = [];
    this.isRecording = false;
    this.recordingId = 0;

    // (percent, phase) => void; phase is 'download' or 'warming' (percent is 100 then)
    this.onLoadProgress = null;

    // Live transcription while still recording
    this.onInterimResult = null; // (text, { settled, pending }) => void
    this.previewTimer = null;
    this.previewChunkMark = 0; // chunk count at the start of the last preview pass
    this.committed = []; // [{ text, end }]: finished phrases, never transcribed again
    this.committedEnd = 0; // sample where the open (not yet committed) part starts
    this.previewInFlight = null; // { promise, from, covered, truncated, commitEnd }
    this.lastPreview = null; // { text, from, covered, truncated } for the open part
  }

  static isSupported() {
    return typeof Worker !== 'undefined'
      && typeof WebAssembly !== 'undefined'
      && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
      && typeof MediaRecorder !== 'undefined';
  }

  _ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(new URL('../workers/asr-worker.js', import.meta.url), { type: 'module' });

    this.worker.onmessage = (e) => {
      const { type, id, text, error, progress, phase } = e.data;

      if (type === 'load-progress') {
        this.onLoadProgress?.(progress, 'download');
        return;
      }
      if (type === 'load-status') {
        this.onLoadProgress?.(100, phase);
        return;
      }

      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);

      if (type === 'error') {
        const err = new Error(error);
        err.retryWithoutWebGPU = !!e.data.retryWithoutWebGPU;
        request.reject(err);
      } else if (type === 'loaded') {
        this.backend = e.data.backend;
        request.resolve();
      } else if (type === 'result') {
        request.resolve(text || '');
      }
    };

    this.worker.onerror = (e) => {
      // Fail all in-flight requests and start over with a fresh worker next time
      this._resetWorker(new Error(e.message || 'ASR worker crashed'));
    };
  }

  // A failed model run leaves the worker unusable (transformers.js keeps the failure in
  // its shared inference chain), so drop it; the model reloads from the browser cache.
  _resetWorker(reason) {
    this._dropWorker(reason);
    this.modelReady = false;
    this.loadingPromise = null;
    this.backend = null;
  }

  _dropWorker(reason) {
    const err = reason || new Error('ASR worker restarted');
    this.pending.forEach(({ reject }) => reject(err));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  _request(message, transfer = []) {
    this._ensureWorker();
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  async _transcribe(audio, interim) {
    try {
      return await this._request({ type: 'transcribe', audio, interim }, [audio.buffer]);
    } catch (e) {
      if (this.worker) this._resetWorker(e);
      throw e;
    }
  }

  // Download/initialize the model (no-op after the first successful call).
  // Model files are cached by the browser, so subsequent loads are fast & offline.
  async ensureLoaded(onProgress) {
    if (this.modelReady) return;
    if (onProgress) this.onLoadProgress = onProgress;
    if (!this.loadingPromise) {
      const loading = this._loadModel()
        .then(() => { this.modelReady = true; })
        .finally(() => {
          // Let a later call retry after a failure
          if (!this.modelReady && this.loadingPromise === loading) this.loadingPromise = null;
        });
      this.loadingPromise = loading;
    }
    await this.loadingPromise;
  }

  async _loadModel() {
    try {
      await this._request({ type: 'load' });
    } catch (e) {
      // A failed load can leave the worker unusable, so never reuse it.
      this._dropWorker(e);
      if (!e.retryWithoutWebGPU) throw e;
      // The GPU path failed on this device: retry in a fresh worker on the CPU.
      try {
        await this._request({ type: 'load', allowWebGPU: false });
      } catch (e2) {
        this._dropWorker(e2);
        throw e2;
      }
    }
  }

  // `onInterimResult`, if given, is called with the transcript of the audio captured so
  // far whenever new speech has been transcribed, so the recitation appears while the
  // user is still reciting. Its second argument splits that text into `settled` (finished
  // phrases, final) and `pending` (the phrase still being recited, may still change).
  async startRecording(onInterimResult) {
    if (this.isRecording) return;

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });

    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', '']
      .find(t => t === '' || MediaRecorder.isTypeSupported(t));

    // Each recording gets its own chunk array so a late event from a previous
    // recorder can't leak into this one.
    const chunks = [];
    this.chunks = chunks;
    this.recordingId++;
    this._resetTranscript();

    this.mediaRecorder = new MediaRecorder(this.mediaStream, mimeType ? { mimeType } : undefined);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    // Small timeslices so live previews always include the latest audio.
    this.mediaRecorder.start(RECORDER_TIMESLICE_MS);
    this.isRecording = true;

    this.onInterimResult = onInterimResult || null;
    if (this.onInterimResult) this._schedulePreview();
  }

  _schedulePreview() {
    this._stopPreviewLoop();
    this.previewTimer = setTimeout(() => this._previewTick(), PREVIEW_POLL_MS);
  }

  _stopPreviewLoop() {
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
  }

  async _previewTick() {
    this.previewTimer = null;
    const recordingId = this.recordingId;
    const stillRecording = () => this.isRecording && recordingId === this.recordingId;
    if (!stillRecording() || this.previewInFlight) return;

    try {
      const chunkCount = this.chunks.length;
      if (chunkCount - this.previewChunkMark < PREVIEW_MIN_NEW_CHUNKS) return;
      this.previewChunkMark = chunkCount;

      const pcm = await this._decodeChunksToPCM(this.chunks.slice(0, chunkCount));
      if (!pcm || !stillRecording()) return;

      // Only the open part, after the last committed phrase, is transcribed again.
      // Nothing (new) said there: no pass, so no invented words and no wasted seconds.
      const from = this.committedEnd;
      const speech = detectSpeech(pcm, from);
      if (!speech.hasSpeech) return;

      let pass;
      const phraseEnd = lastPhraseEnd(speech, from, pcm.length);
      if (phraseEnd > 0 && phraseEnd - speech.start >= MIN_COMMIT_SPEECH) {
        // Phrases followed by a pause are finished: transcribe them once and keep the text.
        const { audio, end } = speechSegment(pcm, { ...speech, end: phraseEnd }, from);
        pass = { audio, from, covered: end, truncated: false, commitEnd: end, endedMidSpeech: false };
      } else {
        // Mid-phrase: wait for the pause unless the reciter has gone on for a while.
        const unseen = speech.end - Math.max(this.lastPreview?.covered ?? 0, speech.start);
        if (unseen < PREVIEW_MAX_UNSEEN) return;
        const { audio, truncated } = speechSegment(pcm, speech, from, PREVIEW_MAX_SECONDS);
        pass = {
          audio,
          from,
          covered: pcm.length,
          truncated,
          commitEnd: null,
          // Still mid-word when the snapshot was taken: the model would guess a word from
          // its first half (e.g. "ذَاتِ" for the start of "ذَٰلِكَ"), so hold that word back.
          endedMidSpeech: pcm.length - speech.end < MID_SPEECH_GAP,
        };
      }
      pass.promise = this._transcribe(pass.audio, true);
      delete pass.audio; // transferred to the worker
      this.previewInFlight = pass;
      let text = '';
      try {
        text = await pass.promise;
      } finally {
        if (this.previewInFlight === pass) this.previewInFlight = null;
      }
      this._applyPass(pass, text, recordingId);
    } catch (e) {
      // Partial audio can occasionally fail to decode mid-recording; retry on the next tick.
    } finally {
      if (stillRecording() && !this.previewInFlight) this._schedulePreview();
    }
  }

  // Record a finished live pass and show the transcript so far.
  _applyPass(pass, text, recordingId) {
    if (recordingId !== this.recordingId || pass.from !== this.committedEnd) return;

    let pending = '';
    if (pass.commitEnd !== null) {
      // Moved past even when empty (a cough, unclear audio) so it isn't retried forever
      if (text) this.committed.push({ text, end: pass.commitEnd });
      this.committedEnd = pass.commitEnd;
      this.lastPreview = null;
    } else if (text) {
      this.lastPreview = { text, from: pass.from, covered: pass.covered, truncated: pass.truncated };
      pending = pass.endedMidSpeech ? withoutLastWord(text) : text;
      if (pending && pass.truncated) pending = `… ${pending}`;
    } else {
      return; // an empty preview keeps the previous text
    }

    const settled = this.committed.map(s => s.text).join(' ');
    const shown = [settled, pending].filter(Boolean).join(' ');
    if (shown && this.isRecording) this.onInterimResult?.(shown, { settled, pending });
  }

  _resetTranscript() {
    this.previewChunkMark = 0;
    this.previewInFlight = null;
    this.lastPreview = null;
    this.committed = [];
    this.committedEnd = 0;
  }

  async _decodeChunksToPCM(chunks) {
    const blob = new Blob(chunks, { type: this.mediaRecorder?.mimeType || chunks[0]?.type || 'audio/webm' });
    if (blob.size === 0) return null;

    const arrayBuffer = await blob.arrayBuffer();
    // decodeAudioData resamples to the context's rate; an offline context needs no
    // audio hardware.
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    let audioBuffer;
    if (OfflineCtx) {
      audioBuffer = await new OfflineCtx(1, 1, SAMPLE_RATE).decodeAudioData(arrayBuffer);
    } else {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
      try {
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      } finally {
        audioCtx.close();
      }
    }

    if (audioBuffer.numberOfChannels > 1) {
      const left = audioBuffer.getChannelData(0);
      const right = audioBuffer.getChannelData(1);
      const pcm = new Float32Array(left.length);
      for (let i = 0; i < left.length; i++) pcm[i] = (left[i] + right[i]) / 2;
      return pcm;
    }
    return audioBuffer.getChannelData(0);
  }

  _stopRecorder() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        resolve();
        return;
      }
      this.mediaRecorder.onstop = () => resolve();
      this.mediaRecorder.stop();
    });
  }

  _releaseMic() {
    this._stopPreviewLoop();
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    this.mediaRecorder = null;
    this.isRecording = false;
    this.onInterimResult = null;
  }

  // Stop recording and return the Arabic text of what was recited ('' if nothing was).
  async stopAndTranscribe() {
    if (!this.isRecording) return '';

    this._stopPreviewLoop();
    await this._stopRecorder();
    const chunks = this.chunks.slice();
    const inFlight = this.previewInFlight;
    const lastPreview = this.lastPreview;
    const from = this.committedEnd;
    const settled = this.committed.map(s => s.text).join(' ');
    this._releaseMic();
    const withSettled = (text) => [settled, text].filter(Boolean).join(' ');

    const pcm = await this._decodeChunksToPCM(chunks);
    if (!pcm) return settled;
    // Only what was said after the last committed phrase still needs transcribing.
    const speech = detectSpeech(pcm, from);
    if (!speech.hasSpeech) return settled;

    // A live pass that already heard all of it is the answer: reciters usually pause
    // before tapping stop, so this often skips a pass entirely.
    const heardEverything = (pass) => pass && pass.from === from && !pass.truncated
      && pass.covered >= speech.end + PAD_BEFORE;
    if (heardEverything(lastPreview)) return withSettled(lastPreview.text);
    if (heardEverything(inFlight)) {
      const text = await inFlight.promise.catch(() => '');
      if (text) return withSettled(text);
    }

    // A pass committing the earlier phrases is worth finishing; then only what was said
    // after it still needs transcribing (a preview pass gets cancelled instead).
    let start = from;
    let committing = '';
    if (inFlight?.commitEnd != null && inFlight.from === from) {
      committing = await inFlight.promise.catch(() => '');
      if (committing) start = inFlight.commitEnd;
    }
    const rest = start === from ? speech : detectSpeech(pcm, start);
    if (!rest.hasSpeech) return withSettled(committing);
    const { audio } = speechSegment(pcm, rest, start);
    const last = await this._transcribe(audio, false);
    return withSettled([committing, last].filter(Boolean).join(' '));
  }

  // Abort a recording without transcribing
  cancelRecording() {
    this._stopPreviewLoop();
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this._releaseMic();
    this.chunks = [];
    this.recordingId++; // ignore any preview still being transcribed
    this._resetTranscript();
    this.worker?.postMessage({ type: 'cancel-previews' });
  }
}

export const quranASR = new QuranASR();
