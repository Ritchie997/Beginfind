const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const blocks = require('./blocks');

test('infobox: server block normalization preserves reordered rows', () => {
  const rawInfobox = {
    id: 'info-1',
    type: 'infobox',
    data: {
      title: 'Ранг «Ветеран»',
      rows: [
        { label: 'Фракция', value: 'Стражи' },
        { label: 'Статус', value: 'Активен' },
        { label: 'Уровень', value: '45' }
      ]
    }
  };

  const normalized = blocks.normalizeBlock(rawInfobox);
  assert.equal(normalized.type, 'infobox');
  assert.equal(normalized.data.title, 'Ранг «Ветеран»');
  assert.equal(normalized.data.rows.length, 3);
  assert.equal(normalized.data.rows[0].label, 'Фракция');
  assert.equal(normalized.data.rows[1].label, 'Статус');
  assert.equal(normalized.data.rows[2].label, 'Уровень');

  // Test row reordering (e.g. moving row 2 between row 0 and 1)
  const reordered = {
    ...rawInfobox,
    data: {
      ...rawInfobox.data,
      rows: [
        rawInfobox.data.rows[0],
        rawInfobox.data.rows[2],
        rawInfobox.data.rows[1]
      ]
    }
  };
  const normalizedReordered = blocks.normalizeBlock(reordered);
  assert.equal(normalizedReordered.data.rows[0].label, 'Фракция');
  assert.equal(normalizedReordered.data.rows[1].label, 'Уровень');
  assert.equal(normalizedReordered.data.rows[2].label, 'Статус');
});

test('infobox: editor-manager implements hover dividers, drag handles and row insertion', () => {
  const editorJs = fs.readFileSync(path.resolve(__dirname, '../../public/editor-manager.js'), 'utf8');

  // 1. Divider between rows
  assert.ok(editorJs.includes('eb-infobox-divider'), 'Must create infobox divider elements');
  assert.ok(editorJs.includes('eb-infobox-divider-btn'), 'Must include button in infobox divider');
  assert.ok(editorJs.includes("createDivider(idx)"), 'Must create divider before each row');
  assert.ok(editorJs.includes("createDivider(block.data.rows.length)"), 'Must create divider after last row');

  // 2. Drag handle (Grip on the left - Variant A)
  assert.ok(editorJs.includes('eb-infobox-grip'), 'Must create infobox grip handle');
  assert.ok(editorJs.includes('fa-grip-vertical'), 'Must use fa-grip-vertical icon for drag handle');
  assert.ok(editorJs.includes('attachInfoboxRowDrag'), 'Must attach pointer-events drag handler to infobox rows');

  // 3. Row drag implementation
  assert.ok(editorJs.includes('setPointerCapture'), 'Drag handler should use pointer capture for smooth tracking');
  assert.ok(editorJs.includes('drag-over-top'), 'Drag handler should highlight top drop target');
  assert.ok(editorJs.includes('drag-over-bottom'), 'Drag handler should highlight bottom drop target');

  // 4. Ctrl+Enter / Cmd+Enter shortcut
  assert.ok(editorJs.includes("e.key === 'Enter' && (e.ctrlKey || e.metaKey)"), 'Must support Ctrl+Enter shortcut to insert row below');
});

test('infobox: editor-blocks.css contains styling for Variant A grip, dividers and mobile layout', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../public/editor-blocks.css'), 'utf8');

  // 1. Grid layout for Variant A: [grip] [label] [value] [del]
  assert.ok(css.includes('grid-template-columns: 20px 1fr 1fr auto'), 'Must define 4-column grid layout for row with grip on left');

  // 2. Grip handle styles
  assert.ok(css.includes('.eb-infobox-grip'), 'Must define styles for .eb-infobox-grip');
  assert.ok(css.includes('cursor: grab'), 'Grip handle must have cursor: grab');
  assert.ok(css.includes('cursor: grabbing'), 'Active grip must have cursor: grabbing');

  // 3. Divider styles
  assert.ok(css.includes('.eb-infobox-divider'), 'Must define styles for .eb-infobox-divider');
  assert.ok(css.includes('.eb-infobox-divider-btn'), 'Must define styles for .eb-infobox-divider-btn');
  assert.ok(css.includes('.eb-infobox-divider:hover'), 'Divider must be visible on hover');

  // 4. Mobile responsive layout
  assert.ok(css.includes('@media (max-width: 640px)'), 'Must include responsive breakpoint for infobox');
  assert.ok(css.includes('grid-template-areas:'), 'Mobile infobox row should use template areas for compact layout');
});
