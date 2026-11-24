const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const radioStore = require('./radio-store');
const cleanup = require('./cleanup');
const backup = require('./backup');

test('radio-store: track management (tracks, podcasts, speech)', async () => {
  const testTrack = await radioStore.createTrack({
    userId: 999,
    authorName: 'TestDj',
    title: 'Electronic Odyssey',
    audioUrl: '/uploads/audio-test-1.mp3',
    duration: 180,
    size: 5000000,
    format: 'mp3',
    type: 'track'
  });

  assert.ok(testTrack.id, 'Track must have an ID');
  assert.equal(testTrack.title, 'Electronic Odyssey');
  assert.equal(testTrack.type, 'track');

  const testPodcast = await radioStore.createTrack({
    userId: 999,
    authorName: 'TestDj',
    title: 'Podcast Episode 1',
    audioUrl: '/uploads/audio-test-2.ogg',
    duration: 1200,
    size: 25000000,
    format: 'ogg',
    type: 'podcast'
  });

  assert.equal(testPodcast.type, 'podcast');

  // List all
  const allList = await radioStore.listTracks({ userId: 999 });
  assert.ok(allList.tracks.length >= 2, 'Should list both tracks');

  // Filter by type
  const podcastOnly = await radioStore.listTracks({ userId: 999, type: 'podcast' });
  assert.ok(podcastOnly.tracks.every(t => t.type === 'podcast'));

  // Clean up
  await radioStore.deleteTrack(testTrack.id, 999, false);
  await radioStore.deleteTrack(testPodcast.id, 999, false);

  const afterDelete = await radioStore.getTrackById(testTrack.id);
  assert.equal(afterDelete, null);
});

test('radio-store: stations, frequencies and timeline slots', async () => {
  const freq = 42.7;
  // Make sure not existing
  const existing = await radioStore.getStationByFrequency(freq);
  if (existing) {
    await radioStore.deleteStation(existing.id, existing.owner_id, true);
  }

  const station = await radioStore.createStation({
    frequency: freq,
    name: 'Radio Galaxy',
    description: '42 Station',
    ownerId: 888,
    ownerName: 'Arthur',
    fallbackMode: 'loop'
  });

  assert.equal(station.frequency, 42.7);
  assert.equal(station.name, 'Radio Galaxy');
  assert.equal(station.fallback_mode, 'loop');

  // Duplicate frequency should fail
  await assert.rejects(async () => {
    await radioStore.createStation({
      frequency: freq,
      name: 'Another Station',
      ownerId: 777,
      ownerName: 'Ford'
    });
  }, /уже занята/);

  // Set timeline slots
  const now = Date.now();
  const slotsInput = [
    { title: 'Intro Speech', type: 'speech', audio_url: '/uploads/intro.mp3', duration: 30 },
    { title: 'Song 1', type: 'track', audio_url: '/uploads/song1.mp3', duration: 180 },
    { title: 'Podcast Talk', type: 'podcast', audio_url: '/uploads/talk.mp3', duration: 300 }
  ];

  const updatedSlots = await radioStore.setTimelineSlots(station.id, slotsInput, new Date(now - 10000).toISOString());
  assert.equal(updatedSlots.length, 3);

  // Check timing calculation: slot 1 starts at now-10s, ends at now+20s
  const slot1 = updatedSlots[0];
  assert.equal(slot1.title, 'Intro Speech');
  assert.equal(slot1.duration, 30);
  assert.equal(new Date(slot1.end_time).getTime() - new Date(slot1.start_time).getTime(), 30000);

  // Live state check
  const liveState = await radioStore.getStationLiveState(station.id);
  assert.ok(liveState.isLive, 'Station should be currently live');
  assert.ok(liveState.currentSlot, 'There should be a current slot playing');
  assert.equal(liveState.currentSlot.title, 'Intro Speech');
  assert.ok(liveState.offset >= 9 && liveState.offset <= 15, `Offset should be around 10s, got ${liveState.offset}`);
  assert.ok(liveState.remaining <= 21, 'Remaining should be around 20s');
  assert.equal(liveState.nextSlots.length, 2);

  // Clear timeline slots test
  await radioStore.clearTimelineSlots(station.id, 888, false);
  const clearedSlots = await radioStore.getTimelineSlots(station.id);
  assert.equal(clearedSlots.length, 0, 'Timeline slots should be empty after clearTimelineSlots');

  // Cleanup station
  await radioStore.deleteStation(station.id, 888, false);
  const deleted = await radioStore.getStationById(station.id);
  assert.equal(deleted, null);
});

test('radio cleanup & backup protection: audio files are tracked and protected', async () => {
  // Check backup configuration
  assert.ok(backup.DATABASE_FILES.includes('radio.db'), 'radio.db must be in DATABASE_FILES for backups');

  // Create temporary track with upload path
  const dummyTrack = await radioStore.createTrack({
    userId: 999,
    authorName: 'CleanupTest',
    title: 'Protected Audio',
    audioUrl: '/uploads/audio-protected-unique-9999.mp3',
    duration: 60,
    size: 1000,
    format: 'mp3'
  });

  const used = await cleanup.collectUsedUploadNames();
  assert.ok(used.has('audio-protected-unique-9999.mp3'), 'collectUsedUploadNames must collect radio track audio_url');

  await radioStore.deleteTrack(dummyTrack.id, 999, true);
});

test('radio-store: favorites ("Моё") and playlists (private and public)', async () => {
  const userId = 777;
  const track = await radioStore.createTrack({
    userId,
    authorName: 'PlaylistCreator',
    title: 'Favorite Track 1',
    audioUrl: '/uploads/track-fav-1.mp3',
    duration: 120,
    size: 2000,
    format: 'mp3'
  });

  // 1. Favorites
  assert.equal(await radioStore.isFavorite(userId, track.id), false);
  const toggledOn = await radioStore.toggleFavorite(userId, track.id);
  assert.equal(toggledOn.favorited, true);
  assert.equal(await radioStore.isFavorite(userId, track.id), true);

  const favIds = await radioStore.getUserFavoriteTrackIds(userId);
  assert.ok(favIds.includes(track.id));

  const userFavs = await radioStore.getUserFavorites(userId);
  assert.equal(userFavs.total, 1);
  assert.equal(userFavs.tracks[0].id, track.id);

  const toggledOff = await radioStore.toggleFavorite(userId, track.id);
  assert.equal(toggledOff.favorited, false);
  assert.equal(await radioStore.isFavorite(userId, track.id), false);

  // 2. Playlists
  const publicPlaylist = await radioStore.createPlaylist({
    userId,
    authorName: 'PlaylistCreator',
    title: 'Top Hits Public',
    description: 'Best community tracks',
    isPublic: 1
  });
  assert.ok(publicPlaylist.id);
  assert.equal(publicPlaylist.is_public, 1);

  const privatePlaylist = await radioStore.createPlaylist({
    userId,
    authorName: 'PlaylistCreator',
    title: 'Secret Gems Private',
    description: 'Personal collection',
    isPublic: 0
  });
  assert.equal(privatePlaylist.is_public, 0);

  // Add track to playlist
  await radioStore.addTrackToPlaylist(publicPlaylist.id, track.id, userId, false);
  const reloaded = await radioStore.getPlaylistById(publicPlaylist.id, userId, false);
  assert.equal(reloaded.trackCount, 1);
  assert.equal(reloaded.tracks[0].id, track.id);

  // Remove track
  await radioStore.removeTrackFromPlaylist(publicPlaylist.id, track.id, userId, false);
  const emptyPl = await radioStore.getPlaylistById(publicPlaylist.id, userId, false);
  assert.equal(emptyPl.trackCount, 0);

  // Other user access to private playlist
  const otherUserView = await radioStore.getPlaylistById(privatePlaylist.id, 9999, false);
  assert.equal(otherUserView, null, 'Private playlist should be inaccessible by other users');

  // Owner access to private playlist (with both integer and string userId)
  const ownerViewNumeric = await radioStore.getPlaylistById(privatePlaylist.id, userId, false);
  assert.ok(ownerViewNumeric, 'Private playlist must be accessible by owner (numeric userId)');
  assert.equal(ownerViewNumeric.id, privatePlaylist.id);

  const ownerViewString = await radioStore.getPlaylistById(privatePlaylist.id, String(userId), false);
  assert.ok(ownerViewString, 'Private playlist must be accessible by owner (string userId)');
  assert.equal(ownerViewString.id, privatePlaylist.id);
  assert.equal(ownerViewString.is_public, 0);
  assert.equal(typeof ownerViewString.tracks_count, 'number');
  assert.equal(typeof ownerViewString.total_duration, 'number');

  // Add track to private playlist using string userId
  await radioStore.addTrackToPlaylist(privatePlaylist.id, track.id, String(userId), false);
  const privateWithTrack = await radioStore.getPlaylistById(privatePlaylist.id, String(userId), false);
  assert.equal(privateWithTrack.trackCount, 1);
  assert.equal(privateWithTrack.tracks_count, 1);
  assert.equal(privateWithTrack.tracks[0].id, track.id);

  // List playlists for unauthenticated guest (only public)
  const guestList = await radioStore.listPlaylists();
  assert.ok(guestList.playlists.some(p => p.id === publicPlaylist.id));
  assert.ok(!guestList.playlists.some(p => p.id === privatePlaylist.id), 'Guest should not see private playlist');

  // List playlists for owner (sees both public and own private playlist)
  const ownerList = await radioStore.listPlaylists({ requestingUserId: String(userId) });
  assert.ok(ownerList.playlists.some(p => p.id === publicPlaylist.id), 'Owner should see public playlist');
  assert.ok(ownerList.playlists.some(p => p.id === privatePlaylist.id), 'Owner should see own private playlist in general list');

  // List playlists with includeMine=true
  const includeMineList = await radioStore.listPlaylists({ isPublic: true, includeMine: true, requestingUserId: String(userId) });
  assert.ok(includeMineList.playlists.some(p => p.id === privatePlaylist.id), 'includeMine=true must include owner private playlist');

  // List public playlists
  const publicList = await radioStore.listPlaylists({ isPublic: true });
  assert.ok(publicList.playlists.some(p => p.id === publicPlaylist.id));
  assert.ok(!publicList.playlists.some(p => p.id === privatePlaylist.id));

  // Cleanup
  await radioStore.deletePlaylist(publicPlaylist.id, userId, false);
  await radioStore.deletePlaylist(privatePlaylist.id, String(userId), false);
  await radioStore.deleteTrack(track.id, userId, true);
});

test('radio-store: virtual loop loops broadcast after schedule ends and populates nextSlots', async () => {
  const freq = 99.3;
  const existing = await radioStore.getStationByFrequency(freq);
  if (existing) await radioStore.deleteStation(existing.id, existing.owner_id, true);

  const station = await radioStore.createStation({
    frequency: freq,
    name: 'Looping Station',
    description: 'Loops forever',
    ownerId: 901,
    ownerName: 'LoopMaster',
    fallbackMode: 'loop'
  });

  // 3 слота по 10 секунд (всего 30 секунд цикл)
  // Стартовали 45 секунд назад — значит прямо сейчас идет 2-й круг цикла!
  const now = radioStore.getEffectiveNow().getTime();
  const startTime = new Date(now - 45000).toISOString();

  await radioStore.setTimelineSlots(station.id, [
    { title: 'Loop Track 1', duration: 10, audio_url: '/uploads/loop1.mp3', type: 'track' },
    { title: 'Loop Track 2', duration: 10, audio_url: '/uploads/loop2.mp3', type: 'track' },
    { title: 'Loop Track 3', duration: 10, audio_url: '/uploads/loop3.mp3', type: 'track' }
  ], startTime);

  const liveState = await radioStore.getStationLiveState(station.id);
  assert.ok(liveState.isLive, 'Станция должна быть активна');
  assert.equal(liveState.isVirtualLoop, true, 'Виртуальное зацикливание должно быть включено');
  assert.ok(liveState.currentSlot, 'Должен быть текущий играющий слот из цикла');
  // 45 сек modulo 30 сек = 15 сек.
  // 0-10с: Track 1, 10-20с: Track 2. Значит на 15-й секунде играет Track 2!
  assert.equal(liveState.currentSlot.title, 'Loop Track 2', 'На 15-й секунде цикла должен играть Track 2');
  assert.ok(liveState.nextSlots.length > 0, 'В режиме зацикливания nextSlots не должен быть пустым');
  assert.equal(liveState.nextSlots[0].title, 'Loop Track 3', 'Следующим слотом должен быть Track 3');

  // Проверка проекции меток времени к реальному времени вещания (устранение рассинхрона)
  const curStart = new Date(liveState.currentSlot.startTime).getTime();
  const curEnd = new Date(liveState.currentSlot.endTime).getTime();
  const nextStart = new Date(liveState.nextSlots[0].startTime).getTime();
  assert.ok(curStart <= now, `currentSlot.startTime (${curStart}) должен быть <= now (${now})`);
  assert.ok(curEnd > now, `currentSlot.endTime (${curEnd}) должен быть > now (${now})`);
  assert.equal(curEnd, nextStart, 'Конец текущего слота должен совпадать со стартом следующего');
  assert.ok(liveState.cycleStartTime, 'cycleStartTime должен быть определен');

  await radioStore.deleteStation(station.id, 901, true);
});

test('radio-store: finishedSlotId in loop mode advances cleanly with current wall-clock timestamps', async () => {
  const freq = 99.35;
  const existing = await radioStore.getStationByFrequency(freq);
  if (existing) await radioStore.deleteStation(existing.id, existing.owner_id, true);

  const station = await radioStore.createStation({
    frequency: freq,
    name: 'Advance Test Station',
    ownerId: 901,
    ownerName: 'AdvanceMaster',
    fallbackMode: 'loop'
  });

  const now = radioStore.getEffectiveNow().getTime();
  const startTime = new Date(now - 60000).toISOString();

  await radioStore.setTimelineSlots(station.id, [
    { title: 'Track A', duration: 15, audio_url: '/uploads/a.mp3', type: 'track' },
    { title: 'Track B', duration: 15, audio_url: '/uploads/b.mp3', type: 'track' }
  ], startTime);

  const timeline = await radioStore.getTimelineSlots(station.id);
  const trackASlotId = timeline[0].id;

  // Имитируем завершение Track A
  const advanced = await radioStore.getStationLiveState(station.id, { finishedSlotId: trackASlotId });
  assert.equal(advanced.currentSlot.title, 'Track B');
  const bStart = new Date(advanced.currentSlot.startTime).getTime();
  const bEnd = new Date(advanced.currentSlot.endTime).getTime();
  assert.ok(bStart <= now + 1000, 'bStart must be aligned with current time');
  assert.ok(bEnd > now, 'bEnd must be in future');
  assert.ok(advanced.nextSlots.length > 0, 'nextSlots must be populated');
  assert.equal(advanced.nextSlots[0].title, 'Track A', 'Next slot in loop must be Track A');

  await radioStore.deleteStation(station.id, 901, true);
});

test('radio-store: audio_url fallback from radio_tracks prevents NOT NULL constraint failure', async () => {
  const freq = 99.4;
  const existing = await radioStore.getStationByFrequency(freq);
  if (existing) await radioStore.deleteStation(existing.id, existing.owner_id, true);

  const station = await radioStore.createStation({
    frequency: freq,
    name: 'NotNull Test Station',
    ownerId: 902,
    ownerName: 'Tester',
    fallbackMode: 'loop'
  });

  const track = await radioStore.createTrack({
    userId: 902,
    authorName: 'Tester',
    title: 'Song With Url',
    audioUrl: '/uploads/real-song.mp3',
    duration: 100,
    size: 2000,
    format: 'mp3'
  });

  // Отправляем слот с track_id, но с audio_url: null (как случалось в сломавшемся редакторе)
  const slots = await radioStore.setTimelineSlots(station.id, [
    { track_id: track.id, title: 'Slot From Track', audio_url: null, duration: 100 }
  ], new Date().toISOString());

  assert.equal(slots.length, 1);
  assert.equal(slots[0].audio_url, '/uploads/real-song.mp3', 'audio_url должен быть автоматически подтянут из radio_tracks');

  await radioStore.deleteTrack(track.id, 902, true);
  await radioStore.deleteStation(station.id, 902, true);
});

test('radio-store: updating timeline replaces old overlapping slots without duplicates or track repeats', async () => {
  const freq = 99.5;
  const existing = await radioStore.getStationByFrequency(freq);
  if (existing) await radioStore.deleteStation(existing.id, existing.owner_id, true);

  const station = await radioStore.createStation({
    frequency: freq,
    name: 'Overlap Test Station',
    ownerId: 903,
    ownerName: 'Tester',
    fallbackMode: 'loop'
  });

  const baseStart = new Date(Date.now() - 60000).toISOString();

  // Первый запуск сетки: 3 трека по 60 сек
  await radioStore.setTimelineSlots(station.id, [
    { title: 'Track A', duration: 60, audio_url: '/uploads/a.mp3' },
    { title: 'Track B', duration: 60, audio_url: '/uploads/b.mp3' },
    { title: 'Track C', duration: 60, audio_url: '/uploads/c.mp3' }
  ], baseStart);

  let initialSlots = await radioStore.getTimelineSlots(station.id);
  assert.equal(initialSlots.length, 3);

  // Редактирование эфира: добавили Track D в конец, сохранив тот же baseStart эфира
  await radioStore.setTimelineSlots(station.id, [
    { title: 'Track A', duration: 60, audio_url: '/uploads/a.mp3' },
    { title: 'Track B', duration: 60, audio_url: '/uploads/b.mp3' },
    { title: 'Track C', duration: 60, audio_url: '/uploads/c.mp3' },
    { title: 'Track D', duration: 60, audio_url: '/uploads/d.mp3' }
  ], baseStart);

  let updatedSlots = await radioStore.getTimelineSlots(station.id);
  assert.equal(updatedSlots.length, 4, 'В сетке должно быть ровно 4 слота, без дубликатов от старой публикации');
  assert.equal(updatedSlots[0].title, 'Track A');
  assert.equal(updatedSlots[1].title, 'Track B');
  assert.equal(updatedSlots[2].title, 'Track C');
  assert.equal(updatedSlots[3].title, 'Track D');

  await radioStore.deleteStation(station.id, 903, true);
});

test('radio-store: track duration auto-probing and updateTrackDuration', async () => {
  const zeroTrack = await radioStore.createTrack({
    userId: 999,
    authorName: 'ZeroTester',
    title: 'Zero Duration Song',
    audioUrl: '/uploads/nonexistent-song.mp3',
    duration: 0,
    size: 1000,
    format: 'mp3',
    type: 'track'
  });

  assert.equal(zeroTrack.duration, 0, 'Initially duration is 0');

  // Update track duration manually via updateTrackDuration
  const updated = await radioStore.updateTrackDuration(zeroTrack.id, 215);
  assert.equal(updated.duration, 215, 'Track duration should be updated to 215s');

  const fetched = await radioStore.getTrackById(zeroTrack.id);
  assert.equal(fetched.duration, 215, 'Fetched track should reflect updated duration');

  await radioStore.deleteTrack(zeroTrack.id, 999, false);
});

test('radio-store: startStationBroadcast, stopStationBroadcast, and slot_order transitions', async () => {
  const freq = 98.7;
  const existing = await radioStore.getStationByFrequency(freq);
  if (existing) await radioStore.deleteStation(existing.id, existing.owner_id, true);

  const station = await radioStore.createStation({
    frequency: freq,
    name: 'Broadcast State Test Station',
    ownerId: 905,
    ownerName: 'StudioDirector',
    fallbackMode: 'loop'
  });

  // Запуск эфира со слотами
  const started = await radioStore.startStationBroadcast(station.id, {
    forceNow: true,
    slots: [
      { title: 'Track 1', duration: 180, audio_url: '/uploads/track1.mp3' },
      { title: 'Track 2', duration: 200, audio_url: '/uploads/track2.mp3' }
    ]
  });

  assert.equal(started.broadcastStatus, 'live');
  assert.equal(started.isLive, true);
  assert.ok(started.currentSlot);
  assert.equal(started.currentSlot.title, 'Track 1');

  // Переход по завершению трека 1 (finishedSlotId):
  const afterTrack1 = await radioStore.getStationLiveState(station.id, {
    finishedSlotId: started.currentSlot.id
  });
  assert.ok(afterTrack1.currentSlot);
  assert.equal(afterTrack1.currentSlot.title, 'Track 2', 'Должен мгновенно перейти на Track 2 по finishedSlotId');
  assert.equal(afterTrack1.offset, 0, 'Смещение следующего слота должно начинаться с 0');

  // Остановка вещания:
  const stopped = await radioStore.stopStationBroadcast(station.id);
  assert.equal(stopped.broadcastStatus, 'offline');

  const stateOffline = await radioStore.getStationLiveState(station.id);
  assert.equal(stateOffline.broadcastStatus, 'offline');
  assert.equal(stateOffline.isLive, false);
  assert.equal(stateOffline.currentSlot, null);

  // Проверяем, что слоты в базе сохранились!
  const slotsAfterStop = await radioStore.getTimelineSlots(station.id);
  assert.equal(slotsAfterStop.length, 2, 'Слоты сетки не должны удаляться при остановке эфира');

  await radioStore.deleteStation(station.id, 905, true);
});

test('radio-timeline-sync: playhead, slot duration lock, and on-air alignment', async () => {
  const freq = 98.6;
  const existing = await radioStore.getStationByFrequency(freq);
  if (existing) await radioStore.deleteStation(existing.id, existing.owner_id, true);

  const station = await radioStore.createStation({
    frequency: freq,
    name: 'Timeline Lock Test Station',
    ownerId: 906,
    ownerName: 'LockDirector',
    fallbackMode: 'loop'
  });

  // Запуск прямого эфира со слотами, как на скриншоте (142с, 40с, 52с, 40с)
  const slots = [
    { title: 'Волны', duration: 142, audio_url: '/uploads/waves.mp3' },
    { title: 'Track 2', duration: 40, audio_url: '/uploads/t2.mp3' },
    { title: 'Track 3', duration: 52, audio_url: '/uploads/t3.mp3' },
    { title: 'Track 4', duration: 40, audio_url: '/uploads/t4.mp3' }
  ];

  const started = await radioStore.startStationBroadcast(station.id, {
    forceNow: true,
    slots
  });

  assert.equal(started.broadcastStatus, 'live');
  assert.equal(started.currentSlot.title, 'Волны');
  assert.equal(started.currentSlot.duration, 142);

  // Проверяем живое состояние спустя 53 секунды: текущий слот строго «Волны»!
  const liveAtStart = await radioStore.getStationLiveState(station.id);
  assert.equal(liveAtStart.currentSlot.title, 'Волны', 'Первый трек должен звучать в эфире все 142 секунды');

  // Проверяем скрипты плеера и клиента на наличие защиты от раннего перескока треков
  const playerCode = fs.readFileSync(path.join(__dirname, '../../public/radio-global-player.js'), 'utf8');
  assert.ok(playerCode.includes('diffMs > 1200'), 'Global player must guard against premature ended events when slot has remaining time');
  assert.ok(playerCode.includes('scheduleLiveSync(state.station, diffMs)'), 'Global player must schedule sync at true endTime when audio finishes early');

  const clientCode = fs.readFileSync(path.join(__dirname, '../../public/site/radio-client.js'), 'utf8');
  assert.ok(clientCode.includes('onAirBlockIndex'), 'radio-client must calculate onAirBlockIndex from playhead elapsed time');
  assert.ok(clientCode.includes('is-on-air'), 'radio-client must highlight the exact clip under the playhead with is-on-air during live broadcast');
  assert.ok(playerCode.includes('isTimeshift'), 'Global player must track isTimeshift in state and UI');
  assert.ok(playerCode.includes('goLive'), 'Global player must expose goLive method');

  await radioStore.deleteStation(station.id, 906, true);
});

test('radio-timeshift: live vs timeshift playback, UI badges and goLive synchronization', async () => {
  const playerCode = fs.readFileSync(path.join(__dirname, '../../public/radio-global-player.js'), 'utf8');
  assert.ok(playerCode.includes('goLiveBtn'), 'Global player bar must include goLiveBtn');
  assert.ok(playerCode.includes('CMD_GO_LIVE'), 'Global player broadcast channel must handle CMD_GO_LIVE');
  assert.ok(playerCode.includes('isTimeshift'), 'Global player state must have isTimeshift');
  assert.ok(playerCode.includes('!state.isTimeshift && state.station'), 'Global player resume() must snap to live broadcast when not in timeshift');

  const clientCode = fs.readFileSync(path.join(__dirname, '../../public/site/radio-client.js'), 'utf8');
  assert.ok(clientCode.includes('is-timeshift-playing'), 'radio-client must highlight timeshift playing clips with is-timeshift-playing');
  assert.ok(clientCode.includes('timelineGoLiveBtn'), 'radio-client must support timelineGoLiveBtn to return to on-air stream');
  assert.ok(clientCode.includes('gAudio.goLive()'), 'radio-client must trigger gAudio.goLive() when user clicks go live');
});

test('radio-global-player: strict prohibition of seeking into future and next button guard on all pages', () => {
  const playerCode = fs.readFileSync(path.join(__dirname, '../../public/radio-global-player.js'), 'utf8');
  const cssCode = fs.readFileSync(path.join(__dirname, '../../public/global-styles.css'), 'utf8');
  const radioHtml = fs.readFileSync(path.join(__dirname, '../../public/site/radio.html'), 'utf8');

  // 1. Запрет перемотки вперед в будущее эфира в seek(ratio)
  assert.ok(playerCode.includes('targetTime > liveOffset + 1.2'), 'seek must detect attempt to seek beyond current live offset');
  assert.ok(playerCode.includes('Нельзя перемотать вперед: эта часть трека еще не проиграна в эфире'), 'seek must warn user and prevent seeking into unbroadcasted future');
  assert.ok(playerCode.includes("showToast('Нельзя перемотать вперед: эта часть трека еще не проиграна в эфире', 'warning');\n            return;"), 'seek must ignore click into future and return without disrupting playing audio');

  // 2. Блокировка кнопки Next при прослушивании прямого эфира
  assert.ok(playerCode.includes('Будущие треки станут доступны только после выхода в эфир'), 'playNext must block future track skipping in radio mode');
  assert.ok(playerCode.includes("domBar.nextBtn.disabled = true;"), 'updateBarUI must disable nextBtn when not in timeshift');
  assert.ok(playerCode.includes("domBar.nextBtn.style.opacity = '0.35'"), 'updateBarUI must visually dim disabled nextBtn');

  // 3. Индикатор границы прямого эфира (live edge) на общем прогресс-баре
  assert.ok(playerCode.includes('globalAudioLiveEdge'), 'globalAudioProgressBar must include live edge marker');
  assert.ok(playerCode.includes('domBar.liveEdge.style.left = `${edgePct}%`'), 'updateProgressUI must position live edge marker at live offset');
  assert.ok(cssCode.includes('.alltell-global-live-edge'), 'global-styles.css must style .alltell-global-live-edge');

  // 4. Понятная метка суммарного хронометража ленты в шапке
  assert.ok(radioHtml.includes('Хронометраж:'), 'radio.html must label timeline total duration as Хронометраж instead of confusing Эфир');
});

test('radio-store: eternal loop creation, toggle and preservation against 32-hour cleanup', async () => {
  const { radioDb } = require('../db/connections');

  const freqNormal = 99.41;
  const freqEternal = 99.42;

  const ex1 = await radioStore.getStationByFrequency(freqNormal);
  if (ex1) await radioStore.deleteStation(ex1.id, ex1.owner_id, true);
  const ex2 = await radioStore.getStationByFrequency(freqEternal);
  if (ex2) await radioStore.deleteStation(ex2.id, ex2.owner_id, true);

  // 1. Создаем обычную станцию и станцию с вечным зацикленным эфиром
  const normalStation = await radioStore.createStation({
    frequency: freqNormal,
    name: 'Normal Station',
    ownerId: 901,
    ownerName: 'Tester',
    fallbackMode: 'loop',
    isEternal: 0
  });

  const eternalStation = await radioStore.createStation({
    frequency: freqEternal,
    name: 'Eternal Station',
    ownerId: 901,
    ownerName: 'Tester',
    fallbackMode: 'loop',
    isEternal: 1
  });

  assert.equal(normalStation.is_eternal, 0, 'Normal station is_eternal must be 0');
  assert.equal(eternalStation.is_eternal, 1, 'Eternal station is_eternal must be 1');

  // 2. Вставляем слоты старше 35 часов (имитируем прошедший эфир)
  const oldStart = new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString();
  const oldEnd = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();

  await new Promise((resolve, reject) => {
    radioDb.run(
      `INSERT INTO radio_timeline_slots (station_id, slot_order, title, type, audio_url, duration, start_time, end_time)
       VALUES (?, 0, 'Old Normal Track', 'track', '/uploads/old_norm.mp3', 3600, ?, ?)`,
      [normalStation.id, oldStart, oldEnd],
      (err) => (err ? reject(err) : resolve())
    );
  });

  await new Promise((resolve, reject) => {
    radioDb.run(
      `INSERT INTO radio_timeline_slots (station_id, slot_order, title, type, audio_url, duration, start_time, end_time)
       VALUES (?, 0, 'Old Eternal Track', 'track', '/uploads/old_etern.mp3', 3600, ?, ?)`,
      [eternalStation.id, oldStart, oldEnd],
      (err) => (err ? reject(err) : resolve())
    );
  });

  // 3. Запускаем cleanupOldTimelineSlots
  const deletedCount = await radioStore.cleanupOldTimelineSlots();
  assert.ok(deletedCount >= 1, 'Cleanup must delete at least 1 slot from non-eternal station');

  // 4. Проверяем, что слот обычной станции удален, а вечной — сохранен
  const normalSlots = await radioStore.getTimelineSlots(normalStation.id);
  const eternalSlots = await radioStore.getTimelineSlots(eternalStation.id);

  assert.equal(normalSlots.length, 0, 'Слоты обычной станции старше 32 часов должны быть удалены');
  assert.equal(eternalSlots.length, 1, 'Слоты вечной радиостанции НЕ должны удаляться через 32 часа');
  assert.equal(eternalSlots[0].title, 'Old Eternal Track');

  // 5. Выключаем вечный эфир у eternalStation и проверяем, что теперь очистка сработает
  await radioStore.updateStation(eternalStation.id, 901, true, { isEternal: 0 });
  const updatedEternalSt = await radioStore.getStationById(eternalStation.id);
  assert.equal(updatedEternalSt.is_eternal, 0, 'is_eternal должен стать 0 после обновления');

  const secondCleanup = await radioStore.cleanupOldTimelineSlots();
  assert.ok(secondCleanup >= 1, 'После отключения вечного режима устаревшие слоты должны очищаться');

  const eternalSlotsAfter = await radioStore.getTimelineSlots(eternalStation.id);
  assert.equal(eternalSlotsAfter.length, 0, 'После отключения вечного режима слот должен быть удален');

  await radioStore.deleteStation(normalStation.id, 901, true);
  await radioStore.deleteStation(eternalStation.id, 901, true);
});

test('radio-store: live state and timeline projection for eternal looped broadcast', async () => {
  const freq = 99.43;
  const existing = await radioStore.getStationByFrequency(freq);
  if (existing) await radioStore.deleteStation(existing.id, existing.owner_id, true);

  const station = await radioStore.createStation({
    frequency: freq,
    name: 'Endless Echo FM',
    ownerId: 902,
    ownerName: 'EchoHost',
    isEternal: 1
  });

  assert.equal(station.is_eternal, 1);
  assert.equal(station.fallback_mode, 'loop');

  // Эфир запущен 48 часов назад (3 трека по 100 секунд, общий цикл 300 секунд)
  const now = radioStore.getEffectiveNow().getTime();
  const startTime = new Date(now - 48 * 3600 * 1000).toISOString();

  await radioStore.setTimelineSlots(station.id, [
    { title: 'Eternal Ambient 1', duration: 100, audio_url: '/uploads/e1.mp3', type: 'track' },
    { title: 'Eternal Ambient 2', duration: 100, audio_url: '/uploads/e2.mp3', type: 'track' },
    { title: 'Eternal Ambient 3', duration: 100, audio_url: '/uploads/e3.mp3', type: 'track' }
  ], startTime, { status: 'live' });

  // Проверяем состояние эфира: станция вещает бесконечно
  const liveState = await radioStore.getStationLiveState(station.id);
  assert.ok(liveState.isLive, 'Вечный эфир должен оставаться активным');
  assert.equal(liveState.isEternal, true, 'isEternal флаг должен быть true');
  assert.ok(liveState.isVirtualLoop, 'Эфир должен виртуально зацикливаться');
  assert.ok(liveState.currentSlot, 'Должен быть активный играющий слот');

  const curStart = new Date(liveState.currentSlot.startTime).getTime();
  const curEnd = new Date(liveState.currentSlot.endTime).getTime();
  assert.ok(curStart <= now + 1000, 'Метка старта должна быть спроецирована на текущий цикл');
  assert.ok(curEnd > now, 'Метка окончания должна быть в будущем текущего цикла');

  // Проверяем, что listStations() показывает станцию как живую (live)
  const allSt = await radioStore.listStations();
  const found = allSt.find(s => s.id === station.id);
  assert.ok(found, 'Станция должна присутствовать в списке');
  assert.ok(found.isLive, 'Станция с вечным эфиром должна определяться как Live в списке станций');
  assert.ok(found.currentTrack, 'У вечной станции должен быть определен currentTrack');

  await radioStore.deleteStation(station.id, 902, true);
});

test('radio-editor-ui: eternal broadcast button, badge, and modal elements exist', () => {
  const radioHtml = fs.readFileSync(path.join(__dirname, '../../public/site/radio.html'), 'utf8');
  const radioClient = fs.readFileSync(path.join(__dirname, '../../public/site/radio-client.js'), 'utf8');
  const radioCss = fs.readFileSync(path.join(__dirname, '../../public/site/radio.css'), 'utf8');

  // 1. Проверяем кнопку и бейдж в radio.html
  assert.ok(radioHtml.includes('btnToggleEternalBroadcast'), 'radio.html must contain btnToggleEternalBroadcast');
  assert.ok(radioHtml.includes('eternalBroadcastBtnText'), 'radio.html must contain eternalBroadcastBtnText');
  assert.ok(radioHtml.includes('editorEternalBadge'), 'radio.html must contain editorEternalBadge');
  assert.ok(radioHtml.includes('editStationIsEternal'), 'modalEditStation must have editStationIsEternal checkbox');
  assert.ok(radioHtml.includes('createStationIsEternal'), 'modalCreateStation must have createStationIsEternal checkbox');

  // 2. Проверяем клиентскую логику в radio-client.js
  assert.ok(radioClient.includes('quickUpdateEternalMode'), 'radio-client must implement quickUpdateEternalMode');
  assert.ok(radioClient.includes('btnToggleEternalBroadcast'), 'radio-client must bind click on btnToggleEternalBroadcast');
  assert.ok(radioClient.includes('editorEternalBadge'), 'radio-client must update editorEternalBadge visibility');
  assert.ok(radioClient.includes('editStationIsEternal'), 'radio-client must sync editStationIsEternal checkbox');
  assert.ok(radioClient.includes('createStationIsEternal'), 'radio-client must handle createStationIsEternal checkbox');

  // 3. Проверяем стили в radio.css
  assert.ok(radioCss.includes('.radio-eternal-badge'), 'radio.css must style .radio-eternal-badge');
  assert.ok(radioCss.includes('#btnToggleEternalBroadcast'), 'radio.css must style #btnToggleEternalBroadcast');
});




