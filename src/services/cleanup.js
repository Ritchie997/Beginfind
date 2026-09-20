// cleanup.js — автоматическая утилизация серверного мусора: три независимые
// категории, каждая со своим "мусором" и своим способом решить, что именно
// можно безвозвратно удалить (см. настройки в cleanup-settings.js, вкладка
// "Настройки" → "Очистка мусора", доступна только владельцу —
// src/routes/cleanup.routes.js).
//
// Категории:
//   trash    — статьи, уже перемещённые в content/.trash/ явным удалением
//              (см. articles-store.js::deleteArticle), но старше
//              trashRetentionDays — это то же самое, что "очистить корзину".
//   uploads  — файлы в public/uploads/ (плоская папка, БЕЗ uploads/stickers/),
//              на которые не ссылается ни одна статья (обложка/тело/
//              attachments), ни одно сообщение мессенджера, ни один
//              комментарий — и не моложе minOrphanAgeHours (грейс-период,
//              чтобы не снести картинку, которую только что загрузили в
//              редакторе, но статью с ней ещё не сохранили).
//   stickers — файлы внутри public/uploads/stickers/<packId>/, на которые
//              не ссылается ни одна запись в таблице stickers для этого
//              набора (типичная причина — addSticker() упал ПОСЛЕ того, как
//              multer уже записал файл на диск: неверный alias, дубликат,
//              превышен лимit MAX_STICKERS_PER_PACK и т.п.), а также целиком
//              папки, чей packId не существует в sticker_packs (набор
//              удалили, а саму папку по какой-то причине не снесли — см.
//              deletePack в stickers-store.js). Тот же minOrphanAgeHours.
//
// Ничего не решает САМО по расписанию — этим занимается initializeAutoCleanup
// в src/server.js (тот же приём, что и автобэкап: cron проверяет раз в
// несколько минут, не пора ли запустить, по cleanup-settings.json).

const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR, STICKERS_DIR } = require('../config/paths');
const { messengerDb, socialDb, stickersDb } = require('../db/connections');
const articlesStore = require('./articles-store');

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (e) {
    return null;
  }
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (e) {
    console.error(`[Cleanup] Не удалось удалить файл ${filePath}:`, e.message);
    return false;
  }
}

// ===== Категория 1: старая корзина статей =====

// Имя файла в корзине — "<slug>.<timestampMs>.json" (см. deleteArticle) —
// момент удаления читаем прямо из имени, а не из mtime файла: mtime это то
// же самое (rename не трогает содержимое), но имя надёжнее переживает
// перенос/восстановление из бэкапа, где mtime сбрасывается на время записи.
const TRASH_NAME_RE = /^(.+)\.(\d{10,})\.json$/;

function findOldTrashedArticles(retentionDays) {
  const dir = articlesStore.TRASH_DIR;
  if (!fs.existsSync(dir)) return [];

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const items = [];

  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(dir, name);
    const stat = safeStat(filePath);
    if (!stat) continue;

    const m = TRASH_NAME_RE.exec(name);
    const deletedAtMs = m ? parseInt(m[2], 10) : stat.mtimeMs;
    if (deletedAtMs > cutoff) continue;

    items.push({
      category: 'trash',
      name,
      path: filePath,
      slug: m ? m[1] : name.replace(/\.json$/, ''),
      size: stat.size,
      deletedAt: new Date(deletedAtMs).toISOString()
    });
  }
  return items;
}

// ===== Категория 2: файлы-сироты в public/uploads/ =====

// Ровно один сегмент после /uploads/ (без "?", "#" и без вложенных "/") —
// то есть путь именно в плоскую папку uploads, а не в uploads/stickers/<id>/…
// (стикеры — отдельная категория со своей логикой, см. ниже).
function extractFlatUploadName(url) {
  if (!url) return null;
  const m = String(url).match(/\/uploads\/([^\/?#\s"'<>]+)(?:[?#]|$)/);
  return m ? m[1] : null;
}

// То же самое, но ищет ВСЕ вхождения внутри произвольного текста (markdown
// сообщения/комментария), а не разбирает одно готовое поле-ссылку.
const UPLOAD_REF_RE = /\/uploads\/([^\s"'()<>]+)/g;
function extractFlatUploadNamesFromText(text) {
  if (!text) return [];
  const out = [];
  UPLOAD_REF_RE.lastIndex = 0;
  let m;
  while ((m = UPLOAD_REF_RE.exec(String(text)))) {
    const seg = m[1].split(/[?#]/)[0];
    if (seg && !seg.includes('/')) out.push(seg); // "stickers/42/x.png" отбрасываем — не эта категория
  }
  return out;
}

// Собирает имена файлов из public/uploads/, на которые ссылается хоть
// что-то в системе: статьи, включая лежащие в корзине (обложка + attachments + картинки/инфобоксы в
// теле, включая вложенные columns/spoiler-section — см.
// blocks.collectImagePaths), сообщения мессенджера, комментарии статей.
async function collectUsedUploadNames() {
  const used = new Set();
  const add = (url) => {
    const name = extractFlatUploadName(url);
    if (name) used.add(name);
  };

  // Статьи из корзины тоже считаются: пока они не удалены безвозвратно
  // (trashRetentionDays), их можно вернуть — а без картинок возвращать нечего.
  for (const article of [...articlesStore.listArticles(), ...articlesStore.listTrashedArticles()]) {
    add(article.image);
    (article.attachments || []).forEach((a) => add(typeof a === 'string' ? a : a && a.url));
    articlesStore.blocks.collectImagePaths(article.content).forEach(add);
  }

  const messages = await dbAll(messengerDb, 'SELECT content FROM messages', []);
  messages.forEach((r) => extractFlatUploadNamesFromText(r.content).forEach((n) => used.add(n)));

  const comments = await dbAll(socialDb, 'SELECT content FROM article_comments', []);
  comments.forEach((r) => extractFlatUploadNamesFromText(r.content).forEach((n) => used.add(n)));

  return used;
}

async function findOrphanUploads(minOrphanAgeHours) {
  if (!fs.existsSync(UPLOADS_DIR)) return [];

  const used = await collectUsedUploadNames();
  const cutoff = Date.now() - minOrphanAgeHours * 60 * 60 * 1000;
  const items = [];

  for (const entry of fs.readdirSync(UPLOADS_DIR, { withFileTypes: true })) {
    // withFileTypes пропускает саму подпапку stickers/ (это directory, не
    // file) — она под своей категорией (findOrphanStickerFiles).
    if (!entry.isFile()) continue;
    // Служебные файлы (.gitkeep и т.п.) — не "загрузка", которую можно
    // счесть неиспользуемой, а разметка самой папки для git.
    if (entry.name.startsWith('.')) continue;
    if (used.has(entry.name)) continue;

    const filePath = path.join(UPLOADS_DIR, entry.name);
    const stat = safeStat(filePath);
    if (!stat || stat.mtimeMs > cutoff) continue;

    items.push({ category: 'uploads', name: entry.name, path: filePath, size: stat.size, mtime: stat.mtime.toISOString() });
  }
  return items;
}

// ===== Категория 3: файлы-сироты в public/uploads/stickers/<packId>/ =====

async function findOrphanStickerFiles(minOrphanAgeHours) {
  if (!fs.existsSync(STICKERS_DIR)) return [];

  const cutoff = Date.now() - minOrphanAgeHours * 60 * 60 * 1000;
  const items = [];

  const packFolders = fs.readdirSync(STICKERS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const folder of packFolders) {
    const packId = folder.name;
    const dirPath = path.join(STICKERS_DIR, packId);

    // Папки набора всегда называются просто числом (см. валидацию "только
    // цифры" в multer-config.js) — что угодно другое не может соответствовать
    // ни одному packId и обрабатывается как "мёртвая" папка ниже. Биндим
    // числом (не строкой) — sticker_packs.id/stickers.pack_id INTEGER,
    // а сравнение TEXT-параметра с INTEGER-колонкой в SQLite не всегда
    // надёжно совпадает по типовой affinity.
    const packIdNum = Number(packId);
    const isNumericId = Number.isInteger(packIdNum) && packIdNum > 0;

    // Папка не соответствует ни одному ID — сам набор давно удалён (см.
    // deletePack в stickers-store.js), а папку по какой-то причине не
    // снесло (например, файл был открыт другим процессом на Windows), либо
    // имя папки в принципе не похоже на packId. В обоих случаях
    // "используемых" имён нет — весь остаток папки мусор.
    const packExists = isNumericId ? await dbGet(stickersDb, 'SELECT id FROM sticker_packs WHERE id = ?', [packIdNum]) : null;
    let usedNames = new Set();
    if (packExists) {
      const rows = await dbAll(stickersDb, 'SELECT file_url FROM stickers WHERE pack_id = ?', [packIdNum]);
      // Стикеры коллабораций, ещё не влитые в набор (draft/pending), лежат в
      // той же папке — это не мусор, пока заявка жива.
      const stagedRows = await dbAll(
        stickersDb,
        `SELECT cs.file_url FROM sticker_collab_stickers cs
         JOIN sticker_collab_requests cr ON cr.id = cs.request_id
         WHERE cr.pack_id = ?`,
        [packIdNum]
      );
      usedNames = new Set([...rows, ...stagedRows].map((r) => path.basename(String(r.file_url || ''))));
    }

    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.')) continue; // служебные файлы (.gitkeep и т.п.)
      if (packExists && usedNames.has(entry.name)) continue;

      const filePath = path.join(dirPath, entry.name);
      const stat = safeStat(filePath);
      if (!stat || stat.mtimeMs > cutoff) continue;

      items.push({
        category: 'stickers',
        name: `${packId}/${entry.name}`,
        path: filePath,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        packId,
        packExists: !!packExists
      });
    }
  }
  return items;
}

// ===== Сканирование + выполнение =====

/**
 * Считает, что можно было бы удалить при текущих настройках — ничего не
 * трогает на диске. Используется и предпросмотром (GET /api/cleanup/preview),
 * и самим runCleanup() как первый шаг.
 */
async function scanGarbage(settings) {
  const [trash, uploads, stickers] = await Promise.all([
    settings.cleanTrashedArticles ? Promise.resolve(findOldTrashedArticles(settings.trashRetentionDays)) : Promise.resolve([]),
    settings.cleanOrphanUploads ? findOrphanUploads(settings.minOrphanAgeHours) : Promise.resolve([]),
    settings.cleanOrphanStickers ? findOrphanStickerFiles(settings.minOrphanAgeHours) : Promise.resolve([])
  ]);
  return { trash, uploads, stickers };
}

function summarizeReport(report) {
  const all = [...report.trash, ...report.uploads, ...report.stickers];
  return {
    trashCount: report.trash.length,
    uploadsCount: report.uploads.length,
    stickersCount: report.stickers.length,
    totalCount: all.length,
    totalBytes: all.reduce((sum, item) => sum + (item.size || 0), 0)
  };
}

/**
 * Выполняет очистку по текущим настройкам. dryRun:true — то же самое
 * сканирование, но без единого удаления (для предпросмотра).
 */
async function runCleanup(settings, { dryRun = false } = {}) {
  const report = await scanGarbage(settings);

  if (!dryRun) {
    report.trash.forEach((item) => safeUnlink(item.path));
    report.uploads.forEach((item) => safeUnlink(item.path));

    // Папки "мёртвых" (уже удалённых из БД) наборов подчищаем целиком после
    // того, как из них убраны файлы — а не только сами файлы, оставляя
    // пустую папку висеть в uploads/stickers/ навсегда.
    const deadPackDirs = new Set();
    report.stickers.forEach((item) => {
      safeUnlink(item.path);
      if (!item.packExists) deadPackDirs.add(path.dirname(item.path));
    });
    deadPackDirs.forEach((dir) => {
      try {
        fs.rmdirSync(dir); // тихо промахивается, если в папке остался ещё файл (fs.rmdirSync кидает ENOTEMPTY) — не критично
      } catch (e) {
        // ok
      }
    });
  }

  return { ...summarizeReport(report), items: report, dryRun, at: new Date().toISOString() };
}

// Та же логика, что и shouldRunAutoBackup в backup.js — не переиспользуем
// напрямую специально: она называется "auto backup" и её порог/семантика
// могут разойтись с очисткой в будущем (например, отдельный джиттер).
function shouldRunScheduled(lastRun, intervalHours) {
  if (!lastRun) return true;
  const hoursDiff = (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60);
  return hoursDiff >= intervalHours;
}

module.exports = {
  scanGarbage,
  summarizeReport,
  runCleanup,
  shouldRunScheduled
};
