const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('radio player: markup includes next track, prev track and loop buttons across views', () => {
  const radioHtml = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.html'), 'utf8');

  // 1. Radio Deck controls on Live tab
  assert.ok(radioHtml.includes('id="deckPrevBtn"'), 'Radio deck must include previous track button');
  assert.ok(radioHtml.includes('id="deckPlayBtn"'), 'Radio deck must include play/pause button');
  assert.ok(radioHtml.includes('id="deckNextBtn"'), 'Radio deck must include next track button');
  assert.ok(radioHtml.includes('id="deckLoopBtn"'), 'Radio deck must include loop/repeat button');

  // 2. Standalone Track Player on /radio/track/:id
  assert.ok(radioHtml.includes('id="trackPagePrevBtn"'), 'Track page player must include previous track button');
  assert.ok(radioHtml.includes('id="trackPagePlayBtn"'), 'Track page player must include play/pause button');
  assert.ok(radioHtml.includes('id="trackPageNextBtn"'), 'Track page player must include next track button');
  assert.ok(radioHtml.includes('id="trackPageLoopBtn"'), 'Track page player must include loop/repeat button');
});

test('radio player: global audio player implements prev, next and loop controls', () => {
  const globalPlayerJs = fs.readFileSync(path.resolve(__dirname, '../../public/radio-global-player.js'), 'utf8');

  // 1. Global bottom bar controls
  assert.ok(globalPlayerJs.includes('id="globalAudioPrevBtn"'), 'Global bar must include prev button');
  assert.ok(globalPlayerJs.includes('id="globalAudioPlayBtn"'), 'Global bar must include play button');
  assert.ok(globalPlayerJs.includes('id="globalAudioNextBtn"'), 'Global bar must include next button');
  assert.ok(globalPlayerJs.includes('id="globalAudioLoopBtn"'), 'Global bar must include loop button');

  // 2. Functions implementation
  assert.ok(globalPlayerJs.includes('function playNext('), 'Must implement playNext');
  assert.ok(globalPlayerJs.includes('function playPrev('), 'Must implement playPrev');
  assert.ok(globalPlayerJs.includes('function toggleLoop('), 'Must implement toggleLoop');
  assert.ok(globalPlayerJs.includes('function setLoop('), 'Must implement setLoop');

  // 3. Global exports
  assert.ok(globalPlayerJs.includes('playNext,'), 'Must export playNext in AllTellGlobalRadio');
  assert.ok(globalPlayerJs.includes('playPrev,'), 'Must export playPrev in AllTellGlobalRadio');
  assert.ok(globalPlayerJs.includes('toggleLoop,'), 'Must export toggleLoop in AllTellGlobalRadio');
  assert.ok(globalPlayerJs.includes('setLoop,'), 'Must export setLoop in AllTellGlobalRadio');
});

test('radio player: radio client binds deck and track controls with loop/active states', () => {
  const radioClientJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');

  // 1. DOM element bindings
  assert.ok(radioClientJs.includes('deckPrevBtn: document.getElementById(\'deckPrevBtn\')'), 'Must query deckPrevBtn');
  assert.ok(radioClientJs.includes('deckNextBtn: document.getElementById(\'deckNextBtn\')'), 'Must query deckNextBtn');
  assert.ok(radioClientJs.includes('deckLoopBtn: document.getElementById(\'deckLoopBtn\')'), 'Must query deckLoopBtn');
  assert.ok(radioClientJs.includes('trackPagePrevBtn: document.getElementById(\'trackPagePrevBtn\')'), 'Must query trackPagePrevBtn');
  assert.ok(radioClientJs.includes('trackPageNextBtn: document.getElementById(\'trackPageNextBtn\')'), 'Must query trackPageNextBtn');
  assert.ok(radioClientJs.includes('trackPageLoopBtn: document.getElementById(\'trackPageLoopBtn\')'), 'Must query trackPageLoopBtn');

  // 2. Events wired
  assert.ok(radioClientJs.includes('dom.deckPrevBtn?.addEventListener'), 'Must bind deckPrevBtn');
  assert.ok(radioClientJs.includes('dom.deckNextBtn?.addEventListener'), 'Must bind deckNextBtn');
  assert.ok(radioClientJs.includes('dom.deckLoopBtn?.addEventListener'), 'Must bind deckLoopBtn');
  assert.ok(radioClientJs.includes('dom.trackPagePrevBtn?.addEventListener'), 'Must bind trackPagePrevBtn');
  assert.ok(radioClientJs.includes('dom.trackPageNextBtn?.addEventListener'), 'Must bind trackPageNextBtn');
  assert.ok(radioClientJs.includes('dom.trackPageLoopBtn?.addEventListener'), 'Must bind trackPageLoopBtn');

  // 3. Exported slot navigation
  assert.ok(radioClientJs.includes('skipSlot,'), 'Must export skipSlot');
  assert.ok(radioClientJs.includes('prevSlot'), 'Must export prevSlot');
});

test('radio player: styles define is-active visual states for loop and media controls', () => {
  const globalCss = fs.readFileSync(path.resolve(__dirname, '../../public/global-styles.css'), 'utf8');
  const radioCss = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.css'), 'utf8');

  assert.ok(globalCss.includes('.alltell-global-audio-btn.is-active'), 'Must style active state in global bar');
  assert.ok(radioCss.includes('.radio-action-btn.is-active'), 'Must style active state for deck loop');
  assert.ok(radioCss.includes('.standalone-action-btn.is-active'), 'Must style active state for track loop');
});

test('radio player: looping repeats active playing track instead of skipping to next playlist track', () => {
  const globalPlayerJs = fs.readFileSync(path.resolve(__dirname, '../../public/radio-global-player.js'), 'utf8');
  const radioClientJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');
  const audioPlayerJs = fs.readFileSync(path.resolve(__dirname, '../../public/audio-player.js'), 'utf8');

  // 1. audio.loop synchronisation on HTML5 Audio element
  assert.ok(globalPlayerJs.includes('audio.loop = state.isLoop'), 'setLoop must assign audio.loop');
  assert.ok(globalPlayerJs.includes('audio.loop = Boolean(state.isLoop)'), 'playTrack and resume must synchronize audio.loop');
  assert.ok(audioPlayerJs.includes('this.audio.loop = this.isLooping'), 'audio-player.js must synchronize native audio.loop');

  // 2. ended event repeats active track when isLoop is true
  assert.ok(globalPlayerJs.includes('if (state.isLoop) {'), 'ended handler must check isLoop');
  assert.ok(globalPlayerJs.includes('audio.currentTime = 0;'), 'ended handler must rewind currentTime on loop');

  // Ensure it does NOT skip to playTrackAt(state.currentIndex + 1) when isLoop is true
  const loopBlockRegex = /if\s*\(\s*state\.isLoop\s*\)\s*\{[\s\S]*?return;\s*\}/;
  assert.ok(loopBlockRegex.test(globalPlayerJs), 'ended handler must return after replaying current track without advancing playlist');

  // 3. UI feedback and sync across deck, track page, and feed
  assert.ok(radioClientJs.includes('Зацикливание трека включено'), 'User must receive toast confirmation when loop is toggled');
  assert.ok(radioClientJs.includes('dom.deckLoopBtn.classList.toggle(\'is-active\', isLoopActive)'), 'deckLoopBtn must sync active state');
  assert.ok(radioClientJs.includes('dom.trackPageLoopBtn.classList.toggle(\'is-active\', isLoopActive)'), 'trackPageLoopBtn must sync active state');
});

test('radio player: mute button visual state syncs with is-muted and volume controls', () => {
  const globalPlayerJs = fs.readFileSync(path.resolve(__dirname, '../../public/radio-global-player.js'), 'utf8');
  const radioClientJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');
  const globalCss = fs.readFileSync(path.resolve(__dirname, '../../public/global-styles.css'), 'utf8');
  const radioCss = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.css'), 'utf8');

  // 1. Global bottom bar mute button visual sync
  assert.ok(globalPlayerJs.includes("domBar.muteBtn.classList.toggle('is-muted', Boolean(state.muted))"), 'Global mute button must toggle is-muted class');
  assert.ok(globalPlayerJs.includes('fa-volume-xmark'), 'Global mute button must render volume-xmark when muted');
  assert.ok(globalCss.includes('.alltell-global-tool-btn.is-muted'), 'Global CSS must style .is-muted state');

  // 2. Deck and feed mute sync
  assert.ok(radioClientJs.includes('dom.deckMuteBtn.classList.toggle(\'is-muted\', isMuted)'), 'Deck mute button must toggle is-muted class');
  assert.ok(radioCss.includes('.radio-action-btn.is-muted'), 'Radio CSS must style .is-muted state');
});

test('radio UI: broadcast loop toggle, custom host pseudonyms, and cover file/url inputs', () => {
  const radioHtml = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.html'), 'utf8');
  const radioClientJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');

  // 1. Broadcast loop button in editor toolbar
  assert.ok(radioHtml.includes('id="btnToggleBroadcastLoop"'), 'radio.html must include btnToggleBroadcastLoop button');
  assert.ok(radioClientJs.includes('dom.btnToggleBroadcastLoop'), 'radio-client.js must bind btnToggleBroadcastLoop');

  // 2. Custom radio host / pseudonym inputs in modals
  assert.ok(radioHtml.includes('id="stationHostInput"'), 'Modal create station must have stationHostInput');
  assert.ok(radioHtml.includes('id="editStationHost"'), 'Modal edit station must have editStationHost');
  assert.ok(radioHtml.includes('id="trackAuthorInput"'), 'Modal upload track must have trackAuthorInput');

  // 3. Cover upload file and URL inputs
  assert.ok(radioHtml.includes('id="createStationAvatarFile"'), 'Modal create station must have avatar file input');
  assert.ok(radioHtml.includes('id="createStationAvatarUrl"'), 'Modal create station must have avatar URL input');
  assert.ok(radioHtml.includes('id="editStationAvatarFile"'), 'Modal edit station must have avatar file input');
  assert.ok(radioHtml.includes('id="editStationAvatar"'), 'Modal edit station must have avatar URL input');
  assert.ok(radioHtml.includes('id="trackCoverInput"'), 'Modal upload track must have cover file input');
  assert.ok(radioHtml.includes('id="trackCoverUrlInput"'), 'Modal upload track must have cover URL input');
  assert.ok(radioHtml.includes('id="playlistCoverInput"'), 'Modal create playlist must have cover file input');
  assert.ok(radioHtml.includes('id="playlistCoverUrlInput"'), 'Modal create playlist must have cover URL input');
});

test('radio UI: infinite scroll in feed matches Antropedia implementation with IntersectionObserver and sentinel', () => {
  const radioHtml = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.html'), 'utf8');
  const radioClientJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');

  // 1. HTML markup parity: sentinel and loading more indicator
  assert.ok(radioHtml.includes('id="radioFeedSentinel"'), 'radio.html must include sentinel element for infinite scrolling');
  assert.ok(radioHtml.includes('id="radioFeedLoadingMore"'), 'radio.html must include loading more spinner element');

  // 2. Client JS implementation parity with Antropedia
  assert.ok(radioClientJs.includes('setupFeedInfiniteScroll'), 'radio-client.js must define setupFeedInfiniteScroll');
  assert.ok(radioClientJs.includes('new IntersectionObserver'), 'Must use IntersectionObserver for infinite scrolling');
  assert.ok(radioClientJs.includes('rootMargin: \'400px\''), 'Must use 400px rootMargin identical to Antropedia');
  assert.ok(radioClientJs.includes('state.feedObserver.observe(dom.radioFeedSentinel)'), 'Must observe radioFeedSentinel element');
  assert.ok(radioClientJs.includes('state.feedObserver.disconnect()'), 'Must disconnect observer in cleanup');
});

test('radio UI & upload: file upload progress indicator and Range / empty audio safety', () => {
  const radioHtml = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.html'), 'utf8');
  const radioClientJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');
  const serverJs = fs.readFileSync(path.resolve(__dirname, '../../src/server.js'), 'utf8');
  const uploadsRoutesJs = fs.readFileSync(path.resolve(__dirname, '../../src/routes/uploads.routes.js'), 'utf8');
  const audioConverterJs = fs.readFileSync(path.resolve(__dirname, '../../src/services/audio-converter.js'), 'utf8');

  // 1. HTML markup: progress indicator identical to gallery
  assert.ok(radioHtml.includes('id="trackUploadProgress"'), 'radio.html must include trackUploadProgress container');
  assert.ok(radioHtml.includes('id="trackUploadProgressBar"'), 'radio.html must include trackUploadProgressBar element');
  assert.ok(radioHtml.includes('id="trackUploadProgressLabel"'), 'radio.html must include trackUploadProgressLabel element');
  assert.ok(radioHtml.includes('id="trackUploadProgressCount"'), 'radio.html must include trackUploadProgressCount element');
  assert.ok(radioHtml.includes('class="alltell-upload-progress"'), 'Must use gallery standard alltell-upload-progress class');

  // 2. Client JS: uploadWithProgress and local getAudioDuration (preventing Range requests to new files)
  assert.ok(radioClientJs.includes('function uploadWithProgress('), 'radio-client.js must define uploadWithProgress helper');
  assert.ok(radioClientJs.includes('xhr.upload.onprogress'), 'uploadWithProgress must track xhr.upload.onprogress');
  assert.ok(radioClientJs.includes('function getAudioDuration('), 'radio-client.js must define getAudioDuration helper');
  assert.ok(radioClientJs.includes('URL.createObjectURL(fileOrUrl)'), 'getAudioDuration must inspect local Blob/File directly');

  // 3. Server: RangeNotSatisfiableError (416) safety and 0-byte file prevention
  assert.ok(serverJs.includes('RangeNotSatisfiableError') || serverJs.includes('status === 416'), 'server.js must cleanly respond to 416 Range requests');
  assert.ok(uploadsRoutesJs.includes("req.file.size === 0"), 'uploads.routes.js must validate non-empty file size');
  assert.ok(audioConverterJs.includes("stat.size === 0"), 'audio-converter.js must reject 0-byte input/output');
});

test('radio live sync: prevention of infinite fetch loop and net::ERR_INSUFFICIENT_RESOURCES storm', () => {
  const globalPlayerJs = fs.readFileSync(path.resolve(__dirname, '../../public/radio-global-player.js'), 'utf8');
  const radioRoutesJs = fs.readFileSync(path.resolve(__dirname, '../../src/routes/radio.routes.js'), 'utf8');

  // 1. Guard against in-flight concurrent fetch storms
  assert.ok(globalPlayerJs.includes('isSyncingLive'), 'radio-global-player must maintain isSyncingLive mutex');
  assert.ok(globalPlayerJs.includes('cancelLiveSync()'), 'radio-global-player must provide cancelLiveSync');
  assert.ok(globalPlayerJs.includes('scheduleLiveSync('), 'radio-global-player must provide centralized scheduleLiveSync');
  assert.ok(globalPlayerJs.includes('syncRetryCount'), 'radio-global-player must track syncRetryCount');
  assert.ok(globalPlayerJs.includes('MAX_SYNC_RETRIES'), 'radio-global-player must define MAX_SYNC_RETRIES limit');

  // 2. Removal of dangerous rapid-fire 300ms / 400ms recursive timeouts
  assert.ok(!globalPlayerJs.includes('setTimeout(() => {\n            if (state.mode === \'radio\' && state.station && state.station.id === station.id) {\n              syncRadioStationLive(station, autoPlay);\n            }\n          }, 300)'), 'Must not have 300ms unthrottled recursion');
  assert.ok(!globalPlayerJs.includes('setTimeout(() => {\n              if (state.mode === \'radio\' && state.station && state.station.id === station.id) {\n                syncRadioStationLive(station, true);\n              }\n            }, 400)'), 'Must not have 400ms unthrottled recursion');

  // 3. Clean reset without audio.src = '' error event explosion
  assert.ok(globalPlayerJs.includes('resetAudioElement()'), 'Must use resetAudioElement to avoid MEDIA_ELEMENT_ERROR: Empty src attribute');
  assert.ok(globalPlayerJs.includes("audio.removeAttribute('src')"), 'resetAudioElement must removeAttribute instead of assigning empty string');

  // 4. Server returns 404 for deleted/unknown station live state
  assert.ok(radioRoutesJs.includes("error.message === 'Станция не найдена'") && radioRoutesJs.includes('status(404)'), 'radio.routes.js must return 404 when station is not found');
});

test('radio duration: auto-detection on upload, database auto-healing, and dynamic client/player sync', () => {
  const audioConverterJs = fs.readFileSync(path.resolve(__dirname, '../../src/services/audio-converter.js'), 'utf8');
  const uploadsRoutesJs = fs.readFileSync(path.resolve(__dirname, '../../src/routes/uploads.routes.js'), 'utf8');
  const radioStoreJs = fs.readFileSync(path.resolve(__dirname, '../../src/services/radio-store.js'), 'utf8');
  const radioRoutesJs = fs.readFileSync(path.resolve(__dirname, '../../src/routes/radio.routes.js'), 'utf8');
  const radioClientJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');
  const globalPlayerJs = fs.readFileSync(path.resolve(__dirname, '../../public/radio-global-player.js'), 'utf8');

  // 1. Audio converter probeAudioDuration helper
  assert.ok(audioConverterJs.includes('function probeAudioDuration('), 'audio-converter must define probeAudioDuration');
  assert.ok(audioConverterJs.includes('probeAudioDuration,'), 'audio-converter must export probeAudioDuration');

  // 2. Upload route returns detected duration
  assert.ok(uploadsRoutesJs.includes('finalDuration') && uploadsRoutesJs.includes('duration: finalDuration'), 'uploads route must return probed audio duration');

  // 3. Radio store updates and auto-heals 00:00 duration
  assert.ok(radioStoreJs.includes('async function updateTrackDuration('), 'radio-store must define updateTrackDuration');
  assert.ok(radioStoreJs.includes('zeroDurationTracks'), 'ensureTracksConvertedToMp3 must query zero duration tracks');
  assert.ok(radioStoreJs.includes('probeAudioDuration(filePath)'), 'ensureTracksConvertedToMp3 must probe tracks with duration <= 0');

  // 4. Radio route endpoint
  assert.ok(radioRoutesJs.includes('/radio/tracks/:id/duration'), 'radio.routes.js must provide PATCH /radio/tracks/:id/duration');

  // 5. Radio client handles Infinity, sets data-track-duration-id, and falls back to server duration
  assert.ok(radioClientJs.includes('data-track-duration-id'), 'radio-client must tag duration elements with data-track-duration-id');
  assert.ok(radioClientJs.includes('uploadRes.duration'), 'radio-client upload handler must fallback to server uploadRes.duration');
  assert.ok(radioClientJs.includes('audio.currentTime = 1e101'), 'getAudioDuration must handle Infinity duration in Chromium');

  // 6. Global radio player heals duration on playback and syncs DOM and server
  assert.ok(globalPlayerJs.includes('handleDetectedDuration'), 'radio-global-player must implement handleDetectedDuration');
  assert.ok(globalPlayerJs.includes('/api/radio/tracks/'), 'handleDetectedDuration must patch duration to server');
});

test('radio-studio-console: dedicated Start/Stop broadcast, schedule controls and no unintended auto-start', () => {
  const radioHtml = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.html'), 'utf8');
  const radioClientJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');
  const radioRoutesJs = fs.readFileSync(path.resolve(__dirname, '../../src/routes/radio.routes.js'), 'utf8');
  const globalPlayerJs = fs.readFileSync(path.resolve(__dirname, '../../public/radio-global-player.js'), 'utf8');

  // 1. Studio markup controls
  assert.ok(radioHtml.includes('id="btnStartBroadcastNow"'), 'radio.html must include btnStartBroadcastNow');
  assert.ok(radioHtml.includes('id="btnStopBroadcast"'), 'radio.html must include btnStopBroadcast');
  assert.ok(radioHtml.includes('id="btnScheduleBroadcast"'), 'radio.html must include btnScheduleBroadcast');
  assert.ok(radioHtml.includes('id="btnSaveTimelineDraft"'), 'radio.html must include btnSaveTimelineDraft');
  assert.ok(radioHtml.includes('id="btnPresetNow"'), 'radio.html must include btnPresetNow');
  assert.ok(radioHtml.includes('id="btnPresetPlus5"'), 'radio.html must include btnPresetPlus5');
  assert.ok(radioHtml.includes('id="btnPresetPlus15"'), 'radio.html must include btnPresetPlus15');
  assert.ok(radioHtml.includes('id="btnPresetNextHour"'), 'radio.html must include btnPresetNextHour');

  // 2. Server API routes
  assert.ok(radioRoutesJs.includes('/radio/stations/:id/start-broadcast'), 'radio.routes.js must have start-broadcast route');
  assert.ok(radioRoutesJs.includes('/radio/stations/:id/stop-broadcast'), 'radio.routes.js must have stop-broadcast route');

  // 3. Client JS handlers
  assert.ok(radioClientJs.includes('async function startBroadcast('), 'radio-client.js must define startBroadcast');
  assert.ok(radioClientJs.includes('async function stopBroadcast('), 'radio-client.js must define stopBroadcast');
  assert.ok(radioClientJs.includes('async function saveTimelineDraft('), 'radio-client.js must define saveTimelineDraft');

  // 4. Verification that accidental auto-start on time input typing is ELIMINATED
  assert.ok(!radioClientJs.includes("editorBroadcastStartTime?.addEventListener('change', (e) => {\n      if (e.target.value) {\n        publishBroadcast"),
    'Accidental auto-start on input change must be eliminated');

  // 5. Global audio player passes finishedSlotId to eliminate boundary drift
  assert.ok(globalPlayerJs.includes('finishedSlotId'), 'Global player must pass finishedSlotId on ended');
});

test('radio-editor-asynchronous: draft banner, hot-apply button, discard action and tab preservation', () => {
  const radioHtml = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.html'), 'utf8');
  const radioCss = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio.css'), 'utf8');
  const radioClientJs = fs.readFileSync(path.resolve(__dirname, '../../public/site/radio-client.js'), 'utf8');

  // 1. UI Markup: Draft banner and actions
  assert.ok(radioHtml.includes('id="radioEditorDraftBanner"'), 'radio.html must include radioEditorDraftBanner');
  assert.ok(radioHtml.includes('id="btnApplyDraftToLive"'), 'radio.html must include btnApplyDraftToLive');
  assert.ok(radioHtml.includes('id="btnDiscardDraft"'), 'radio.html must include btnDiscardDraft');
  assert.ok(radioHtml.includes('id="btnMasterApplyDraft"'), 'radio.html must include btnMasterApplyDraft in master console');

  // 2. CSS Styles for draft mode
  assert.ok(radioCss.includes('.radio-editor-draft-banner'), 'radio.css must style .radio-editor-draft-banner');
  assert.ok(radioCss.includes('.radio-cta-apply-btn'), 'radio.css must style .radio-cta-apply-btn');
  assert.ok(radioCss.includes('.radio-draft-apply-btn'), 'radio.css must style .radio-draft-apply-btn');

  // 3. Client JS: State, helpers, and exports
  assert.ok(radioClientJs.includes('isEditorDirty: false'), 'state must include isEditorDirty flag');
  assert.ok(radioClientJs.includes('editorInitialized: false'), 'state must include editorInitialized flag');
  assert.ok(radioClientJs.includes('function markEditorDirty('), 'radio-client.js must define markEditorDirty helper');
  assert.ok(radioClientJs.includes('function updateEditorDraftBannerUI('), 'radio-client.js must define updateEditorDraftBannerUI');
  assert.ok(radioClientJs.includes('async function applyDraftToLive('), 'radio-client.js must define applyDraftToLive');
  assert.ok(radioClientJs.includes('async function discardDraftChanges('), 'radio-client.js must define discardDraftChanges');
  assert.ok(radioClientJs.includes('applyDraftToLive,'), 'window.RadioClient must export applyDraftToLive');
  assert.ok(radioClientJs.includes('discardDraftChanges,'), 'window.RadioClient must export discardDraftChanges');
  assert.ok(radioClientJs.includes('markEditorDirty,'), 'window.RadioClient must export markEditorDirty');

  // 4. Tab switching must preserve initialized editor draft without wiping state
  assert.ok(radioClientJs.includes('if (tabName === \'editor\') {\n      if (!state.editorInitialized) {\n        initEditor();\n      } else {\n        renderEditor();\n      }\n    }'),
    'switchTab must preserve initialized editor state without re-invoking initEditor');
});

test('radio-store: hotUpdate seamlessly updates upcoming slots without interrupting active playing track', async () => {
  const radioStore = require('./radio-store');

  const testFreq = 93.7;
  const existing = await radioStore.getStationByFrequency(testFreq);
  if (existing) {
    await radioStore.deleteStation(existing.id, existing.owner_id || 9999);
  }

  // 1. Create a test radio station
  const station = await radioStore.createStation({
    name: 'Asynchronous Test FM',
    frequency: testFreq,
    ownerId: 9999,
    ownerName: 'DJ Tester'
  });
  assert.ok(station && station.id, 'Station must be created');

  try {
    // 2. Schedule 3 initial tracks
    const initialSlots = [
      { title: 'Active Track 1', duration: 180, audio_url: '/audio/track1.mp3', type: 'track' },
      { title: 'Upcoming Track 2', duration: 200, audio_url: '/audio/track2.mp3', type: 'track' },
      { title: 'Upcoming Track 3', duration: 210, audio_url: '/audio/track3.mp3', type: 'track' }
    ];

    await radioStore.setTimelineSlots(station.id, initialSlots, 'now', { forceNow: true, status: 'live' });
    const liveStateBefore = await radioStore.getStationLiveState(station.id);
    assert.ok(liveStateBefore.isLive, 'Station must be live');
    assert.ok(liveStateBefore.currentSlot, 'Active slot must exist');
    assert.equal(liveStateBefore.currentSlot.title, 'Active Track 1');
    const activeSlotId = liveStateBefore.currentSlot.id;
    const activeEndTime = liveStateBefore.currentSlot.endTime || liveStateBefore.currentSlot.end_time;

    // 3. User modifies the draft in editor: replaces upcoming tracks with new ones
    const newDraftSlots = [
      { title: 'Active Track 1', duration: 180, audio_url: '/audio/track1.mp3', type: 'track' },
      { title: 'Brand New Track B', duration: 240, audio_url: '/audio/trackB.mp3', type: 'track' },
      { title: 'Brand New Track C', duration: 190, audio_url: '/audio/trackC.mp3', type: 'track' }
    ];

    // 4. Hot-apply draft to live broadcast
    const updatedSlots = await radioStore.setTimelineSlots(station.id, newDraftSlots, null, { hotUpdate: true });

    // 5. Verify the active slot was NOT interrupted or deleted
    const liveStateAfter = await radioStore.getStationLiveState(station.id);
    assert.ok(liveStateAfter.isLive, 'Station must still be live');
    assert.ok(liveStateAfter.currentSlot, 'Active slot must still be active');
    assert.equal(liveStateAfter.currentSlot.id, activeSlotId, 'Active slot ID must remain unchanged');
    assert.equal(liveStateAfter.currentSlot.title, 'Active Track 1', 'Active track title must remain unchanged');
    assert.equal(liveStateAfter.currentSlot.endTime, activeEndTime, 'Active slot endTime must be preserved');

    // 6. Verify upcoming slots are seamlessly replaced with the new draft
    assert.ok(liveStateAfter.nextSlots && liveStateAfter.nextSlots.length >= 2, 'Must have nextSlots from new draft');
    assert.equal(liveStateAfter.nextSlots[0].title, 'Brand New Track B', 'Next slot must be the new draft track');
    assert.equal(liveStateAfter.nextSlots[1].title, 'Brand New Track C', 'Second upcoming slot must match new draft');
    assert.equal(liveStateAfter.nextSlots[0].startTime, activeEndTime, 'Next slot must start exactly at the end of active slot');
  } finally {
    // Cleanup station
    await radioStore.deleteStation(station.id, 9999);
  }
});


