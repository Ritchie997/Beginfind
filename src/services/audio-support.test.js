const test = require('node:test');
const assert = require('node:assert/strict');
const blocks = require('./blocks');
const { RESTORABLE_UPLOAD_EXTENSIONS } = require('./backup');

test('audio block: BLOCK_TYPES and extensions supported', () => {
  assert.ok(blocks.BLOCK_TYPES.includes('audio'), 'BLOCK_TYPES must include audio');

  const supported = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm', 'wma'];
  for (const ext of supported) {
    assert.ok(blocks.AUDIO_EXT_RE.test(`track.${ext}`), `AUDIO_EXT_RE must match .${ext}`);
    assert.ok(blocks.AUDIO_EXT_RE.test(`track.${ext.toUpperCase()}`), `AUDIO_EXT_RE must match .${ext.toUpperCase()}`);
    assert.ok(RESTORABLE_UPLOAD_EXTENSIONS.has(`.${ext}`), `RESTORABLE_UPLOAD_EXTENSIONS must include .${ext}`);
  }
});

test('audio block: sanitization, normalization, text search and media collection', () => {
  const safePath = '/uploads/audio-123456789.mp3';
  assert.equal(blocks.sanitizeAudioPath(safePath), safePath);
  assert.equal(blocks.sanitizeAudioPath('https://example.com/stream.ogg'), 'https://example.com/stream.ogg');
  assert.equal(blocks.sanitizeAudioPath('javascript:alert(1)'), '');
  assert.equal(blocks.sanitizeAudioPath('/uploads/malicious.exe'), '');

  const rawData = {
    src: '/uploads/theme.flac',
    title: 'Main Theme',
    artist: 'Composer Name',
    duration: 180,
    size: 25000000,
    format: 'flac',
    extraGarbage: 'discard-me'
  };

  const blockObj = blocks.normalizeBlock({ id: 'b1', type: 'audio', data: rawData });
  assert.equal(blockObj.type, 'audio');
  assert.equal(blockObj.data.src, '/uploads/theme.flac');
  assert.equal(blockObj.data.title, 'Main Theme');
  assert.equal(blockObj.data.artist, 'Composer Name');
  assert.equal(blockObj.data.size, 25000000);
  assert.equal(blockObj.data.format, 'flac');
  assert.equal(blockObj.data.extraGarbage, undefined);

  const text = blocks.documentSearchText({ blocks: [blockObj] });
  assert.ok(text.includes('Main Theme'));
  assert.ok(text.includes('Composer Name'));

  const doc = { blocks: [blockObj] };
  const paths = blocks.collectImagePaths(doc);
  assert.ok(paths.includes('/uploads/theme.flac'));

  const mapped = blocks.mapImages(doc, (src) => src.replace('/uploads/', '/cdn/'));
  assert.equal(mapped.blocks[0].data.src, '/cdn/theme.flac');
});

test('cleanup & backup: all audio extensions are recognized and protected', () => {
  const { ALLOWED_AUDIO_EXTENSIONS } = require('../uploads/multer-config');
  for (const ext of ALLOWED_AUDIO_EXTENSIONS) {
    assert.ok(RESTORABLE_UPLOAD_EXTENSIONS.has(ext), `RESTORABLE_UPLOAD_EXTENSIONS must include ${ext}`);
    assert.ok(blocks.AUDIO_EXT_RE.test(`track${ext}`), `AUDIO_EXT_RE must recognize ${ext}`);
  }
});

test('editor-blocks: audio label and createBlock structure', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const editorBlocksContent = fs.readFileSync(path.join(__dirname, '../../public/editor-blocks.js'), 'utf8');
  assert.ok(editorBlocksContent.includes("audio: 'Аудио'"), "TYPE_LABELS must include audio: 'Аудио'");
  assert.ok(editorBlocksContent.includes("block.type === 'audio'"), "createBlock must handle block.type === 'audio'");
});

test('audio-converter: mp3 files are preserved without re-encoding', async () => {
  const { convertToMp3 } = require('./audio-converter');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');

  const tmpMp3 = path.join(os.tmpdir(), `test-audio-${Date.now()}.mp3`);
  fs.writeFileSync(tmpMp3, Buffer.from('FAKE_MP3_DATA'));

  try {
    const res = await convertToMp3(tmpMp3);
    assert.equal(res.converted, false, 'mp3 must not be re-encoded');
    assert.equal(res.format, 'mp3');
    assert.equal(res.outputPath, tmpMp3);
    assert.ok(fs.existsSync(tmpMp3));
  } finally {
    if (fs.existsSync(tmpMp3)) fs.unlinkSync(tmpMp3);
  }
});

test('radio-store: createTrack auto-converts wav in uploads to mp3', async () => {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const { UPLOADS_DIR } = require('../config/paths');
  const radioStore = require('./radio-store');

  const testWavName = `test-convert-${Date.now()}.wav`;
  const testWavPath = path.join(UPLOADS_DIR, testWavName);

  // Генерируем 0.5 сек синусоиды в wav через ffmpeg
  spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', testWavPath]);
  assert.ok(fs.existsSync(testWavPath), 'Wav file should be created');

  try {
    const track = await radioStore.createTrack({
      userId: 999,
      authorName: 'Tester',
      title: 'WAV Test Track',
      audioUrl: `/uploads/${testWavName}`,
      duration: 1,
      size: fs.statSync(testWavPath).size,
      format: 'wav',
      type: 'track'
    });

    assert.equal(track.format, 'mp3', 'Track format must be converted to mp3 in DB');
    assert.ok(track.audio_url.endsWith('.mp3'), 'Track URL must end with .mp3');
    assert.equal(fs.existsSync(testWavPath), false, 'Original wav file must be deleted');

    const mp3Path = path.join(UPLOADS_DIR, path.basename(track.audio_url));
    assert.ok(fs.existsSync(mp3Path), 'Converted mp3 file must exist on disk');

    // Чистим за собой
    if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
    await radioStore.deleteTrack(track.id, 999, true);
  } finally {
    if (fs.existsSync(testWavPath)) fs.unlinkSync(testWavPath);
  }
});

test('posts and articles: audio attachments are verified and converted to mp3', async () => {
  const { convertToMp3 } = require('./audio-converter');
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const { UPLOADS_DIR } = require('../config/paths');

  const testWavName = `test-post-audio-${Date.now()}.wav`;
  const testWavPath = path.join(UPLOADS_DIR, testWavName);

  spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=520:duration=0.4', testWavPath]);
  assert.ok(fs.existsSync(testWavPath));

  try {
    const conv = await convertToMp3(testWavPath);
    assert.equal(conv.converted, true);
    assert.equal(conv.format, 'mp3');
    assert.ok(conv.filename.endsWith('.mp3'));
    assert.equal(fs.existsSync(testWavPath), false, 'Original non-mp3 must be unlinked');
    assert.ok(fs.existsSync(conv.outputPath), 'Converted mp3 must exist');

    if (fs.existsSync(conv.outputPath)) fs.unlinkSync(conv.outputPath);
  } finally {
    if (fs.existsSync(testWavPath)) fs.unlinkSync(testWavPath);
  }
});

test('audio title: decodeOriginalName repairs Cyrillic filenames and block normalization handles mojibake', () => {
  const { decodeOriginalName } = require('./audio-converter');

  // 1. Проверяем восстановление кириллицы, поврежденной latin1 перекодировкой multer/busboy
  const originalCyrillic = 'Виктор Цой - Звезда по имени Солнце (Remaster 2026).mp3';
  const multerCorrupted = Buffer.from(originalCyrillic, 'utf8').toString('latin1');
  assert.equal(decodeOriginalName(multerCorrupted), originalCyrillic);

  // 2. Проверяем восстановление mojibake Windows-1252
  assert.equal(decodeOriginalName('ÐœÐ¾Ð¹ Ñ‚Ñ€ÐµÐº (2026)'), 'Мой трек (2026)');

  // 3. Чистый русский текст и чистый английский текст не должны изменяться
  assert.equal(decodeOriginalName('Чистый трек.mp3'), 'Чистый трек.mp3');
  assert.equal(decodeOriginalName('Track 01 - Rock Anthem.flac'), 'Track 01 - Rock Anthem.flac');

  // 4. Проверяем авто-восстановление в модели блоков Antropedia (blocks.js normalizeBlock)
  const blockWithBrokenTitle = blocks.normalizeBlock({
    id: 'b-audio',
    type: 'audio',
    data: {
      src: '/uploads/audio-test.mp3',
      title: multerCorrupted.replace('.mp3', ''),
      artist: Buffer.from('Кино', 'utf8').toString('latin1')
    }
  });

  assert.equal(blockWithBrokenTitle.data.title, 'Виктор Цой - Звезда по имени Солнце (Remaster 2026)');
  assert.equal(blockWithBrokenTitle.data.artist, 'Кино');
});
