const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { PUBLIC_DIR } = require('../src/config/paths');
const pages = require('../src/routes/pages.routes');

test('public and admin entry points remain separated with legacy URLs', async (t) => {
  const app = express();
  app.use(express.static(PUBLIC_DIR, { index: false }));
  const records = [
    {
      slug: 'public example',
      title: 'Public "title"',
      excerpt: 'A public "description"',
      image: '/uploads/public-cover.png',
      content: { version: 1, blocks: [] },
      layers: [],
      locked: false,
      roles: []
    },
    {
      slug: 'hidden-example',
      title: 'Secret private title',
      excerpt: 'Private description',
      content: { version: 1, blocks: [] },
      layers: [],
      locked: true,
      roles: [2]
    },
    {
      slug: 'unsafe-metadata',
      title: '</title><script>alert(1)</script> $&',
      excerpt: 'Description "quoted"',
      image: 'javascript:alert(1)',
      content: { version: 1, blocks: [] },
      layers: [],
      locked: false,
      roles: []
    }
  ];
  app.use(pages.createPagesRouter({
    getArticle: (slug) => records.find((article) => article.slug === slug) || null
  }));
  app.get('*', pages.spaCatchAll);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  }));

  const base = `http://127.0.0.1:${server.address().port}`;
  async function get(pathname, options) {
    const response = await fetch(new URL(pathname, base), options);
    return { response, body: await response.text() };
  }

  const home = await get('/');
  assert.equal(home.response.status, 200);
  assert.match(home.body, /data-page="home"/);
  assert.match(home.body, /Добро пожаловать в фэндом/);
  assert.doesNotMatch(home.body, /id="app-content"/);

  const publicCatalog = await get('/antropedia');
  assert.match(publicCatalog.body, /rel="canonical" href="http:\/\/127\.0\.0\.1:\d+\/antropedia"/);

  const publicArticle = await get('/antropedia/public%20example');
  assert.equal(publicArticle.response.status, 200);
  assert.match(publicArticle.body, /data-page="antropedia"/);
  assert.doesNotMatch(publicArticle.body, /id="app-content"/);
  assert.match(publicArticle.body, /<title>Public &quot;title&quot; — Antropedia<\/title>/);
  assert.match(publicArticle.body, /content="A public &quot;description&quot;"/);
  assert.match(publicArticle.body, /property="og:url" content="http:\/\/127\.0\.0\.1:\d+\/antropedia\/public%20example"/);
  assert.match(publicArticle.body, /property="og:image" content="http:\/\/127\.0\.0\.1:\d+\/uploads\/public-cover\.png"/);
  const forwardedArticle = await get('/antropedia/public%20example', {
    headers: { 'x-forwarded-host': 'public.example', 'x-forwarded-proto': 'https' }
  });
  assert.match(forwardedArticle.body, /rel="canonical" href="https:\/\/public\.example\/antropedia\/public%20example"/);

  const unsafeMetadata = await get('/antropedia/unsafe-metadata');
  assert.match(unsafeMetadata.body, /<title>&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; \$&amp; — Antropedia<\/title>/);
  assert.match(unsafeMetadata.body, /property="og:image" content=""/);

  const hiddenArticle = await get('/antropedia/hidden-example');
  assert.equal(hiddenArticle.response.status, 404);
  assert.doesNotMatch(hiddenArticle.body, /Secret private title|Private description/);
  assert.match(hiddenArticle.body, /<title>Antropedia — энциклопедия вселенной AllTell<\/title>/);
  const missingArticle = await get('/antropedia/missing-example');
  assert.equal(missingArticle.response.status, 404);
  assert.equal(missingArticle.body, hiddenArticle.body);

  for (const pathname of [
    '/admin-panel',
    '/admin-panel?editArticle=example-article',
    '/admin-panel/antropedia',
    '/admin-panel/antropedia/example-article',
    '/admin-panel.html',
    '/roles.html',
    '/index.html',
    '/dashboard.html',
    '/dashboard'
  ]) {
    const admin = await get(pathname);
    assert.equal(admin.response.status, 200, pathname);
    assert.match(admin.body, /id="app-content"/, pathname);
    assert.doesNotMatch(admin.body, /Добро пожаловать в фэндом/, pathname);
  }

  const legacyPublic = await get('/site/index.html');
  assert.equal(legacyPublic.response.status, 200);
  assert.match(legacyPublic.body, /data-page="home"/);

  for (const pathname of ['/site/antropedia.html', '/site/alltell.html', '/site/gallery.html']) {
    const legacyPage = await get(pathname);
    assert.equal(legacyPage.response.status, 200, pathname);
    assert.doesNotMatch(legacyPage.body, /id="siteUser"|site-icon-btn|Мой профиль|Выйти/, pathname);
  }

  const staticAsset = await get('/site/site.js');
  assert.equal(staticAsset.response.status, 200);
  assert.match(staticAsset.body, /api\/public\/articles/);
  assert.match(staticAsset.body, /editArticle=/);

  const adminShell = await get('/admin-panel');
  assert.match(adminShell.body, /id="public-site-toggle"/);
});
