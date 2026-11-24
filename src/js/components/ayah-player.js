// Quran Firm Plant - Ayah player (Page Map)
//
// One controller for listening on the Page Map: it holds the only copy of
// what is playing and where, and the page and the player bar mirror it.
//
//   status: idle → loading → playing ⇄ paused → (gap) → ended, or error
//   'gap' is Echo's "Your turn": after an ayah, a silence as long as the ayah.
//
// It plays the surah file with quran.com's word timings when it can (word
// follow, word steps, exact loops), and one file per ayah when it can't.
//
// Ayah ends are checked on a timer and on 'timeupdate' against the audio clock,
// never only on animation frames: frames stop when the screen is off, and a
// loop would then run on into the next ayah. Frames only drive smooth visuals.
//
// Events (on(type, fn) returns an unsubscribe function; fn gets getState()):
//   'state'  status, ayah or settings changed
//   'time'   position moved (every frame while playing)
//   'word'   the word being recited changed
//   'pass'   an ayah was heard to the end once ({ key } in state.lastPass)

import {
  DEFAULT_RECITER, loadChapter, peekChapter, ayahUrl, ayahUrlSync, reciterInfo,
} from '../data/recitations.js';

export const REPEATS = [1, 2, 3, 5, Infinity];
export const RATES = [0.75, 1, 1.25, 1.5];
const RATE_CYCLE = [1, 1.25, 1.5, 0.75];

const BACK_WORD_MS = 600;     // Back one word: within this of a word's start, go to the previous word
const PREV_AYAH_MS = 1500;    // Previous ayah: within this of the ayah's start, go to the previous ayah
const NO_WORDS_STEP_MS = 2000; // word steps without word timings move this far instead
const END_EPS_MS = 20;        // this close to the ayah's end counts as the end
const HEARD_SHARE = 0.5;      // a pass counts as listened when at least this share was heard
const MIN_GAP_MS = 800;

const STORE = {
  reciter: 'pagemap-reciter',
  rate: 'pagemap-rate',
  repeat: 'pagemap-repeat',
  echo: 'pagemap-echo',
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function readStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage full or blocked */ }
}

export class AyahPlayer {
  // describe(verseKey) names an ayah for the lock screen, e.g. "At-Tariq 86:5"
  constructor({ describe = (key) => key } = {}) {
    this.describe = describe;
    this.listeners = new Map();

    const a = new Audio();
    a.preload = 'auto';
    a.preservesPitch = true;
    a.mozPreservesPitch = true;
    a.webkitPreservesPitch = true;
    this.audio = a;
    this.srcUrl = null;       // the URL we gave the element (a.src is normalised)

    this.order = [];          // ayahs on the page in reading order (previous / next)
    this.key = null;          // the loaded ayah
    this.track = null;        // how it plays: { key, reciter, surah, mode: 'timed'|'ayah', url, from, to, words }
    this.status = 'idle';
    this.error = null;
    this.pos = 0;             // ms into the ayah while it isn't running
    this.pendingPos = null;   // 'last-word' or { word } to place once the timings are known
    this.wordIndex = -1;
    this.loop = 0;            // passes finished in this selection
    this.heard = 0;           // ms of the ayah heard in this pass
    this.lastT = null;
    this.lastPass = null;
    this.pausedInGap = false;
    this.gapStart = 0;
    this.gapDur = 0;
    this.running = false;     // the element is meant to be playing the track
    this.token = 0;           // bumps when a pending start or load must be dropped
    this.timer = 0;
    this.raf = 0;
    this.gapTimer = 0;
    this.failedFiles = new Set(); // `${reciter}:${surah}` surah files that failed to load

    const savedReciter = parseInt(readStored(STORE.reciter), 10);
    this.reciterId = Number.isInteger(savedReciter) ? savedReciter : DEFAULT_RECITER;
    const savedRate = parseFloat(readStored(STORE.rate));
    this.rate = RATES.includes(savedRate) ? savedRate : 1;
    const savedRepeat = readStored(STORE.repeat);
    this.repeat = savedRepeat === 'inf' ? Infinity : (REPEATS.includes(Number(savedRepeat)) ? Number(savedRepeat) : 1);
    this.echo = readStored(STORE.echo) === '1';
    a.defaultPlaybackRate = this.rate;
    a.playbackRate = this.rate;

    this.onMedia = {
      playing: () => {
        clearTimeout(this.waitTimer);
        if (this.running && this.status === 'loading' && !a.paused) this.setStatus('playing');
      },
      // Buffering. A seek (a loop, a word step) waits a few ms; only a real
      // stall shows the spinner.
      waiting: () => {
        clearTimeout(this.waitTimer);
        this.waitTimer = setTimeout(() => {
          if (this.running && this.status === 'playing' && !a.paused && a.readyState < 3) this.setStatus('loading');
        }, 250);
      },
      // A pause we didn't ask for: Android audio focus, a headset button, the OS.
      // Ignore one that arrives after a newer play() (switching ayahs pauses first).
      pause: () => {
        if (!this.running || a.ended || !a.paused) return;
        this.pos = this.now();
        this.halt();
        this.setStatus('paused');
      },
      ended: () => {
        if (this.running) this.ayahEnd();
      },
      timeupdate: () => {
        if (this.running) this.check();
      },
      loadedmetadata: () => {
        // A position set before the file knew its length: make sure it took.
        // Nothing has played yet at this point, so the start position stands.
        if (this.track && this.srcUrl === this.track.url) {
          const want = (this.track.from + (this.running ? (this.lastT ?? this.pos) : this.pos)) / 1000;
          if (Math.abs(a.currentTime - want) > 0.25) {
            try { a.currentTime = want; } catch { /* not seekable */ }
          }
        }
        this.emit('time');
      },
      durationchange: () => this.emit('time'),
      error: () => {
        // Only the file we asked for (an aborted earlier load doesn't count)
        if (this.srcUrl && a.getAttribute('src') === this.srcUrl) this.mediaFailed(a.error);
      },
    };
    Object.entries(this.onMedia).forEach(([type, fn]) => a.addEventListener(type, fn));

    this.bindMediaSession();
  }

  // --- Listeners ---

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  emit(type) {
    const fns = this.listeners.get(type);
    if (fns?.size) {
      const state = this.getState();
      [...fns].forEach((fn) => {
        try { fn(state); } catch (e) { console.error(`Ayah player "${type}" listener failed:`, e); }
      });
    }
    if (type === 'state' || type === 'select') this.syncMediaSession();
  }

  // --- State ---

  get isActive() {
    return this.status === 'playing' || this.status === 'loading' || this.status === 'gap';
  }

  get reciter() {
    return reciterInfo(this.reciterId);
  }

  // ms into the loaded ayah
  position() {
    return this.running ? this.now() : this.pos;
  }

  duration() {
    const t = this.track;
    if (!t) return 0;
    if (t.mode === 'timed') return t.to - t.from;
    const d = this.audio.duration;
    return this.srcUrl === t.url && Number.isFinite(d) ? d * 1000 : 0;
  }

  getState() {
    const duration = this.duration();
    const index = this.order.indexOf(this.key);
    const gapElapsed = this.status === 'gap' ? performance.now() - this.gapStart : 0;
    return {
      key: this.key,
      status: this.status,
      error: this.error,
      position: clamp(this.position(), 0, duration || Infinity),
      duration,
      mode: this.track?.key === this.key ? this.track.mode : null,
      words: this.track?.key === this.key ? this.track.words : [],
      wordIndex: this.wordIndex,
      loop: this.loop,
      repeat: this.repeat,
      rate: this.rate,
      echo: this.echo,
      reciterId: this.reciterId,
      gapProgress: this.status === 'gap' ? clamp(gapElapsed / this.gapDur, 0, 1) : 0,
      gapLeft: this.status === 'gap' ? Math.max(0, this.gapDur - gapElapsed) : 0,
      hasPrev: index > 0,
      hasNext: index >= 0 && index < this.order.length - 1,
      lastPass: this.lastPass,
    };
  }

  // The page's ayahs in reading order
  setOrder(keys) {
    this.order = keys.slice();
    this.emit('state');
  }

  // Load the word timings for these surahs ahead of the first tap
  prefetch(surahs) {
    surahs.forEach((s) => {
      if (!this.failedFiles.has(`${this.reciterId}:${s}`)) loadChapter(this.reciterId, s);
    });
  }

  // --- Commands ---

  // Load an ayah and play it (or leave it paused). pos: ms, 'last-word' or
  // { word: position } (the word's first time in the recitation).
  select(key, { play = true, pos = 0 } = {}) {
    if (!key) return;
    this.token++;
    this.halt();
    clearTimeout(this.gapTimer);
    if (!this.audio.paused) this.audio.pause();

    this.key = key;
    this.loop = 0;
    this.heard = 0;
    this.lastT = null;
    this.pausedInGap = false;
    this.error = null;
    this.pendingPos = typeof pos === 'number' ? null : pos;
    this.pos = typeof pos === 'number' ? Math.max(0, pos) : 0;

    const track = this.trackFor(key);
    if (track && this.pendingPos != null) {
      this.pos = resolvePos(this.pendingPos, track);
      this.pendingPos = null;
    }
    this.track = track;
    this.setWord(track ? wordIndexAt(track.words, this.pos) : -1);
    this.emit('select');

    if (play) {
      this.start();
    } else {
      this.setStatus('paused', true);
      this.prepare();
    }
  }

  play() {
    if (!this.key) {
      if (this.order.length) this.select(this.order[0]);
      return;
    }
    if (this.status === 'playing' || this.status === 'loading') return;
    // In Echo's "Your turn": skip the rest of the silence
    if (this.status === 'gap' || this.pausedInGap) {
      this.afterPass();
      return;
    }
    // The selection is done: Play starts it again from the beginning
    if (this.status === 'ended') {
      this.loop = 0;
      this.pos = 0;
      this.heard = 0;
    }
    // After an error, load the file again rather than replaying the failure
    if (this.status === 'error') this.srcUrl = null;
    this.start();
  }

  pause() {
    if (this.status === 'gap') {
      clearTimeout(this.gapTimer);
      cancelAnimationFrame(this.raf);
      this.pausedInGap = true;
      this.setStatus('paused');
      return;
    }
    if (this.status !== 'playing' && this.status !== 'loading') return;
    if (this.running) this.pos = this.now();
    this.token++;
    this.halt();
    this.audio.pause();
    this.setStatus('paused');
  }

  toggle() {
    if (this.isActive) this.pause();
    else this.play();
  }

  // Jump to ms into the loaded ayah. Keeps playing, or stays paused.
  seek(ms) {
    if (!this.key) return;
    const dur = this.duration();
    let t = Math.max(0, Number(ms) || 0);
    if (dur > 0) t = Math.min(t, Math.max(0, dur - 30));
    const inGap = this.status === 'gap';
    clearTimeout(this.gapTimer);
    this.pausedInGap = false;
    this.pendingPos = null;
    this.pos = t;
    this.lastT = t;
    this.setWord(this.track ? wordIndexAt(this.track.words, t) : -1);

    if (inGap) {
      // Seeking during "Your turn" goes back to listening from there
      this.start();
      return;
    }
    if (this.status === 'ended') {
      this.loop = 0;
      this.setStatus('paused');
    }
    if (this.running) {
      this.seekElement(t);
      this.tick();
    } else if (this.track && this.srcUrl === this.track.url) {
      this.seekElement(t);
    }
    this.emit('time');
    this.syncPositionState();
  }

  // Start of this ayah; within 1.5 s of it, the previous ayah on the page
  prevAyah() {
    if (!this.key) return;
    if (this.status === 'ended') {
      this.seek(0); // the start of the selection, still stopped
      return;
    }
    if (this.position() > PREV_AYAH_MS) {
      this.seek(0);
      return;
    }
    const prev = this.neighbor(-1);
    if (prev) this.move(prev, 0);
    else this.seek(0);
  }

  // The next ayah on the page
  nextAyah() {
    if (!this.key) return;
    const next = this.neighbor(1);
    if (next) this.move(next, 0, this.isActive || this.status === 'ended');
  }

  // Start of the current word; within 0.6 s of it, the word before it in
  // reading order (from the first word, the previous ayah's last word)
  backWord() {
    if (!this.key || !this.track || this.track.key !== this.key) return;
    const words = this.track.words;
    if (!words.length) {
      this.seek(this.position() - NO_WORDS_STEP_MS);
      return;
    }
    if (this.status === 'ended') {
      this.seek(lastWordStart(words)); // the selection's last word
      return;
    }
    const to = backWordTarget(words, this.position());
    if (to !== 'prev') {
      this.seek(to);
      return;
    }
    const prev = this.neighbor(-1);
    if (prev) this.move(prev, 'last-word');
    else this.seek(0);
  }

  // The next word in reading order; after the last word, the next ayah
  fwdWord() {
    if (!this.key || !this.track || this.track.key !== this.key || this.status === 'ended') return;
    const words = this.track.words;
    const t = this.position();
    if (!words.length) {
      const dur = this.duration();
      if (dur && t + NO_WORDS_STEP_MS >= dur) this.nextAyah();
      else this.seek(t + NO_WORDS_STEP_MS);
      return;
    }
    const to = fwdWordTarget(words, t);
    if (to === 'next') this.nextAyah();
    else this.seek(to);
  }

  setRepeat(n) {
    if (!REPEATS.includes(n)) return;
    this.repeat = n;
    store(STORE.repeat, n === Infinity ? 'inf' : String(n));
    this.emit('state');
  }

  cycleRepeat() {
    this.setRepeat(REPEATS[(REPEATS.indexOf(this.repeat) + 1) % REPEATS.length]);
  }

  setRate(r) {
    if (!RATES.includes(r)) return;
    this.rate = r;
    store(STORE.rate, String(r));
    this.audio.defaultPlaybackRate = r;
    this.audio.playbackRate = r;
    if (this.running) this.tick(); // the time left to the ayah's end changed
    this.emit('state');
  }

  cycleRate() {
    const i = RATE_CYCLE.indexOf(this.rate);
    this.setRate(RATE_CYCLE[(i + 1) % RATE_CYCLE.length]);
  }

  setEcho(on) {
    this.echo = !!on;
    store(STORE.echo, this.echo ? '1' : '0');
    if (!this.echo && this.status === 'gap') {
      this.afterPass();
      return;
    }
    if (!this.echo && this.pausedInGap) this.pausedInGap = false;
    this.emit('state');
  }

  // Switch reciter, staying on the same ayah and word, playing or paused
  setReciter(id) {
    if (!Number.isInteger(id) || id === this.reciterId) return;
    this.reciterId = id;
    store(STORE.reciter, String(id));
    // The new reciter's timings for every surah on the page
    this.prefetch([...new Set(this.order.map((k) => Number(k.split(':')[0])))]);
    if (!this.key) {
      this.emit('state');
      return;
    }
    // The same word by position: reciters repeat different words, so the
    // index in the time-ordered list doesn't carry over
    const word = this.status !== 'ended' && this.wordIndex >= 0 ? this.track?.words?.[this.wordIndex] : null;
    const play = this.isActive;
    this.track = null;
    this.select(this.key, { play, pos: word ? { word: word.pos } : 0 });
  }

  // Try again after an error
  retry() {
    if (!this.key) return;
    this.srcUrl = null; // reload the file
    this.start();
  }

  // Unload: nothing is loaded afterwards
  stop() {
    this.token++;
    this.halt();
    clearTimeout(this.gapTimer);
    this.key = null;
    this.track = null;
    this.pos = 0;
    this.pendingPos = null;
    this.loop = 0;
    this.heard = 0;
    this.pausedInGap = false;
    this.error = null;
    this.wordIndex = -1;
    const a = this.audio;
    a.pause();
    if (a.getAttribute('src')) {
      a.removeAttribute('src');
      a.load();
    }
    this.srcUrl = null;
    this.setStatus('idle', true);
  }

  destroy() {
    this.stop();
    Object.entries(this.onMedia).forEach(([type, fn]) => this.audio.removeEventListener(type, fn));
    this.unbindMediaSession();
    this.listeners.clear();
  }

  // --- Internals: tracks ---

  neighbor(dir) {
    const i = this.order.indexOf(this.key);
    return i < 0 ? null : this.order[i + dir] || null;
  }

  move(key, pos, play = this.isActive) {
    this.select(key, { play, pos });
  }

  // The track for an ayah if it can be built without waiting for a request
  trackFor(key) {
    if (this.track && this.track.key === key && this.track.reciter === this.reciterId
        && !(this.track.mode === 'timed' && this.failedFiles.has(this.track.fileKey))) {
      return this.track;
    }
    const surah = Number(key.split(':')[0]);
    const fileKey = `${this.reciterId}:${surah}`;
    if (!this.failedFiles.has(fileKey)) {
      const chapter = peekChapter(this.reciterId, surah);
      if (chapter === undefined) return null; // still loading: wait for it
      const v = chapter?.verses.get(key);
      if (v) {
        return { key, reciter: this.reciterId, surah, fileKey, mode: 'timed', url: chapter.audioUrl, from: v.from, to: v.to, words: v.words };
      }
    }
    const url = ayahUrlSync(this.reciterId, key);
    return url ? { key, reciter: this.reciterId, surah, fileKey, mode: 'ayah', url, from: 0, to: null, words: [] } : null;
  }

  async resolveTrack(key) {
    const surah = Number(key.split(':')[0]);
    const reciter = this.reciterId;
    if (!this.failedFiles.has(`${reciter}:${surah}`)) await loadChapter(reciter, surah);
    const track = this.trackFor(key);
    if (track) return track;
    const url = await ayahUrl(reciter, key);
    if (!url) throw new Error(`No recitation found for ${key}`);
    return { key, reciter, surah, fileKey: `${reciter}:${surah}`, mode: 'ayah', url, from: 0, to: null, words: [] };
  }

  // Run fn(track) with the loaded ayah's track, now or once it's known
  withTrack(token, fn, onError) {
    const track = this.trackFor(this.key);
    if (track) {
      fn(track);
      return;
    }
    this.resolveTrack(this.key).then((t) => {
      if (token === this.token) fn(t);
    }, (e) => {
      if (token === this.token && onError) onError(e);
    });
  }

  useTrack(track) {
    this.track = track;
    const a = this.audio;
    if (this.srcUrl !== track.url) {
      this.srcUrl = track.url;
      a.src = track.url;
    }
    a.defaultPlaybackRate = this.rate;
    a.playbackRate = this.rate;
    if (this.pendingPos != null) {
      this.pos = resolvePos(this.pendingPos, track);
      this.pendingPos = null;
    }
    this.setWord(wordIndexAt(track.words, this.pos));
  }

  seekElement(ms) {
    if (!this.track) return;
    const t = (this.track.from + ms) / 1000;
    // Already there (a resume after Pause): a seek would only make it buffer
    if (this.audio.readyState >= 1 && Math.abs(this.audio.currentTime - t) < 0.03) return;
    try {
      this.audio.currentTime = t;
    } catch {
      // Not seekable yet; loadedmetadata applies it
    }
  }

  // Paused selection: find the track and load the file, so the bar can show
  // its length and word ticks before Play
  prepare() {
    const token = this.token;
    this.withTrack(token, (track) => {
      this.useTrack(track);
      this.seekElement(this.pos);
      this.emit('state');
    }, () => {});
  }

  start() {
    const token = ++this.token;
    this.halt();
    clearTimeout(this.gapTimer);
    this.pausedInGap = false;
    this.error = null;
    // The same file with data at hand (another pass, a resume): no spinner
    const ready = this.track && this.track.key === this.key && this.srcUrl === this.track.url
      && this.audio.readyState >= 3;
    this.setStatus(ready ? 'playing' : 'loading');
    this.withTrack(token, (track) => {
      this.useTrack(track);
      const a = this.audio;
      this.seekElement(this.pos);
      this.lastT = this.pos;
      this.running = true;
      let playing;
      try {
        playing = a.play();
      } catch (e) {
        playing = Promise.reject(e);
      }
      Promise.resolve(playing).then(() => {
        if (token !== this.token || !this.running) return;
        if (this.status === 'loading' && !a.paused) this.setStatus('playing');
        this.tick();
      }, (e) => {
        if (token !== this.token) return;
        if (e?.name === 'AbortError') return; // a newer load or pause interrupted it
        this.mediaFailed(e);
      });
      this.tick();
      this.syncPositionState();
    }, (e) => this.fail(e));
  }

  // The surah file failed: play this surah ayah by ayah from now on. An ayah
  // file failed: show the error.
  mediaFailed(error) {
    const track = this.track;
    if (!track || !this.key) return;
    if (error?.name === 'NotAllowedError') {
      // The browser wants a tap before it plays (an Echo gap ended in the background)
      this.pos = this.running ? this.now() : this.pos;
      this.halt();
      this.setStatus('paused');
      return;
    }
    const wasLoading = this.status === 'loading' || this.status === 'playing' || this.running;
    if (track.mode === 'timed') {
      console.warn(`Surah file failed (${track.url}); playing ayah by ayah.`, error);
      this.failedFiles.add(track.fileKey);
      if (this.running) this.pos = this.now();
      this.halt();
      this.track = null;
      this.srcUrl = null;
      // The ayah's own file covers the same recitation, so the place carries over
      if (wasLoading) this.start();
      else this.prepare();
      return;
    }
    if (!wasLoading && this.status !== 'paused') return;
    this.halt();
    this.fail(error);
  }

  fail(error) {
    this.halt();
    this.error = error || new Error('Playback failed');
    this.setStatus('error', true);
  }

  // --- Internals: the clock ---

  // ms into the ayah, from the element
  now() {
    if (!this.track) return this.pos;
    const t = this.audio.currentTime * 1000 - this.track.from;
    const dur = this.duration();
    return clamp(t, 0, dur || Infinity);
  }

  halt() {
    this.running = false;
    this.lastT = null;
    clearTimeout(this.timer);
    clearTimeout(this.waitTimer);
    cancelAnimationFrame(this.raf);
  }

  // One check, run on animation frames (smooth follow), on a timer and on
  // timeupdate (both keep going with the screen off)
  check() {
    if (!this.running || !this.track) return false;
    const t = this.now();
    if (this.lastT != null && t > this.lastT) this.heard += t - this.lastT;
    this.lastT = t;
    if (this.track.mode === 'timed' && t >= this.duration() - END_EPS_MS) {
      this.ayahEnd();
      return false;
    }
    this.setWord(wordIndexAt(this.track.words, t));
    this.emit('time');
    return true;
  }

  tick() {
    clearTimeout(this.timer);
    cancelAnimationFrame(this.raf);
    if (!this.running) return;
    const frame = () => {
      if (this.check()) this.raf = requestAnimationFrame(frame);
    };
    const timed = () => {
      if (!this.check()) return;
      let wait = 250;
      if (this.track.mode === 'timed') {
        const left = (this.duration() - this.now()) / (this.audio.playbackRate || 1);
        wait = clamp(left, 10, 250);
      }
      this.timer = setTimeout(timed, wait);
    };
    this.raf = requestAnimationFrame(frame);
    this.timer = setTimeout(timed, 20);
  }

  // The ayah reached its end (timer, timeupdate or the file's own end)
  ayahEnd() {
    const dur = this.duration() || this.now();
    const heard = this.heard + (this.lastT != null ? Math.max(0, dur - this.lastT) : 0);
    this.halt();
    this.audio.pause();
    this.pos = dur;
    this.heard = 0;
    this.loop += 1;
    if (dur > 0 && heard >= dur * HEARD_SHARE) {
      this.lastPass = { key: this.key, loop: this.loop, at: Date.now() };
      this.emit('pass');
    }
    if (this.echo) {
      this.startGap(dur / this.rate);
      return;
    }
    this.afterPass();
  }

  startGap(ms) {
    this.gapDur = Math.max(MIN_GAP_MS, ms);
    this.gapStart = performance.now();
    this.setStatus('gap');
    this.gapTimer = setTimeout(() => {
      if (this.status === 'gap') this.afterPass();
    }, this.gapDur);
    const frame = () => {
      if (this.status !== 'gap') return;
      this.emit('time');
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
    this.syncPositionState();
  }

  // Another pass, or done
  afterPass() {
    clearTimeout(this.gapTimer);
    cancelAnimationFrame(this.raf);
    this.pausedInGap = false;
    if (this.loop < this.repeat) {
      this.pos = 0;
      this.heard = 0;
      this.start();
      return;
    }
    this.pos = this.duration();
    this.setStatus('ended');
  }

  setWord(i) {
    if (i === this.wordIndex) return;
    this.wordIndex = i;
    this.emit('word');
  }

  setStatus(status, force = false) {
    if (!force && status === this.status) return;
    this.status = status;
    this.emit('state');
  }

  // --- Lock screen / notification (Media Session) ---

  bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const handlers = {
      play: () => this.play(),
      pause: () => this.pause(),
      stop: () => this.pause(),
      previoustrack: () => this.prevAyah(),
      nexttrack: () => this.nextAyah(),
      seekbackward: () => this.backWord(),
      seekforward: () => this.fwdWord(),
      seekto: (d) => {
        if (d && Number.isFinite(d.seekTime)) this.seek(d.seekTime * 1000);
      },
    };
    this.mediaActions = Object.keys(handlers);
    Object.entries(handlers).forEach(([action, fn]) => {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch {
        // This browser doesn't know the action
      }
    });
  }

  unbindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    (this.mediaActions || []).forEach((action) => {
      try { navigator.mediaSession.setActionHandler(action, null); } catch { /* ignore */ }
    });
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    } catch { /* ignore */ }
  }

  syncMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      if (!this.key || this.status === 'idle') {
        ms.metadata = null;
        ms.playbackState = 'none';
        this.mediaTitle = null;
        return;
      }
      const r = this.reciter;
      const title = `${this.describe(this.key)} · ${r.short}`;
      if (title !== this.mediaTitle && typeof MediaMetadata === 'function') {
        ms.metadata = new MediaMetadata({ title, artist: r.name, album: 'Quran Firm Plant' });
        this.mediaTitle = title;
      }
      ms.playbackState = this.isActive ? 'playing' : 'paused';
    } catch {
      // Media Session is best effort
    }
    this.syncPositionState();
  }

  syncPositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const dur = this.duration();
    try {
      if (!this.key || !dur) return;
      navigator.mediaSession.setPositionState({
        duration: dur / 1000,
        playbackRate: this.rate,
        position: clamp(this.position(), 0, dur) / 1000,
      });
    } catch {
      // Ignore positions the browser rejects
    }
  }
}

// Index of the word being recited at t (ms into the ayah): the last word that
// has started, or the first word before any has. -1 without word timings.
export function wordIndexAt(words, t) {
  if (!words?.length) return -1;
  let i = 0;
  for (let j = 0; j < words.length; j++) {
    if (t >= words[j].st) i = j;
    else break;
  }
  return i;
}

// --- Word steps ---
//
// `words` is in time order, as heard, and a reciter sometimes goes back and
// repeats words: Alafasy reads 4:75 as 1…14, 13, 14, 15…23, 22, 23, 24…31.
// Follow uses that order, so the word underlined is the one being recited.
// The word steps go by reading order instead (word positions): Back is always
// the word before, Forward the word after, never a later or far-off word.
// When the target word is heard more than once, a step picks the occurrence
// nearest to the current one on its own side:
//   Back:    the latest occurrence that starts before the current word
//            (from the repeated 13 of 4:75, back to 12; from 15, back to the
//            repeated 14)
//   Forward: the first occurrence that starts after the current word
//            (from the first 14, on to 15, past the repeat)
// and, if there is none on that side, the nearest one on the other.

// Where Back one word goes from t (ms into the ayah): a time in the ayah, or
// 'prev' for the previous ayah's last word.
export function backWordTarget(words, t) {
  const i = wordIndexAt(words, t);
  if (i < 0) return 'prev';
  const cur = words[i];
  if (t - cur.st > BACK_WORD_MS) return cur.st;
  // The word before in reading order (a word without timings is skipped)
  let pos = -Infinity;
  for (const w of words) if (w.pos < cur.pos && w.pos > pos) pos = w.pos;
  return pos === -Infinity ? 'prev' : nearestOccurrence(words, pos, i, -1).st;
}

// Where Forward one word goes from t: a time in the ayah, or 'next' for the
// next ayah.
export function fwdWordTarget(words, t) {
  const i = wordIndexAt(words, t);
  if (i < 0) return 'next';
  const cur = words[i];
  if (t < cur.st) return cur.st; // before the first word starts
  let pos = Infinity;
  for (const w of words) if (w.pos > cur.pos && w.pos < pos) pos = w.pos;
  return pos === Infinity ? 'next' : nearestOccurrence(words, pos, i, 1).st;
}

// The occurrence of the word at `pos` nearest to index i in direction dir
// (-1 earlier, 1 later), else the nearest in the other direction
function nearestOccurrence(words, pos, i, dir) {
  for (let j = i + dir; j >= 0 && j < words.length; j += dir) if (words[j].pos === pos) return words[j];
  for (let j = i - dir; j >= 0 && j < words.length; j -= dir) if (words[j].pos === pos) return words[j];
  return words[i];
}

// The start of the ayah's last word in reading order, the last time it's heard
export function lastWordStart(words) {
  if (!words?.length) return 0;
  let last = words[0];
  for (const w of words) if (w.pos >= last.pos) last = w;
  return last.st;
}

// Where each word is first heard, in reading order: [{ pos, st }]
export function firstHearings(words) {
  const seen = new Map();
  (words || []).forEach((w) => { if (!seen.has(w.pos)) seen.set(w.pos, w.st); });
  return [...seen].map(([pos, st]) => ({ pos, st })).sort((a, b) => a.pos - b.pos);
}

function resolvePos(pos, track) {
  if (typeof pos === 'number') return pos;
  const words = track.words || [];
  if (!words.length) return 0;
  if (pos === 'last-word') return lastWordStart(words);
  if (pos && Number.isInteger(pos.word)) {
    // The word's first time, or the next word that has a timing
    const first = firstHearings(words);
    return (first.find((w) => w.pos >= pos.word) || first[first.length - 1]).st;
  }
  return 0;
}
