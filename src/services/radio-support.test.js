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
