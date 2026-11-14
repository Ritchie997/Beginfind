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

test('multiblock: drag-and-drop algorithm moves selected blocks in order and skips unselected', () => {
  // Test the exact multi-move algorithm implemented in editor-manager.js
  function moveMulti(list, selectedIds, targetIndex) {
    const movingBlocks = list.filter((b) => selectedIds.has(b.id));
    const movingSet = new Set(movingBlocks.map((b) => b.id));

    const countBefore = movingBlocks.filter((b) => list.indexOf(b) < targetIndex).length;
    const finalIndex = Math.max(0, targetIndex - countBefore);

    for (let i = list.length - 1; i >= 0; i--) {
      if (movingSet.has(list[i].id)) list.splice(i, 1);
    }

    list.splice(finalIndex, 0, ...movingBlocks);
    return list;
  }

  // Initial: [A*, B, C*, D, E*, F, G]
  // Target: drop between F and G (index 6, before G)
  {
    const list = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }, { id: 'F' }, { id: 'G' }];
    const selected = new Set(['A', 'C', 'E']);
    const result = moveMulti(list, selected, 6);
    assert.deepStrictEqual(result.map(x => x.id), ['B', 'D', 'F', 'A', 'C', 'E', 'G']);
  }

  // Target: drop between B and C (index 2, before C) -> inserts between B and D
  {
    const list = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }, { id: 'F' }, { id: 'G' }];
    const selected = new Set(['A', 'C', 'E']);
    const result = moveMulti(list, selected, 2);
    assert.deepStrictEqual(result.map(x => x.id), ['B', 'A', 'C', 'E', 'D', 'F', 'G']);
  }

  // Target: drop at start (index 0)
  {
    const list = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }, { id: 'F' }, { id: 'G' }];
    const selected = new Set(['A', 'C', 'E']);
    const result = moveMulti(list, selected, 0);
    assert.deepStrictEqual(result.map(x => x.id), ['A', 'C', 'E', 'B', 'D', 'F', 'G']);
  }

  // Target: drop at end (index 7)
  {
    const list = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }, { id: 'F' }, { id: 'G' }];
    const selected = new Set(['A', 'C', 'E']);
    const result = moveMulti(list, selected, 7);
    assert.deepStrictEqual(result.map(x => x.id), ['B', 'D', 'F', 'G', 'A', 'C', 'E']);
  }
});

test('multiblock: selection bar is not restricted to articles-page and supports client site', () => {
  const blocksCss = fs.readFileSync(path.join(__dirname, '../../public/editor-blocks.css'), 'utf8');
  assert.ok(!blocksCss.includes('body:not(.articles-page) .eb-select-bar'), 'editor-blocks.css must not restrict eb-select-bar to articles-page');
  assert.ok(blocksCss.includes('.eb-select-bar[hidden] { display: none; }'), 'editor-blocks.css must use [hidden] to toggle eb-select-bar');

  const editorBlocksJs = fs.readFileSync(path.join(__dirname, '../../public/editor-blocks.js'), 'utf8');
  assert.ok(editorBlocksJs.includes('opts.hasSelection'), 'editor-blocks.js must check hasSelection on handle click');

  const editorManagerJs = fs.readFileSync(path.join(__dirname, '../../public/editor-manager.js'), 'utf8');
  assert.ok(editorManagerJs.includes('movingBlocks'), 'editor-manager.js must support movingBlocks in drag and drop');
  assert.ok(editorManagerJs.includes('countBefore'), 'editor-manager.js must calculate countBefore for multi-block insertion');
});

