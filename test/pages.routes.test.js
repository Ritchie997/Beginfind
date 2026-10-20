const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { PUBLIC_DIR } = require('../src/config/paths');
const pages = require('../src/routes/pages.routes');

test('public and admin entry points remain separated with legacy URLs', async (t) => {
  const app = express();
  app.use(express.static(PUBLIC_DIR, { index: false }));
  app.use(pages.router);
  app.get('*', pages.spaCatchAll);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  }));

  const base = `http://127.0.0.1:${server.address().port}`;
  async function get(pathname) {
    const response = await fetch(new URL(pathname, base));
    return { response, body: await response.text() };
  }

  const home = await get('/');
  assert.equal(home.response.status, 200);
  assert.match(home.body, /data-page="home"/);
  assert.match(home.body, /Добро пожаловать в фэндом/);
  assert.doesNotMatch(home.body, /id="app-content"/);

  const publicArticle = await get('/antropedia/example-article');
  assert.equal(publicArticle.response.status, 200);
  assert.match(publicArticle.body, /data-page="antropedia"/);
  assert.doesNotMatch(publicArticle.body, /id="app-content"/);

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

  const staticAsset = await get('/site/site.js');
  assert.equal(staticAsset.response.status, 200);
  assert.match(staticAsset.body, /api\/public\/articles/);
  assert.match(staticAsset.body, /editArticle=/);

  const adminShell = await get('/admin-panel');
  assert.match(adminShell.body, /id="public-site-toggle"/);
});
