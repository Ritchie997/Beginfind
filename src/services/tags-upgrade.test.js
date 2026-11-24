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

test('tags autocomplete: editor-manager.js implements hashtag suggestion alongside wikilinks', () => {
  const js = fs.readFileSync(path.resolve(__dirname, '../../public/editor-manager.js'), 'utf8');

  // Verify regex and methods
  assert.ok(js.includes('const HASHTAG_OPEN_RE'), 'Must define HASHTAG_OPEN_RE');
  assert.ok(js.includes('loadTagsIndex('), 'Must implement loadTagsIndex');
  assert.ok(js.includes('updateSuggest('), 'Must implement unified updateSuggest');
  assert.ok(js.includes('updateHashtagSuggest('), 'Must implement updateHashtagSuggest');
  assert.ok(js.includes('eb-suggest-tag-item'), 'Must render eb-suggest-tag-item buttons');
  assert.ok(js.includes('eb-tag-suggest'), 'Must apply eb-tag-suggest class to floating popup');

  // Test HASHTAG_OPEN_RE regex matching behavior
  const HASHTAG_OPEN_RE = /(?:^|[\s\u00a0(])#(?:\[([^\]\n]*)|([a-zA-Zа-яА-ЯёЁ0-9_-]*))$/;
  assert.ok(HASHTAG_OPEN_RE.test('Текст #'), 'Matches # at end of line');
  assert.ok(HASHTAG_OPEN_RE.test('Текст #магия'), 'Matches #магия at end of line');
  assert.ok(HASHTAG_OPEN_RE.test('Текст #[данные'), 'Matches bracketed #[данные at end of line');
  assert.ok(HASHTAG_OPEN_RE.test('#первое'), 'Matches # at beginning of string');
  assert.ok(HASHTAG_OPEN_RE.test('(#в_скобках'), 'Matches # after opening parenthesis');
  assert.ok(!HASHTAG_OPEN_RE.test('user#notatag'), 'Must NOT match anchor without space');
  assert.ok(!HASHTAG_OPEN_RE.test('Текст #готово '), 'Must NOT match after trailing space');
});

test('tags autocomplete: alltell-client.js implements hashtag and wikilink suggestions in publication feed', () => {
  const js = fs.readFileSync(path.resolve(__dirname, '../../public/site/alltell-client.js'), 'utf8');

  assert.ok(js.includes('FEED_TAG_OPEN_RE'), 'Must define FEED_TAG_OPEN_RE');
  assert.ok(js.includes('FEED_WIKILINK_OPEN_RE'), 'Must define FEED_WIKILINK_OPEN_RE');
  assert.ok(js.includes('loadFeedTags('), 'Must implement loadFeedTags');
  assert.ok(js.includes('loadFeedArticles('), 'Must implement loadFeedArticles');
  assert.ok(js.includes('updateTagSuggest('), 'Must implement updateTagSuggest');
  assert.ok(js.includes('handleTagKeydown('), 'Must implement handleTagKeydown');
  assert.ok(js.includes('applyTagSuggest('), 'Must implement applyTagSuggest');
  assert.ok(js.includes('alltell-tag-suggest'), 'Must render alltell-tag-suggest popup');
});

test('tags autocomplete: CSS styling exists for tag suggest in editor-blocks.css and site.css', () => {
  const editorBlocksCss = fs.readFileSync(path.resolve(__dirname, '../../public/editor-blocks.css'), 'utf8');
  assert.ok(editorBlocksCss.includes('.eb-wikilink-suggest.eb-tag-suggest'), 'Must style eb-tag-suggest in editor-blocks.css');
  assert.ok(editorBlocksCss.includes('.eb-suggest-tag-item'), 'Must style eb-suggest-tag-item in editor-blocks.css');
  assert.ok(editorBlocksCss.includes('.eb-suggest-tag-icon'), 'Must style eb-suggest-tag-icon in editor-blocks.css');
  assert.ok(editorBlocksCss.includes('.eb-suggest-tag-name'), 'Must style eb-suggest-tag-name in editor-blocks.css');
  assert.ok(editorBlocksCss.includes('.eb-suggest-tag-meta'), 'Must style eb-suggest-tag-meta in editor-blocks.css');

  const siteCss = fs.readFileSync(path.resolve(__dirname, '../../public/site/site.css'), 'utf8');
  assert.ok(siteCss.includes('.alltell-tag-suggest'), 'Must style alltell-tag-suggest in site.css');
});

test('tag colors: TagColors module exists and correctly normalizes, registers and paints elements', () => {
  const TagColors = require('../../public/tag-colors');
  assert.ok(TagColors, 'TagColors must be exported');
  assert.strictEqual(typeof TagColors.get, 'function');
  assert.strictEqual(typeof TagColors.set, 'function');
  assert.strictEqual(typeof TagColors.registerAll, 'function');
  assert.strictEqual(typeof TagColors.paint, 'function');

  // Test normalization
  assert.strictEqual(TagColors.normalizeKey('#Дракон'), 'дракон');
  assert.strictEqual(TagColors.normalizeKey('##[Космос]'), 'космос');
  assert.strictEqual(TagColors.normalizeKey('  [Данные удалены]  '), 'данные удалены');

  // Test register and get
  TagColors.registerAll([
    { tag: 'Дракон', color: '#ff5722' },
    { tag: 'Космос', color: '#00b0f4' }
  ]);
  assert.strictEqual(TagColors.get('дракон'), '#ff5722');
  assert.strictEqual(TagColors.get('#Дракон'), '#ff5722');
  assert.strictEqual(TagColors.get('#[Космос]'), '#00b0f4');
  assert.strictEqual(TagColors.get('nonexistent'), null);

  // Test set
  TagColors.set('дракон', '#e91e63');
  assert.strictEqual(TagColors.get('дракон'), '#e91e63');

  // Test paint mock element
  const mockEl = {
    dataset: { tag: 'дракон' },
    style: {},
    classList: {
      classes: new Set(),
      contains(cls) { return this.classes.has(cls); },
      add(cls) { this.classes.add(cls); }
    },
    getAttribute() { return null; }
  };
  TagColors.paint(mockEl);
  assert.strictEqual(mockEl.style.color, '#e91e63');
  assert.ok(mockEl.style.backgroundColor.includes('#e91e63'));
  assert.ok(mockEl.style.borderColor.includes('#e91e63'));
  assert.ok(mockEl.classList.contains('has-tag-color'));
});

test('tag colors: blocks-renderer.js and alltell-client.js format hashtags with tag colors', () => {
  const rendererJs = fs.readFileSync(path.resolve(__dirname, '../../public/blocks-renderer.js'), 'utf8');
  assert.ok(rendererJs.includes('TagColors.paint(span, tagValue)'), 'blocks-renderer must call TagColors.paint on hashtag spans');
  assert.ok(rendererJs.includes('TagColors.paintAll(container)'), 'blocks-renderer must repaint container tags on attach');

  const alltellJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/alltell-client.js'), 'utf8');
  assert.ok(alltellJs.includes('alltell-post-hashtag'), 'alltell-client must render alltell-post-hashtag');
  assert.ok(alltellJs.includes('TagColors.get(raw)'), 'alltell-client must query TagColors in formatPostBody');
  assert.ok(alltellJs.includes('TagColors.registerAll('), 'alltell-client must register tags into TagColors');
});

test('tag colors: public-articles route /public/tags returns color for public tags', () => {
  const routeJs = fs.readFileSync(path.resolve(__dirname, '../../src/routes/public-articles.routes.js'), 'utf8');
  assert.ok(routeJs.includes('colorsStore.ensureColors'), '/public/tags route must ensure colors for public tags');
  assert.ok(routeJs.includes('color: (colorMap.get'), '/public/tags route must include color in response data');
});

test('tag colors: global-styles.css, editor-obsidian.css and site.css include hashtag badge styles', () => {
  const globalCss = fs.readFileSync(path.resolve(__dirname, '../../public/global-styles.css'), 'utf8');
  assert.ok(globalCss.includes('.hashtag'), 'global-styles.css must include .hashtag');
  assert.ok(globalCss.includes('.hashtag.has-tag-color'), 'global-styles.css must style .hashtag.has-tag-color');
  assert.ok(globalCss.includes('.alltell-post-hashtag'), 'global-styles.css must style .alltell-post-hashtag');

  const obsidianCss = fs.readFileSync(path.resolve(__dirname, '../../public/editor-obsidian.css'), 'utf8');
  assert.ok(obsidianCss.includes('.preview-pane .hashtag'), 'editor-obsidian.css must style .preview-pane .hashtag');

  const siteCss = fs.readFileSync(path.resolve(__dirname, '../../public/site/site.css'), 'utf8');
  assert.ok(siteCss.includes('.hashtag'), 'site.css must include .hashtag');
});

test('unified tag dropdown & metadata chips: chip-field.js mirrors editor suggest and paints colored chips', () => {
  const chipFieldJs = fs.readFileSync(path.resolve(__dirname, '../../public/chip-field.js'), 'utf8');

  // Unified dropdown item markup
  assert.ok(chipFieldJs.includes('eb-suggest-tag-item'), 'chip-field dropdown must use eb-suggest-tag-item class');
  assert.ok(chipFieldJs.includes('eb-suggest-tag-icon'), 'chip-field dropdown must render eb-suggest-tag-icon');
  assert.ok(chipFieldJs.includes('eb-suggest-tag-name'), 'chip-field dropdown must render eb-suggest-tag-name');
  assert.ok(chipFieldJs.includes('eb-suggest-tag-meta'), 'chip-field dropdown must render eb-suggest-tag-meta');
  assert.ok(chipFieldJs.includes('eb-tag-suggest'), 'chip-field dropdown must add eb-tag-suggest class for tags');

  // Keyboard navigation
  assert.ok(chipFieldJs.includes("e.key === 'ArrowDown'"), 'chip-field must support ArrowDown navigation');
  assert.ok(chipFieldJs.includes("e.key === 'ArrowUp'"), 'chip-field must support ArrowUp navigation');
  assert.ok(chipFieldJs.includes('eb-suggest-active') || chipFieldJs.includes('is-active'), 'chip-field must track active suggest item');

  // Chip coloring
  assert.ok(chipFieldJs.includes('has-tag-color'), 'chip-field must set has-tag-color on colored chips');
  assert.ok(chipFieldJs.includes('TagColors.get'), 'chip-field must check TagColors for chip colors');

  const globalCss = fs.readFileSync(path.resolve(__dirname, '../../public/global-styles.css'), 'utf8');
  assert.ok(globalCss.includes('.chip-field-chip.has-tag-color'), 'global-styles.css must style .chip-field-chip.has-tag-color');
  assert.ok(globalCss.includes('.eb-suggest-tag-icon'), 'global-styles.css must include .eb-suggest-tag-icon');
});

test('reading view and antropedia feed: tags take colors in detail view, cards and quick tags', () => {
  const siteJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/site.js'), 'utf8');
  assert.ok(siteJs.includes('public-article-tags'), 'site.js must manage public-article-tags in reading view');
  assert.ok(siteJs.includes('TagColors.get(clean'), 'site.js must query TagColors in detail view & cards');
  assert.ok(siteJs.includes('has-tag-color'), 'site.js must add has-tag-color to colored tag buttons/chips');

  const antropediaJs = fs.readFileSync(path.resolve(__dirname, '../../public/antropedia.js'), 'utf8');
  assert.ok(antropediaJs.includes('antropedia-view-tag'), 'antropedia.js must render antropedia-view-tag in reading view');
  assert.ok(antropediaJs.includes('antropedia-card-tags'), 'antropedia.js must render antropedia-card-tags on catalog cards');
  assert.ok(antropediaJs.includes('TagColors'), 'antropedia.js must integrate with TagColors');
});

test('antropedia tag dropdown z-index: toolbar and chip-field dropdown stay above article cards', () => {
  const globalCss = fs.readFileSync(path.resolve(__dirname, '../../public/global-styles.css'), 'utf8');
  assert.ok(globalCss.includes('.chip-field.has-open-dropdown'), 'global-styles.css must style .chip-field.has-open-dropdown');
  assert.ok(globalCss.includes('z-index: 1200'), 'global-styles.css must set high z-index on chip-field-dropdown');

  const siteCss = fs.readFileSync(path.resolve(__dirname, '../../public/site/site.css'), 'utf8');
  assert.ok(siteCss.includes('.antropedia-toolbar-container') && siteCss.includes('z-index: 60'), 'site.css must give toolbar container explicit z-index');
  assert.ok(siteCss.includes('.antropedia-toolbar-container:focus-within') || siteCss.includes('.antropedia-toolbar:focus-within'), 'site.css must elevate toolbar z-index on focus');

  const antropediaCss = fs.readFileSync(path.resolve(__dirname, '../../public/antropedia.css'), 'utf8');
  assert.ok(antropediaCss.includes('z-index: 100'), 'antropedia.css must give .antropedia-toolbar z-index of 100');
  assert.ok(!antropediaCss.includes('.antropedia-toolbar {\n    position: static;'), 'antropedia.css must not use position: static for toolbar on tablet/mobile');

  const chipFieldJs = fs.readFileSync(path.resolve(__dirname, '../../public/chip-field.js'), 'utf8');
  assert.ok(chipFieldJs.includes('has-open-dropdown'), 'chip-field.js must toggle has-open-dropdown class');
});
