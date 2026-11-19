// src/services/global-search.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { searchGlobal } = require('./global-search');

test('global-search: returns empty results for empty or whitespace query', async () => {
  const res = await searchGlobal('', { category: 'all' });
  assert.deepEqual(res.results, []);
  assert.equal(res.total, 0);
  assert.deepEqual(res.counts, { all: 0, articles: 0, gallery: 0, alltell: 0, radio: 0 });
});

test('global-search: executes multi-domain search across categories', async () => {
  const res = await searchGlobal('тест', { category: 'all', limit: 10 });
  assert.ok(Array.isArray(res.results), 'results should be an array');
  assert.ok(res.counts !== undefined, 'counts should be defined');
  assert.equal(typeof res.counts.all, 'number');
  assert.equal(typeof res.counts.articles, 'number');
  assert.equal(typeof res.counts.gallery, 'number');
  assert.equal(typeof res.counts.alltell, 'number');
  assert.equal(typeof res.counts.radio, 'number');
});

test('global-search: respects category filtering', async () => {
  const articlesOnly = await searchGlobal('война', { category: 'articles', limit: 5 });
  assert.ok(Array.isArray(articlesOnly.results));
  for (const item of articlesOnly.results) {
    assert.equal(item.type, 'article');
    assert.equal(item.badge, 'Статья');
  }

  const galleryOnly = await searchGlobal('арт', { category: 'gallery', limit: 5 });
  assert.ok(Array.isArray(galleryOnly.results));
  for (const item of galleryOnly.results) {
    assert.equal(item.type, 'gallery');
    assert.equal(item.badge, 'Галерея');
  }

  const alltellOnly = await searchGlobal('сервер', { category: 'alltell', limit: 5 });
  assert.ok(Array.isArray(alltellOnly.results));
  for (const item of alltellOnly.results) {
    assert.equal(item.type, 'alltell');
  }

  const radioOnly = await searchGlobal('радио', { category: 'radio', limit: 5 });
  assert.ok(Array.isArray(radioOnly.results));
  for (const item of radioOnly.results) {
    assert.equal(item.type, 'radio');
  }
});

test('global-search: items have standard fields for QuickSwitcher UI', async () => {
  const res = await searchGlobal('a', { category: 'all', limit: 10 });
  for (const item of res.results) {
    assert.ok(item.id, 'item should have an id');
    assert.ok(item.type, 'item should have a type');
    assert.ok(item.title, 'item should have a title');
    assert.ok(item.badge, 'item should have a badge');
    assert.ok(item.icon, 'item should have an icon');
  }
});
