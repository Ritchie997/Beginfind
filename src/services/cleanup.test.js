const test = require('node:test');
const assert = require('node:assert/strict');
const cleanup = require('./cleanup');
const { serversDb, serversSchemaReady, socialDb } = require('../db/connections');

test('extractFlatUploadName extracts flat upload filenames correctly', () => {
  assert.equal(cleanup.extractFlatUploadName('/uploads/image-1.png'), 'image-1.png');
  assert.equal(cleanup.extractFlatUploadName('uploads/image-2.jpg'), 'image-2.jpg');
  assert.equal(cleanup.extractFlatUploadName('/uploads/image-3.webp?v=123'), 'image-3.webp');
  assert.equal(cleanup.extractFlatUploadName('http://localhost:3000/uploads/image-4.gif'), 'image-4.gif');
  assert.equal(cleanup.extractFlatUploadName('/uploads/stickers/5/s.png'), null);
  assert.equal(cleanup.extractFlatUploadName('/uploads/maps/m1/b1/1/2.webp'), null);
  assert.equal(cleanup.extractFlatUploadName('/uploads/gallery/1/g.png'), null);
  assert.equal(cleanup.extractFlatUploadName('/uploads/avatar/1.png'), null);
  assert.equal(cleanup.extractFlatUploadName(''), null);
  assert.equal(cleanup.extractFlatUploadName(null), null);
});

test('extractFlatUploadNamesFromText extracts flat upload names from arbitrary text', () => {
  const text = `
    Here is an image: ![preview](/uploads/test-img1.png)
    And another one: <img src="/uploads/test-img2.jpg?v=1">
    And sticker: /uploads/stickers/1/stk.png
    And map: /uploads/maps/m/1/2.webp
    And plain link: uploads/test-img3.webp
  `;
  const names = cleanup.extractFlatUploadNamesFromText(text);
  assert.deepEqual(names.sort(), ['test-img1.png', 'test-img2.jpg', 'test-img3.webp'].sort());
});

test('collectUsedUploadNames collects AllTell avatars, hubs, posts and comments', async () => {
  await serversSchemaReady;

  // Insert temporary test records in serversDb
  const testServerAvatar = 'alltell-test-server-avatar.png';
  const testHubAvatar = 'alltell-test-hub-avatar.png';
  const testPostMain = 'alltell-test-post-main.png';
  const testPostExtra = 'alltell-test-post-extra.png';
  const testPostBody = 'alltell-test-post-body.png';
  const testCommentImg = 'alltell-test-comment-img.png';
  const testPostAudio = 'alltell-test-audio1.mp3';
  const testPostAudioExtra = 'alltell-test-audio2.flac';

  const run = (db, sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (err) { err ? rej(err) : res(this); }));

  let serverId;
  let hubId;
  let postId;
  let commentId;

  try {
    const sRes = await run(serversDb, 'INSERT INTO servers (name, description, owner_id, avatar_url) VALUES (?, ?, ?, ?)', [
      'Test Cleanup Server',
      'Test server desc',
      1,
      `/uploads/${testServerAvatar}`
    ]);
    serverId = sRes.lastID;

    const hRes = await run(serversDb, 'INSERT INTO franchise_hubs (server_id, name, avatar_url, created_by, created_by_name) VALUES (?, ?, ?, ?, ?)', [
      serverId,
      'Test Cleanup Hub',
      `/uploads/${testHubAvatar}`,
      1,
      'Owner'
    ]);
    hubId = hRes.lastID;

    const pRes = await run(serversDb, 'INSERT INTO franchise_posts (server_id, hub_id, type, title, body, image_url, image_urls, audio_url, audio_tracks, created_by, created_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      serverId,
      hubId,
      'news',
      'Test News Post',
      `Check this post image: /uploads/${testPostBody}`,
      `/uploads/${testPostMain}`,
      JSON.stringify([`/uploads/${testPostMain}`, `/uploads/${testPostExtra}`]),
      `/uploads/${testPostAudio}`,
      JSON.stringify([{ url: `/uploads/${testPostAudioExtra}`, title: 'Extra FLAC track' }]),
      1,
      'Owner'
    ]);
    postId = pRes.lastID;

    const cRes = await run(socialDb, 'INSERT INTO franchise_post_comments (user_id, author_name, post_id, content) VALUES (?, ?, ?, ?)', [
      1,
      'Owner',
      postId,
      `Nice post: /uploads/${testCommentImg}`
    ]);
    commentId = cRes.lastID;

    const used = await cleanup.collectUsedUploadNames();

    assert.ok(used.has(testServerAvatar), 'Server avatar should be collected');
    assert.ok(used.has(testHubAvatar), 'Hub avatar should be collected');
    assert.ok(used.has(testPostMain), 'Post main image should be collected');
    assert.ok(used.has(testPostExtra), 'Post extra image should be collected');
    assert.ok(used.has(testPostBody), 'Post body image should be collected');
    assert.ok(used.has(testPostAudio), 'Post audio_url should be collected');
    assert.ok(used.has(testPostAudioExtra), 'Post audio_tracks should be collected');
    assert.ok(used.has(testCommentImg), 'Franchise comment image should be collected');
  } finally {
    if (commentId) await run(socialDb, 'DELETE FROM franchise_post_comments WHERE id = ?', [commentId]);
    if (postId) await run(serversDb, 'DELETE FROM franchise_posts WHERE id = ?', [postId]);
    if (hubId) await run(serversDb, 'DELETE FROM franchise_hubs WHERE id = ?', [hubId]);
    if (serverId) await run(serversDb, 'DELETE FROM servers WHERE id = ?', [serverId]);
  }
});
