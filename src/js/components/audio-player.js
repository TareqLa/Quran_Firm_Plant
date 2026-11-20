// Quran Firm Plant - Shared Audio Player Component
// One <audio> element for the whole app, playing one ayah at a time from the
// per-ayah MP3s on cdn.islamic.network (Mishary Rashid Alafasy).
//
// Status: 'idle' (nothing loaded) → 'loading' → 'playing' ⇄ 'paused' → 'ended',
// or 'error'. Pausing keeps the position: playing the loaded ayah again
// continues from there. Only a different ayah (or a retry) loads a new file.
//
// Listeners: on('state', fn) runs when the status or the loaded ayah changes,
// on('time', fn) when the position or duration moves. Both get getState() and
// return a function that unsubscribes. The <audio> element stays public, so
// modules can also listen to its own events (Voice Finder does).

const AUDIO_BASE = 'https://cdn.islamic.network/quran/audio/128/ar.alafasy';
const HAVE_FUTURE_DATA = 3; // HTMLMediaElement.HAVE_FUTURE_DATA

export class AudioPlayer {
  constructor() {
    this.audio = new Audio();
    this.currentAyahKey = null;
    this.currentGlobalId = null;
    this.status = 'idle';
    this.error = null;
    this.listeners = new Map(); // event type -> Set of callbacks

    const a = this.audio;
    // Each handler ignores a stopped player, and events that no longer match
    // the element (a pause that arrives after the next play, for instance).
    a.addEventListener('play', () => {
      if (this.currentAyahKey && a.readyState < HAVE_FUTURE_DATA) this._setStatus('loading');
    });
    a.addEventListener('playing', () => {
      if (this.currentAyahKey && !a.paused) this._setStatus('playing');
    });
    a.addEventListener('waiting', () => {
      if (this.currentAyahKey && !a.paused) this._setStatus('loading');
    });
    a.addEventListener('pause', () => {
      if (!this.currentAyahKey || !a.paused || this.status === 'error') return;
      this._setStatus(a.ended ? 'ended' : 'paused');
    });
    a.addEventListener('ended', () => {
      if (this.currentAyahKey) this._setStatus('ended');
    });
    a.addEventListener('error', () => {
      if (this.currentAyahKey) this._fail(a.error);
    });
    ['timeupdate', 'durationchange', 'loadedmetadata', 'seeking', 'seeked'].forEach(type => {
      a.addEventListener(type, () => {
        if (this.currentAyahKey) this._emit('time');
      });
    });
  }

  // --- Listeners ---

  on(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
    return () => this.off(type, callback);
  }

  off(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }

  // What is loaded and where it is: { key, globalId, status, currentTime, duration, error }
  getState() {
    const a = this.audio;
    return {
      key: this.currentAyahKey,
      globalId: this.currentGlobalId,
      status: this.status,
      currentTime: a.currentTime || 0,
      duration: Number.isFinite(a.duration) ? a.duration : 0,
      error: this.error,
    };
  }

  // Playing or about to (still loading)
  get isPlaying() {
    return this.status === 'playing' || this.status === 'loading';
  }

  isLoaded(globalId, ayahKey) {
    return globalId != null && this.currentGlobalId === globalId && this.currentAyahKey === ayahKey;
  }

  urlFor(globalId) {
    return `${AUDIO_BASE}/${globalId}.mp3`;
  }

  // --- Playback ---

  // Start the given ayah (global verse number 1–6236), or continue it if it is
  // the one loaded. With no arguments, continues the loaded ayah. Never pauses.
  // `onError` runs if this start fails (the player's own state shows it too).
  play(globalId = this.currentGlobalId, ayahKey = this.currentAyahKey, { onError } = {}) {
    if (globalId == null) return;
    if (!this.isLoaded(globalId, ayahKey) || this.status === 'error') this._load(globalId, ayahKey);
    this._start(onError);
  }

  // The loaded ayah while it plays → pause it; anything else → play() it.
  toggle(globalId, ayahKey, options) {
    if (this.isLoaded(globalId, ayahKey) && this.isPlaying) this.pause();
    else this.play(globalId, ayahKey, options);
  }

  // Kept for existing callers (Recitation Quiz, Voice Finder): same as toggle().
  playGlobalVerse(globalId, ayahKey, options) {
    this.toggle(globalId, ayahKey, options);
  }

  pause() {
    this.audio.pause();
    if (this.isPlaying) this._setStatus('paused');
  }

  // Play the loaded ayah again from its start
  replay() {
    if (this.currentGlobalId == null) return;
    if (this.status === 'error') {
      this.play();
      return;
    }
    this.seek(0);
    this._start();
  }

  // Load the file again after a failure and play it
  retry() {
    if (this.currentGlobalId == null) return;
    this._load(this.currentGlobalId, this.currentAyahKey);
    this._start();
  }

  // Jump to a position in seconds. Keeps playing, or stays paused.
  seek(seconds) {
    if (this.currentGlobalId == null || this.status === 'error') return;
    const a = this.audio;
    const end = Number.isFinite(a.duration) ? a.duration : Infinity;
    const t = Math.min(Math.max(0, seconds || 0), end);
    a.currentTime = t;
    // Moving back from the end leaves the ayah paused there, not finished
    if (this.status === 'ended' && t < end) this._setStatus('paused');
    this._emit('time');
  }

  // Move by a number of seconds (negative goes back)
  skip(deltaSeconds) {
    this.seek(this.audio.currentTime + deltaSeconds);
  }

  // Unload: nothing is playing or loaded afterwards. load() drops the queued
  // 'pause' event, so element listeners don't hear one; on('state') reports 'idle'.
  stop() {
    const a = this.audio;
    a.pause();
    this.currentAyahKey = null;
    this.currentGlobalId = null;
    this.error = null;
    // Drop the file so a half-finished download stops too
    if (a.getAttribute('src')) {
      a.removeAttribute('src');
      a.load();
    }
    this._setStatus('idle', true);
  }

  setVolume(val) {
    this.audio.volume = val; // 0 to 1
  }

  setSpeed(speed) {
    this.audio.playbackRate = speed; // 0.5 to 2
  }

  // --- Internals ---

  _load(globalId, ayahKey) {
    this.currentGlobalId = globalId;
    this.currentAyahKey = ayahKey;
    this.error = null;
    this.audio.src = this.urlFor(globalId);
    this._setStatus('loading', true);
  }

  _start(onError) {
    const a = this.audio;
    const globalId = this.currentGlobalId;
    const ayahKey = this.currentAyahKey;
    this._setStatus(a.readyState >= HAVE_FUTURE_DATA ? 'playing' : 'loading');
    a.play().catch(e => {
      // A newer play(), pause() or file interrupted this one; that isn't a failure
      if (e?.name === 'AbortError') return;
      if (!this.isLoaded(globalId, ayahKey)) return; // another ayah has started since
      console.error('Audio playback failed:', e);
      this._fail(e);
      if (onError) onError(e);
    });
  }

  _fail(error) {
    this.error = error || new Error('Audio playback failed');
    this._setStatus('error', true);
  }

  _setStatus(status, force = false) {
    if (!force && status === this.status) return;
    this.status = status;
    this._emit('state');
  }

  _emit(type) {
    const callbacks = this.listeners.get(type);
    if (!callbacks || !callbacks.size) return;
    const state = this.getState();
    [...callbacks].forEach(callback => {
      try {
        callback(state);
      } catch (e) {
        console.error(`Audio player "${type}" listener failed:`, e);
      }
    });
  }
}

export const audioPlayer = new AudioPlayer();
