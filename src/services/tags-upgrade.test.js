const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const blocks = require('./blocks');
const store = require('./articles-store');
const tagColors = require('./tag-colors');
const articleSearch = require('./article-search');

test('tags upgrade: removeHashtagsFromDocument replaces deleted hashtags in text with #[Данные удалены]', () => {
  const doc = {
    version: 1,
    blocks: [
      {
        id: 'b1',
        type: 'paragraph',
        data: { markdown: 'Это текст с #дракон и #магия в мире.' }
      },
      {
        id: 'b2',
        type: 'callout',
        data: { title: 'Заголовок #магия', markdown: 'Внимание #внимание и #дракон' }
      },
      {
        id: 'b3',
        type: 'list',
        data: {
          items: [
            { markdown: 'Элемент 1 #дракон' },
            { markdown: 'Элемент 2 #город' }
          ]
        }
      },
      {
        id: 'b4',
        type: 'table',
        data: {
          rows: [
            ['Колонка 1 #дракон', 'Колонка 2 #город']
          ]
        }
      }
    ]
  };

  const shouldRemove = (tag) => store.tagKey(tag) === 'дракон';
  const { doc: newDoc, changed } = blocks.removeHashtagsFromDocument(doc, shouldRemove);

  assert.equal(changed, true, 'changed must be true');
  assert.equal(newDoc.blocks[0].data.markdown, 'Это текст с #[Данные удалены] и #магия в мире.');
  assert.equal(newDoc.blocks[1].data.title, 'Заголовок #магия');
  assert.equal(newDoc.blocks[1].data.markdown, 'Внимание #внимание и #[Данные удалены]');
  assert.equal(newDoc.blocks[2].data.items[0].markdown, 'Элемент 1 #[Данные удалены]');
  assert.equal(newDoc.blocks[2].data.items[1].markdown, 'Элемент 2 #город');
  assert.equal(newDoc.blocks[3].data.rows[0][0], 'Колонка 1 #[Данные удалены]');
  assert.equal(newDoc.blocks[3].data.rows[0][1], 'Колонка 2 #город');

  // Verify that extractHashtagsFromDocument extracts 'данные удалены', 'магия', 'внимание', 'город'
  const extracted = blocks.extractHashtagsFromDocument(newDoc);
  assert.ok(!extracted.includes('дракон'), 'дракон must no longer be an extracted hashtag');
  assert.ok(extracted.includes('данные удалены'), 'данные удалены must be extracted as a hashtag so it can be searched');
  assert.ok(extracted.includes('магия'), 'магия must remain');
  assert.ok(extracted.includes('город'), 'город must remain');
});

test('tags upgrade: articleSearch parses bracketed hashtags like #[Данные удалены]', () => {
  const parsed = articleSearch.parseSearchQuery('#[Данные удалены] тест');
  assert.ok(parsed.hashKeys.includes('данные удалены'), 'Search must extract "данные удалены" from #[Данные удалены]');
});

test('tags upgrade: tag-colors deleteColors removes entries from tag_colors table', async () => {
  const key = 'test_del_tag_' + Date.now();
  await tagColors.setColor(key, 'Test Del Tag', '#112233');

  const beforeMap = await tagColors.ensureColors([{ key, name: 'Test Del Tag' }]);
  assert.equal(beforeMap.get(key)?.color, '#112233');

  const removed = await tagColors.deleteColors([key]);
  assert.ok(removed >= 1, 'deleteColors should report at least 1 deleted row');

  const afterMap = await tagColors.ensureColors([{ key, name: 'Test Del Tag' }]);
  assert.notEqual(afterMap.get(key)?.color, '#112233', 'Old color should be gone');

  // Cleanup
  await tagColors.deleteColors([key]);
});

test('tags upgrade: deleteTags in articles-store handles empty or non-matching tags safely', () => {
  const res = store.deleteTags(['__non_existing_tag_xyz_123__']);
  assert.equal(typeof res.affectedArticles, 'number');
  assert.ok(Array.isArray(res.affectedSlugs));
});

test('tags upgrade: tags.html contains sorting dropdown, selection hint and bulk action bar', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../public/views/tags.html'), 'utf8');

  // Sort dropdown & options
  assert.ok(html.includes('id="tagsSortSelect"'), 'Must have tagsSortSelect');
  assert.ok(html.includes('value="count_desc"'), 'Must have count_desc sort option');
  assert.ok(html.includes('value="count_asc"'), 'Must have count_asc sort option');
  assert.ok(html.includes('value="name_asc"'), 'Must have name_asc sort option');
  assert.ok(html.includes('value="name_desc"'), 'Must have name_desc sort option');

  // Selection hint and buttons
  assert.ok(html.includes('id="tagsSelectionHint"'), 'Must have tagsSelectionHint');
  assert.ok(html.includes('id="tagsSelectAllBtn"'), 'Must have tagsSelectAllBtn');
  assert.ok(html.includes('id="tagsDeselectAllBtn"'), 'Must have tagsDeselectAllBtn');

  // Bulk actions bar
  assert.ok(html.includes('id="tagsBulkBar"'), 'Must have tagsBulkBar');
  assert.ok(html.includes('id="tagsBulkSelectedCount"'), 'Must have tagsBulkSelectedCount');
  assert.ok(html.includes('id="tagsBulkColorBtn"'), 'Must have tagsBulkColorBtn');
  assert.ok(html.includes('id="tagsBulkDeleteBtn"'), 'Must have tagsBulkDeleteBtn');
  assert.ok(html.includes('id="tagsBulkCancelBtn"'), 'Must have tagsBulkCancelBtn');

  // Modal upgrades
  assert.ok(html.includes('id="tag-color-modal-title"'), 'Modal must have tag-color-modal-title');
  assert.ok(html.includes('id="tag-color-modal-desc"'), 'Modal must have tag-color-modal-desc');
});

test('tags upgrade: spa-router.js implements sorting, gesture selection (Ctrl+click & long press), bulk color and deletion', () => {
  const js = fs.readFileSync(path.resolve(__dirname, '../../public/spa-router.js'), 'utf8');

  // Check state & handlers
  assert.ok(js.includes('this.tagsSelected = new Set()'), 'Must initialize tagsSelected set');
  assert.ok(js.includes('this.tagsSortOrder'), 'Must track tagsSortOrder');
  assert.ok(js.includes('toggleTagSelection('), 'Must implement toggleTagSelection');
  assert.ok(js.includes('selectAllVisibleTags('), 'Must implement selectAllVisibleTags');
  assert.ok(js.includes('clearSelectedTags('), 'Must implement clearSelectedTags');
  assert.ok(js.includes('deleteSelectedTags('), 'Must implement deleteSelectedTags');
  assert.ok(js.includes('showBulkTagColorModal('), 'Must implement showBulkTagColorModal');
  assert.ok(js.includes('updateTagsBulkBar('), 'Must implement updateTagsBulkBar');

  // Verify non-persistent selection: Ctrl/Cmd click on desktop and long press on touch
  assert.ok(js.includes('e.ctrlKey || e.metaKey'), 'Must handle Ctrl/Cmd click for selection');
  assert.ok(js.includes('longPressTimer'), 'Must handle long press timer for mobile devices');
  assert.ok(js.includes('tag-card-check'), 'Cards render clean check badge instead of permanent checkboxes');
  assert.ok(!js.includes('tag-card-checkbox'), 'Cards must NOT contain permanent checkbox elements');
});

test('tags upgrade: app.js ApiClient supports deleteTags and bulk setTagColor with DELETE body support', () => {
  const js = fs.readFileSync(path.resolve(__dirname, '../../public/app.js'), 'utf8');

  assert.ok(js.includes("method === 'DELETE'"), 'makeAuthenticatedRequest must support DELETE body');
  assert.ok(js.includes('deleteTags(tagOrTags)'), 'ApiClient must implement deleteTags');
  assert.ok(js.includes('Array.isArray(tagOrTags)'), 'setTagColor must support array of tags');
});
