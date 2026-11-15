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

test('GET /radio/track/:id serves public radio.html page for track view', async () => {
  const app = createApp();
  const res = await callApi(app, 'GET', '/radio/track/999');
  assert.equal(res.status, 200);
  assert.ok(res.rawBody.includes('radioTrackView'), 'Should include track view markup');
  assert.ok(res.rawBody.includes('feedPlayerBar'), 'Should include separate feed player bar');
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

test('global audio player: background playback, MediaSession, cross-tab leader and non-destructive sync', () => {
  const fs = require('fs');
  const path = require('path');
  const playerJs = fs.readFileSync(path.resolve(__dirname, '../../public/radio-global-player.js'), 'utf8');
  const radioClientJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');

  // 1. Background playback & MediaSession
  assert.ok(playerJs.includes('mediaSession'), 'Must integrate navigator.mediaSession');
  assert.ok(playerJs.includes('MediaMetadata'), 'Must instantiate MediaMetadata');
  assert.ok(playerJs.includes("'play'"), 'Must handle mediaSession play');
  assert.ok(playerJs.includes("'pause'"), 'Must handle mediaSession pause');
  assert.ok(playerJs.includes("'previoustrack'"), 'Must handle mediaSession previoustrack');
  assert.ok(playerJs.includes("'nexttrack'"), 'Must handle mediaSession nexttrack');

  // 2. Cross-tab leader coordination & unload protection
  assert.ok(playerJs.includes('isAudioLeader'), 'Must track audio leader across tabs');
  assert.ok(playerJs.includes('QUERY_LEADER'), 'Must query leader to prevent duplicate audio');
  assert.ok(playerJs.includes('LEADER_ACK'), 'Must acknowledge leader to follower tabs');
  assert.ok(playerJs.includes('isPageUnloading'), 'Must track page unloading state');
  assert.ok(playerJs.includes('beforeunload'), 'Must handle beforeunload');
  assert.ok(playerJs.includes('pagehide'), 'Must handle pagehide');

  // 3. Audio reload prevention (isSameSrc)
  assert.ok(playerJs.includes('isSameSrc'), 'Must check isSameSrc to avoid resetting media element');

  // 4. Deck and track UI progress synchronization
  assert.ok(playerJs.includes('deckProgressFill'), 'Must update deckProgressFill');
  assert.ok(playerJs.includes('deckTimeCurrent'), 'Must update deckTimeCurrent');
  assert.ok(playerJs.includes('deckTimeRemaining'), 'Must update deckTimeRemaining');
  assert.ok(playerJs.includes('trackPageProgressFill'), 'Must update trackPageProgressFill');

  // 5. Radio client: non-destructive poll timer and autoPlay respect
  assert.ok(!radioClientJs.includes('tuneStation(state.currentStation, gState.isPlaying)'), 'Poll timer must not unconditionally call tuneStation');
  assert.ok(radioClientJs.includes('autoPlay'), 'tuneStation must support and respect autoPlay parameter');
  assert.ok(radioClientJs.includes('syncBar'), 'switchTab must synchronize player bar visibility');
});
