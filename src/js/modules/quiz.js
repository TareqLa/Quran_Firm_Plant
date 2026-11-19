// Quran Firm Plant - Recitation Quiz Module
// Tests memorization by guessing verse sources or continuing recitation via microphone.

import { db } from '../data/db.js';
import { SURAH_LIST } from '../components/surah-selector.js';
import { normalizeArabic, levenshteinDistance } from '../utils/normalize.js';
import { audioPlayer } from '../components/audio-player.js';
import { quranASR, QuranASR } from '../utils/asr.js';
import { getAsrEngine, setAsrEngine } from '../utils/asr-engine-pref.js';

export class RecitationQuizModule {
  constructor(contentContainerId) {
    this.container = document.getElementById(contentContainerId);
    this.currentSurah = 87; // Default Al-A'la
    this.ayahs = [];
    this.quizType = 'guess-source'; // 'guess-source', 'continue-reciting'
    
    // Quiz state
    this.currentQuestion = null;
    this.streak = 0;
    this.score = 0;
    this.totalQuestions = 0;
    this.answered = false;
    this.isCorrect = false;
    this.userAnswer = null;

    // Voice recognition for continue reciting mode
    this.recognition = null;
    this.isRecording = false;
    this.isTranscribing = false;
    this.recordedText = '';

    // Two selectable engines while we test/tune both (see asr-engine-pref.js):
    // browser SpeechRecognition (fast, cloud-based, default) or the on-device
    // Tarteel Whisper model (offline, currently slower/less accurate).
    this.whisperSupported = QuranASR.isSupported();
    this.useWhisper = this.whisperSupported && getAsrEngine() === 'whisper';
    this.initSpeechRecognition();
  }

  async toggleWhisperRecitation() {
    if (this.isTranscribing) return;

    const box = document.getElementById('quiz-transcription');
    const micBtn = document.getElementById('quiz-mic-btn');

    if (!quranASR.isRecording) {
      try {
        if (!quranASR.modelReady) {
          if (box) box.innerText = 'Loading recitation model (first time only)...';
          await quranASR.ensureLoaded((pct, phase) => {
            if (box) box.innerText = phase === 'warming'
              ? 'Preparing the on-device recitation model...'
              : `Loading Tarteel Whisper model... ${pct}%`;
          });
        }
        this.isRecording = true;
        if (micBtn) {
          micBtn.classList.add('listening');
          micBtn.style.backgroundColor = 'var(--color-error)';
        }
        if (box) box.innerText = 'Listening... recite the next verse, then tap the mic to stop.';

        await quranASR.startRecording((text) => {
          if (!text || !this.isRecording) return;
          this.recordedText = text;
          if (box) {
            box.dir = 'rtl';
            box.innerText = text;
          }
        });
      } catch (e) {
        console.error('On-device ASR failed:', e);
        if (e.name === 'NotAllowedError' || e.name === 'NotFoundError') {
          if (box) box.innerText = 'Microphone unavailable. Please allow microphone access.';
          return;
        }
        this.useWhisper = false;
        if (this.recognition) {
          this.recognition.start();
        } else if (box) {
          box.innerText = 'Speech recognition is not available in this browser.';
        }
      }
    } else {
      this.isRecording = false;
      this.isTranscribing = true;
      this.updateMicUI();
      if (box) box.innerText = 'Transcribing your recitation on-device...';

      try {
        const text = await quranASR.stopAndTranscribe();
        this.isTranscribing = false;

        if (!text) {
          if (box) box.innerText = 'No speech detected. Tap the mic and try again.';
          return;
        }

        this.recordedText = text;
        if (box) {
          box.dir = 'rtl';
          box.innerText = text;
        }
        this.checkRecitationAnswer(text);
      } catch (e) {
        console.error('Transcription failed:', e);
        this.isTranscribing = false;
        if (box) box.innerText = 'Transcription failed. Tap the mic and try again.';
      }
    }
  }

  initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    this.recognition = new SpeechRecognition();
    this.recognition.lang = 'ar-SA';
    this.recognition.continuous = false;
    this.recognition.interimResults = false;

    this.recognition.onstart = () => {
      this.isRecording = true;
      this.recordedText = '';
      const micBtn = document.getElementById('quiz-mic-btn');
      if (micBtn) {
        micBtn.classList.add('listening');
        micBtn.style.backgroundColor = 'var(--color-error)';
      }
      const box = document.getElementById('quiz-transcription');
      if (box) box.innerText = 'Listening to your recitation...';
    };

    this.recognition.onerror = (e) => {
      console.error(e);
      this.isRecording = false;
      this.updateMicUI();
      const box = document.getElementById('quiz-transcription');
      if (box) box.innerText = 'Error capturing audio. Please tap mic and try again.';
    };

    this.recognition.onend = () => {
      this.isRecording = false;
      this.updateMicUI();
    };

    this.recognition.onresult = (e) => {
      if (e.results.length > 0) {
        this.recordedText = e.results[0][0].transcript;
        const box = document.getElementById('quiz-transcription');
        if (box) {
          box.dir = 'rtl';
          box.innerText = this.recordedText;
        }
        this.checkRecitationAnswer(this.recordedText);
      }
    };
  }

  updateMicUI() {
    const micBtn = document.getElementById('quiz-mic-btn');
    if (micBtn) {
      micBtn.classList.remove('listening');
      micBtn.style.backgroundColor = '';
    }
  }

  async loadSurah(surahNumber) {
    this.currentSurah = surahNumber;
    this.streak = 0;
    this.score = 0;
    this.totalQuestions = 0;

    try {
      this.ayahs = await db.getSurahText(surahNumber);
      if (this.ayahs.length === 0) {
        throw new Error('Local database empty');
      }

      this.generateQuestion();
      this.render();
      this.setupEvents();
    } catch (e) {
      console.error(e);
      this.container.innerHTML = `<div class="card" style="text-align: center; color: var(--color-error); padding: 40px;">Database empty. Seed data first.</div>`;
    }
  }

  render() {
    this.container.innerHTML = `
      <div class="blank-page-controls" style="margin-bottom: 24px;">
        <div class="toolbar-group">
          <button class="btn-outline qmode-btn ${this.quizType === 'guess-source' ? 'active' : ''}" data-mode="guess-source">Identify Source</button>
          <button class="btn-outline qmode-btn ${this.quizType === 'continue-reciting' ? 'active' : ''}" data-mode="continue-reciting">Continue Reciting</button>
        </div>
        <div class="toolbar-group" style="margin-left: auto; color: var(--text-secondary); font-size: 0.9rem; align-items: center; gap: 16px;">
          <span>Score: <strong>${this.score}/${this.totalQuestions}</strong></span>
          <span style="border-left: 1px solid var(--border-color); padding-left: 16px; color: var(--accent-gold);">Streak: <strong>🔥 ${this.streak}</strong></span>
        </div>
      </div>

      <div class="line-connector-card" style="margin-top: 12px;">
        ${this.renderQuizBox()}
      </div>
    `;

    this.setupEvents();
  }

  renderQuizBox() {
    if (!this.currentQuestion) return 'Loading question...';

    const q = this.currentQuestion;

    if (this.quizType === 'guess-source') {
      return `
        <div class="line-connector-prompt card">
          <span class="prompt-label">Where is this Ayah from?</span>
          <div class="prompt-verse" style="margin-top: 16px; margin-bottom: 8px;">${q.ayahText}</div>
          <span class="prompt-label" style="color: var(--accent-gold);">Ayah ${q.ayahNum}</span>
        </div>

        <div class="line-connector-options" style="margin-top: 12px;">
          ${q.options.map(opt => {
            let cls = '';
            if (this.answered) {
              if (opt.id === q.correctSurahId) {
                cls = 'correct';
              } else if (opt.id === this.userAnswer) {
                cls = 'incorrect';
              }
            }
            return `<button class="option-btn option-quiz-btn ${cls}" data-id="${opt.id}" ${this.answered ? 'disabled' : ''}>${opt.nameEn} (${opt.name})</button>`;
          }).join('')}
        </div>

        <div id="quiz-feedback-box" class="card" style="display: ${this.answered ? 'block' : 'none'}; text-align: center; margin-top: 20px;">
          <h4 style="color: ${this.isCorrect ? 'var(--color-success)' : 'var(--color-error)'}; margin-bottom: 8px;">
            ${this.isCorrect ? 'Correct!' : 'Incorrect'}
          </h4>
          <p>This verse belongs to <strong>Surah ${SURAH_LIST.find(s => s.id === q.correctSurahId).nameEn}</strong>.</p>
          <button id="next-quiz-btn" class="btn-gold" style="margin-top: 16px;">Next Question</button>
        </div>
      `;
    }

    if (this.quizType === 'continue-reciting') {
      return `
        <div class="line-connector-prompt card">
          <span class="prompt-label">Recite the NEXT Ayah from memory:</span>
          <div class="prompt-verse" style="margin-top: 16px; margin-bottom: 12px; color: var(--text-secondary);">${q.ayahText}</div>
          <span class="prompt-label" style="color: var(--accent-gold);">${q.surahNameEn} : Ayah ${q.ayahNum}</span>
        </div>

        <div class="card" style="display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 24px; text-align: center;">
          <div id="quiz-mic-container" class="mic-btn-container" style="width: 100px; height: 100px;">
            <div class="mic-pulse-ring"></div>
            <button id="quiz-mic-btn" class="mic-btn" style="width: 76px; height: 76px;" title="Start Reciting">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              </svg>
            </button>
          </div>

          <div id="quiz-transcription" style="font-size: 1rem; color: var(--text-secondary); font-style: italic;">
            Tap microphone and recite the next verse...
          </div>

          ${this.recognition && this.whisperSupported ? `
          <div style="display: flex; align-items: center; gap: 8px; font-size: 0.8rem; color: var(--text-muted);">
            <span>Recognition engine (testing):</span>
            <button id="quiz-engine-toggle" class="btn-outline" style="padding: 3px 10px; font-size: 0.78rem; border-radius: var(--border-radius-sm);">
              ${this.useWhisper ? 'On-device Whisper' : 'Browser (live)'}
            </button>
          </div>
          ` : ''}
        </div>

        <div id="quiz-recite-feedback" class="card" style="display: ${this.answered ? 'block' : 'none'}; text-align: center; margin-top: 20px;">
          <h4 style="color: ${this.isCorrect ? 'var(--color-success)' : 'var(--color-error)'}; margin-bottom: 12px;">
            ${this.isCorrect ? 'Correct recitation! Excellent.' : 'Correction needed:'}
          </h4>
          <div style="margin-bottom: 16px;">
            <div class="prompt-label" style="margin-bottom: 6px;">Correct Next Verse (Ayah ${q.nextAyahNum}):</div>
            <div class="quran-text" style="font-size: 2rem; color: var(--accent-gold);">${q.nextAyahText}</div>
          </div>
          <div style="display: flex; justify-content: center; gap: 12px;">
            <button id="quiz-play-btn" class="btn-outline" data-global-id="${q.nextGlobalId}">Play Recitation</button>
            <button id="next-quiz-btn" class="btn-gold">Next Question</button>
          </div>
        </div>
      `;
    }

    return '';
  }

  generateQuestion() {
    this.answered = false;
    this.userAnswer = null;

    if (this.quizType === 'guess-source') {
      // Pick a random ayah from this Surah
      const randIdx = Math.floor(Math.random() * this.ayahs.length);
      const ayah = this.ayahs[randIdx];

      // Distractors: pick 2 other random Surahs
      const correctSurahId = ayah.surah;
      const filteredSurahs = SURAH_LIST.filter(s => s.id !== correctSurahId);
      
      const distractors = [];
      while (distractors.length < 2 && filteredSurahs.length > 0) {
        const idx = Math.floor(Math.random() * filteredSurahs.length);
        distractors.push(filteredSurahs.splice(idx, 1)[0]);
      }

      const correctSurahObj = SURAH_LIST.find(s => s.id === correctSurahId);
      const options = [correctSurahObj, ...distractors].sort(() => Math.random() - 0.5);

      this.currentQuestion = {
        ayahText: ayah.text,
        ayahNum: ayah.ayah,
        correctSurahId,
        options
      };
    }

    if (this.quizType === 'continue-reciting') {
      // Pick a random ayah that has a next ayah in this Surah
      const randIdx = Math.floor(Math.random() * (this.ayahs.length - 1));
      const ayah = this.ayahs[randIdx];
      const nextAyah = this.ayahs[randIdx + 1];

      this.currentQuestion = {
        surahNameEn: ayah.surahNameEn,
        ayahNum: ayah.ayah,
        ayahText: ayah.text,
        nextAyahNum: nextAyah.ayah,
        nextAyahText: nextAyah.text,
        nextGlobalId: nextAyah.globalId
      };
    }
  }

  checkGuessAnswer(selectedId) {
    if (this.answered) return;

    this.answered = true;
    this.userAnswer = selectedId;
    this.totalQuestions++;
    
    const correctId = this.currentQuestion.correctSurahId;
    this.isCorrect = (selectedId === correctId);
    
    if (this.isCorrect) {
      this.score++;
      this.streak++;
    } else {
      this.streak = 0;
    }

    this.render();
  }

  checkRecitationAnswer(transcription) {
    if (this.answered) return;

    const correctText = this.currentQuestion.nextAyahText;
    const normTyped = normalizeArabic(transcription);
    const normCorrect = normalizeArabic(correctText);

    // Compute Levenshtein distance similarity
    const dist = levenshteinDistance(normTyped, normCorrect);
    const maxLen = Math.max(normTyped.length, normCorrect.length);
    const similarity = 1 - dist / maxLen;

    this.answered = true;
    this.totalQuestions++;
    this.isCorrect = (similarity > 0.65); // 65% match passes for spoken recitation

    if (this.isCorrect) {
      this.score++;
      this.streak++;
    } else {
      this.streak = 0;
    }

    this.render();
  }

  setupEvents() {
    // Mode switcher buttons
    this.container.querySelectorAll('.qmode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.container.querySelectorAll('.qmode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.quizType = btn.dataset.mode;
        this.generateQuestion();
        this.render();
      });
    });

    // Answer click handler (Identify Source)
    if (this.quizType === 'guess-source' && !this.answered) {
      this.container.querySelectorAll('.option-quiz-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = parseInt(btn.dataset.id);
          this.checkGuessAnswer(id);
        });
      });
    }

    // Audio mic click handler (Continue Reciting)
    if (this.quizType === 'continue-reciting' && !this.answered) {
      document.getElementById('quiz-mic-btn')?.addEventListener('click', () => {
        if (this.useWhisper) {
          this.toggleWhisperRecitation();
          return;
        }

        if (!this.recognition) {
          alert('Speech Recognition not supported in this browser. Please use Chrome or Edge.');
          return;
        }

        if (this.isRecording) {
          this.recognition.stop();
        } else {
          this.recognition.start();
        }
      });

      document.getElementById('quiz-engine-toggle')?.addEventListener('click', () => {
        if (this.isRecording || this.isTranscribing) return; // don't swap mid-recording
        this.useWhisper = !this.useWhisper;
        setAsrEngine(this.useWhisper ? 'whisper' : 'browser');
        const btn = document.getElementById('quiz-engine-toggle');
        if (btn) btn.innerText = this.useWhisper ? 'On-device Whisper' : 'Browser (live)';
      });
    }

    // Play next recitation button handler
    if (this.answered) {
      document.getElementById('quiz-play-btn')?.addEventListener('click', (e) => {
        const globalId = parseInt(e.target.dataset.globalId);
        audioPlayer.playGlobalVerse(globalId, `quiz-${globalId}`);
      });
    }

    // Next question button
    document.getElementById('next-quiz-btn')?.addEventListener('click', () => {
      audioPlayer.stop();
      this.generateQuestion();
      this.render();
    });
  }
}
