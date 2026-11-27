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

test('manageable franchise list requires an approved signed-in user', async () => {
  const app = createApp();
  const res = await callApi(app, 'GET', '/api/radio/manageable-franchises');
  assert.equal(res.status, 401);
});

test('station franchise binding is editable only through the station settings and protected by franchise permissions', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.html'), 'utf8');
  const client = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');
  const routes = fs.readFileSync(path.resolve(__dirname, './radio.routes.js'), 'utf8');

  assert.ok(html.includes('id="editStationFranchise"'), 'Station settings must offer an optional franchise selector');
  assert.ok(client.includes("api('/api/radio/manageable-franchises')"), 'The selector must list franchises available to the current user');
  assert.ok(client.includes('franchiseId: dom.editStationFranchise?.value || null'), 'Saving station settings must persist or clear the franchise binding');
  assert.ok(routes.includes("router.get('/radio/manageable-franchises', auth.authenticateToken, auth.checkApproved"), 'The available franchise list must require an approved user');
  assert.ok(routes.includes('Привязать станцию можно только к франшизе, которой вы управляете'), 'The API must reject binding to a franchise the user cannot manage');
  assert.ok(routes.includes('WHERE is_published = 1 AND id IN'), 'Station cards must only resolve names of public franchises');
  assert.ok(client.includes('radio-card-franchise-link'), 'Publicly linked stations must show a link to their franchise');
});

test('radio frequency cards show live station status and refresh without reloading the page', () => {
  const fs = require('fs');
  const path = require('path');
  const client = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');
  const css = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.css'), 'utf8');

  assert.ok(client.includes('function getStationCardLiveState'), 'Station cards must derive a current broadcast status');
  assert.ok(client.includes('radio-card-live-status'), 'Station cards must render the broadcast status');
  assert.ok(client.includes('radio-card-track-title'), 'Station cards must render the current track title');
  assert.ok(client.includes('setInterval(refreshVisibleStations, 10000)'), 'Station status must refresh every 10 seconds');
  assert.ok(client.includes("document.addEventListener('visibilitychange', refreshVisibleStations)"), 'Station status must refresh when the page becomes visible');
  assert.ok(client.includes('clearInterval(state.stationsPollTimer)'), 'Station polling must be stopped during page cleanup');
  assert.ok(css.includes('body[data-page="radio"] .radio-card-live-status.is-live'), 'Live station status must have a distinct visual style');
  assert.ok(css.includes('body[data-page="radio"] .radio-card-track-title'), 'Current track title must be styled within each frequency card');
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

test('radio visual system shares public-site styling and isolates mobile overrides', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.html'), 'utf8');
  const desktopCss = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.css'), 'utf8');
  const mobileCss = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-mobile.css'), 'utf8');

  assert.match(html, /href="\/site\/radio-mobile\.css(?:\?v=\d+)?"/, 'Radio page must load its independent mobile stylesheet');
  assert.ok(html.includes('media="(max-width: 768px)"'), 'Mobile overrides must not load on desktop');
  assert.ok(desktopCss.includes('body[data-page="radio"] .modal-box'), 'Radio modal styling must be scoped to the radio page');
  assert.ok(desktopCss.includes('var(--background-secondary'), 'Desktop radio surfaces must use shared public-site tokens');
  assert.ok(desktopCss.includes('--radio-accent: #ff4757;'), 'Radio accents must retain the red radio palette');
  assert.ok(desktopCss.includes('body[data-page="radio"] .alltell-global-audio-bar'), 'Global player styling must remain scoped to radio');
  assert.ok(desktopCss.includes('body[data-page="radio"] #btnMasterApplyDraft'), 'The duplicate draft-apply control must be hidden only on radio');
  assert.ok(mobileCss.includes('@media (max-width: 768px)'), 'Mobile stylesheet must use the shared public-site breakpoint');
  assert.ok(mobileCss.includes('body[data-page="radio"] .radio-nav-tabs'), 'Mobile layout must adapt radio navigation');
  assert.ok(mobileCss.includes('body[data-page="radio"] .radio-feed-player-bar'), 'Mobile layout must adapt the mini player');
  assert.ok(mobileCss.includes('body[data-page="radio"] .alltell-global-audio-bar'), 'Mobile layout must adapt the cross-page mini player on radio');
  assert.ok(mobileCss.includes('body[data-page="radio"] .modal-overlay'), 'Mobile layout must adapt radio dialogs');
  assert.ok(mobileCss.includes('body[data-page="radio"] .radio-timeline-track-scroll'), 'Mobile layout must keep timeline scrolling inside its viewport');
  assert.ok(html.includes('<details class="radio-editor-disclosure radio-editor-schedule-disclosure">'), 'Editor scheduling controls must be collapsible');
  assert.ok(!html.includes('radio-studio-add-disclosure') && !html.includes('Добавить в сетку'), 'The duplicate add-to-grid section must be removed');
  assert.ok(html.includes('id="btnToggleMediaDrawer"') && html.includes('id="btnOpenSmartGapFill"'), 'The media library and gap-fill tools must remain available');
  assert.ok(!html.includes('id="btnPickFromMyTracks"'), 'The redundant track-library picker button must no longer appear');
  assert.ok(html.includes('aria-label="Масштаб редактора эфира"'), 'Timeline zoom controls must remain available beside the overview');

  for (const id of [
    'btnClearTimelineBtn',
    'btnReleaseStationBtn',
    'btnScheduleBroadcast',
    'btnPresetNow',
    'btnToggleBroadcastLoop',
    'btnToggleEternalBroadcast',
    'btnTimelineZoomOut',
    'btnTimelineZoomReset',
    'btnTimelineZoomIn',
    'btnTimelineExtendScale',
    'btnToggleMediaDrawer',
    'btnOpenSmartGapFill',
    'btnSaveTimeline'
  ]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `Editor control ${id} must retain one stable DOM id`);
  }
});

test('radio schedule blocks render as a compact horizontal arrangement lane', () => {
  const fs = require('fs');
  const path = require('path');
  const client = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');
  const desktopCss = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.css'), 'utf8');
  const mobileCss = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-mobile.css'), 'utf8');

  assert.ok(client.includes('const clipWidth = Math.min(maxClipWidth, Math.max(210, Math.round(135 + Math.max(0, durSec) * 0.45)))'), 'Clip width must respond to its duration');
  assert.ok(client.includes('data-base-width="${clipWidth}"'), 'Editor clips must expose their base duration width for zooming');
  assert.ok(client.includes('style="width: ${pct.toFixed(3)}%;"'), 'Overview clips must expose their proportional duration width');
  assert.ok(client.includes("const showTitle = renderedWidth >= labelMinWidth;"), 'Overview clip names must only appear when the clip has room for a readable label');
  assert.ok(client.includes('class="clip-title"><i class="fas ${icon}"></i><span class="clip-name">${titleText}</span></div>'), 'Overview clip names must be truncated independently from their icons');
  assert.ok(client.includes('const isScrollableOverview = state.editorBlocks.length > 12;'), 'Dense overview must switch to horizontal scrolling after twelve schedule blocks');
  assert.ok(client.includes('Math.max(overviewWidth, state.editorBlocks.length * minBlockWidth)'), 'Dense overview must expand enough to keep average clips readable');
  assert.ok(client.includes('eb-block-${block.type}'), 'Rendered clips must expose their block type for restrained color coding');
  assert.ok(client.includes('class="radio-eb-empty-state"'), 'The empty schedule message must use the full-lane empty state');
  assert.ok(desktopCss.includes('body[data-page="radio"] .radio-eb-blocklist {\n  display: flex;\n  flex-direction: row;'), 'Schedule clips must flow horizontally in one scrollable lane');
  assert.ok(desktopCss.includes('flex: 1 0 100%;'), 'The empty state must span the full editor lane');
  assert.ok(desktopCss.includes('body[data-page="radio"] .radio-eb-blocklist:has(.radio-eb-empty-state)'), 'The empty lane must not retain extra blank space around the full-width state');
  assert.ok(desktopCss.includes('body[data-page="radio"] .radio-eb-block.is-on-air-block'), 'On-air clips must use a distinct non-glowing highlight');
  assert.ok(mobileCss.includes('body[data-page="radio"] .radio-eb-blocklist'), 'The arrangement lane must have mobile-specific sizing');
});

test('radio timeline insertions retain the clicked position and live playhead follows playlist track time', () => {
  const fs = require('fs');
  const path = require('path');
  const client = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');

  assert.ok(client.includes('openInsertWordsModalAtBlockIndex(targetIndex);'), 'The plus-menu speech action must preserve its exact block insertion index');
  assert.ok(client.includes('addBlockToEditor({') && client.includes('}, targetIndex);'), 'Speech blocks selected from the plus menu must insert at the chosen block boundary');
  assert.ok(!client.includes('openInsertWordsModalForIndex(targetIndex - 1)'), 'Quick insertion must not infer the selected boundary from rounded wall-clock time');
  assert.ok(!client.includes("label: 'Трек из медиатеки'"), 'The plus menu must not expose the restricted duplicate track picker');
  assert.ok(client.includes("label: 'Плейлист'"), 'The plus menu playlist action must use the concise label');
  assert.ok(client.includes('function findEditorBlockForSlot(slot)'), 'Live slot matching must resolve playlist subtracks to their parent block');
  assert.ok(client.includes('activeBlockOffset += Math.min(Math.max(0, audioSec), activeTrackDuration || audioSec);'), 'The live playhead must include preceding tracks within a playlist');
  assert.ok(client.includes('const playheadPct = (activeElapsed / timelineScale) * 100;'), 'The playhead must use the same normalized time scale as overview clips');
});

test('radio editor blocks keep a fixed workspace and expand playlists inside their cards', () => {
  const fs = require('fs');
  const path = require('path');
  const client = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');
  const desktopCss = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.css'), 'utf8');
  const mobileCss = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-mobile.css'), 'utf8');

  assert.ok(client.includes('const isCollapsed = block.isCollapsed !== false;'), 'Playlists must default to collapsed regardless of track count');
  assert.ok(!client.includes('isCollapsed: false'), 'Newly created and split playlists must also start collapsed');
  assert.ok(client.includes("title.addEventListener('click'"), 'A title click must start its marquee animation');
  assert.ok(client.includes('const pauseMs = 3000;'), 'The marquee must pause for three seconds when it returns to the start');
  assert.ok(desktopCss.includes('height: 240px;\n  min-height: 240px;'), 'Editor cards must have a fixed height');
  assert.ok(desktopCss.includes('max-height: 100px;') && desktopCss.includes('overflow-y: auto;'), 'Expanded playlist tracks must scroll inside a bounded list');
  assert.ok(desktopCss.includes('body[data-page="radio"] .radio-eb-insert-btn {\n  display: flex;\n  align-items: center;\n  justify-content: center;'), 'The plus icon must be centered inside its circular insertion button');
  assert.match(mobileCss, /\.radio-eb-block\s*\{[^}]*height: 240px;[^}]*min-height: 240px;/s, 'Mobile editor cards must preserve the same fixed height');
});

test('speech blocks provide working microphone and file attachment actions', () => {
  const fs = require('fs');
  const path = require('path');
  const client = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');
  const html = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.html'), 'utf8');

  assert.ok(client.includes('class="btn btn-primary btn-sm btn-add-speech-recording"'), 'Unrecorded speech blocks must show an actionable recording button');
  assert.ok(client.includes('openSpeechAudioModalForBlock(Number(btn.dataset.index))'), 'The block action must open its recording/attachment form for the selected block');
  assert.ok(client.includes("document.getElementById('speechFileInput')?.addEventListener('change'"), 'The speech modal must capture a selected audio file');
  assert.ok(client.includes('setSpeechAudioPreview(file, true);'), 'A selected local file must be previewable before saving');
  assert.ok(client.includes('setSpeechAudioPreview(blob, true);'), 'A microphone recording must be previewable before saving');
  assert.ok(client.includes('class="btn btn-secondary btn-sm btn-preview-block radio-eb-speech-preview"'), 'Recorded speech blocks must expose a labeled preview action');
  assert.ok(client.includes('block.audio_url = finalAudioUrl;'), 'Saving a recording must attach its URL to the original block');
  assert.ok(client.includes("api('/api/upload-audio', { method: 'POST', body: formData })"), 'Recorded microphone audio must upload through the audio endpoint');
  assert.ok(html.includes('id="btnModalRecordSpeech"') && html.includes('id="speechFileInput"') && html.includes('id="speechAudioPreview"'), 'The speech modal must expose recording, file selection and playback controls');
});

test('radio overview is read-only and its navigation stays synchronized with the block editor', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.html'), 'utf8');
  const client = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');
  const css = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.css'), 'utf8');

  assert.ok(html.includes('Обзор эфира'), 'The upper lane must be identified as the broadcast overview');
  assert.ok(html.includes('Редактор сетки'), 'The lower lane must be clearly identified as the editor');
  assert.ok(html.includes('aria-label="Обзор расписания эфира, только для навигации"'), 'The overview must expose its read-only role accessibly');
  assert.ok(client.includes('draggable="false"'), 'Overview clips must not be draggable');
  assert.ok(client.includes('navigateEditorFromOverview(position - viewportWidthRatio / 2)'), 'Clicking the overview must navigate the editor to the same time');
  assert.ok(client.includes('updateTimelineViewport();'), 'Editor scrolling must update the visible-range overlay in the overview');
  assert.ok(client.includes("dom.radioTimelineTrackScroll?.addEventListener('scroll'"), 'Scrolling a dense overview must navigate the editor in sync');
  assert.ok(client.includes("['dragstart', 'dragenter', 'dragover', 'drop']"), 'The overview must reject all drag-and-drop interactions');
  assert.ok(!client.includes("dom.radioTimelineTrack?.addEventListener('drop'"), 'The overview must not retain a drop handler that can mutate the schedule');
  assert.ok(css.includes('.radio-timeline-clip.is-selected'), 'Selected overview clips must have a visual state');
  assert.ok(css.includes('.radio-timeline-clip.is-title-visible .clip-title'), 'Overview labels must be shown on clips with enough room');
  assert.ok(css.includes('.radio-timeline-clip.is-title-visible .clip-name'), 'Long overview labels must truncate without overflowing their clip');
  assert.ok(css.includes('.radio-timeline-track-scroll.is-scrollable {\n  overflow-x: auto;'), 'Dense overview must expose horizontal scrolling');
  assert.ok(css.includes('.radio-timeline-track-scroll.is-scrollable .radio-timeline-viewport {\n  display: none;'), 'Dense scrolling must not show a viewport overlay detached from the scrolled content');
  assert.ok(css.includes('.radio-eb-block.is-timeline-selected'), 'Overview selection must be reflected in the editor');
});

test('radio overview is a full-width navigator above the editor with zoom and a draggable viewport', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.html'), 'utf8');
  const client = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');
  const desktopCss = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.css'), 'utf8');
  const mobileCss = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-mobile.css'), 'utf8');

  assert.match(
    html,
    /<div class="radio-timeline-workspace">[\s\S]*id="radioTimelineContainer"[\s\S]*class="radio-timeline-editor-pane"[\s\S]*id="editorBlocksList"/,
    'Overview and editable blocks must live in the same workspace'
  );
  assert.match(desktopCss, /\.radio-timeline-workspace \{\s*display: block;/, 'Overview must span the full width above the editor');
  assert.ok(html.includes('id="radioTimelineViewport"'), 'Overview must show the visible editor range');
  assert.ok(html.includes('data-edge="start"') && html.includes('data-edge="end"'), 'Overview range edges must allow zoom adjustment');
  assert.ok(client.includes("addEventListener('pointerdown'"), 'Overview range must be draggable');
  assert.ok(client.includes('setTimelineZoom(zoom, scrollRatio, false)'), 'Dragging an overview edge must adjust editor zoom');
  assert.ok(client.includes('Math.round(baseWidth * state.timelineZoom)'), 'Zoom controls must scale editor blocks, not the overview strip');
  assert.match(desktopCss, /\.radio-timeline-workspace \.radio-timeline-edge-handle \{\s*display: none !important;/, 'Read-only overview must not show resize handles');
  assert.ok(desktopCss.includes('height: 28px;\n  border: 1px solid rgba(255, 255, 255, 0.08);'), 'Overview must remain a compact navigator strip');
  assert.ok(desktopCss.includes('padding-left: 30px;'), 'Editor blocks must leave clear space for the reorder handle');
  assert.match(mobileCss, /radio-timeline-workspace \.radio-timeline-nle-header \{\s*flex-wrap: wrap;/, 'Mobile controls must wrap without moving the overview beside the editor');
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
  assert.ok(playerJs.includes('function connectCapturedAudioStream()'), 'Visualizer must reconnect to a playing media stream');
  assert.ok(playerJs.includes("audio.addEventListener('loadedmetadata'"), 'Visualizer must discard stale sources when the media resource changes');
  assert.ok(playerJs.includes("audio.addEventListener('playing'"), 'Visualizer must connect after playback starts and captured tracks become live');
  assert.ok(playerJs.includes('track.readyState === \'live\''), 'Visualizer must not keep reading an ended capture stream');
  assert.ok(playerJs.includes('!visualizerSource) return null'), 'Visualizer must use its fallback until a live source is connected');
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
