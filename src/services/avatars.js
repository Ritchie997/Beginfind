// avatars.js — аватарки профилей: файлы public/uploads/avatar/<userId>.<ext>
// (раздаются статикой как /uploads/avatar/*, см. server.js). Отдельного
// столбца в users.db нет — источник правды сама папка: имя файла = id
// пользователя. Чтобы не ходить на диск на каждый комментарий/карточку,
// держим индекс id → URL в памяти и пересобираем его не чаще раза в
// INDEX_TTL_MS (подхватывает и восстановление из бэкапа, которое пишет
// файлы мимо этого модуля).
//
// В URL добавляется ?v=<mtime>: имя файла при замене аватарки не меняется,
// и без этого браузер показывал бы старую картинку из кэша.

const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR } = require('../config/paths');

const AVATAR_DIR = path.join(UPLOADS_DIR, 'avatar');
const AVATAR_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const FILE_RE = /^([1-9][0-9]*)(\.(?:jpg|jpeg|png|gif|webp))$/i;
const INDEX_TTL_MS = 60 * 1000;

if (!fs.existsSync(AVATAR_DIR)) {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
}

let index = new Map();
let indexBuiltAt = 0;

function rebuildIndex() {
  const next = new Map();
  try {
    for (const name of fs.readdirSync(AVATAR_DIR)) {
      const m = name.match(FILE_RE);
      if (!m) continue;
      try {
        const stat = fs.statSync(path.join(AVATAR_DIR, name));
        if (!stat.isFile()) continue;
        next.set(Number(m[1]), `/uploads/avatar/${name}?v=${Math.floor(stat.mtimeMs)}`);
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
  return index.get(id) || null;
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

module.exports = { AVATAR_DIR, getAvatarUrl, setAvatarFromFile, removeAvatar };
