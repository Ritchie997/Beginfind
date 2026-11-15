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

  // 5. Both label and value fields must be auto-expanding textareas
  assert.ok(editorJs.includes("label.className = 'eb-input eb-input-auto eb-infobox-label'"), 'Label must be auto-expanding textarea');
  assert.ok(editorJs.includes("value.className = 'eb-input eb-input-auto eb-infobox-value'"), 'Value must be auto-expanding textarea');
  assert.ok(editorJs.includes('autosizeLabel'), 'Label must have autosize handler attached');
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
  assert.ok(css.includes('.eb-infobox-label'), 'Mobile layout must map .eb-infobox-label to label area');
  assert.ok(css.includes('.eb-infobox-value'), 'Mobile layout must map .eb-infobox-value to value area');
});

test('infobox: image size regulation and normalization', () => {
  const rawInfoboxWithImage = {
    id: 'info-img',
    type: 'infobox',
    data: {
      title: 'Артефакт',
      image: { src: '/uploads/artifact.png', alt: 'Меч', widthPct: 65 },
      rows: [{ label: 'Тип', value: 'Оружие' }]
    }
  };

  const normalized = blocks.normalizeBlock(rawInfoboxWithImage);
  assert.equal(normalized.data.image.widthPct, 65, 'widthPct must be preserved in normalized block');
  assert.equal(normalized.data.image.src, '/uploads/artifact.png');
  assert.equal(normalized.data.image.alt, 'Меч');

  // Clamping test
  const clamped = blocks.normalizeBlock({
    id: 'info-clamp',
    type: 'infobox',
    data: {
      image: { src: '/uploads/artifact.png', widthPct: 250 }
    }
  });
  assert.equal(clamped.data.image.widthPct, 100, 'widthPct must be clamped to 100%');
});

test('infobox: editor-manager and blocks-renderer support image sizing dialog and rendering', () => {
  const editorJs = fs.readFileSync(path.resolve(__dirname, '../../public/editor-manager.js'), 'utf8');
  const rendererJs = fs.readFileSync(path.resolve(__dirname, '../../public/blocks-renderer.js'), 'utf8');
  const obsidianCss = fs.readFileSync(path.resolve(__dirname, '../../public/editor-obsidian.css'), 'utf8');

  // 1. Editor image dialog methods for infobox
  assert.ok(editorJs.includes('pickAndUploadImageForInfobox'), 'Must define pickAndUploadImageForInfobox');
  assert.ok(editorJs.includes('editInfoboxImage'), 'Must define editInfoboxImage');
  assert.ok(editorJs.includes('hideAlign: true'), 'Image dialog must support hiding alignment for infobox');

  // 2. Blocks renderer outputs CSS variable for image width
  assert.ok(rendererJs.includes('--infobox-img-w'), 'Renderer must set --infobox-img-w for infobox image');

  // 3. Obsidian CSS styles image sizing
  assert.ok(obsidianCss.includes('max-width: var(--infobox-img-w, 100%)'), 'CSS must use --infobox-img-w variable');
  assert.ok(obsidianCss.includes('max-height: 280px'), 'CSS must allow larger images in infobox');
});

test('antropedia: reading view width matches editor and sidebar sits to the right', () => {
  const siteCss = fs.readFileSync(path.resolve(__dirname, '../../public/site/site.css'), 'utf8');
  const antropediaCss = fs.readFileSync(path.resolve(__dirname, '../../public/antropedia.css'), 'utf8');

  // 1. Site CSS article reading container max-width: 1200px
  assert.ok(siteCss.includes('max-width: 1200px;'), 'Article detail must expand to 1200px matching editor');
  assert.ok(siteCss.includes('max-width: min(1560px, 96vw)'), 'Main container must expand to accommodate wider reading area and sidebar');

  // 2. Admin panel antropedia.css max-width: 1200px
  assert.ok(antropediaCss.includes('max-width: 1200px;'), 'Admin article view must expand to 1200px');
});
