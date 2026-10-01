// gallery-store.js — Галерея (аналог Pinterest): работы, их страницы и
// вариации страниц, ассоциированные работы, привязка к статьям Ibripedia,
// лайки/просмотры/комментарии (см. таблицы gallery_* в src/db/connections.js).
//
// Страница и вариация — разные вещи:
//   - страницы (gallery_pages) — то, что листается: массовая загрузка
//     листается слайдером (scroll_mode 'horizontal', по умолчанию) или
//     вертикальной лентой сверху вниз ('vertical');
//   - вариации (gallery_images) — картинки ОДНОЙ страницы: у страницы их
//     одна или несколько ("Цветная", "Ч/Б", "Эскиз"…, имя вводит автор),
//     читатель переключается между ними. У каждой вариации свои роли на
//     просмотр — читатель видит только доступные ему вариации, страница без
//     единой доступной вариации ему не показывается вовсе.
//
// Роли (и у работы целиком, и у вариации) — формат слоёв статьи
// ([{scope:'system'|'server', id}], см. article-layers.js): пустой список —
// открыто всем, кому видна работа. Автор, владелец и доверенный админ видят
// всё. article_slugs — статьи, к которым работа привязана; ассоциированные
// работы — симметричная связь gallery_associations.
//
// Картинки, загруженные в редакторе статей, сюда НЕ попадают (это обычный
// /api/upload-image) — в галерею работа выкладывается только явно.

const fs = require('fs');
const path = require('path');
const { galleryDb, serversDb } = require('../db/connections');
const { GALLERY_DIR } = require('../config/paths');
const articleLayers = require('./article-layers');

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 5000;
const VARIANT_NAME_MAX = 80;
const COMMENT_MAX_LEN = 2000;
const MAX_VARIANTS_PER_PAGE = 20;
const MAX_IMAGES_PER_WORK = 500;
const MAX_ASSOCIATIONS = 50;
const MAX_ARTICLE_LINKS = 50;
const THUMB_WIDTH = 600;
const SCROLL_MODES = ['horizontal', 'vertical'];

// ===== Promise-обёртки над sqlite3 =====

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    galleryDb.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    galleryDb.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    galleryDb.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function placeholders(list) {
  return list.map(() => '?').join(',');
}

function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function toId(v) {
  const id = parseInt(v, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ===== Нормализация полей =====

function normalizeTags(raw) {
  return articleLayers.normalizeTagList(Array.isArray(raw) ? raw : []);
}

function normalizeSlugList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    const slug = String(s == null ? '' : s).trim();
    if (slug && !out.includes(slug)) out.push(slug);
    if (out.length >= MAX_ARTICLE_LINKS) break;
  }
  return out;
}

function normalizeScrollMode(v) {
  return SCROLL_MODES.includes(v) ? v : 'horizontal';
}

function buildSearchText(work, variantNames, authorName) {
  return [work.title, work.description, (work.tags || []).join(' '), (variantNames || []).join(' '), authorName || '']
    .join(' ')
    .toLowerCase();
}

function rowToWork(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    author_id: row.author_id,
    server_id: row.server_id || null,
    roles: articleLayers.normalizeLayerRoles(parseJson(row.roles, [])),
    tags: parseJson(row.tags, []),
    scroll_mode: normalizeScrollMode(row.scroll_mode),
    article_slugs: parseJson(row.article_slugs, []),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function rowToVariant(row, { withRoles = false } = {}) {
  const roles = articleLayers.normalizeLayerRoles(parseJson(row.roles, []));
  return {
    id: row.id,
    pageId: row.page_id,
    name: row.name || '',
    url: row.file_url,
    thumb: row.thumb_url || row.file_url,
    width: row.width || null,
    height: row.height || null,
    animated: !!row.is_animated,
    restricted: roles.length > 0,
    ...(withRoles ? { roles } : {})
  };
}

// ===== Доступ =====

// Все роли пользователя на всех серверах разом — id server_roles глобально
// уникальны, поэтому для проверки роли работы достаточно множества id (без
// привязки к серверу). Один запрос на весь список работ (см. listWorks).
function getUserServerRoleIdSet(userId) {
  return new Promise((resolve) => {
    serversDb.all(
      'SELECT role_id FROM user_server_role_assignments WHERE user_id = ?',
      [userId],
      (err, rows) => resolve(new Set(err || !rows ? [] : rows.map((r) => Number(r.role_id))))
    );
  });
}

async function getAccessContext(user) {
  const bypass = !!(user && (user.is_root || user.is_role_manager));
  return {
    user,
    bypass,
    serverRoleIds: bypass || !user ? new Set() : await getUserServerRoleIdSet(user.id)
  };
}

function rolesMatch(roles, ctx) {
  if (!roles || roles.length === 0) return true;
  return roles.some((r) => {
    if (r.scope === 'system') return ctx.user.admin_role_id != null && Number(ctx.user.admin_role_id) === Number(r.id);
    if (r.scope === 'server') return ctx.serverRoleIds.has(Number(r.id));
    return false;
  });
}

function seesEverything(work, ctx) {
  return !!(ctx && ctx.user && (ctx.bypass || work.author_id === ctx.user.id));
}

function canViewWork(work, ctx) {
  if (!ctx || !ctx.user) return false;
  return seesEverything(work, ctx) || rolesMatch(work.roles, ctx);
}

// Вариация видна, если видна работа и есть роль самой вариации (или у
// вариации ролей нет). roles — разобранный массив или JSON-строка из БД.
function canViewVariant(work, roles, ctx) {
  if (!canViewWork(work, ctx)) return false;
  if (seesEverything(work, ctx)) return true;
  const list = typeof roles === 'string' ? articleLayers.normalizeLayerRoles(parseJson(roles, [])) : roles;
  return rolesMatch(list, ctx);
}

// Назначить работе роль можно только ту, что есть у самого автора (как у
// слоёв статей — см. canCreateLayerWithRoles): иначе можно было бы
// подсунуть контент группе, к которой сам не относишься.
async function canAssignRoles(user, roles) {
  const normalized = articleLayers.normalizeLayerRoles(roles);
  if (!normalized.length) return true;
  const ctx = await getAccessContext(user);
  if (ctx.bypass) return true;
  return normalized.every((r) => {
    if (r.scope === 'system') return user.admin_role_id != null && Number(user.admin_role_id) === Number(r.id);
    return ctx.serverRoleIds.has(Number(r.id));
  });
}

// ===== Чтение =====

async function getWorkRow(id) {
  const workId = toId(id);
  if (!workId) return null;
  const row = await get('SELECT * FROM gallery_works WHERE id = ?', [workId]);
  return row ? rowToWork(row) : null;
}

/**
 * Страницы работы с вариациями, доступными пользователю (ctx). Страницы без
 * единой доступной вариации отбрасываются. withRoles — отдать и списки ролей
 * вариаций (для формы правки).
 */
async function getPagesForUser(work, ctx, { withRoles = false } = {}) {
  const pages = await all('SELECT * FROM gallery_pages WHERE work_id = ? ORDER BY position, id', [work.id]);
  const images = await all('SELECT * FROM gallery_images WHERE work_id = ? ORDER BY position, id', [work.id]);
  const byPage = new Map(pages.map((p) => [p.id, []]));
  images.forEach((img) => {
    if (byPage.has(img.page_id) && canViewVariant(work, img.roles, ctx)) {
      byPage.get(img.page_id).push(rowToVariant(img, { withRoles }));
    }
  });
  return pages
    .map((p) => ({ id: p.id, variants: byPage.get(p.id) }))
    .filter((p) => p.variants.length > 0);
}

// Обложка (первая доступная вариация первой страницы, где такая есть),
// число доступных страниц и есть ли у них вариации — сразу для страницы
// карточек, двумя запросами. works — строки rowToWork (нужны author_id/roles).
async function getCoversForWorks(works, ctx) {
  const result = new Map();
  const workIds = works.map((w) => w.id);
  if (!workIds.length) return result;
  const workById = new Map(works.map((w) => [w.id, w]));
  const pages = await all(
    `SELECT id, work_id FROM gallery_pages WHERE work_id IN (${placeholders(workIds)}) ORDER BY position, id`,
    workIds
  );
  const images = await all(
    `SELECT * FROM gallery_images WHERE work_id IN (${placeholders(workIds)}) ORDER BY position, id`,
    workIds
  );
  const imagesByPage = new Map();
  images.forEach((img) => {
    if (!canViewVariant(workById.get(img.work_id), img.roles, ctx)) return;
    if (!imagesByPage.has(img.page_id)) imagesByPage.set(img.page_id, []);
    imagesByPage.get(img.page_id).push(img);
  });
  workIds.forEach((id) => result.set(id, { cover: null, pagesCount: 0, hasVariations: false }));
  pages.forEach((p) => {
    const imgs = imagesByPage.get(p.id);
    if (!imgs || !imgs.length) return;
    const entry = result.get(p.work_id);
    entry.pagesCount += 1;
    if (imgs.length > 1) entry.hasVariations = true;
    if (!entry.cover) entry.cover = rowToVariant(imgs[0]);
  });
  return result;
}

// ===== Лайки / просмотры / комментарии — копия логики social-store.js
// (статьи Ibripedia), только на своих таблицах gallery_* =====

async function getCountsForWorks(userId, workIds) {
  const result = new Map();
  workIds.forEach((id) => result.set(id, { likes: 0, liked: false, comments: 0, views: 0 }));
  if (!workIds.length) return result;
  const ph = placeholders(workIds);
  const likes = await all(
    `SELECT work_id, COUNT(*) as count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as liked
     FROM gallery_likes WHERE work_id IN (${ph}) GROUP BY work_id`,
    [userId, ...workIds]
  );
  likes.forEach((r) => { const e = result.get(r.work_id); e.likes = r.count; e.liked = !!r.liked; });
  const comments = await all(`SELECT work_id, COUNT(*) as count FROM gallery_comments WHERE work_id IN (${ph}) GROUP BY work_id`, workIds);
  comments.forEach((r) => { result.get(r.work_id).comments = r.count; });
  const views = await all(`SELECT work_id, COUNT(*) as count FROM gallery_views WHERE work_id IN (${ph}) GROUP BY work_id`, workIds);
  views.forEach((r) => { result.get(r.work_id).views = r.count; });
  return result;
}

async function getLikeSummary(workId, userId) {
  const row = await get(
    `SELECT COUNT(*) as count, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) as liked
     FROM gallery_likes WHERE work_id = ?`,
    [userId, workId]
  );
  return { count: (row && row.count) || 0, liked: !!(row && row.liked) };
}

async function toggleLike(userId, workId) {
  const row = await get('SELECT id FROM gallery_likes WHERE user_id = ? AND work_id = ?', [userId, workId]);
  if (row) await run('DELETE FROM gallery_likes WHERE id = ?', [row.id]);
  else await run('INSERT INTO gallery_likes (user_id, work_id) VALUES (?, ?)', [userId, workId]);
  return getLikeSummary(workId, userId);
}

async function recordView(userId, workId) {
  await run('INSERT OR IGNORE INTO gallery_views (user_id, work_id) VALUES (?, ?)', [userId, workId]);
}

async function getViewCount(workId) {
  const row = await get('SELECT COUNT(*) as count FROM gallery_views WHERE work_id = ?', [workId]);
  return (row && row.count) || 0;
}

function rowToComment(row) {
  return {
    id: row.id,
    workId: row.work_id,
    userId: row.user_id,
    authorName: row.author_name,
    content: row.content,
    parentId: row.parent_id || null,
    createdAt: row.created_at
  };
}

async function listComments(workId) {
  const rows = await all('SELECT * FROM gallery_comments WHERE work_id = ? ORDER BY created_at ASC, id ASC', [workId]);
  return rows.map(rowToComment);
}

async function getComment(id) {
  const row = await get('SELECT * FROM gallery_comments WHERE id = ?', [toId(id)]);
  return row ? rowToComment(row) : null;
}

async function addComment(userId, authorName, workId, content, parentId) {
  const trimmed = String(content || '').trim().slice(0, COMMENT_MAX_LEN);
  if (!trimmed) throw new Error('Комментарий не может быть пустым');
  const { lastID } = await run(
    'INSERT INTO gallery_comments (user_id, author_name, work_id, content, parent_id) VALUES (?, ?, ?, ?, ?)',
    [userId, authorName, workId, trimmed, parentId || null]
  );
  return getComment(lastID);
}

// Вместе с ответами — как deleteCommentCascade в social-store.js.
async function deleteCommentCascade(id) {
  const { changes } = await run('DELETE FROM gallery_comments WHERE id = ? OR parent_id = ?', [id, id]);
  return changes > 0;
}

// ===== Список / поиск =====

const SORTS = {
  newest: (a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id,
  oldest: (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id,
  updated: (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id
};

/**
 * Страница работ, доступных пользователю. q ищет по названию, описанию,
 * тегам, именам вариаций и автору (search_text — всё это в нижнем регистре:
 * SQLite LOWER() не умеет кириллицу, поэтому регистр приводим в JS).
 * Работы без единой страницы (недогруженные) видит только их автор.
 * @returns {Promise<{items:object[], total:number}>} items — строки работ
 *   (rowToWork) + cover/pagesCount/hasVariations + counts.
 */
async function listWorks(user, { q, tag, authorId, sort, limit = 30, offset = 0, ids } = {}) {
  const where = ['(EXISTS (SELECT 1 FROM gallery_images i WHERE i.work_id = w.id) OR w.author_id = ?)'];
  const params = [user.id];
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  terms.forEach((t) => {
    where.push("w.search_text LIKE ? ESCAPE '\\'");
    params.push(`%${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  });
  if (toId(authorId)) {
    where.push('w.author_id = ?');
    params.push(toId(authorId));
  }
  if (Array.isArray(ids)) {
    const clean = ids.map(toId).filter(Boolean);
    if (!clean.length) return { items: [], total: 0 };
    where.push(`w.id IN (${placeholders(clean)})`);
    params.push(...clean);
  }

  const rows = await all(`SELECT w.* FROM gallery_works w WHERE ${where.join(' AND ')}`, params);
  const ctx = await getAccessContext(user);
  const tagKey = String(tag || '').trim().replace(/^#+/, '').toLowerCase();
  let works = rows.map(rowToWork).filter((w) => canViewWork(w, ctx));
  if (tagKey) works = works.filter((w) => w.tags.some((t) => String(t).toLowerCase() === tagKey));

  let counts = null;
  if (sort === 'likes' || sort === 'views' || sort === 'comments') {
    counts = await getCountsForWorks(user.id, works.map((w) => w.id));
    works.sort((a, b) => (counts.get(b.id)[sort] - counts.get(a.id)[sort]) || SORTS.newest(a, b));
  } else {
    works.sort(SORTS[sort] || SORTS.newest);
  }

  const total = works.length;
  const lim = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const page = works.slice(off, off + lim);
  const pageIds = page.map((w) => w.id);
  const [covers, pageCounts] = await Promise.all([
    getCoversForWorks(page, ctx),
    getCountsForWorks(user.id, pageIds)
  ]);
  const items = page.map((w) => ({ ...w, ...covers.get(w.id), counts: pageCounts.get(w.id) }));
  return { items, total };
}

// Все теги доступных работ — для подсказок в фильтре.
async function listTags(user) {
  const rows = await all('SELECT id, author_id, roles, tags FROM gallery_works');
  const ctx = await getAccessContext(user);
  const counts = new Map();
  rows.forEach((row) => {
    const work = { id: row.id, author_id: row.author_id, roles: articleLayers.normalizeLayerRoles(parseJson(row.roles, [])) };
    if (!canViewWork(work, ctx)) return;
    parseJson(row.tags, []).forEach((t) => {
      const key = String(t).toLowerCase();
      const e = counts.get(key) || { name: t, count: 0 };
      e.count += 1;
      counts.set(key, e);
    });
  });
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

async function getAssociatedIds(workId) {
  const rows = await all('SELECT related_id FROM gallery_associations WHERE work_id = ?', [workId]);
  return rows.map((r) => r.related_id);
}

// Работы, привязанные к статье — article_slugs хранится JSON-массивом,
// поэтому грубый LIKE по кавычкам и точная проверка уже в JS.
async function listWorksForArticle(user, slug) {
  const needle = `%${JSON.stringify(String(slug)).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const rows = await all("SELECT id, article_slugs FROM gallery_works WHERE article_slugs LIKE ? ESCAPE '\\'", [needle]);
  const ids = rows.filter((r) => parseJson(r.article_slugs, []).includes(slug)).map((r) => r.id);
  if (!ids.length) return [];
  const { items } = await listWorks(user, { ids, limit: 100 });
  return items;
}

// ===== Запись =====

async function syncSearchText(workId, authorName) {
  const work = await getWorkRow(workId);
  if (!work) return;
  const variants = await all('SELECT DISTINCT name FROM gallery_images WHERE work_id = ?', [workId]);
  await run('UPDATE gallery_works SET search_text = ? WHERE id = ?', [
    buildSearchText(work, variants.map((v) => v.name), authorName),
    workId
  ]);
}

function cleanMeta(body) {
  const title = String(body.title || '').trim().slice(0, TITLE_MAX);
  if (!title) throw new Error('Укажите название работы');
  return {
    title,
    description: String(body.description || '').trim().slice(0, DESCRIPTION_MAX),
    server_id: toId(body.serverId),
    roles: articleLayers.normalizeLayerRoles(body.roles),
    tags: normalizeTags(body.tags),
    scroll_mode: normalizeScrollMode(body.scrollMode),
    article_slugs: normalizeSlugList(body.articleSlugs)
  };
}

function cleanVariantName(name, index) {
  return String(name || '').trim().slice(0, VARIANT_NAME_MAX) || (index === 0 ? 'Основная' : `Вариация ${index + 1}`);
}

async function setAssociations(workId, relatedIds) {
  const clean = [...new Set((Array.isArray(relatedIds) ? relatedIds : []).map(toId).filter((id) => id && id !== workId))]
    .slice(0, MAX_ASSOCIATIONS);
  const existing = clean.length
    ? (await all(`SELECT id FROM gallery_works WHERE id IN (${placeholders(clean)})`, clean)).map((r) => r.id)
    : [];
  await run('DELETE FROM gallery_associations WHERE work_id = ? OR related_id = ?', [workId, workId]);
  for (const id of existing) {
    await run('INSERT OR IGNORE INTO gallery_associations (work_id, related_id) VALUES (?, ?)', [workId, id]);
    await run('INSERT OR IGNORE INTO gallery_associations (work_id, related_id) VALUES (?, ?)', [id, workId]);
  }
}

/**
 * Создаёт работу без страниц (страницы догружаются отдельными запросами —
 * см. addImages). body: {title, description, tags, roles, serverId,
 * scrollMode, articleSlugs, associatedIds}.
 */
// authorId — обычно сам выкладывающий; другого автора назначать могут только
// владелец и доверенный админ (проверка — в gallery.routes.js).
async function createWork(authorId, body, authorName) {
  const meta = cleanMeta(body);
  const { lastID: workId } = await run(
    `INSERT INTO gallery_works (title, description, author_id, server_id, roles, tags, scroll_mode, article_slugs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [meta.title, meta.description, authorId, meta.server_id, JSON.stringify(meta.roles), JSON.stringify(meta.tags), meta.scroll_mode, JSON.stringify(meta.article_slugs)]
  );
  await setAssociations(workId, body.associatedIds);
  await syncSearchText(workId, authorName);
  return workId;
}

// Роли вариаций по id — для проверки "добавленных" ролей при правке (см.
// PUT /gallery/works/:id в gallery.routes.js).
async function getVariantRolesMap(workId) {
  const rows = await all('SELECT id, roles FROM gallery_images WHERE work_id = ?', [workId]);
  return new Map(rows.map((r) => [r.id, articleLayers.normalizeLayerRoles(parseJson(r.roles, []))]));
}

/**
 * Правка работы: метаданные (не присланные поля остаются как были) +
 * состав страниц. pages — итоговый список в нужном порядке:
 * [{id, variants:[{id, name, roles}]}] — id существующих страниц/вариаций
 * (новые сначала загружаются через addImages). Вариацию можно перенести на
 * другую страницу. Страницы/вариации, которых в списке нет, удаляются
 * вместе с файлами — КРОМЕ вариаций, которых правящий не видит (их роли ему
 * недоступны): он их не получал и прислать не мог, они остаются на своих
 * страницах как были. Без pages состав не трогается. body.authorId —
 * смена автора (права проверяет gallery.routes.js; authorName — имя уже
 * нового автора, для поиска).
 */
async function updateWork(workId, body, authorName, editorCtx) {
  const current = await getWorkRow(workId);
  const meta = cleanMeta({
    title: body.title !== undefined ? body.title : current.title,
    description: body.description !== undefined ? body.description : current.description,
    serverId: body.serverId !== undefined ? body.serverId : current.server_id,
    roles: body.roles !== undefined ? body.roles : current.roles,
    tags: body.tags !== undefined ? body.tags : current.tags,
    scrollMode: body.scrollMode !== undefined ? body.scrollMode : current.scroll_mode,
    articleSlugs: body.articleSlugs !== undefined ? body.articleSlugs : current.article_slugs
  });
  await run(
    `UPDATE gallery_works SET title = ?, description = ?, server_id = ?, roles = ?, tags = ?, scroll_mode = ?,
       article_slugs = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [meta.title, meta.description, meta.server_id, JSON.stringify(meta.roles), JSON.stringify(meta.tags), meta.scroll_mode, JSON.stringify(meta.article_slugs), workId]
  );
  if (toId(body.authorId)) await run('UPDATE gallery_works SET author_id = ? WHERE id = ?', [toId(body.authorId), workId]);

  if (Array.isArray(body.pages)) {
    const existingPages = await all('SELECT * FROM gallery_pages WHERE work_id = ? ORDER BY position, id', [workId]);
    const pageIds = new Set(existingPages.map((p) => p.id));
    const existingImages = await all('SELECT * FROM gallery_images WHERE work_id = ? ORDER BY position, id', [workId]);
    const imageById = new Map(existingImages.map((img) => [img.id, img]));
    const hidden = existingImages.filter((img) => !canViewVariant(current, img.roles, editorCtx));
    const hiddenIds = new Set(hidden.map((img) => img.id));
    const keptPages = [];
    const keptImageIds = new Set();

    for (const p of body.pages) {
      const pageId = toId(p && p.id);
      if (!pageId || !pageIds.has(pageId) || keptPages.includes(pageId)) continue;
      const variants = (Array.isArray(p.variants) ? p.variants : [])
        .filter((v) => {
          const id = toId(v && v.id);
          return id && imageById.has(id) && !hiddenIds.has(id) && !keptImageIds.has(id);
        })
        .slice(0, MAX_VARIANTS_PER_PAGE);
      let position = 0;
      for (const v of variants) {
        const id = toId(v.id);
        keptImageIds.add(id);
        await run('UPDATE gallery_images SET page_id = ?, name = ?, roles = ?, position = ? WHERE id = ?', [
          pageId, cleanVariantName(v.name, position), JSON.stringify(articleLayers.normalizeLayerRoles(v.roles)), position, id
        ]);
        position++;
      }
      // Невидимые правящему вариации этой страницы — следом за видимыми.
      for (const img of hidden.filter((h) => h.page_id === pageId)) {
        await run('UPDATE gallery_images SET position = ? WHERE id = ?', [position++, img.id]);
      }
      if (position > 0) keptPages.push(pageId);
    }
    // Страницы, которые правящий не прислал, но на которых есть невидимые
    // ему вариации, — остаются (в конце, в прежнем порядке).
    existingPages.forEach((p) => {
      if (!keptPages.includes(p.id) && hidden.some((h) => h.page_id === p.id)) keptPages.push(p.id);
    });
    if (!keptPages.length) throw new Error('У работы должна остаться хотя бы одна страница');

    for (let i = 0; i < keptPages.length; i++) {
      await run('UPDATE gallery_pages SET position = ? WHERE id = ?', [i, keptPages[i]]);
    }
    for (const img of existingImages) {
      if (keptImageIds.has(img.id) || hiddenIds.has(img.id)) continue;
      await run('DELETE FROM gallery_images WHERE id = ?', [img.id]);
      removeImageFiles(img);
    }
    for (const p of existingPages) {
      if (!keptPages.includes(p.id)) await run('DELETE FROM gallery_pages WHERE id = ?', [p.id]);
    }
  }

  if (Array.isArray(body.associatedIds)) await setAssociations(workId, body.associatedIds);
  await syncSearchText(workId, authorName);
}

// URL вида /uploads/gallery/<workId>/<file> → путь на диске (строго внутри
// GALLERY_DIR — URL из БД, но перестраховка против "..").
function urlToGalleryPath(url) {
  const m = /^\/uploads\/gallery\/(\d+)\/([A-Za-z0-9._-]+)$/.exec(String(url || ''));
  return m ? path.join(GALLERY_DIR, m[1], m[2]) : null;
}

function unlinkQuiet(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
}

function removeImageFiles(img) {
  unlinkQuiet(urlToGalleryPath(img.file_url));
  if (img.thumb_url && img.thumb_url !== img.file_url) unlinkQuiet(urlToGalleryPath(img.thumb_url));
}

async function deleteWork(workId) {
  await run('DELETE FROM gallery_images WHERE work_id = ?', [workId]);
  await run('DELETE FROM gallery_pages WHERE work_id = ?', [workId]);
  await run('DELETE FROM gallery_associations WHERE work_id = ? OR related_id = ?', [workId, workId]);
  await run('DELETE FROM gallery_likes WHERE work_id = ?', [workId]);
  await run('DELETE FROM gallery_views WHERE work_id = ?', [workId]);
  await run('DELETE FROM gallery_comments WHERE work_id = ?', [workId]);
  await run('DELETE FROM gallery_works WHERE id = ?', [workId]);
  fs.rm(path.join(GALLERY_DIR, String(workId)), { recursive: true, force: true }, () => {});
}

// ===== Загрузка страниц =====

let sharp = null;
function getSharp() {
  if (sharp === null) {
    try {
      sharp = require('sharp');
      sharp.cache(false);
    } catch (e) {
      sharp = false;
    }
  }
  return sharp || null;
}

// Размеры + анимированность (GIF/WebP с несколькими кадрами) и превью для
// сетки: статичные картинки ужимаются до THUMB_WIDTH в webp (на слабом
// сервере сетка из полноразмерных артов грузилась бы долго), анимированные
// остаются как есть — превью GIF тоже должно двигаться.
async function processUploadedFile(file) {
  const s = getSharp();
  const info = { width: null, height: null, animated: false, thumbName: null };
  if (!s) return info;
  try {
    const meta = await s(file.path, { animated: true, limitInputPixels: false }).metadata();
    info.width = meta.width || null;
    info.height = meta.pageHeight || meta.height || null;
    info.animated = (meta.pages || 1) > 1;
    if (!info.animated && info.width && info.width > THUMB_WIDTH) {
      const thumbName = file.filename.replace(/\.[^.]+$/, '') + '.thumb.webp';
      await s(file.path, { limitInputPixels: false })
        .rotate()
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(path.join(path.dirname(file.path), thumbName));
      info.thumbName = thumbName;
    }
  } catch (e) {
    console.error('[gallery] Не удалось обработать картинку', file.filename, e.message);
  }
  return info;
}

/**
 * Загруженные multer'ом файлы: без pageId каждый файл — новая страница в
 * конце работы (её единственная вариация); с pageId — новые вариации этой
 * страницы. Имена/роли вариаций задаются потом через updateWork.
 * @returns {Promise<object[]>} новые вариации (rowToVariant, с pageId)
 */
async function addImages(workId, files, pageId) {
  const countRow = await get('SELECT COUNT(*) as count FROM gallery_images WHERE work_id = ?', [workId]);
  if ((countRow ? countRow.count : 0) + files.length > MAX_IMAGES_PER_WORK) {
    throw new Error(`В одной работе не больше ${MAX_IMAGES_PER_WORK} картинок`);
  }
  let pagePos = 0;
  let variantPos = 0;
  if (pageId) {
    const row = await get('SELECT COUNT(*) as count, MAX(position) as pos FROM gallery_images WHERE page_id = ?', [pageId]);
    if ((row ? row.count : 0) + files.length > MAX_VARIANTS_PER_PAGE) {
      throw new Error(`У страницы не больше ${MAX_VARIANTS_PER_PAGE} вариаций`);
    }
    variantPos = row && row.pos != null ? row.pos + 1 : 0;
  } else {
    const row = await get('SELECT MAX(position) as pos FROM gallery_pages WHERE work_id = ?', [workId]);
    pagePos = row && row.pos != null ? row.pos + 1 : 0;
  }

  const added = [];
  for (const file of files) {
    const info = await processUploadedFile(file);
    let targetPage = pageId;
    let position = 0;
    if (pageId) position = variantPos++;
    else targetPage = (await run('INSERT INTO gallery_pages (work_id, position) VALUES (?, ?)', [workId, pagePos++])).lastID;
    const fileUrl = `/uploads/gallery/${workId}/${file.filename}`;
    const thumbUrl = info.thumbName ? `/uploads/gallery/${workId}/${info.thumbName}` : null;
    const { lastID } = await run(
      `INSERT INTO gallery_images (work_id, page_id, name, file_url, thumb_url, width, height, is_animated, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [workId, targetPage, cleanVariantName('', position), fileUrl, thumbUrl, info.width, info.height, info.animated ? 1 : 0, position]
    );
    added.push(rowToVariant(await get('SELECT * FROM gallery_images WHERE id = ?', [lastID])));
  }
  await run('UPDATE gallery_works SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [workId]);
  return added;
}

async function getPage(workId, pageId) {
  return get('SELECT * FROM gallery_pages WHERE id = ? AND work_id = ?', [toId(pageId), workId]);
}

// ===== Встраивание в статьи (image-блок с data.gallery) =====

/**
 * Возвращает НОВЫЙ документ статьи, в котором у image-блоков, привязанных
 * к работе галереи (data.gallery = {workId, imageId} — imageId это id
 * вариации страницы), src подставлен из галереи — всегда актуальная картинка.
 * Работа или вариация, недоступная читателю, — src пустой и gallery.locked
 * (картинка закрытой вариации не должна утекать через статью); удалённая
 * вариация — обложка работы; удалённая работа — gallery.missing (остаётся
 * последний сохранённый src).
 */
async function resolveEmbedsInDocument(doc, user) {
  if (!doc || !Array.isArray(doc.blocks)) return doc;
  const refs = [];
  articleLayers.blocks.visitBlocks(doc, (block) => {
    if (block.type === 'image' && block.data && block.data.gallery && toId(block.data.gallery.workId)) refs.push(block.data.gallery);
  });
  if (!refs.length) return doc;

  const workIds = [...new Set(refs.map((r) => toId(r.workId)))];
  const rows = await all(`SELECT * FROM gallery_works WHERE id IN (${placeholders(workIds)})`, workIds);
  const works = new Map(rows.map((r) => [r.id, rowToWork(r)]));
  const images = await all(`SELECT * FROM gallery_images WHERE work_id IN (${placeholders(workIds)})`, workIds);
  const imageById = new Map(images.map((img) => [img.id, img]));
  const ctx = await getAccessContext(user);
  const covers = await getCoversForWorks([...works.values()], ctx);

  const mapBlock = (block) => {
    if (block.type === 'image' && block.data && block.data.gallery && toId(block.data.gallery.workId)) {
      const workId = toId(block.data.gallery.workId);
      const work = works.get(workId);
      const gallery = { workId, imageId: toId(block.data.gallery.imageId) };
      if (!work) return { ...block, data: { ...block.data, gallery: { ...gallery, missing: true } } };
      const img = gallery.imageId && imageById.get(gallery.imageId);
      const own = img && img.work_id === workId ? img : null;
      const visible = own ? canViewVariant(work, own.roles, ctx) : canViewWork(work, ctx);
      const src = own ? own.file_url : (covers.get(workId).cover || {}).url;
      if (!visible || !src) return { ...block, data: { ...block.data, src: '', gallery: { ...gallery, locked: true } } };
      return { ...block, data: { ...block.data, src, gallery: { ...gallery, title: work.title } } };
    }
    if (block.type === 'columns') {
      return { ...block, data: { columns: block.data.columns.map((c) => ({ ...c, blocks: c.blocks.map(mapBlock) })) } };
    }
    if (block.type === 'spoiler-section') {
      return { ...block, data: { ...block.data, blocks: block.data.blocks.map(mapBlock) } };
    }
    return block;
  };
  return { ...doc, blocks: doc.blocks.map(mapBlock) };
}

module.exports = {
  SCROLL_MODES,
  getAccessContext,
  canViewWork,
  canViewVariant,
  canAssignRoles,
  getWorkRow,
  getPagesForUser,
  getVariantRolesMap,
  getCoversForWorks,
  getCountsForWorks,
  getAssociatedIds,
  listWorks,
  listTags,
  listWorksForArticle,
  createWork,
  updateWork,
  deleteWork,
  addImages,
  getPage,
  removeImageFiles,
  resolveEmbedsInDocument,
  getLikeSummary,
  toggleLike,
  recordView,
  getViewCount,
  listComments,
  getComment,
  addComment,
  deleteCommentCascade
};
