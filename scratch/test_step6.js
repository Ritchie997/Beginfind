const assert = require('assert');
const fs = require('fs');

// Extract functions from alltell-client.js
const fileContent = fs.readFileSync('public/site/alltell-client.js', 'utf8');

// Build an environment to test functions in isolation
function mockEnv() {
  const window = {
    toast: () => {},
    showMessage: () => {},
    confirmDialog: {
      prompt: async ({ title, message, placeholder }) => 'https://example.com'
    }
  };
  const document = {
    querySelectorAll: () => [],
    getElementById: () => null,
    querySelector: () => null
  };
  return { window, document };
}

// Quick validation of regex and logic from alltell-client.js
console.log('--- Test 1: Parser and Serializer roundtrip ---');
// Let's test parsePostBlocks and serializePostBlocks
const vm = require('vm');
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  window: { toast: () => {} },
  document: {
    querySelectorAll: () => [],
    getElementById: () => null,
    querySelector: () => null
  }
};
vm.createContext(sandbox);

// Extract formatPostBody as well
const formatStart = fileContent.indexOf('function formatPostBody(');
const formatEnd = fileContent.indexOf('function renderPost(');
const formatCode = fileContent.substring(formatStart, formatEnd);

// Extract the editor engine slice
const startIndex = fileContent.indexOf('// ===== AllTell Post Block Editor Engine =====');
const endIndex = fileContent.indexOf('function renderPostForm(');
const engineCode = fileContent.substring(startIndex, endIndex);

// We need escapeHtml and pickTextColor for formatPostBody
const helpers = `
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
function pickTextColor(hex) { return '#fff'; }
` + formatCode + '\n' + engineCode;

vm.runInContext(helpers, sandbox);

// 1. Test block parser
const md = `# Заголовок

Обычный текст с **жирным**

---

\`\`\`javascript
const a = 1;
const b = 2;
\`\`\`

> [!TIP] Совет дня
> Не забывайте про тесты!

- [x] Сделано
- [ ] Не сделано
`;

const blocks = sandbox.parsePostBlocks(md);
console.log('Parsed blocks count:', blocks.length);
assert.strictEqual(blocks[0].type, 'heading');
assert.strictEqual(blocks[0].data.level, 1);
assert.strictEqual(blocks[1].type, 'paragraph');
assert.strictEqual(blocks[2].type, 'divider');
assert.strictEqual(blocks[3].type, 'code');
assert.strictEqual(blocks[3].data.language, 'javascript');
assert.strictEqual(blocks[3].data.code, 'const a = 1;\nconst b = 2;\n');
assert.strictEqual(blocks[4].type, 'callout');
assert.strictEqual(blocks[4].data.variant, 'tip');
assert.strictEqual(blocks[4].data.title, 'Совет дня');
assert.strictEqual(blocks[4].data.markdown, 'Не забывайте про тесты!');
assert.strictEqual(blocks[5].type, 'list');
assert.strictEqual(blocks[5].data.style, 'checklist');
assert.strictEqual(blocks[5].data.items.length, 2);
console.log('✓ All block types parsed correctly');

// 2. Test serializer
const serialized = sandbox.serializePostBlocks(blocks);
console.log('Serialized markdown:\n' + serialized);
assert.ok(serialized.includes('# Заголовок'));
assert.ok(serialized.includes('---'));
assert.ok(serialized.includes('```javascript'));
assert.ok(serialized.includes('> [!TIP] Совет дня'));
assert.ok(serialized.includes('- [x] Сделано'));
console.log('✓ Markdown serialization matches expected output');

// 3. Test formatPostBody
const html = sandbox.formatPostBody(serialized);
console.log('HTML preview snippet:\n' + html.slice(0, 300) + '...');
assert.ok(html.includes('<h1 class="alltell-post-h1">Заголовок</h1>'));
assert.ok(html.includes('<hr class="alltell-post-divider">'));
assert.ok(html.includes('<pre class="alltell-post-code-block blk-code"><code class="language-javascript">'));
assert.ok(html.includes('<aside class="alltell-post-callout blk-callout blk-callout-tip">'));
assert.ok(html.includes('Совет дня</strong>'));
assert.ok(html.includes('Не забывайте про тесты!</div>'));
assert.ok(html.includes('<ul class="alltell-checklist blk-checklist">'));
console.log('✓ formatPostBody renders code blocks and callouts cleanly');

// 4. Test History (undo / redo)
const state = {
  postBlocks: [{ id: 'b1', type: 'paragraph', data: { markdown: 'Initial' } }],
  _postHistory: null,
  _postHistoryIndex: -1
};
sandbox.recordPostEditorHistory(state, true);
assert.strictEqual(state._postHistory.length, 1);
assert.strictEqual(state._postHistoryIndex, 0);

// Add block
state.postBlocks.push({ id: 'b2', type: 'divider', data: {} });
sandbox.recordPostEditorHistory(state, true);
assert.strictEqual(state._postHistory.length, 2);
assert.strictEqual(state._postHistoryIndex, 1);

// Undo
sandbox.undoPostEditor(state);
assert.strictEqual(state._postHistoryIndex, 0);
assert.strictEqual(state.postBlocks.length, 1);
assert.strictEqual(state.postBlocks[0].data.markdown, 'Initial');
console.log('✓ Undo restored previous state');

// Redo
sandbox.redoPostEditor(state);
assert.strictEqual(state._postHistoryIndex, 1);
assert.strictEqual(state.postBlocks.length, 2);
assert.strictEqual(state.postBlocks[1].type, 'divider');
console.log('✓ Redo restored updated state');

// 5. Test Duplicate block
sandbox.duplicatePostBlock(state, 'b2');
assert.strictEqual(state.postBlocks.length, 3);
assert.strictEqual(state.postBlocks[2].type, 'divider');
assert.notStrictEqual(state.postBlocks[1].id, state.postBlocks[2].id);
console.log('✓ Duplicate block works and assigns unique id');

console.log('\nALL 5 STEP 6 TESTS PASSED SUCCESSFULLY!');
