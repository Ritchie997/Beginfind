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

test('radio station modal keeps submit footer visible inside a constrained viewport', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.html'), 'utf8');
  const css = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.css'), 'utf8');

  assert.ok(html.includes('id="formCreateStation"'), 'Station form must be present');
  assert.ok(html.includes('id="btnSubmitCreateStation"'), 'Station submit button must be present');
  assert.ok(css.includes('.modal-box > form'), 'Modal form must participate in constrained flex layout');
  assert.ok(css.includes('flex: 1'), 'Modal body or form must consume available height');
  assert.ok(css.includes('flex-shrink: 0'), 'Modal header and footer must remain visible');
});

test('radio live player and station cards use a clean compact interface', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.html'), 'utf8');
  const radioClientJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');
  const css = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.css'), 'utf8');

  assert.ok(!html.includes('id="btnDeckEditStation"'), 'Live player must not show its ellipsis menu');
  assert.ok(!radioClientJs.includes('btn-card-station-menu'), 'Station cards must not render their ellipsis menu');
  assert.ok(css.includes('.radio-controls-main .deck-btn-label'), 'Live player button labels must be hidden');
  assert.ok(css.includes('border: none;'), 'Live player controls must not have outlined button frames');
  assert.ok(css.includes('background: transparent;'), 'Live player controls must use the mini-player transparent style');
  assert.ok(css.includes('width: 32px;'), 'Live player action buttons must remain compact icon buttons');
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
  const radioCss = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.css'), 'utf8');

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
  assert.ok(playerJs.includes('isPageUnloading'), 'Must preserve unload handling for the audio pause event');
  assert.ok(playerJs.includes('beforeunload'), 'Must handle beforeunload');
  assert.ok(playerJs.includes('pagehide'), 'Must handle pagehide');
  assert.ok(!playerJs.includes('data.isPlaying = true'), 'Unloading must not force paused playback to resume');

  // 3. Audio reload prevention (isSameSrc)
  assert.ok(playerJs.includes('isSameSrc'), 'Must check isSameSrc to avoid resetting media element');

  // 4. Deck and track UI progress synchronization
  assert.ok(playerJs.includes('deckProgressFill'), 'Must update deckProgressFill');
  assert.ok(playerJs.includes('deckTimeCurrent'), 'Must update deckTimeCurrent');
  assert.ok(playerJs.includes('deckTimeRemaining'), 'Must update deckTimeRemaining');
  assert.ok(playerJs.includes('trackPageProgressFill'), 'Must update trackPageProgressFill');
  assert.ok(playerJs.includes('audio.captureStream'), 'Visualizer must inspect the existing audio stream without reloading it');
  assert.ok(playerJs.includes('createMediaStreamSource'), 'Must analyze the playing audio stream with Web Audio');
  assert.ok(playerJs.includes('createAnalyser'), 'Must use a real audio analyser');
  assert.ok(playerJs.includes('getByteFrequencyData'), 'Must expose frequency data to the radio UI');
  assert.ok(playerJs.includes('getVisualizerSampleRate'), 'Visualizer must map FFT bins using the actual audio context sample rate');
  assert.ok(playerJs.includes('fftSize = 2048'), 'Visualizer must resolve enough frequency bins for band separation');
  assert.ok(playerJs.includes('createMediaElementSource(audio)'), 'Visualizer needs a same-origin fallback when stream capture is unavailable');
  assert.ok(radioCss.includes('.radio-visualizer.is-playing.is-fallback'), 'Synthetic animation must only run when audio analysis is unavailable');
  assert.ok(radioClientJs.includes("classList.add('is-fallback')"), 'Visualizer must automatically enable the fallback animation when analysis is unavailable');
  assert.ok(radioClientJs.includes("classList.remove('is-fallback')"), 'Visualizer must return to real analysis when it becomes available');
  assert.ok(radioClientJs.includes('requestAnimationFrame(renderFrame)'), 'Visualizer must render analyzed audio levels');
  assert.ok(radioClientJs.includes('Math.pow(maxFrequency / minFrequency'), 'Visualizer must use logarithmic frequency bands');

  // 5. Radio client: non-destructive poll timer and autoPlay respect
  assert.ok(!radioClientJs.includes('tuneStation(state.currentStation, gState.isPlaying)'), 'Poll timer must not unconditionally call tuneStation');
  assert.ok(radioClientJs.includes('autoPlay'), 'tuneStation must support and respect autoPlay parameter');
  assert.ok(radioClientJs.includes('syncBar'), 'switchTab must synchronize player bar visibility');
  assert.ok(!radioClientJs.includes('tuneStation(targetStation, true)'), 'Loading the station list must not autoplay a station');
  assert.ok(!radioClientJs.includes('tuneStation(stations[0], false)'), 'Loading the station list must not select a station implicitly');
});

test('SPA navigation & audio continuity: router resilience, script deduplication, and player singleton', () => {
  const fs = require('fs');
  const path = require('path');
  const routerJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/router.js'), 'utf8');
  const headerJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/site-header.js'), 'utf8');
  const playerJs = fs.readFileSync(path.resolve(__dirname, '../../public/radio-global-player.js'), 'utf8');
  const siteJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/site.js'), 'utf8');

  // 1. Header includes Radio in navigation
  assert.ok(headerJs.includes('data-page="radio"'), 'SiteHeader markup must include radio link');
  assert.ok(headerJs.includes('href="/radio"'), 'SiteHeader markup must link to /radio');

  // 2. Router recognizes all public section paths
  assert.ok(routerJs.includes("normalizedPath === '/radio'"), 'Router must recognize /radio');
  assert.ok(routerJs.includes("normalizedPath === '/site/radio.html'"), 'Router must recognize /site/radio.html');
  assert.ok(routerJs.includes("normalizedPath === '/site/index.html'"), 'Router must recognize /site/index.html');
  assert.ok(routerJs.includes("normalizedPath === '/site/antropedia.html'"), 'Router must recognize /site/antropedia.html');

  // 3. Router deduplicates same-origin scripts by pathname (immune to ?v= query strings)
  assert.ok(routerJs.includes('existingUrl.pathname === sourceUrl.pathname'), 'Router must match same-origin scripts by pathname');

  // 4. Router handles external CDN errors gracefully without aborting SPA navigation
  assert.ok(routerJs.includes('!isSameOrigin'), 'Router must distinguish same-origin vs external CDN scripts');

  // 5. Router protects background playback from forced reload if sections already mounted
  assert.ok(routerJs.includes('sectionsReplaced'), 'Router must track sectionsReplaced to avoid full page reload when audio is playing');

  // 6. Global audio player singleton protection
  assert.ok(playerJs.includes('if (window.alltellGlobalAudio)'), 'radio-global-player must guard against duplicate instantiation');

  // 7. Safe cleanup and async handling in site.js
  assert.ok(siteJs.includes("typeof currentRouteCleanup === 'function'"), 'cleanupPublicPage must safely check function type');
  assert.ok(siteJs.includes('alltellResult.then'), 'mountPublicPage must handle async AllTellClient.init');
});

test('POST /api/radio/stations/:id/start-broadcast and stop-broadcast routes require authentication', async () => {
  const app = createApp();
  const resStart = await callApi(app, 'POST', '/api/radio/stations/1/start-broadcast', { forceNow: true });
  assert.equal(resStart.status, 401, 'Unauthenticated start-broadcast should return 401');

  const resStop = await callApi(app, 'POST', '/api/radio/stations/1/stop-broadcast', {});
  assert.equal(resStop.status, 401, 'Unauthenticated stop-broadcast should return 401');
});
