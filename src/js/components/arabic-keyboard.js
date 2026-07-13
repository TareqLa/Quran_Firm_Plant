// Quran Firm Plant - On-screen Arabic Keyboard
// Tappable fallback for devices without an Arabic layout installed.
// Renders letter rows (standard Arabic 101 arrangement), hamza variants,
// and a harakat row, plus space/backspace/clear controls. The component is
// purely presentational: it types into the <input> it's bound to and leaves
// grading to the caller.

const LETTER_ROWS = [
  ['ض', 'ص', 'ث', 'ق', 'ف', 'غ', 'ع', 'ه', 'خ', 'ح', 'ج', 'د'],
  ['ش', 'س', 'ي', 'ب', 'ل', 'ا', 'ت', 'ن', 'م', 'ك', 'ط'],
  ['ذ', 'ء', 'ؤ', 'ئ', 'ى', 'ر', 'ة', 'و', 'ز', 'ظ', 'لا'],
  ['أ', 'إ', 'آ', 'ٱ'],
];

// Combining marks get a dotted-circle carrier so the keycap is legible.
const HARAKAT = ['َ', 'ُ', 'ِ', 'ْ', 'ّ', 'ً', 'ٌ', 'ٍ'];

export function arabicKeyboardHtml() {
  const letterRows = LETTER_ROWS.map(row => `
    <div class="arabic-kb-row">
      ${row.map(ch => `<button type="button" class="arabic-kb-key" data-char="${ch}">${ch}</button>`).join('')}
    </div>
  `).join('');

  const harakaRow = `
    <div class="arabic-kb-row">
      ${HARAKAT.map(ch => `<button type="button" class="arabic-kb-key kb-haraka" data-char="${ch}">◌${ch}</button>`).join('')}
    </div>
  `;

  return `
    <div class="arabic-kb" dir="rtl">
      ${letterRows}
      ${harakaRow}
      <div class="arabic-kb-row">
        <button type="button" class="arabic-kb-key kb-ctrl" data-action="clear">مسح</button>
        <button type="button" class="arabic-kb-key kb-space" data-action="space">مسافة</button>
        <button type="button" class="arabic-kb-key kb-ctrl" data-action="backspace">⌫</button>
      </div>
    </div>
  `;
}

function insertAtCaret(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const pos = start + text.length;
  input.setSelectionRange(pos, pos);
}

function backspaceAtCaret(input) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  if (start !== end) {
    input.value = input.value.slice(0, start) + input.value.slice(end);
    input.setSelectionRange(start, start);
  } else if (start > 0) {
    input.value = input.value.slice(0, start - 1) + input.value.slice(start);
    input.setSelectionRange(start - 1, start - 1);
  }
}

// Wire a rendered keyboard to an input. `root` is any ancestor element that
// contains the .arabic-kb markup (event delegation, so it survives nothing —
// callers re-bind after re-rendering innerHTML).
export function bindArabicKeyboard(root, input, { onChange } = {}) {
  const kb = root.querySelector('.arabic-kb');
  if (!kb || !input) return;

  // Keep the input's focus/caret when tapping keys.
  kb.addEventListener('mousedown', (e) => e.preventDefault());

  kb.addEventListener('click', (e) => {
    const key = e.target.closest('.arabic-kb-key');
    if (!key) return;

    if (key.dataset.char) {
      insertAtCaret(input, key.dataset.char);
    } else if (key.dataset.action === 'space') {
      insertAtCaret(input, ' ');
    } else if (key.dataset.action === 'backspace') {
      backspaceAtCaret(input);
    } else if (key.dataset.action === 'clear') {
      input.value = '';
    }
    input.focus();
    onChange?.(input.value);
  });
}
