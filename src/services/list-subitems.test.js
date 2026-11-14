const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const blocks = require('./blocks');

test('blocks: list normalization preserves indent, checked and subitem styles', () => {
  const rawListBlock = {
    id: 'test-list-1',
    type: 'list',
    data: {
      style: 'checklist',
      items: [
        { markdown: 'Родительский пункт', checked: true, indent: 99 }, // should clamp to 0 because idx === 0
        { markdown: 'Подпункт 1', checked: false, indent: 3 }, // should clamp to 1 because prevIndent is 0
        { markdown: 'Под-подпункт 1.1', checked: false, indent: 2, style: 'bullet' }, // allowed: 2
        { markdown: 'Подпункт 2', checked: true, indent: 1 }
      ]
    }
  };

  const normalized = blocks.normalizeBlock(rawListBlock);
  assert.strictEqual(normalized.type, 'list');
  assert.strictEqual(normalized.data.style, 'checklist');
  assert.strictEqual(normalized.data.items.length, 4);

  assert.strictEqual(normalized.data.items[0].indent, 0);
  assert.strictEqual(normalized.data.items[0].checked, true);
  assert.strictEqual(normalized.data.items[0].markdown, 'Родительский пункт');

  assert.strictEqual(normalized.data.items[1].indent, 1);
  assert.strictEqual(normalized.data.items[1].checked, false);

  assert.strictEqual(normalized.data.items[2].indent, 2);
  assert.strictEqual(normalized.data.items[2].style, 'bullet');

  assert.strictEqual(normalized.data.items[3].indent, 1);
});

test('blocks: backward compatibility for legacy list items without indent', () => {
  const legacyListBlock = {
    id: 'legacy-list-1',
    type: 'list',
    data: {
      style: 'bullet',
      items: [
        { markdown: 'Пункт 1', checked: false },
        { markdown: 'Пункт 2', checked: false }
      ]
    }
  };

  const normalized = blocks.normalizeBlock(legacyListBlock);
  assert.strictEqual(normalized.data.items[0].indent, 0);
  assert.strictEqual(normalized.data.items[1].indent, 0);
});

test('client: blocks-renderer renders nested lists with guidelines and classes', () => {
  const rendererCode = fs.readFileSync(path.join(__dirname, '../../public/blocks-renderer.js'), 'utf8');

  // Verify renderListBlock implementation presence
  assert.ok(rendererCode.includes('function renderListBlock('), 'blocks-renderer.js must have renderListBlock function');
  assert.ok(rendererCode.includes('blk-checklist-nested'), 'blocks-renderer.js must support blk-checklist-nested');
  assert.ok(rendererCode.includes('blk-list-nested'), 'blocks-renderer.js must support blk-list-nested');
  assert.ok(rendererCode.includes('targetIndent > currentIndent'), 'blocks-renderer.js must handle indentation transitions');
});

test('client: editor-manager and editor-blocks support sub-items, shortcuts and buttons', () => {
  const editorManagerCode = fs.readFileSync(path.join(__dirname, '../../public/editor-manager.js'), 'utf8');
  assert.ok(editorManagerCode.includes('_normalizeListItemsIndent'), 'editor-manager.js must normalize list indents');
  assert.ok(editorManagerCode.includes("e.key === 'Tab'"), 'editor-manager.js must handle Tab for sub-items');
  assert.ok(editorManagerCode.includes("e.shiftKey"), 'editor-manager.js must handle Shift+Tab for outdenting');
  assert.ok(editorManagerCode.includes("fa-level-down-alt"), 'editor-manager.js must have + Подпункт button');
  assert.ok(editorManagerCode.includes("_pendingFocusItemIdx"), 'editor-manager.js must track item focus index');

  const editorBlocksCode = fs.readFileSync(path.join(__dirname, '../../public/editor-blocks.js'), 'utf8');
  assert.ok(editorBlocksCode.includes('normalizeEbItemsIndent'), 'editor-blocks.js must normalize list indents');
  assert.ok(editorBlocksCode.includes("e.key === 'Tab'"), 'editor-blocks.js must handle Tab for sub-items');
  assert.ok(editorBlocksCode.includes("fa-indent"), 'editor-blocks.js must have indent action button');
});

test('styles: editor-blocks.css and editor-obsidian.css contain sub-item and tree guideline styles', () => {
  const blocksCss = fs.readFileSync(path.join(__dirname, '../../public/editor-blocks.css'), 'utf8');
  assert.ok(blocksCss.includes('.eb-list-item[data-indent]'), 'editor-blocks.css must style indented list items');
  assert.ok(blocksCss.includes('.eb-list-shift-btn'), 'editor-blocks.css must style shift buttons');
  assert.ok(blocksCss.includes('.eb-list-bottom-actions'), 'editor-blocks.css must style bottom actions');

  const obsidianCss = fs.readFileSync(path.join(__dirname, '../../public/editor-obsidian.css'), 'utf8');
  assert.ok(obsidianCss.includes('.preview-pane ul.blk-list-nested'), 'editor-obsidian.css must style nested lists');
  assert.ok(obsidianCss.includes('.preview-pane ul.blk-checklist-nested'), 'editor-obsidian.css must style nested checklists');
});
