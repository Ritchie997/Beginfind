// src/services/articles-fts.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const fts = require('./articles-fts');
const searchService = require('./article-search');

test('articles-fts: indexing, BM25 search, snippets, and stemming', async () => {
  const db = new sqlite3.Database(':memory:');
  await fts.initFts(db);

  const mockArticles = [
    {
      slug: 'poet-bio',
      title: 'Поэт',
      tags: ['стихи', 'литература'],
      legacyAuthorName: 'Ритчи',
      layers: [
        {
          title: 'Поэт',
          content: {
            blocks: [{ type: 'paragraph', data: { markdown: 'Великий поэт жил в высоких горах.' } }]
          }
        }
      ]
    },
    {
      slug: 'logic-notes',
      title: 'Логика и рассуждения',
      tags: ['философия'],
      legacyAuthorName: 'Платон',
      layers: [
        {
          title: 'Логика и рассуждения',
          content: {
            blocks: [{ type: 'paragraph', data: { markdown: 'У нас было мало времени, поэтому мы поспешили.' } }]
          }
        }
      ]
    },
    {
      slug: 'box-war-6',
      title: 'Шестая Коробочная война',
      tags: ['война', 'история'],
      legacyAuthorName: 'Летописец',
      layers: [
        {
          title: 'Шестая Коробочная война',
          content: {
            blocks: [{ type: 'paragraph', data: { markdown: 'Эта война потрясла весь континент.' } }]
          }
        }
      ]
    }
  ];

  await fts.syncAllArticles(mockArticles, null, db);

  // 1. Поиск "Поэт"
  const parsed1 = searchService.parseSearchQuery('Поэт');
  const res1 = await fts.searchFts(parsed1, {}, db);
  assert.equal(res1.has('poet-bio'), true);
  // Важнейшая проверка: "поэтому" НЕ должно матчиться!
  assert.equal(res1.has('logic-notes'), false);
  // Проверка сниппета с <mark>
  assert.ok(res1.get('poet-bio').snippet.includes('<mark>поэт</mark>'));

  // 2. Морфологический поиск: "войны" находит "Шестая Коробочная война"
  const parsed2 = searchService.parseSearchQuery('войны');
  const res2 = await fts.searchFts(parsed2, {}, db);
  assert.equal(res2.has('box-war-6'), true);

  // 3. Исправление раскладки: "djqyf" -> "война"
  const parsed3 = searchService.parseSearchQuery('djqyf');
  const res3 = await fts.searchFts(parsed3, {}, db);
  assert.equal(res3.has('box-war-6'), true);

  // 4. Поиск по автору @Ритчи
  const parsed4 = searchService.parseSearchQuery('@Ритчи');
  const res4 = await fts.searchFts(parsed4, {}, db);
  assert.equal(res4.has('poet-bio'), true);
  assert.equal(res4.has('logic-notes'), false);

  // 5. Удаление статьи
  await fts.removeArticle('poet-bio', db);
  const res5 = await fts.searchFts(parsed1, {}, db);
  assert.equal(res5.has('poet-bio'), false);

  // 6. Проверка изоляции сниппетов: пустой поиск не должен содержать search_snippet
  const store = require('./articles-store');
  const emptyResults = store.filterArticles({ q: '' });
  assert.ok(emptyResults.length > 0);
  assert.ok(emptyResults.every(a => !a.search_snippet), 'При пустом поиске ни у одной статьи не должно быть search_snippet');
});
