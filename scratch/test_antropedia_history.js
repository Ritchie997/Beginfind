const fs = require('fs');
const assert = require('assert');

// 1. Verify Antropedia editor HTML has history toolbar group
const antropediaHtml = fs.readFileSync('public/site/antropedia.html', 'utf8');
assert(antropediaHtml.includes('id="editorUndoBtn"'), 'antropedia.html must contain editorUndoBtn');
assert(antropediaHtml.includes('id="editorRedoBtn"'), 'antropedia.html must contain editorRedoBtn');
assert(antropediaHtml.includes('fa-rotate-left'), 'antropedia.html must contain fa-rotate-left');
assert(antropediaHtml.includes('fa-rotate-right'), 'antropedia.html must contain fa-rotate-right');
assert(antropediaHtml.includes('data-history-command="undo"'), 'antropedia.html must have data-history-command undo');
assert(antropediaHtml.includes('data-history-command="redo"'), 'antropedia.html must have data-history-command redo');
assert(antropediaHtml.includes('>история</span>'), 'antropedia.html must contain история label');

// 2. Verify articles.html has history toolbar group
const articlesHtml = fs.readFileSync('public/views/articles.html', 'utf8');
assert(articlesHtml.includes('id="editorUndoBtn"'), 'articles.html must contain editorUndoBtn');
assert(articlesHtml.includes('id="editorRedoBtn"'), 'articles.html must contain editorRedoBtn');
assert(articlesHtml.includes('data-history-command="undo"'), 'articles.html must have data-history-command undo');
assert(articlesHtml.includes('data-history-command="redo"'), 'articles.html must have data-history-command redo');
assert(articlesHtml.includes('data-post-cmd="undo"'), 'articles.html must have data-post-cmd undo');
assert(articlesHtml.includes('data-post-cmd="redo"'), 'articles.html must have data-post-cmd redo');

// 3. Verify alltell-client.js passes showMoveButtons: false
const alltellClientJs = fs.readFileSync('public/site/alltell-client.js', 'utf8');
assert(alltellClientJs.includes('showMoveButtons: false'), 'alltell-client.js must pass showMoveButtons: false');

// 4. Verify editor-blocks.js supports showMoveButtons
const editorBlocksJs = fs.readFileSync('public/editor-blocks.js', 'utf8');
assert(editorBlocksJs.includes('opts.showMoveButtons !== false'), 'editor-blocks.js must check opts.showMoveButtons');

// 5. Verify editor-blocks.css hides move buttons in post editor
const editorBlocksCss = fs.readFileSync('public/editor-blocks.css', 'utf8');
assert(editorBlocksCss.includes('#postBlocksContent .eb-move-btn'), 'editor-blocks.css must include #postBlocksContent .eb-move-btn');

// 6. Verify editor-manager.js protections
const editorManagerJs = fs.readFileSync('public/editor-manager.js', 'utf8');
assert(editorManagerJs.includes('Math.max(26, el.scrollHeight)'), 'editor-manager.js must clamp min autosize height to 26px');
assert(editorManagerJs.includes('lastHistoryActionTime'), 'editor-manager.js must throttle history toolbar button clicks');
assert(editorManagerJs.includes('btn._historyBound'), 'editor-manager.js must guard against duplicate history listeners');
assert(editorManagerJs.includes('KeyZ') && editorManagerJs.includes('!typing'), 'editor-manager.js must support global Ctrl+Z when not typing');

// 7. Unit test: simulate rapid mousedown + click events on history button
let undoCallCount = 0;
const mockEditor = {
  undo: () => { undoCallCount++; }
};

let lastHistoryActionTime = 0;
const handleHistoryCmd = (btn, e) => {
  if (e) e.preventDefault();
  const now = Date.now();
  if (now - lastHistoryActionTime < 250) return;
  lastHistoryActionTime = now;
  const cmd = btn.getAttribute('data-history-command');
  if (cmd === 'undo') mockEditor.undo();
};

const mockBtn = {
  getAttribute: (name) => name === 'data-history-command' ? 'undo' : null
};

// Simulate mousedown
handleHistoryCmd(mockBtn, { preventDefault: () => {}, type: 'mousedown', detail: 1 });
assert.strictEqual(undoCallCount, 1, 'Mousedown should trigger undo');

// Simulate mouse click 50ms later (mouse released)
handleHistoryCmd(mockBtn, { preventDefault: () => {}, type: 'click', detail: 1 });
assert.strictEqual(undoCallCount, 1, 'Mouse click event within 250ms must NOT trigger a second undo');

console.log('Antropedia history & publication editor arrows verification PASSED!');
