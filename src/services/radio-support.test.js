const test = require('node:test');
const assert = require('node:assert/strict');
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

