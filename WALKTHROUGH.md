# Quran Firm Plant — Project Walkthrough

The **Quran Firm Plant** web application is successfully implemented and fully built. The application provides a premium, zero-dependency environment for Quran memorizers (*Huffaz*) to reinforce active recall, spaced repetition, visual page mapping, handwriting practice, and recitation audits.

---

## 🚀 How to Run the App

To run the application locally on your computer:
1. Open a terminal inside the workspace directory (`C:\Users\T.Lafi\Downloads\Quran-Firm-Plant`).
2. Run the development server:
   ```bash
   npm run dev
   ```
3. Open your browser and navigate to the address shown in the terminal (usually `http://localhost:5173`).

---

## 🎨 Design System & Aesthetics
- **Emerald & Gold Palette:** Pure premium styling using a dark emerald green backdrop (`#051410`), soft card backgrounds (`#0a221c`), and elegant gold/amber highlights (`#cca038`).
- **Google Quranic Typography:** Text is rendered using the **Amiri** and **Scheherazade New** fonts with proper line-height configurations to guarantee pixel-perfect tashkeel rendering.
- **RTL & Micro-Animations:** Clean right-to-left layout flow for Arabic text, smooth fade-in animations for revealed word blocks, pulsing speech states, and shakes on incorrect keyboard characters.

---

## 📂 Architecture & Technical Stack

The project structure is clean and modular:

```
Quran-Firm-Plant/
├── index.html                 # Main HTML5 layout with sidebar skeleton & loading modals
├── src/
│   ├── main.js                # App entry point, navigator, and central event router
│   ├── style.css              # Custom HSL-based dark emerald design system stylesheet
│   ├── js/
│   │   ├── data/
│   │   │   ├── db.js          # IndexedDB manager (stores text, layout pages, and progress)
│   │   │   └── loader.js      # CDN loader fetching Quran text (Tanzil-based) and QCF4 pages
│   │   ├── components/
│   │   │   ├── audio-player.js  # Streams Azaan / Qaris recitations fromCDN per global Ayah ID
│   │   │   ├── navigation.js  # Links sidebar navigation triggers to main router
│   │   │   └── surah-selector.js # Searchable modal dropdown listing all 114 Surahs
│   │   ├── modules/
│   │   │   ├── page-map.js    # Features C+E: 15-line visual page grid, active recall reveal modes & line connectors
│   │   │   ├── writing-practice.js # Feature F: Handwriting canvas & typing test validator
│   │   │   ├── voice-finder.js  # Feature A: Web Speech Recognition Arabic verse finder
│   │   │   ├── quiz.js        # Feature B: Identify Source & Continue Reciting testers
│   │   │   └── mutashabihat.js # Feature D: Side-by-side similarity contrast cards
│   │   └── utils/
│   │       └── normalize.js   # Diacritic stripper & Levenshtein string ratio checker
```

---

## 💎 Key Features Implemented

### 1. 🗺️ Visual Mushaf Page Map (Features C + E, merged)
- Renders standard **15-line Madinah Mushaf** page structures dynamically — this is the default view and the home of all active-recall study.
- **Four sub-features:**
  1. *Page Silhouette:* Renders word blocks in the exact mushaf layout. Three study modes: **Free Reveal** (tap any block), **Next Word Guide** (sequential reveal in reading order with a highlighted next-word hint), and **First Word Anchors** (the first word of each ayah stays visible as an anchor). Includes a progress bar, Hide All / Show All, and prev/next page navigation for continuous study across a surah. Revealed words persist per page in IndexedDB. Long-press an ayah circle for ayah-level hide/reveal options and **audio playback**; long-press a word to mark it as forgotten.
  2. *Line Connector Game:* Asks the user to match the last word of line $N$ to the first word of line $N+1$, reinforcing visual layout links.
  3. *Coordinate Finder:* Highlights a verse and asks the user to click which of the 15 lines it belongs to.
  4. *First & Last Word Drill:* Fast-paced flashcard drills for line-level boundaries.

### 2. ✍️ Writing & Typing Practice (Feature F)
- **Handwriting Canvas:** Fully responsive HTML5 canvas for sketching letters with finger/mouse/stylus, including an eraser tool, canvas clear, and a faint ghost text tracing guide.
- **Typing Recall:** A typing test box that validates Arabic characters in real-time. Correct letters light up green, errors shake and display red.
- **Fill-in-the-Blank:** Selects random words in the verse to blank out as input fields, supporting immediate validation.

### 3. 🎙️ Voice Recitation Finder (Feature A)
- Transcribes recitation **on-device** using the Tarteel-tuned Whisper model (`eventhorizon0/tarteel-ai-onnx-whisper-base-ar-quran`) running in a web worker via `transformers.js` — works in all modern browsers, keeps audio private, and works offline once the model (~45MB, one-time download) is cached. Falls back to the browser-native `SpeechRecognition` API if the model can't load.
- Recite a verse $\rightarrow$ tap to stop $\rightarrow$ Whisper transcribes with full tashkeel $\rightarrow$ two-pass fuzzy matching (cheap word screening over all 6,236 verses, then word-window Levenshtein on top candidates) locates the exact page, surah, and ayah in ~1-2 seconds.
- The same on-device model powers the **Continue Reciting** quiz mode.

### 4. 🎯 Recitation Quiz (Feature B)
- **Identify Source:** Displays a verse and prompts the user to select the correct Surah name from multiple choices.
- **Continue Reciting:** Shows a verse and prompts the user to speak the *next* verse. Evaluates the spoken input against the database next ayah.
- Tracks score, total questions, and daily streaks (`🔥`).

### 5. 🔀 Mutashabihat Review Cards (Feature D)
- Displays sets of confusing similar verses in parallel side-by-side columns.
- Automatically isolates and highlights the exact word differences in **green** (source) and **red** (matching counterpart).
- Flashcard mode hides the matching counterparts for active recall.

---

## 🛜 Offline Capabilities & Caching
1. **Initial Setup:** On the very first run, the app downloads the compiled Quran text JSON (1.8MB) and Juz 30 Mutashabihat JSON, storing them in IndexedDB.
2. **On-Demand Page Caching:** Rather than forcing a slow 604-file initial download, the app fetches page layout files from the CDN on-demand when you study a Surah, caching them instantly. Once fetched, they work completely offline.
3. **Volume download:** Settings page button allows downloading the full 604-page Mushaf for offline backups.
