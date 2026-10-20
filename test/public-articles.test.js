const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const articleLayers = require('../src/services/article-layers');
const publicArticles = require('../src/services/public-articles');
const { createPublicArticlesRouter } = require('../src/routes/public-articles.routes');

function document(...blocks) {
  return { version: 1, blocks };
}

function legacyArticle(slug, overrides = {}) {
  return {
    slug,
    title: `Title ${slug}`,
    excerpt: `Excerpt ${slug}`,
    image: `/uploads/${slug}.png`,
    content: document({ type: 'paragraph', data: { markdown: `Text ${slug}` } }),
    layers: [],
    locked: false,
    roles: [],
    tags: ['Visible'],
    attachments: [{ secret: 'private attachment metadata' }],
    author_id: 123,
    server: 88,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides
  };
}

test('public resolver exposes unlocked legacy articles but not locked legacy articles', () => {
  const open = legacyArticle('open');
  const locked = legacyArticle('locked', { locked: true, roles: [4] });

  assert.ok(articleLayers.resolvePublicArticleLayers(open));
  assert.equal(publicArticles.getPublicArticle(locked), null);
});

test('public resolver requires explicit public marker beside restricted layers', () => {
  const article = legacyArticle('layered', {
    title: 'Private fallback title',
    excerpt: 'Private fallback excerpt',
    image: '/uploads/private.png',
    layers: articleLayers.normalizeLayers([
      {
        id: 'public-layer',
        public: true,
        title: 'Reader title',
        excerpt: 'Reader excerpt',
        content: document({ type: 'paragraph', data: { markdown: 'Reader text' } }),
        tags: ['Reader tag']
      },
      {
        id: 'restricted-layer',
        roles: [{ scope: 'system', id: 3 }],
        title: 'Secret title',
        excerpt: 'Secret excerpt',
        content: document({ type: 'paragraph', data: { markdown: 'Secret text' } }),
        tags: ['Secret tag']
      }
    ])
  });
  const result = publicArticles.getPublicArticle(article);

  assert.equal(result.title, 'Reader title');
  assert.equal(result.excerpt, 'Reader excerpt');
  assert.deepEqual(result.tags, ['Reader tag']);
  assert.equal(JSON.stringify(result).includes('Secret'), false);
  assert.deepEqual(Object.keys(result).sort(), [
    'content', 'created_at', 'excerpt', 'image', 'slug', 'tags', 'title', 'updated_at'
  ]);

  article.layers[0].public = false;
  assert.equal(publicArticles.getPublicArticle(article), null);
});

test('public DTO removes non-public map/gallery embeds and unknown block data recursively', () => {
  const article = legacyArticle('sanitized', {
    content: document(
      { type: 'map', data: { mapId: 'private-map' } },
      { type: 'image', data: { src: '', gallery: { workId: 99 } } },
      { type: 'future-secret-block', data: { secret: 'not safe' } },
      {
        type: 'columns',
        data: {
          columns: [{
            blocks: [
              { type: 'image', data: { src: '', gallery: { workId: 100 } } },
              { type: 'paragraph', data: { markdown: 'Visible nested text' } }
            ]
          }]
        }
      }
    )
  });

  const result = publicArticles.getPublicArticle(article);
  assert.deepEqual(result.content.blocks.map((block) => block.type), ['columns']);
  assert.deepEqual(
    result.content.blocks[0].data.columns[0].blocks.map((block) => block.type),
    ['paragraph']
  );
  assert.equal(JSON.stringify(result).includes('private-map'), false);
  assert.equal(JSON.stringify(result).includes('workId'), false);
  assert.equal(JSON.stringify(result).includes('not safe'), false);
});

test('guest endpoints only list/search/read public content and expose no write route', async (t) => {
  const publicArticle = legacyArticle('guest-open');
  const privateArticle = legacyArticle('guest-closed', {
    locked: true,
    roles: [2],
    content: document({ type: 'paragraph', data: { markdown: 'Secret search phrase' } })
  });
  const mixedArticle = legacyArticle('guest-mixed', {
    layers: articleLayers.normalizeLayers([
      {
        id: 'public',
        public: true,
        title: 'Public mixed article',
        tags: ['Public tag'],
        content: document({ type: 'paragraph', data: { markdown: 'Public searchable text' } })
      },
      {
        id: 'private',
        roles: [{ scope: 'system', id: 7 }],
        title: 'Private mixed article',
        tags: ['Private tag'],
        content: document({ type: 'paragraph', data: { markdown: 'Secret search phrase' } })
      }
    ])
  });
  const articleStore = {
    listArticles: () => [publicArticle, privateArticle, mixedArticle],
    getArticle: (slug) => [publicArticle, privateArticle, mixedArticle].find((article) => article.slug === slug) || null
  };

  const app = express();
  app.use('/api', createPublicArticlesRouter(articleStore));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  }));

  const base = `http://127.0.0.1:${server.address().port}/api/public/articles`;
  const listResponse = await fetch(base);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.total, 2);
  assert.deepEqual(list.data.map((article) => article.slug), ['guest-open', 'guest-mixed']);

  const secretSearch = await fetch(`${base}?q=Secret%20search%20phrase`);
  assert.deepEqual(await secretSearch.json(), {
    data: [],
    total: 0,
    limit: 30,
    offset: 0
  });

  const privateTagSearch = await fetch(`${base}?tag=Private%20tag`);
  assert.equal((await privateTagSearch.json()).total, 0);

  const publicTagSearch = await fetch(`${base}?tag=Public%20tag`);
  const publicTagResults = await publicTagSearch.json();
  assert.equal(publicTagResults.total, 1);
  assert.equal(publicTagResults.data[0].slug, 'guest-mixed');

  const openResponse = await fetch(`${base}/guest-open`);
  assert.equal(openResponse.status, 200);
  const openArticle = await openResponse.json();
  assert.deepEqual(Object.keys(openArticle).sort(), [
    'content', 'created_at', 'excerpt', 'image', 'slug', 'tags', 'title', 'updated_at'
  ]);

  const privateResponse = await fetch(`${base}/guest-closed`);
  assert.equal(privateResponse.status, 404);
  assert.deepEqual(await privateResponse.json(), { error: 'Статья не найдена' });

  const writeResponse = await fetch(base, { method: 'POST' });
  assert.equal(writeResponse.status, 404);
});
