// Quran Firm Plant - Shared Audio Player Component
// Handles playing audio streams for specific verses from CDNs.

export class AudioPlayer {
  constructor() {
    this.audio = new Audio();
    this.isPlaying = false;
    this.currentAyahKey = null;
    this.currentGlobalId = null;
    
    this.onPlayCallback = null;
    this.onPauseCallback = null;
    this.onEndedCallback = null;
    
    this.audio.addEventListener('play', () => {
      this.isPlaying = true;
      if (this.onPlayCallback) this.onPlayCallback(this.currentAyahKey);
    });

    this.audio.addEventListener('pause', () => {
      this.isPlaying = false;
      if (this.onPauseCallback) this.onPauseCallback(this.currentAyahKey);
    });

    this.audio.addEventListener('ended', () => {
      this.isPlaying = false;
      if (this.onEndedCallback) this.onEndedCallback(this.currentAyahKey);
    });
  }

  // Play audio for a verse using its absolute/global verse number (1 - 6236).
  // `onError`, if given, handles a failed start instead of the alert() (e.g. to show it inline).
  playGlobalVerse(globalId, ayahKey, { onError } = {}) {
    if (this.isPlaying && this.currentGlobalId === globalId) {
      this.pause();
      return;
    }

    this.currentAyahKey = ayahKey;
    this.currentGlobalId = globalId;

    // Al-Quran Cloud audio stream (Mishary Rashid Alafasy)
    this.audio.src = `https://cdn.islamic.network/quran/audio/128/ar.alafasy/${globalId}.mp3`;
    this.audio.play().catch(e => {
      // A newer play() or pause() interrupted this one; that isn't a failure
      if (e?.name === 'AbortError') return;
      console.error('Audio playback failed:', e);
      if (onError) onError(e);
      else alert('Could not stream audio. Please check your internet connection.');
    });
  }

  pause() {
    this.audio.pause();
  }

  stop() {
    this.audio.pause();
    this.audio.currentTime = 0;
    this.isPlaying = false;
  }

  setVolume(val) {
    this.audio.volume = val; // 0 to 1
  }

  setSpeed(speed) {
    this.audio.playbackRate = speed; // 0.5 to 2
  }

  onPlay(callback) { this.onPlayCallback = callback; }
  onPause(callback) { this.onPauseCallback = callback; }
  onEnded(callback) { this.onEndedCallback = callback; }
}

export const audioPlayer = new AudioPlayer();
