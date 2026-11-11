require('../config/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Socket } = require('node:net');
const express = require('express');
const { stickersDb } = require('../db/connections');
const stickersRoutes = require('./stickers.routes');
const { createPagesRouter } = require('./pages.routes');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', stickersRoutes);
  app.use(createPagesRouter());
  return app;
}

function callApi(app, method, url, body, customHeaders = {}) {
  return new Promise((resolve) => {
    const payload = body !== undefined ? JSON.stringify(body) : '';
    const socket = new Socket();
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = url;
    req.headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      ...customHeaders
    };
    const res = new http.ServerResponse(req);
    let resBody = '';
    res.write = (chunk) => { if (chunk) resBody += chunk; };
    res.end = (chunk) => {
      if (chunk) resBody += chunk;
      socket.destroy();
      let parsed = {};
      try { parsed = JSON.parse(resBody); } catch (_) {}
      resolve({ status: res.statusCode, body: parsed, rawBody: resBody });
    };
    app(req, res);
    if (payload) req.push(payload);
    req.push(null);
  });
}

test('GET /api/stickers/catalog returns approved sticker packs for unauthenticated guest', async () => {
  const app = createApp();
  const res = await callApi(app, 'GET', '/api/stickers/catalog');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  res.body.forEach((pack) => {
    assert.equal(pack.status, 'approved');
    assert.equal(pack.subscribed, false);
    assert.equal(pack.isOwn, false);
  });
});

test('GET /stickers serves public stickers.html page', async () => {
  const app = createApp();
  const res = await callApi(app, 'GET', '/stickers');
  assert.equal(res.status, 200);
  assert.match(res.rawBody, /data-page="stickers"/);
  assert.match(res.rawBody, /sticker-pack-view\.js/);
  assert.match(res.rawBody, /sticker-store\.js/);
});

test('GET /api/stickers/packs/:id allows guest viewing of approved pack and denies draft', async () => {
  const app = createApp();
  // Insert a test approved pack and a test draft pack
  const packIdApproved = await new Promise((resolve, reject) => {
    stickersDb.run(
      "INSERT INTO sticker_packs (slug, title, author_id, author_name, status) VALUES ('test-approved-pack', 'Test Approved', 99999, 'Tester', 'approved')",
      function (err) { if (err) reject(err); else resolve(this.lastID); }
    );
  });
  const packIdDraft = await new Promise((resolve, reject) => {
    stickersDb.run(
      "INSERT INTO sticker_packs (slug, title, author_id, author_name, status) VALUES ('test-draft-pack', 'Test Draft', 99999, 'Tester', 'draft')",
      function (err) { if (err) reject(err); else resolve(this.lastID); }
    );
  });

  try {
    const resApproved = await callApi(app, 'GET', `/api/stickers/packs/${packIdApproved}`);
    assert.equal(resApproved.status, 200);
    assert.equal(resApproved.body.title, 'Test Approved');
    assert.equal(resApproved.body.status, 'approved');
    assert.equal(resApproved.body.subscribed, false);

    const resDraft = await callApi(app, 'GET', `/api/stickers/packs/${packIdDraft}`);
    assert.equal(resDraft.status, 403);
  } finally {
    await new Promise((resolve) => {
      stickersDb.run("DELETE FROM sticker_packs WHERE id IN (?, ?)", [packIdApproved, packIdDraft], () => resolve());
    });
  }
});
