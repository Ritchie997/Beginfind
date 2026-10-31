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

// 2. Verify alltell-client.js passes showMoveButtons: false
const alltellClientJs = fs.readFileSync('public/site/alltell-client.js', 'utf8');
assert(alltellClientJs.includes('showMoveButtons: false'), 'alltell-client.js must pass showMoveButtons: false');

// 3. Verify editor-blocks.js supports showMoveButtons
const editorBlocksJs = fs.readFileSync('public/editor-blocks.js', 'utf8');
assert(editorBlocksJs.includes('opts.showMoveButtons !== false'), 'editor-blocks.js must check opts.showMoveButtons');

// 4. Verify editor-blocks.css hides move buttons in post editor
const editorBlocksCss = fs.readFileSync('public/editor-blocks.css', 'utf8');
assert(editorBlocksCss.includes('#postBlocksContent .eb-move-btn'), 'editor-blocks.css must include #postBlocksContent .eb-move-btn');

console.log('Antropedia history & publication editor arrows verification PASSED!');
