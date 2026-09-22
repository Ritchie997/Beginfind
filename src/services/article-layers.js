// article-layers.js — «многослойные статьи»: одна статья, несколько версий
// содержимого (и заголовка/excerpt/картинки) под разные роли читателя.
//
// Слой — { id, roles, title, excerpt, image, content }. roles — OR-список
// ролей ДВУХ каталогов сразу: { scope:'system', id } — роль из общего
// каталога admin_roles (players.admin_role_id), { scope:'server', id } —
// роль КОНКРЕТНОГО сервера статьи (server_roles, через
// user_server_role_assignments). Пустой roles = слой публичный.
//
// Порядок слоёв в массиве article.layers — это и есть "уровень": слой с
// БОЛЬШИМ индексом закрытее. Никаких числовых порогов/весов ролей друг
// относительно друга не сравнивается — только принадлежность роли (см.
// обсуждение "многослойные статьи", пункт A: "никаких числовых порогов").
//
// Читателю резолвится САМЫЙ ВЕРХНИЙ слой, до чьих ролей он "дотягивается";
// достигнув его, он может произвольно спуститься к любому слою ниже —
// доступ выше автоматически даёт доступ и ко всему, что ниже (см. пункт D,
// "селектор" в клиенте).
//
// Статья БЕЗ layers (обычная, как было до этой фичи) — с точки зрения этого
// модуля один "виртуальный" слой, синтезированный из старых полей
// title/excerpt/image/content/locked/roles (см. legacyLayers) — старые
// статьи продолжают работать без миграции, один в один как раньше вело себя
// canAccessArticle в articles.routes.js.

const { serversDb } = require('../db/connections');
const { isAdminOnServer } = require('./server-permissions');
const blocks = require('./blocks');

function genId() {
  try {
    return require('crypto').randomUUID();
  } catch (e) {
    return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
}

function str(v, fallback = '') {
  return typeof v === 'string' ? v : fallback;
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// === Ссылка на роль ({scope, id}) и список ролей слоя ===

function normalizeRoleRef(raw) {
  if (!isPlainObject(raw)) return null;
  const scope = raw.scope === 'system' || raw.scope === 'server' ? raw.scope : null;
  const id = parseInt(raw.id, 10);
  if (!scope || !Number.isInteger(id) || id <= 0) return null;
  return { scope, id };
}

function normalizeLayerRoles(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const ref = normalizeRoleRef(r);
    if (!ref) continue;
    const key = `${ref.scope}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function roleRefsEqual(a, b) {
  if (a.length !== b.length) return false;
  const key = (r) => `${r.scope}:${r.id}`;
  const setA = new Set(a.map(key));
  return b.every((r) => setA.has(key(r)));
}

// === Один слой / массив слоёв — нормализация для хранения ===

function normalizeLayer(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    id: str(raw.id) || genId(),
    roles: normalizeLayerRoles(raw.roles),
    // public — явная отметка "этот слой без ролей нарочно открыт всем", а
    // не молча оставленная пустой. См. findAmbiguousPublicLayer ниже: без
    // этой отметки статью со смесью "слой с ролями" + "слой без ролей" сохранить
    // нельзя — раньше именно так пустой слой тихо открывал всю статью любому
    // читателю, даже когда другой слой той же статьи был ограничен ролью.
    public: raw.public === true,
    title: str(raw.title),
    excerpt: str(raw.excerpt),
    image: raw.image || null,
    content: blocks.normalizeDocument(raw.content)
  };
}

/**
 * Нормализует article.layers для записи на диск. Пустой/некорректный вход —
 * [] (это ЗНАЧИТ "статья не использует слои", а не ошибку — тогда действуют
 * обычные верхнеуровневые title/content/excerpt/image/locked/roles, как и
 * раньше).
 */
function normalizeLayers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeLayer).filter(Boolean);
}

// === Легаси-статья (без layers) → один виртуальный слой ===
//
// Повторяет прежнее поведение canAccessArticle 1:1: не locked — слой
// публичный; locked — слой с ролями article.roles (числа id server_roles,
// как и раньше; путь для них ВСЕГДА scope:'server' — легаси-статьи ничего не
// знают про системный каталог admin_roles).
function legacyLayers(article) {
  const roles = article.locked
    ? (article.roles || [])
        .map((id) => ({ scope: 'server', id: parseInt(id, 10) }))
        .filter((r) => Number.isInteger(r.id) && r.id > 0)
    : [];
  return [{
    id: '__legacy__',
    roles,
    title: article.title,
    excerpt: article.excerpt,
    image: article.image,
    content: article.content
  }];
}

/**
 * Слои статьи "как есть" для резолва доступа/отображения — реальные
 * article.layers, если статья ими пользуется, иначе синтезированный
 * единственный слой из старых полей (см. legacyLayers).
 */
function getEffectiveLayers(article) {
  if (Array.isArray(article.layers) && article.layers.length > 0) return article.layers;
  return legacyLayers(article);
}

// === Резолв доступа ===

function getUserServerRoleIds(userId, serverId) {
  return new Promise((resolve) => {
    serversDb.all(
      'SELECT role_id FROM user_server_role_assignments WHERE user_id = ? AND server_id = ?',
      [userId, serverId],
      (err, rows) => resolve(err || !rows ? [] : rows.map((r) => r.role_id))
    );
  });
}

function articleServerId(article) {
  const id = parseInt(article.server, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function layerRolesMatch(roles, user, userServerRoleIds) {
  if (!roles || roles.length === 0) return true; // публичный слой
  return roles.some((r) => {
    if (!r) return false;
    if (r.scope === 'system') return user.admin_role_id != null && Number(user.admin_role_id) === Number(r.id);
    if (r.scope === 'server') return userServerRoleIds.includes(Number(r.id));
    return false;
  });
}

/**
 * Резолвит для пользователя самый верхний слой статьи, до которого он
 * "дотягивается" своими ролями (общесистемной ИЛИ ролью на сервере статьи).
 * root и админ сервера статьи — как и раньше с article.locked — сразу
 * получают самый верхний (закрытый) слой, без проверки списков ролей.
 * @returns {Promise<{index:number, layer:object, layers:object[]}|null>}
 *   null — нет доступа НИ К ОДНОМУ слою (используется для узла-заглушки в
 *   графе и маркера "[не доступно]" у wiki-ссылок).
 */
async function resolveArticleLayer(article, user) {
  const layers = getEffectiveLayers(article);
  if (!layers.length) return null;
  const topIndex = layers.length - 1;

  if (user.is_root) return { index: topIndex, layer: layers[topIndex], layers };

  const serverId = articleServerId(article);

  if (serverId && await isAdminOnServer(user.id, serverId)) {
    return { index: topIndex, layer: layers[topIndex], layers };
  }

  const userServerRoleIds = serverId ? await getUserServerRoleIds(user.id, serverId) : [];
  for (let i = topIndex; i >= 0; i--) {
    if (layerRolesMatch(layers[i].roles, user, userServerRoleIds)) {
      return { index: i, layer: layers[i], layers };
    }
  }
  return null;
}

/**
 * Булев короткий путь — замена прежнего canAccessArticle: есть доступ хотя
 * бы к одному (самому нижнему) слою статьи.
 */
async function hasArticleAccess(article, user) {
  return (await resolveArticleLayer(article, user)) !== null;
}

/**
 * Может ли пользователь прочитать/редактировать слой с данным индексом —
 * "максимально себе доступный": да, если этот слой не выше того, что ему и
 * так резолвится (все слои НИЖЕ достигнутого — тоже доступны, см. каскад).
 */
async function canAccessLayerIndex(article, user, layerIndex) {
  const resolved = await resolveArticleLayer(article, user);
  if (!resolved) return false;
  return layerIndex <= resolved.index;
}

/**
 * Может ли пользователь создать/оставить слой с данным списком ролей —
 * только если сам под эти роли подходит (иначе он писал бы содержимое,
 * которое впоследствии не может даже проверить сам). Пустой список (слой
 * публичный) — можно всегда, без похода в БД.
 */
async function canCreateLayerWithRoles(article, user, roles) {
  const normalized = normalizeLayerRoles(roles);
  if (normalized.length === 0) return true;
  if (user.is_root) return true;
  const serverId = articleServerId(article);
  if (serverId && await isAdminOnServer(user.id, serverId)) return true;
  const userServerRoleIds = serverId ? await getUserServerRoleIds(user.id, serverId) : [];
  return layerRolesMatch(normalized, user, userServerRoleIds);
}

/**
 * Находит слой без ролей, который никак не помечен публичным, в статье, где
 * ЕСТЬ другой слой с ролями — сам по себе слой без ролей это ок (обычная
 * незакрытая статья/единственный слой), проблема только в СМЕСИ: рядом с
 * реально ограниченным слоем пустой слой без явной пометки "публичный",
 * скорее всего, просто забыли настроить, а не намеренно оставили дырой.
 * @returns {object|null} первый такой слой или null, если всё однозначно.
 */
function findAmbiguousPublicLayer(layers) {
  if (!Array.isArray(layers) || layers.length < 2) return null;
  const hasRestricted = layers.some((l) => l && Array.isArray(l.roles) && l.roles.length > 0);
  if (!hasRestricted) return null;
  return layers.find((l) => l && (!Array.isArray(l.roles) || l.roles.length === 0) && l.public !== true) || null;
}

// === Слияние слоёв при PUT /articles/:id ===
//
// Клиент присылает layers = [слой0 .. слойK] — ровно то, что сам видел (все
// слои от 0 до своего резолвнутого максимума M "до" правки), возможно
// отредактированные/удалённые/переставленными местами (см. ручная
// перестановка слоёв в редакторе), возможно с НОВЫМИ слоями. Всё, что
// физически лежало ВЫШЕ M в уже сохранённой статье, клиент никогда не
// получал через GET — оно молча сохраняется как есть следом за тем, что
// прислал клиент, а не перетирается и не отдаётся ему на просмотр.
//
// Роли КАЖДОГО присланного слоя проверяются через canCreateLayerWithRoles —
// не только тех, что выше прежнего индекса M (как было раньше). Раньше слой,
// уже лежавший в пределах доступа редактора, никогда не проверялся повторно
// — можно было молча поставить ему чужую роль (которой сам редактор не
// обладает). Пока слои шли строго по возрастанию номера, это было не
// эксплуатируемо; со свободной перестановкой стало бы дырой: такой
// "перегороженный" слой можно было бы опустить туда, где он первым подойдёт
// РЕАЛЬНОМУ обладателю той роли — подсунуть контент группе, которую сам
// редактор даже не должен был иметь права назначать.
// @returns {Promise<{layers:object[]}|{error:string}>}
async function mergeLayersUpdate(existingArticle, user, bodyLayers) {
  const before = await resolveArticleLayer(existingArticle, user);
  const maxIndex = before ? before.index : -1;

  for (const layer of bodyLayers) {
    const ok = await canCreateLayerWithRoles(existingArticle, user, layer && layer.roles);
    if (!ok) {
      return { error: 'Нельзя создать или изменить роли слоя на те, которых у вас нет — сначала эта роль должна быть назначена вам самому' };
    }
  }

  const normalizedPart = normalizeLayers(bodyLayers);
  const preservedTail = getEffectiveLayers(existingArticle).slice(maxIndex + 1);
  const merged = [...normalizedPart, ...preservedTail];

  const ambiguous = findAmbiguousPublicLayer(merged);
  if (ambiguous) {
    return { error: `Слой "${ambiguous.title || 'без названия'}" без ролей соседствует со слоем, у которого роли есть — отметьте его публичным или задайте ему роли` };
  }

  return { layers: merged };
}

module.exports = {
  normalizeLayers,
  normalizeLayerRoles,
  normalizeRoleRef,
  roleRefsEqual,
  getEffectiveLayers,
  resolveArticleLayer,
  hasArticleAccess,
  canAccessLayerIndex,
  canCreateLayerWithRoles,
  findAmbiguousPublicLayer,
  mergeLayersUpdate,
  getUserServerRoleIds,
  articleServerId,
  // Реэкспорт blocks — для текста/ссылок/хэштегов по всем слоям сразу (см.
  // articles-store.js: allLayersSearchText/allLayersWikiLinks/allLayersHashtags).
  blocks
};
