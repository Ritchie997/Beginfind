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
