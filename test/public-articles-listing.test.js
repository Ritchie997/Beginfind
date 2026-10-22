// Список/фильтры/сортировка публичного каталога — чистая логика без express и БД.

const assert = require('node:assert/strict');
const test = require('node:test');
const articleLayers = require('../src/services/article-layers');
const publicArticles = require('../src/services/public-articles');

function document(...blocks) {
  return { version: 1, blocks };
}

function paragraph(markdown) {
  return { type: 'paragraph', data: { markdown } };
}

function article(slug, overrides = {}) {
  return {
    slug,
    title: `Title ${slug}`,
    excerpt: `Excerpt ${slug}`,
    image: null,
    content: document(paragraph(`Text ${slug}`)),
    layers: [],
    locked: false,
    roles: [],
    tags: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function slugs(result) {
  return result.data.map((item) => item.slug);
}

const catalog = () => [
  article('alpha', {
    title: 'Дом Ториан',
    tags: ['Персонажи', 'Фракции'],
    created_at: '2026-01-10T12:00:00.000Z',
    updated_at: '2026-03-01T00:00:00.000Z',
    content: document(paragraph('Правящая династия Севера #север'))
  }),
  article('bravo', {
    title: 'Ибри-Порт',
    tags: ['Локации'],
    created_at: '2026-02-05T08:00:00.000Z',
    updated_at: '2026-02-06T00:00:00.000Z',
    content: document(paragraph('Торговый узел. Дом Ториан держит доки.'))
  }),
  article('charlie', {
    title: 'Война Трёх Флагов',
    tags: ['История', 'Персонажи'],
    created_at: '2026-03-20T00:00:00.000Z',
    updated_at: '2026-03-21T00:00:00.000Z',
    content: document(paragraph('Конфликт на столетия'))
  }),
  article('closed', {
    title: 'Закрытая статья',
    locked: true,
    roles: [2],
    tags: ['Секрет'],
    created_at: '2026-04-01T00:00:00.000Z'
  })
];

test('default order is newest first and closed articles never appear', () => {
  const result = publicArticles.listPublicArticles(catalog());
  assert.deepEqual(slugs(result), ['charlie', 'bravo', 'alpha']);
  assert.equal(result.total, 3);
});

test('sort modes: oldest, updated, alpha, views', () => {
  const list = (sort, extra) => slugs(publicArticles.listPublicArticles(catalog(), { sort, ...extra }));
  assert.deepEqual(list('oldest'), ['alpha', 'bravo', 'charlie']);
  assert.deepEqual(list('updated'), ['charlie', 'alpha', 'bravo']);
  // По заголовкам: «Война…» < «Дом…» < «Ибри…».
  assert.deepEqual(list('alpha'), ['charlie', 'alpha', 'bravo']);
  assert.deepEqual(list('views', { viewCounts: new Map([['alpha', 9], ['bravo', 3]]) }), ['alpha', 'bravo', 'charlie']);
  // Ничья по просмотрам разрешается свежестью, а неизвестная сортировка — это "новые".
  assert.deepEqual(list('views', { viewCounts: new Map() }), ['charlie', 'bravo', 'alpha']);
  assert.deepEqual(list('bogus'), ['charlie', 'bravo', 'alpha']);
});

test('tag filter accepts several tags (any match), ignores "#" and case', () => {
  const list = (tag) => slugs(publicArticles.listPublicArticles(catalog(), { tag }));
  assert.deepEqual(list('Персонажи'), ['charlie', 'alpha']);
  assert.deepEqual(list('#персонажи'), ['charlie', 'alpha']);
  assert.deepEqual(list('Локации,История'), ['charlie', 'bravo']);
  assert.deepEqual(list('север'), ['alpha']); // #хэштег из текста
  assert.deepEqual(list('Секрет'), []); // тег закрытой статьи не виден
  assert.equal(list('').length, 3);
});

test('date range is inclusive, including the whole "to" day', () => {
  const list = (dateFrom, dateTo) => slugs(publicArticles.listPublicArticles(catalog(), { dateFrom, dateTo }));
  assert.deepEqual(list('2026-02-01', ''), ['charlie', 'bravo']);
  assert.deepEqual(list('', '2026-01-10'), ['alpha']);
  assert.deepEqual(list('2026-01-10', '2026-02-05'), ['bravo', 'alpha']);
  assert.deepEqual(list('2026-05-01', ''), []);
  assert.deepEqual(list('not-a-date', 'also-bad'), ['charlie', 'bravo', 'alpha']);
});

test('search ranks title matches above text matches; #words filter by tag prefix', () => {
  const search = (q, extra) => slugs(publicArticles.listPublicArticles(catalog(), { q, ...extra }));
  // "Дом Ториан": заголовок статьи alpha важнее упоминания в тексте bravo.
  assert.deepEqual(search('дом ториан'), ['alpha', 'bravo']);
  assert.deepEqual(search('дом ториан', { sort: 'newest' }), ['bravo', 'alpha']);
  assert.deepEqual(search('#перс'), ['charlie', 'alpha']);
  assert.deepEqual(search('#перс #фракц'), ['alpha']);
  assert.deepEqual(search('ториан #локац'), ['bravo']);
  assert.deepEqual(search('Закрытая'), []);
});

test('pagination slices the sorted result and reports the full total', () => {
  const result = publicArticles.listPublicArticles(catalog(), { sort: 'oldest', limit: 2, offset: 1 });
  assert.deepEqual(slugs(result), ['bravo', 'charlie']);
  assert.equal(result.total, 3);
  assert.equal(result.limit, 2);
  assert.equal(result.offset, 1);
});

test('summaries expose only whitelisted fields', () => {
  const [first] = publicArticles.listPublicArticles(catalog()).data;
  assert.deepEqual(Object.keys(first).sort(), [
    'created_at', 'excerpt', 'image', 'slug', 'tags', 'title', 'updated_at'
  ]);
});

test('public tag list counts articles, keeps author casing, hides restricted layers', () => {
  const layered = article('layered', {
    layers: articleLayers.normalizeLayers([
      { id: 'public', public: true, title: 'Public', tags: ['Персонажи'], content: document(paragraph('Text')) },
      { id: 'private', roles: [{ scope: 'system', id: 7 }], title: 'Private', tags: ['Секретный слой'], content: document(paragraph('#скрыто')) }
    ])
  });
  const tags = publicArticles.listPublicTags([...catalog(), layered]);
  const byTag = Object.fromEntries(tags.map((item) => [item.tag, item.count]));

  assert.equal(byTag['Персонажи'], 3);
  assert.equal(byTag['Фракции'], 1);
  assert.equal(byTag['север'], 1);
  assert.equal('Секрет' in byTag, false);
  assert.equal('Секретный слой' in byTag, false);
  assert.equal('скрыто' in byTag, false);
  assert.equal(tags[0].tag, 'Персонажи'); // по убыванию числа статей
  assert.deepEqual(Object.keys(tags[0]).sort(), ['count', 'tag']);
});
