const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const blocks = require('./blocks');

test('columns: server model allows infobox, callout, map, spoiler and content blocks in columns', () => {
  const rawDocument = {
    version: 1,
    blocks: [
      {
        id: 'cols-1',
        type: 'columns',
        data: {
          columns: [
            {
              widthPct: 40,
              blocks: [
                {
                  id: 'info-1',
                  type: 'infobox',
                  data: {
                    title: 'Персонаж',
                    rows: [{ label: 'Фракция', value: 'Стражи' }]
                  }
                },
                {
                  id: 'img-1',
                  type: 'image',
                  data: { src: '/uploads/portrait.png', alt: 'Портрет' }
                }
              ]
            },
            {
              widthPct: 60,
              blocks: [
                {
                  id: 'head-1',
                  type: 'heading',
                  data: { level: 2, markdown: 'Биография' }
                },
                {
                  id: 'call-1',
                  type: 'callout',
                  data: { variant: 'info', title: 'Заметка', markdown: 'Важные детали' }
                },
                {
                  id: 'spoil-1',
                  type: 'spoiler-section',
                  data: {
                    title: 'Сюжетные спойлеры',
                    blocks: [
                      { id: 'p-1', type: 'paragraph', data: { markdown: 'Секретная информация' } }
                    ]
                  }
                },
                {
                  id: 'map-1',
                  type: 'map',
                  data: { mapId: 'world-map', height: 350 }
                }
              ]
            }
          ]
        }
      }
    ]
  };

  const normalized = blocks.normalizeDocument(rawDocument);
  assert.equal(normalized.blocks.length, 1);
  const colBlock = normalized.blocks[0];
  assert.equal(colBlock.type, 'columns');
  assert.equal(colBlock.data.columns.length, 2);

  // Column 1
  const col1 = colBlock.data.columns[0];
  assert.equal(col1.blocks.length, 2);
  assert.equal(col1.blocks[0].type, 'infobox');
  assert.equal(col1.blocks[0].data.title, 'Персонаж');
  assert.equal(col1.blocks[1].type, 'image');

  // Column 2
  const col2 = colBlock.data.columns[1];
  assert.equal(col2.blocks.length, 4);
  assert.equal(col2.blocks[0].type, 'heading');
  assert.equal(col2.blocks[1].type, 'callout');
  assert.equal(col2.blocks[2].type, 'spoiler-section');
  assert.equal(col2.blocks[2].data.blocks.length, 1);
  assert.equal(col2.blocks[2].data.blocks[0].type, 'paragraph');
  assert.equal(col2.blocks[3].type, 'map');
});

test('columns: recursive columns inside columns are rejected to prevent invalid layouts', () => {
  const invalidColumnsInsideColumns = {
    id: 'cols-outer',
    type: 'columns',
    data: {
      columns: [
        {
          widthPct: 50,
          blocks: [
            {
              id: 'cols-inner',
              type: 'columns',
              data: {
                columns: [{ widthPct: 50, blocks: [] }, { widthPct: 50, blocks: [] }]
              }
            }
          ]
        },
        {
          widthPct: 50,
          blocks: [{ id: 'p-1', type: 'paragraph', data: { markdown: 'OK' } }]
        }
      ]
    }
  };

  const normalized = blocks.normalizeBlock(invalidColumnsInsideColumns);
  assert.equal(normalized.data.columns[0].blocks.length, 0, 'Nested columns block must be discarded');
  assert.equal(normalized.data.columns[1].blocks.length, 1, 'Valid paragraph block must be preserved');
});

test('columns: editor-manager implements per-column drop target resolution and drag styles', () => {
  const editorJs = fs.readFileSync(path.resolve(__dirname, '../../public/editor-manager.js'), 'utf8');

  // 1. NESTED_ALLOWED_TYPES must include infobox, callout, map, spoiler-section
  assert.ok(editorJs.includes("'infobox'"), 'Must include infobox in nested allowed types');
  assert.ok(editorJs.includes("'callout'"), 'Must include callout in nested allowed types');
  assert.ok(editorJs.includes("'map'"), 'Must include map in nested allowed types');
  assert.ok(editorJs.includes("'spoiler-section'"), 'Must include spoiler-section in nested allowed types');

  // 2. canListHostBlocks helper
  assert.ok(editorJs.includes('canListHostBlocks'), 'Must define canListHostBlocks helper');

  // 3. closestColInWrap helper for gap between columns
  assert.ok(editorJs.includes('closestColInWrap'), 'Must define closestColInWrap for inter-column gaps');

  // 4. Per-column drop targeting in findDropTarget
  assert.ok(editorJs.includes("el.closest('.eb-columns-wrap')"), 'Must detect column row in findDropTarget');
  assert.ok(editorJs.includes("el.closest('.eb-column')"), 'Must detect specific column in findDropTarget');

  // 5. Active column drop highlight
  assert.ok(editorJs.includes('eb-column-drop-target'), 'Must apply drop highlight class to active column');
});

test('columns: editor-blocks.css contains drop target highlight and empty column placeholder', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../public/editor-blocks.css'), 'utf8');

  assert.ok(css.includes('.eb-column.eb-column-drop-target'), 'CSS must define .eb-column-drop-target');
  assert.ok(css.includes('.eb-nested-blocklist:empty'), 'CSS must define empty nested blocklist styles');
  assert.ok(css.includes('.eb-column .eb-infobox-editor'), 'CSS must contain column infobox editor constraint');
});

test('columns: list moving simulation across columns and document', () => {
  // Simulate editor document structure
  const docBlocks = [
    { id: 'top-1', type: 'paragraph', data: { markdown: 'Intro' } },
    {
      id: 'cols-1',
      type: 'columns',
      data: {
        columns: [
          { widthPct: 50, blocks: [{ id: 'col1-p1', type: 'paragraph', data: { markdown: 'Col 1 Text' } }] },
          { widthPct: 50, blocks: [] }
        ]
      }
    },
    { id: 'bottom-1', type: 'paragraph', data: { markdown: 'Footer' } }
  ];

  const col1 = docBlocks[1].data.columns[0].blocks;
  const col2 = docBlocks[1].data.columns[1].blocks;

  // 1. Move block from main doc into empty Column 2
  const movingBlock1 = docBlocks[0]; // 'top-1'
  docBlocks.splice(0, 1);
  col2.splice(0, 0, movingBlock1);
  assert.equal(col2.length, 1);
  assert.equal(col2[0].id, 'top-1');
  assert.equal(docBlocks[0].id, 'cols-1');

  // 2. Move block from Column 1 to Column 2
  const movingBlock2 = col1[0]; // 'col1-p1'
  col1.splice(0, 1);
  col2.splice(1, 0, movingBlock2);
  assert.equal(col1.length, 0, 'Column 1 is now empty');
  assert.equal(col2.length, 2, 'Column 2 has both blocks');
  assert.equal(col2[1].id, 'col1-p1');

  // 3. Move block from Column 2 back to main document
  const movingBlock3 = col2[1];
  col2.splice(1, 1);
  docBlocks.splice(1, 0, movingBlock3);
  assert.equal(col2.length, 1);
  assert.equal(docBlocks.length, 3);
  assert.equal(docBlocks[1].id, 'col1-p1');
});

test('columns: strict sizing constraints in editor-obsidian.css prevent image overflow and infobox overlap', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../public/editor-obsidian.css'), 'utf8');

  // 1. Column rigid bounding (min-width: 0, max-width: 100%, overflow: hidden)
  assert.ok(css.includes('.preview-pane .blk-column {'), 'Must define .preview-pane .blk-column');
  assert.ok(css.includes('overflow: hidden;'), 'Column must isolate contents with overflow: hidden');
  assert.ok(css.includes('min-width: 0;'), 'Column must override flex default with min-width: 0');
  assert.ok(css.includes('max-width: 100%;'), 'Column must have max-width: 100%');

  // 2. Images inside column must not float or poke out of the column
  assert.ok(css.includes('.preview-pane .blk-column figure.blk-image'), 'Must constrain image figure in column');
  assert.ok(css.includes('.preview-pane .blk-column figure.blk-image img'), 'Must constrain image element in column');
  assert.ok(css.includes('float: none !important;'), 'Must cancel floats inside column');

  // 3. Infobox inside column must not float right, must not have 300px fixed width or 22px margin
  assert.ok(css.includes('.preview-pane .blk-column aside.blk-infobox'), 'Must constrain infobox in column');
  assert.ok(css.includes('width: 100% !important;'), 'Infobox in column must take 100% of column width');
  assert.ok(css.includes('margin: 0 0 16px 0 !important;'), 'Infobox in column must not have 22px margin');
});

test('columns: strict sizing constraints in editor-blocks.css and editor-manager.js', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../public/editor-blocks.css'), 'utf8');
  const js = fs.readFileSync(path.resolve(__dirname, '../../public/editor-manager.js'), 'utf8');

  // 1. Editor column bounding in CSS
  assert.ok(css.includes('min-width: 0;'), 'Editor column must specify min-width: 0');
  assert.ok(css.includes('.eb-column .eb-image-block img'), 'Must constrain image img in editor column');
  assert.ok(css.includes('.eb-column .eb-infobox-row'), 'Must constrain infobox rows in editor column');
  assert.ok(css.includes('minmax(0, 1fr)'), 'Must use minmax(0, 1fr) in editor infobox rows');

  // 2. Editor columns dynamically set flex and --w based on widthPct
  assert.ok(js.includes("colEl.style.setProperty('--w', currentPct)"), 'Must set --w variable on column element');
  assert.ok(js.includes("colEl.style.flex = `${currentPct} 1 0%`"), 'Must set flex proportion on column element');
  assert.ok(js.includes("colEl.style.flex = `${col.widthPct} 1 0%`"), 'Must update flex proportion on input change');
});
