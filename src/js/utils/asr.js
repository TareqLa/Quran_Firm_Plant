// Quran Firm Plant - Quranic Speech Recognition Service
// Records microphone audio and transcribes it locally with the Tarteel-tuned
// Whisper model running in a web worker (see workers/asr-worker.js).
// Works in any modern browser and fully offline once the model is cached.

export class QuranASR {
  constructor() {
    this.worker = null;
    this.modelReady = false;
    this.loadingPromise = null;
    this.nextRequestId = 1;
    this.pending = new Map(); // requestId -> {resolve, reject}

    // Recording state
    this.mediaRecorder = null;
    this.mediaStream = null;
    this.chunks = [];
    this.isRecording = false;

    this.onLoadProgress = null; // (percent) => void

    // Live interim transcription (updates while still recording)
    this.interimTimer = null;
    this.interimBusy = false;
    this.onInterimResult = null; // (text) => void
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
      const { type, id, text, error, progress } = e.data;

      if (type === 'load-progress') {
        if (this.onLoadProgress) this.onLoadProgress(progress);
        return;
      }

      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);

      if (type === 'error') {
        request.reject(new Error(error));
      } else if (type === 'loaded') {
        request.resolve();
      } else if (type === 'result') {
        request.resolve(text);
      }
    };

    this.worker.onerror = (e) => {
      // Fail all in-flight requests if the worker itself crashes
      const err = new Error(e.message || 'ASR worker crashed');
      this.pending.forEach(({ reject }) => reject(err));
      this.pending.clear();
    };
  }

  _request(message) {
    this._ensureWorker();
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id });
    });
  }

  // Download/initialize the model (no-op after the first successful call).
  // Model files are cached by the browser, so subsequent loads are instant & offline.
  async ensureLoaded(onProgress) {
    if (this.modelReady) return;
    this.onLoadProgress = onProgress || null;
    if (!this.loadingPromise) {
      this.loadingPromise = this._request({ type: 'load' })
        .then(() => { this.modelReady = true; })
        .catch((e) => {
          this.loadingPromise = null;
          throw e;
        });
    }
    await this.loadingPromise;
  }

  // `onInterimResult`, if given, is called every few seconds with the best-effort
  // transcript of the audio captured so far, so the recitation appears live instead
  // of only after the mic is stopped.
  async startRecording(onInterimResult) {
    if (this.isRecording) return;

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1
      }
    });

    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', '']
      .find(t => t === '' || MediaRecorder.isTypeSupported(t));

    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(this.mediaStream, mimeType ? { mimeType } : undefined);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    // Request data periodically (instead of only on stop) so we have audio to
    // run interim transcriptions against while the user is still reciting.
    this.mediaRecorder.start(1000);
    this.isRecording = true;

    this.onInterimResult = onInterimResult || null;
    if (this.onInterimResult) this._startInterimLoop();
  }

  _startInterimLoop() {
    this._stopInterimLoop();
    this.interimTimer = setInterval(() => this._runInterimTranscription(), 3000);
  }

  _stopInterimLoop() {
    if (this.interimTimer) {
      clearInterval(this.interimTimer);
      this.interimTimer = null;
    }
  }

  async _runInterimTranscription() {
    if (this.interimBusy || !this.isRecording || this.chunks.length === 0) return;
    this.interimBusy = true;
    try {
      const pcm = await this._decodeChunksToPCM(this.chunks.slice());
      if (pcm && this.isRecording) {
        const text = await this._request({ type: 'transcribe', audio: pcm });
        if (this.isRecording && this.onInterimResult) this.onInterimResult(text);
      }
    } catch (e) {
      // Partial audio can occasionally fail to decode/transcribe mid-recording; ignore and retry on the next tick.
    } finally {
      this.interimBusy = false;
    }
  }

  async _decodeChunksToPCM(chunks) {
    const blob = new Blob(chunks, { type: this.mediaRecorder?.mimeType || 'audio/webm' });
    if (blob.size === 0) return null;

    const arrayBuffer = await blob.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    let audioBuffer;
    try {
      audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } finally {
      audioCtx.close();
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
    this._stopInterimLoop();
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    this.mediaRecorder = null;
    this.isRecording = false;
    this.onInterimResult = null;
  }

  // Stop recording, decode to 16kHz mono PCM, and run Whisper. Returns the Arabic text.
  async stopAndTranscribe() {
    if (!this.isRecording) return '';

    this._stopInterimLoop();
    await this._stopRecorder();
    const chunks = this.chunks.slice();
    this._releaseMic();

    const pcm = await this._decodeChunksToPCM(chunks);
    if (!pcm) return '';

    return this._request({ type: 'transcribe', audio: pcm });
  }

  // Abort a recording without transcribing
  cancelRecording() {
    this._stopInterimLoop();
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this._releaseMic();
    this.chunks = [];
  }
}

export const quranASR = new QuranASR();
