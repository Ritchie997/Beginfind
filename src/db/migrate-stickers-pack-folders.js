// migrate-stickers-pack-folders.js — идемпотентная миграция файлов стикеров
// из плоской общей папки uploads/stickers/ в подпапки по ID набора
// (uploads/stickers/<packId>/<filename>).
//
// Раньше все файлы всех наборов лежали в одной папке, различаясь только
// уникальным по времени именем (sticker-<timestamp>-<rand>.ext, см.
// src/uploads/multer-config.js) — физически безопасно (коллизий имён не
// было), но неудобно разбирать руками и не даёт наборам с одинаковым
// названием (slug с суффиксом -2, -3…) выглядеть как отдельные сущности на
// диске. Новые загрузки (см. multer-config.js/stickers.routes.js) сразу
// пишутся в свою папку набора — эта миграция один раз переносит то, что уже
// было загружено раньше.
//
// Идемпотентно: строка stickers.file_url вида /uploads/stickers/<packId>/...
// (уже перенесённая) пропускается, поэтому безопасно вызывать при каждом
// старте сервера (см. src/db/connections.js), как и ensureUserSchema в
// migrate-users-schema.js.

const fs = require('fs');
const path = require('path');
const { STICKERS_DIR } = require('../config/paths');

// Старый плоский путь: ровно один сегмент после /uploads/stickers/, без
// собственной подпапки набора.
const FLAT_PATH_RE = /^\/uploads\/stickers\/([^/]+)$/;

function all(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function run(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { (err ? reject(err) : resolve(this)); });
  });
}

async function migrateStickerFilesToPackFolders(db) {
  const rows = await all(db, 'SELECT id, pack_id, file_url FROM stickers', []);
  for (const row of rows) {
    const match = FLAT_PATH_RE.exec(String(row.file_url || ''));
    if (!match) continue; // уже в своей папке (или путь неожиданной формы) — не трогаем

    const filename = match[1];
    const oldPath = path.join(STICKERS_DIR, filename);
    const packDir = path.join(STICKERS_DIR, String(row.pack_id));
    const newPath = path.join(packDir, filename);
    const newUrl = `/uploads/stickers/${row.pack_id}/${filename}`;

    try {
      if (fs.existsSync(oldPath)) {
        fs.mkdirSync(packDir, { recursive: true });
        fs.renameSync(oldPath, newPath);
      }
      // Даже если файла на диске уже не было (удалили руками и т.п.) — всё
      // равно чиним URL в БД, чтобы он указывал в правильную (новую) схему
      // путей и будущий unlink не искал файл по устаревшему плоскому пути.
      await run(db, 'UPDATE stickers SET file_url = ? WHERE id = ?', [newUrl, row.id]);
    } catch (err) {
      console.error(`Не удалось перенести файл стикера #${row.id} (набор #${row.pack_id}) в папку набора:`, err);
    }
  }
}

module.exports = { migrateStickerFilesToPackFolders };
