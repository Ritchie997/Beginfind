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
