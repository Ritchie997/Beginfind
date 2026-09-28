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

const crypto = require('crypto');
const { draftsDb } = require('../db/connections');
const { normalizeDocument, documentSearchText } = require('./blocks');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TITLE_MAX_LEN = 300;
const SEARCH_TEXT_MAX_LEN = 5000;
const DATA_MAX_BYTES = 5 * 1024 * 1024;
const MAX_DRAFTS_PER_USER = 300;
const FOLDER_NAME_MAX_LEN = 100;
const MAX_FOLDERS_PER_USER = 100;
const FOLDER_MAX_DEPTH = 10;

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
    folderId: row.folder_id || null,
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

// ===== Папки черновиков =====
//
// Папка — только способ сгруппировать черновики в списке: у черновика
// есть folder_id (NULL — "без папки"), у папки — parent_id (папки
// вложенные, до FOLDER_MAX_DEPTH уровней). Удаление папки черновики не
// удаляет — они поднимаются в родительскую папку.

function run(sql, params) {
  return new Promise((resolve, reject) => {
    draftsDb.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this.changes);
    });
  });
}

function normalizeFolderName(name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, FOLDER_NAME_MAX_LEN);
  if (!clean) throw new Error('Введите название папки');
  return clean;
}

function listFolders(userId) {
  return new Promise((resolve, reject) => {
    draftsDb.all('SELECT id, name, parent_id, created_at FROM draft_folders WHERE user_id = ? ORDER BY name COLLATE NOCASE', [userId], (err, rows) => {
      if (err) { reject(err); return; }
      resolve((rows || []).map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id || null, createdAt: r.created_at })));
    });
  });
}

function getFolder(userId, folderId) {
  return new Promise((resolve, reject) => {
    draftsDb.get('SELECT id, parent_id FROM draft_folders WHERE user_id = ? AND id = ?', [userId, folderId], (err, row) => {
      if (err) reject(err); else resolve(row || null);
    });
  });
}

async function folderExists(userId, folderId) {
  return !!(await getFolder(userId, folderId));
}

// parentId из запроса: null/'' — верхний уровень, иначе — существующая
// своя папка.
async function resolveParent(userId, parentId) {
  if (parentId == null || parentId === '') return null;
  const id = String(parentId);
  if (!isValidId(id) || !(await folderExists(userId, id))) throw new Error('Папка не найдена');
  return id;
}

// Глубина папки (1 — верхний уровень). Цепочка родителей ограничена
// FOLDER_MAX_DEPTH + 1 шагом — на случай битых данных с циклом.
async function folderDepth(userId, folderId) {
  let depth = 0;
  let id = folderId;
  while (id && depth <= FOLDER_MAX_DEPTH) {
    const row = await getFolder(userId, id);
    if (!row) break;
    depth++;
    id = row.parent_id;
  }
  return depth;
}

// Высота поддерева папки (1 — папка без вложенных).
async function subtreeHeight(userId, folderId) {
  const folders = await listFolders(userId);
  const height = (id, guard) => {
    if (guard > FOLDER_MAX_DEPTH) return guard;
    const children = folders.filter((f) => f.parentId === id);
    return 1 + (children.length ? Math.max(...children.map((c) => height(c.id, guard + 1))) : 0);
  };
  return height(folderId, 0);
}

async function createFolder(userId, name, parentId = null) {
  const clean = normalizeFolderName(name);
  const parent = await resolveParent(userId, parentId);
  const count = await new Promise((resolve, reject) => {
    draftsDb.get('SELECT COUNT(*) AS n FROM draft_folders WHERE user_id = ?', [userId], (err, row) => {
      if (err) reject(err); else resolve(row ? row.n : 0);
    });
  });
  if (count >= MAX_FOLDERS_PER_USER) throw new Error(`Слишком много папок (максимум ${MAX_FOLDERS_PER_USER})`);
  if (parent && (await folderDepth(userId, parent)) >= FOLDER_MAX_DEPTH) {
    throw new Error(`Слишком глубокая вложенность (максимум ${FOLDER_MAX_DEPTH} уровней)`);
  }
  const id = `folder_${crypto.randomBytes(8).toString('hex')}`;
  const now = Date.now();
  await run('INSERT INTO draft_folders (id, user_id, name, parent_id, created_at) VALUES (?, ?, ?, ?, ?)', [id, userId, clean, parent, now]);
  return { id, name: clean, parentId: parent, createdAt: now };
}

async function renameFolder(userId, folderId, name) {
  const clean = normalizeFolderName(name);
  const changes = await run('UPDATE draft_folders SET name = ? WHERE user_id = ? AND id = ?', [clean, userId, folderId]);
  return changes > 0 ? { id: folderId, name: clean } : null;
}

/**
 * Переместить папку внутрь другой (parentId = null — на верхний уровень).
 * Нельзя положить папку в саму себя или в свою же вложенную папку.
 */
async function moveFolder(userId, folderId, parentId) {
  const folder = await getFolder(userId, folderId);
  if (!folder) return null;
  const parent = await resolveParent(userId, parentId);
  if (parent) {
    // Поднимаемся от новой родительской папки вверх: если встретили
    // переносимую — получился бы цикл.
    let id = parent;
    for (let i = 0; id && i <= FOLDER_MAX_DEPTH + 1; i++) {
      if (id === folderId) throw new Error('Нельзя переместить папку в неё саму или во вложенную в неё папку');
      const row = await getFolder(userId, id);
      id = row ? row.parent_id : null;
    }
    if ((await folderDepth(userId, parent)) + (await subtreeHeight(userId, folderId)) > FOLDER_MAX_DEPTH) {
      throw new Error(`Слишком глубокая вложенность (максимум ${FOLDER_MAX_DEPTH} уровней)`);
    }
  }
  await run('UPDATE draft_folders SET parent_id = ? WHERE user_id = ? AND id = ?', [parent, userId, folderId]);
  return { id: folderId, parentId: parent };
}

// Удаление папки ничего не теряет: её черновики и вложенные папки
// поднимаются на уровень выше (в родительскую папку).
async function deleteFolder(userId, folderId) {
  const folder = await getFolder(userId, folderId);
  if (!folder) return false;
  const parent = folder.parent_id || null;
  await run('UPDATE drafts SET folder_id = ? WHERE user_id = ? AND folder_id = ?', [parent, userId, folderId]);
  await run('UPDATE draft_folders SET parent_id = ? WHERE user_id = ? AND parent_id = ?', [parent, userId, folderId]);
  return (await run('DELETE FROM draft_folders WHERE user_id = ? AND id = ?', [userId, folderId])) > 0;
}

/**
 * Перенести черновики в папку (folderId = null — "без папки"). rev и
 * updated_at не трогаем: перенос — не правка содержимого.
 * @returns {Promise<number>} сколько черновиков перенесено (черновики,
 *   которых ещё нет на сервере, не считаются).
 */
async function moveDrafts(userId, ids, folderId) {
  const list = (Array.isArray(ids) ? ids : []).filter(isValidId).slice(0, MAX_DRAFTS_PER_USER);
  if (!list.length) throw new Error('Не выбраны черновики');
  const target = folderId == null || folderId === '' ? null : String(folderId);
  if (target !== null && (!isValidId(target) || !(await folderExists(userId, target)))) {
    throw new Error('Папка не найдена');
  }
  const placeholders = list.map(() => '?').join(', ');
  return run(
    `UPDATE drafts SET folder_id = ? WHERE user_id = ? AND id IN (${placeholders})`,
    [target, userId, ...list]
  );
}

module.exports = {
  isValidId,
  listForUser,
  getDraft,
  saveDraft,
  deleteDraft,
  listFolders,
  createFolder,
  renameFolder,
  moveFolder,
  deleteFolder,
  moveDrafts
};
