// Quran Firm Plant - ASR engine preference
// Lets the recitation-recording features (Voice Finder, Recitation Quiz) share
// one switch between the two speech-to-text engines while we test/tune both:
//   - 'browser': native Web Speech API (SpeechRecognition) - cloud based, near
//     instant streaming results, generally the more accurate option when online.
//   - 'whisper': on-device Tarteel-tuned Whisper model - fully offline/private,
//     but slower and currently less accurate; kept around for offline use and
//     further tuning.

const STORAGE_KEY = 'quran-asr-engine';
const DEFAULT_ENGINE = 'browser';

export function getAsrEngine() {
  const stored = localStorage.getItem(STORAGE_KEY);
  return (stored === 'browser' || stored === 'whisper') ? stored : DEFAULT_ENGINE;
}

export function setAsrEngine(engine) {
  localStorage.setItem(STORAGE_KEY, engine === 'whisper' ? 'whisper' : 'browser');
}
