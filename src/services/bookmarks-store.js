// bookmarks-store.js — закладки статей Ibripedia, привязанные к профилю
// (user_id). Пользователь кликает по хвостику закладки слева от абзаца
// статьи и ставит на него именованную цветную закладку (см.
// public/ibripedia.js — renderBookmarkGutter/openBookmarkPopover) — не
// более одной закладки на блок (клиент сам следит за этим), закладок на
// статью может быть сколько угодно. Каждая хранит блок, к которому
// привязана (block_id — id узла в дереве блоков, см. src/services/blocks.js),
// короткий автоматический фрагмент его текста (quote, для превью в списке)
// и то, что ввёл пользователь: имя и цвет.
//
// Хранилище — отдельная SQLite-таблица (см. src/db/connections.js), а не
// content/<slug>.json (тот — данные статьи, общие для всех, закладки —
// личные данные читателя, не должны попадать в файл статьи/её историю).

const { bookmarksDb } = require('../db/connections');

const NAME_MAX_LEN = 100;
const QUOTE_MAX_LEN = 500;
const TITLE_MAX_LEN = 200;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR = '#5865f2';

function normalizeColor(color) {
  return HEX_COLOR_RE.test(String(color || '')) ? color : DEFAULT_COLOR;
}

function rowToBookmark(row) {
  return {
    id: row.id,
    slug: row.article_slug,
    title: row.article_title || null,
    blockId: row.block_id || null,
    quote: row.quote || '',
    name: row.name,
    color: row.color,
    createdAt: row.created_at
  };
}

/**
 * Все закладки пользователя, самые новые сверху. slug опционален — если
 * задан, отдаёт закладки только по этой статье (панель "Закладки" в
 * просмотре статьи); без него — все закладки пользователя (вкладка
 * "Закладки" в профиле).
 */
function listForUser(userId, slug = null) {
  return new Promise((resolve, reject) => {
    const params = [userId];
    let sql = 'SELECT * FROM bookmarks WHERE user_id = ?';
    if (slug) {
      sql += ' AND article_slug = ?';
      params.push(slug);
    }
    sql += ' ORDER BY created_at DESC';
    bookmarksDb.all(sql, params, (err, rows) => {
      if (err) { reject(err); return; }
      resolve((rows || []).map(rowToBookmark));
    });
  });
}

function createBookmark(userId, fields) {
  const name = String(fields.name || '').trim().slice(0, NAME_MAX_LEN);
  const slug = String(fields.slug || '').trim();
  if (!name) return Promise.reject(new Error('Название закладки обязательно'));
  if (!slug) return Promise.reject(new Error('Не указана статья'));

  const title = fields.title ? String(fields.title).trim().slice(0, TITLE_MAX_LEN) : null;
  const blockId = fields.blockId ? String(fields.blockId).slice(0, 100) : null;
  const quote = fields.quote ? String(fields.quote).trim().slice(0, QUOTE_MAX_LEN) : '';
  const color = normalizeColor(fields.color);

  return new Promise((resolve, reject) => {
    bookmarksDb.run(
      `INSERT INTO bookmarks (user_id, article_slug, article_title, block_id, quote, name, color)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, slug, title, blockId, quote, name, color],
      function (err) {
        if (err) { reject(err); return; }
        bookmarksDb.get('SELECT * FROM bookmarks WHERE id = ?', [this.lastID], (err2, row) => {
          if (err2 || !row) { reject(err2 || new Error('Не удалось создать закладку')); return; }
          resolve(rowToBookmark(row));
        });
      }
    );
  });
}

/**
 * Переименовать закладку и/или сменить цвет — только своя (WHERE user_id).
 */
function updateBookmark(userId, id, fields) {
  return new Promise((resolve, reject) => {
    bookmarksDb.get('SELECT * FROM bookmarks WHERE id = ? AND user_id = ?', [id, userId], (err, row) => {
      if (err) { reject(err); return; }
      if (!row) { resolve(null); return; }

      const name = fields.name != null ? String(fields.name).trim().slice(0, NAME_MAX_LEN) || row.name : row.name;
      const color = fields.color != null ? normalizeColor(fields.color) : row.color;

      bookmarksDb.run('UPDATE bookmarks SET name = ?, color = ? WHERE id = ?', [name, color, id], (err2) => {
        if (err2) { reject(err2); return; }
        resolve(rowToBookmark({ ...row, name, color }));
      });
    });
  });
}

/**
 * Удалить закладку — только свою (WHERE user_id), возвращает true/false.
 */
function deleteBookmark(userId, id) {
  return new Promise((resolve, reject) => {
    bookmarksDb.run('DELETE FROM bookmarks WHERE id = ? AND user_id = ?', [id, userId], function (err) {
      if (err) { reject(err); return; }
      resolve(this.changes > 0);
    });
  });
}

module.exports = {
  listForUser,
  createBookmark,
  updateBookmark,
  deleteBookmark
};
