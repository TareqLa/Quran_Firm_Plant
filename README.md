# Quran Firm Plant (Hifz Assistant) - Review & Resource Guide

Your idea for a **Quran Firm Plant** web application is an excellent, highly feasible, and deeply valuable tool. Differentiating similar verses (*Mutashabihat*), testing recitation memory, and using interactive "blank page" reveal methods are exactly the techniques recommended by cognitive science and traditional scholars for long-term memorization (active recall and spaced repetition).

To address your need to **visually picture the pages in your mind**—specifically knowing where verses are located, matching the end of one line to the start of the next, and recalling exact verse numbers (like verse 5 and 10)—we can add a dedicated **Visual Mushaf Page Mapping & Line Transition** module.

---

## 1. Feature-by-Feature Feasibility & Implementation Review

### Feature A: Speak / Record a Verse $\rightarrow$ Find Its Position
*   **Feasibility:** **High.**
*   **How it works:** 
    1.  Captures the user's voice using the browser's `MediaRecorder` API.
    2.  An Automatic Speech Recognition (ASR) model transcribes the spoken Arabic.
    3.  A fuzzy string matching algorithm (like Levenshtein distance) or full-text search compares the transcription against a local database of the Quran to locate the exact Surah and Ayah.
*   **ASR Model:** Use a Whisper model fine-tuned specifically for Quranic recitation (details below).

### Feature B: "Continue Reciting" or "Guess the Source" Quiz
*   **Feasibility:** **High.**
*   **How it works:**
    1.  **Quiz Type 1 (Identify Source):** The app displays a random verse (from a chosen Surah or the whole Quran). The user is asked to specify the Surah name or Ayah number.
    2.  **Quiz Type 2 (Continue Reciting):** The app displays a starting verse, and the user must recite the *next* verse. The app records their voice, transcribes it, and verifies it.

### Feature C: Interactive "Blank Page" (Active Recall)
*   **Feasibility:** **Very High (Frontend-only logic).**
*   **How it works:**
    1.  Render a Surah's text with words hidden (replaced by blank boxes, dashed lines, or low-opacity placeholders).
    2.  Provide different reveal modes:
        *   **Tap-to-Reveal:** Tapping a specific word reveals it.
        *   **Sequential Reveal:** Tapping a "Next Word" button reveals the next word in sequence.
        *   **First-Word Guide:** Only show the first word of each Ayah, keeping the rest hidden.
        *   **Last Verse Display:** Tapping the end of a verse reveals that entire verse.

### Feature D: Mutashabihat (Similar Verses) Review Sets
*   **Feasibility:** **High.**
*   **How it works:**
    1.  Use a dataset that maps similar verses in the Quran.
    2.  Group them into study cards and provide side-by-side views with differences highlighted in red/green (e.g., comparing "خَالِدِينَ فِيهَا أَبَدًا" vs "خَالِدِينَ فِيهَا").

### Feature E: Visual Mushaf Page Mapping & Line Transitions [NEW]
*   **Feasibility:** **High** (using specialized layout datasets).
*   **Purpose:** To build a visual/photographic memory of the standard 15-line Madinah Mushaf pages, preventing the common issue where your mind goes blank when moving to the next line or page, and training you to associate verse numbers with their physical page location.
*   **Sub-features:**
    1.  **Line-End to Line-Start Connector Game:** 
        *   The app displays the last word of Line 1 (e.g. `خَلَقَ` in Surat Al-A'la) and prompts you: *"What is the first word of Line 2?"* (Answer: `فَسَوَّى`). 
        *   This strengthens the "cross-line link" in your visual memory.
    2.  **Visual Page Silhouette (Block Mode):**
        *   Instead of rendering text, the app draws empty blocks representing the lengths of words on the 15 lines of a page.
        *   It marks where the Ayah circles (e.g., ⑤, ⑩) sit on those lines.
        *   You can click or tap a block to reveal the Arabic word. This helps your brain memorize the visual "shape" of the page.
    3.  **Verse Coordinate Finder:**
        *   The app asks: *"Where is Ayah 10 on this page?"* 
        *   You must tap the correct line (out of 15) or position on the page grid.
    4.  **First & Last Word Drill:**
        *   A fast-paced card drill asking: *"What is the last word of Line 3?"* or *"What is the first word of Line 7?"* on the current page.

---

## 2. Free APIs, Datasets, and Repositories

To build this app serverless and free of charge, you can rely on the following open-source resources:

### A. Quranic Speech-to-Text (ASR)
*   **[eventhorizon0/tarteel-ai-onnx-whisper-base-ar-quran](https://huggingface.co/eventhorizon0/tarteel-ai-onnx-whisper-base-ar-quran)**: An ONNX-converted version of Tarteel AI's specialized Quranic Whisper model.
    *   *Why use it:* It runs **entirely in the user's browser** via `transformers.js`, meaning you do not need to host or pay for a backend GPU server.
*   **[Transformers.js](https://huggingface.co/docs/transformers.js/)**: The JavaScript library that enables running ONNX models directly in browser web workers.

### B. Quran Text, Page, & Line Layouts
*   **[MohamadHajjRabee/quran-qcf4](https://github.com/MohamadHajjRabee/quran-qcf4)**: A highly valuable dataset containing **page-level JSON files** representing the exact lines and word-by-word positions of the Madinah Mushaf (QCF v4). This is the key dataset for creating the **15-line visual page grid** and **first/last word quizzes**.
*   **[blueheron786/line-by-line-quran](https://github.com/blueheron786/line-by-line-quran)**: A database mapping each page of the 15-line Uthmani Mushaf to its corresponding line lines.
*   **[Quran.com API (v4)](https://developers.quran.com/)** & **[Al-Quran Cloud API](https://api.alquran.cloud/)**: Great for fetching word-by-word data, translations, tafsir, and reciter audio.

### C. Mutashabihat Datasets
*   **[Waqar144/Quran_Mutashabihat_Data](https://github.com/Waqar144/Quran_Mutashabihat_Data)** & **[srmdn/quran-mutashabihat](https://github.com/srmdn/quran-mutashabihat)**: Curated lists of similar verses.

---

## 3. Proposed Technical Stack

For a fast, modern, and zero-hosting-cost web app:

- **Frontend Framework:** **Vite + React (or Vue / Vanilla JS)**. Using Vite guarantees a super-fast development experience and optimized builds.
- **Styling:** **Tailwind CSS + Custom CSS** for premium typography (like Amiri or Scheherazade New) and fluid micro-animations.
- **ASR Processing:** **Web Worker with Transformers.js**. Running Whisper in a separate thread ensures the UI remains fully responsive.
- **Local Database:** **SQLite-WASM or simple JSON modules**. Storing the 6,236 verses locally means instant searches and offline capability.

---

## 4. UI/UX Design & Aesthetic Suggestions

To make the app feel premium and peaceful:
*   **Colors:** Dark mode by default, utilizing soft, deep emerald greens (`#064e3b`), warm sand/gold accents (`#d97706`), and off-white/cream text.
*   **Typography:** Set the Arabic text to a dedicated Quranic font (e.g., `Amiri` or `Scheherazade New` via Google Fonts) with adjustable font size.
*   **Animations:** Smooth fade-ins when words are revealed, micro-pulses for the recording button, and slide-in comparisons for Mutashabihat.

---

## Next Steps
If you want to build this application, we can proceed by:
1.  Setting up a new Vite project in this empty directory.
2.  Downloading the Quran text database (JSON format) and setting up basic indexing.
3.  Implementing the **Interactive Blank Page** feature as the initial prototype.
4.  Integrating **Transformers.js** for the voice-to-text recitation check.

Let me know if you would like to start creating the app!
