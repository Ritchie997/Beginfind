// drafts-store.js — черновики статей редактора, привязанные к профилю
// (user_id). Раньше черновики жили только в localStorage браузера и не
// переезжали между устройствами; теперь основное хранилище — здесь, а в
// localStorage остаётся лишь очередь офлайн-копий, не успевших доехать до
// сервера (см. public/spa-router.js — flushPendingDrafts).
//
// id черновика генерирует клиент (он же ключ офлайн-копии в localStorage):
// так черновик, созданный без сети, получает тот же id и на сервере, и
// повторная отправка той же копии обновляет запись, а не плодит дубль.
//
// Конфликты: клиент присылает baseRev — rev, с которой начал правку. Если
// на сервере rev уже другая (черновик тем временем сохранили с другого
// устройства), сохранение отклоняется (conflict) — клиент сохранит свою
// версию отдельным черновиком, чтобы ни одна из правок не потерялась.
// Исключение — присланные данные совпадают с сохранёнными байт в байт
// (например, keepalive-запрос при закрытии вкладки уже довёз эту же копию,
// а ответ клиент не успел прочитать): это не конфликт, а повтор.

const { draftsDb } = require('../db/connections');
const { normalizeDocument, documentSearchText } = require('./blocks');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TITLE_MAX_LEN = 300;
const SEARCH_TEXT_MAX_LEN = 5000;
const DATA_MAX_BYTES = 5 * 1024 * 1024;
const MAX_DRAFTS_PER_USER = 300;

function isValidId(id) {
  return ID_RE.test(String(id || ''));
}

// Текст для поиска/превью в списке черновиков. Содержимое редактора — JSON
// документа блоков (строкой, см. shimInnerHTML в public/editor-manager.js),
// поэтому достаём текст теми же средствами, что и поиск по статьям, и
// снимаем самую заметную markdown-разметку. На рендер нигде не идёт.
function contentToText(content) {
  let text;
  try {
    text = documentSearchText(normalizeDocument(content));
  } catch (e) {
    text = String(content || '');
  }
  return text
    .replace(/\[([^\]\n]*)\]\(\(([^()#\n]+)(?:#[^()\n]*)?\)\)/g, (m, label, target) => label || target)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/[*_~`]|\+\+|==|\|\|/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function rowToSummary(row) {
  let meta = {};
  try {
    const data = JSON.parse(row.data);
    meta = {
      server: data.server || '',
      image: data.image || '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      locked: !!data.locked,
      layersEnabled: !!data.layersEnabled
    };
  } catch (e) { /* битый data — отдаём хотя бы заголовок и даты */ }
  return {
    id: row.id,
    title: row.title || '',
    text: row.search_text || '',
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...meta
  };
}

/**
 * Все черновики пользователя (без полного data — только то, что нужно
 * списку: заголовок, текст для поиска/превью, обложка, теги, даты),
 * самые свежие сверху.
 */
function listForUser(userId) {
  return new Promise((resolve, reject) => {
    draftsDb.all('SELECT * FROM drafts WHERE user_id = ? ORDER BY updated_at DESC', [userId], (err, rows) => {
      if (err) { reject(err); return; }
      resolve((rows || []).map(rowToSummary));
    });
  });
}

function getDraft(userId, id) {
  return new Promise((resolve, reject) => {
    draftsDb.get('SELECT * FROM drafts WHERE user_id = ? AND id = ?', [userId, id], (err, row) => {
      if (err) { reject(err); return; }
      if (!row) { resolve(null); return; }
      let data;
      try { data = JSON.parse(row.data); } catch (e) { data = {}; }
      resolve({ id: row.id, rev: row.rev, createdAt: row.created_at, updatedAt: row.updated_at, data });
    });
  });
}

function countForUser(userId) {
  return new Promise((resolve, reject) => {
    draftsDb.get('SELECT COUNT(*) AS n FROM drafts WHERE user_id = ?', [userId], (err, row) => {
      if (err) { reject(err); return; }
      resolve(row ? row.n : 0);
    });
  });
}

/**
 * Создать или обновить черновик.
 * @returns {Promise<{status:'ok', draft} | {status:'conflict', draft}>}
 *   draft — { id, rev, updatedAt } сохранённой (или конфликтующей серверной) версии.
 */
async function saveDraft(userId, id, { data, baseRev, updatedAt }) {
  if (!isValidId(id)) throw new Error('Некорректный id черновика');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Нет данных черновика');

  const dataJson = JSON.stringify(data);
  if (Buffer.byteLength(dataJson, 'utf8') > DATA_MAX_BYTES) throw new Error('Черновик слишком большой');

  const title = String(data.title || '').trim().slice(0, TITLE_MAX_LEN);
  const searchText = contentToText(data.content).slice(0, SEARCH_TEXT_MAX_LEN);
  // Время правки — клиентское (офлайн-копия могла пролежать долго, и в
  // списке должно стоять время, когда её правили, а не когда доехала), но
  // не из будущего — иначе кривые часы устройства навсегда задрали бы
  // черновик наверх списка.
  const now = Date.now();
  const clientTs = Number(updatedAt);
  const ts = Number.isFinite(clientTs) && clientTs > 0 ? Math.min(clientTs, now) : now;

  const existing = await new Promise((resolve, reject) => {
    draftsDb.get('SELECT id, rev, data, updated_at FROM drafts WHERE user_id = ? AND id = ?', [userId, id], (err, row) => {
      if (err) reject(err); else resolve(row || null);
    });
  });

  if (!existing) {
    if (await countForUser(userId) >= MAX_DRAFTS_PER_USER) {
      throw new Error(`Слишком много черновиков (максимум ${MAX_DRAFTS_PER_USER}) — удалите ненужные`);
    }
    await new Promise((resolve, reject) => {
      draftsDb.run(
        `INSERT INTO drafts (id, user_id, title, search_text, data, rev, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [id, userId, title, searchText, dataJson, ts, ts],
        (err) => (err ? reject(err) : resolve())
      );
    });
    return { status: 'ok', draft: { id, rev: 1, updatedAt: ts } };
  }

  if (existing.data === dataJson) {
    return { status: 'ok', draft: { id, rev: existing.rev, updatedAt: existing.updated_at } };
  }

  const base = Number(baseRev);
  if (!Number.isInteger(base) || base !== existing.rev) {
    return { status: 'conflict', draft: { id, rev: existing.rev, updatedAt: existing.updated_at } };
  }

  const rev = existing.rev + 1;
  const newTs = Math.max(ts, existing.updated_at);
  await new Promise((resolve, reject) => {
    draftsDb.run(
      'UPDATE drafts SET title = ?, search_text = ?, data = ?, rev = ?, updated_at = ? WHERE user_id = ? AND id = ?',
      [title, searchText, dataJson, rev, newTs, userId, id],
      (err) => (err ? reject(err) : resolve())
    );
  });
  return { status: 'ok', draft: { id, rev, updatedAt: newTs } };
}

/**
 * Удалить черновик — только свой (WHERE user_id), возвращает true/false.
 */
function deleteDraft(userId, id) {
  return new Promise((resolve, reject) => {
    draftsDb.run('DELETE FROM drafts WHERE user_id = ? AND id = ?', [userId, id], function (err) {
      if (err) { reject(err); return; }
      resolve(this.changes > 0);
    });
  });
}

module.exports = {
  isValidId,
  listForUser,
  getDraft,
  saveDraft,
  deleteDraft
};
