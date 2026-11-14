require('../config/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Socket } = require('node:net');
const express = require('express');
const radioRoutes = require('./radio.routes');
const { createPagesRouter } = require('./pages.routes');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', radioRoutes);
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

test('GET /radio serves public radio.html page', async () => {
  const app = createApp();
  const res = await callApi(app, 'GET', '/radio');
  assert.equal(res.status, 200);
  assert.ok(res.rawBody.includes('data-page="radio"'), 'Should serve radio page markup');
  assert.ok(res.rawBody.includes('radio-client.js'), 'Should include radio client script');
});

test('GET /api/radio/stations returns stations list for unauthenticated guest', async () => {
  const app = createApp();
  const res = await callApi(app, 'GET', '/api/radio/stations');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body), 'Response should be an array of stations');
});

test('GET /api/radio/tracks returns tracks list with pagination', async () => {
  const app = createApp();
  const res = await callApi(app, 'GET', '/api/radio/tracks');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.tracks), 'Response should have tracks array');
  assert.equal(typeof res.body.total, 'number');
});

test('maintenance mode: radio page and API gating', async () => {
  const { maintenanceGate, maintenancePageGate, maintenancePageForPath } = require('../middleware/maintenance');
  const { readSettings, writeSettings } = require('../services/system-settings');

  assert.equal(maintenancePageForPath('/radio'), 'radio');
  assert.equal(maintenancePageForPath('/site/radio.html'), 'radio');

  const prevSettings = readSettings();
  try {
    writeSettings({
      maintenancePages: { ...prevSettings.maintenancePages, radio: true }
    });

    const app = express();
    app.use(express.json());
    app.use(maintenancePageGate);
    app.use('/api', maintenanceGate);
    app.use('/api', radioRoutes);
    app.use(createPagesRouter());

    const pageRes = await callApi(app, 'GET', '/radio');
    assert.equal(pageRes.status, 503);
    assert.ok(pageRes.rawBody.includes('Техническое обслуживание'));

    const apiRes = await callApi(app, 'GET', '/api/radio/stations');
    assert.equal(apiRes.status, 503);
    assert.equal(apiRes.body.maintenance, true);
    assert.equal(apiRes.body.page, 'radio');
  } finally {
    writeSettings(prevSettings);
  }
});
