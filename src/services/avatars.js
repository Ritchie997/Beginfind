// avatars.js — оригиналы профилей в public/uploads/avatar/<userId>.<ext>.
// Миниатюры WebP строятся по запросу во временном каталоге; GIF остаются
// оригиналами. Отдельного столбца в users.db нет — имя оригинала = id
// пользователя. Индекс id → URL пересобирается не чаще раза в INDEX_TTL_MS
// и подхватывает файлы, восстановленные из бэкапа.
//
// В URL добавляется ?v=<mtime>: имя файла при замене аватарки не меняется,
// и без этого браузер показывал бы старую картинку из кэша.

const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const { UPLOADS_DIR } = require('../config/paths');

const AVATAR_DIR = path.join(UPLOADS_DIR, 'avatar');
const THUMBNAIL_DIR = path.join(os.tmpdir(), 'alltell-avatar-thumbnails');
const AVATAR_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const FILE_RE = /^([1-9][0-9]*)(\.(?:jpg|jpeg|png|gif|webp))$/i;
const THUMBNAIL_SIZES = [104, 208, 312];
const INDEX_TTL_MS = 60 * 1000;

if (!fs.existsSync(AVATAR_DIR)) {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
}

let index = new Map();
let indexBuiltAt = 0;
const thumbnailJobs = new Map();

function rebuildIndex() {
  const next = new Map();
  try {
    for (const name of fs.readdirSync(AVATAR_DIR)) {
      const m = name.match(FILE_RE);
      if (!m) continue;
      try {
        const stat = fs.statSync(path.join(AVATAR_DIR, name));
        if (!stat.isFile()) continue;
        next.set(Number(m[1]), {
          fileName: name,
          modifiedAt: Math.floor(stat.mtimeMs),
          url: `/uploads/avatar/${m[1]}/104.webp?v=${Math.floor(stat.mtimeMs)}`
        });
      } catch (e) { /* файл удалили между readdir и stat */ }
    }
  } catch (e) {
    console.error('[Avatars] Не удалось прочитать папку аватарок:', e.message);
  }
  index = next;
  indexBuiltAt = Date.now();
}

function getAvatarUrl(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (Date.now() - indexBuiltAt > INDEX_TTL_MS) rebuildIndex();
  const avatar = index.get(id);
  if (!avatar) return null;
  if (path.extname(avatar.fileName).toLowerCase() === '.gif') {
    return `/uploads/avatar/${avatar.fileName}?v=${avatar.modifiedAt}`;
  }
  return avatar.url;
}

async function getThumbnailPath(userId, size, version) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0 || !THUMBNAIL_SIZES.includes(Number(size))) {
    throw Object.assign(new Error('Некорректный размер аватарки'), { status: 400 });
  }
  if (Date.now() - indexBuiltAt > INDEX_TTL_MS) rebuildIndex();
  const avatar = index.get(id);
  if (!avatar || path.extname(avatar.fileName).toLowerCase() === '.gif') {
    throw Object.assign(new Error('Аватарка не найдена'), { status: 404 });
  }
  if (!version || String(avatar.modifiedAt) !== String(version)) {
    throw Object.assign(new Error('Аватарка была обновлена'), { status: 404 });
  }

  const thumbnailName = `${id}-${avatar.modifiedAt}-${size}.webp`;
  const thumbnailPath = path.join(THUMBNAIL_DIR, thumbnailName);
  try {
    await fs.promises.access(thumbnailPath);
    return thumbnailPath;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const jobKey = thumbnailPath;
  if (!thumbnailJobs.has(jobKey)) {
    const job = (async () => {
      await fs.promises.mkdir(THUMBNAIL_DIR, { recursive: true });
      const sourcePath = path.join(AVATAR_DIR, avatar.fileName);
      const temporaryPath = `${thumbnailPath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await sharp(sourcePath)
          .resize(size, size, {
            fit: 'cover',
            position: 'centre',
            kernel: sharp.kernel.lanczos3
          })
          .sharpen({ sigma: 0.5 })
          .webp({ quality: 94, effort: 6, alphaQuality: 100 })
          .toFile(temporaryPath);
        await fs.promises.rename(temporaryPath, thumbnailPath);
      } finally {
        try { await fs.promises.unlink(temporaryPath); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    })();
    thumbnailJobs.set(jobKey, job);
    job.finally(() => thumbnailJobs.delete(jobKey)).catch(() => {});
  }
  await thumbnailJobs.get(jobKey);
  return thumbnailPath;
}

function removeFilesFor(userId, exceptName) {
  for (const ext of AVATAR_EXTENSIONS) {
    const name = `${userId}${ext}`;
    if (name === exceptName) continue;
    const p = path.join(AVATAR_DIR, name);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* не критично */ }
  }
}

// tmpPath — файл, уже сохранённый multer'ом во временное имя в AVATAR_DIR.
function setAvatarFromFile(userId, tmpPath, ext) {
  const id = Number(userId);
  const finalName = `${id}${ext.toLowerCase()}`;
  // Старая аватарка могла быть с другим расширением — убираем, иначе у
  // пользователя оказалось бы два файла и индекс выбрал бы случайный.
  removeFilesFor(id, finalName);
  const finalPath = path.join(AVATAR_DIR, finalName);
  try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch (e) { /* перезапишем ниже */ }
  fs.renameSync(tmpPath, finalPath);
  rebuildIndex();
  return getAvatarUrl(id);
}

function removeAvatar(userId) {
  removeFilesFor(Number(userId));
  rebuildIndex();
}

module.exports = {
  AVATAR_DIR,
  getAvatarUrl,
  getThumbnailPath,
  THUMBNAIL_SIZES,
  setAvatarFromFile,
  removeAvatar
};
