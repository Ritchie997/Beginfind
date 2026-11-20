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

