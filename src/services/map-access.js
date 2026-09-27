// map-access.js — кто видит и кто правит карты, и сборка "версии карты для
// конкретного читателя".
//
// Доступ устроен как у статей (см. article-layers.js): роли — ссылки
// {scope:'system'|'server', id}, server-роли — роли сервера карты (мира).
// Пустой список ролей = открыто всем. Владелец (is_root) и доверенный админ
// (is_role_manager) видят всё.
//
// Скрытое фильтрует СЕРВЕР: если отдавать браузеру всю карту и прятать зоны
// там, их было бы видно в сетевых запросах.

const { serversDb } = require('../db/connections');
const articleLayers = require('./article-layers');
const articlesStore = require('./articles-store');
const { isAdminOnServer } = require('./server-permissions');
const store = require('./maps-store');

function bypasses(user) {
  return !!(user && (user.is_root || user.is_role_manager));
}

function rolesMatch(roles, user, serverRoleIds) {
  if (!roles || roles.length === 0) return true;
  return roles.some((r) => {
    if (r.scope === 'system') return user.admin_role_id != null && Number(user.admin_role_id) === Number(r.id);
    if (r.scope === 'server') return serverRoleIds.includes(Number(r.id));
    return false;
  });
}

async function serverRoleIdsFor(user, map) {
  return map.serverId ? articleLayers.getUserServerRoleIds(user.id, map.serverId) : [];
}

async function canViewMap(user, map, serverRoleIds) {
  if (bypasses(user)) return true;
  const ids = serverRoleIds || await serverRoleIdsFor(user, map);
  return rolesMatch(map.roles, user, ids);
}

async function isServerAdmin(user, serverId) {
  if (!serverId) return false;
  if (user.is_root) return true;
  try { return await isAdminOnServer(user.id, serverId); } catch (e) { return false; }
}

// Править: владелец, доверенный админ, автор, соавторы, админ сервера карты.
async function canEditMap(user, map) {
  if (bypasses(user)) return true;
  if (map.author_id === user.id || map.co_author_ids.includes(user.id)) return true;
  return isServerAdmin(user, map.serverId);
}

// Удалить: автор, владелец, админ сервера (соавторам — нет, как у статей).
async function canDeleteMap(user, map) {
  if (user.is_root) return true;
  if (map.author_id === user.id) return true;
  return isServerAdmin(user, map.serverId);
}

function isServerMember(userId, serverId) {
  return new Promise((resolve) => {
    serversDb.get(
      'SELECT 1 FROM user_server_memberships WHERE user_id = ? AND server_id = ?',
      [userId, serverId],
      (err, row) => resolve(!err && !!row)
    );
  });
}

// Создать карту в мире может участник этого сервера (и те, кто обходит закрытость).
async function canCreateMapOn(user, serverId) {
  if (bypasses(user)) return true;
  return isServerMember(user.id, serverId);
}

function getServerName(serverId) {
  return new Promise((resolve) => {
    if (!serverId) return resolve(null);
    serversDb.get('SELECT name FROM servers WHERE id = ?', [serverId], (err, row) => resolve(err || !row ? null : row.name));
  });
}

function publicBasemaps(map) {
  return map.basemaps
    .filter((b) => b.status === 'ready')
    .map((b) => ({ id: b.id, title: b.title, url: store.tilesUrl(map.id, b), maxZoom: b.maxZoom, width: b.width, height: b.height, from: b.from, to: b.to }));
}

/**
 * Версия карты для читателя: только видимые ему зоны, у зон с закрытой
 * статьёй — «замок» (без ссылки) или зона скрыта целиком (lockedMode).
 * Скрытая зона скрывает и всех своих потомков.
 */
async function buildViewerMap(user, map) {
  const serverRoleIds = await serverRoleIdsFor(user, map);
  const bypass = bypasses(user);
  const byId = new Map(map.zones.map((z) => [z.id, z]));
  const visibility = new Map(); // id -> boolean

  const articleCache = new Map(); // slug -> { exists, access, title }
  async function articleInfo(slug) {
    if (articleCache.has(slug)) return articleCache.get(slug);
    const article = articlesStore.getArticle(slug);
    let info;
    if (!article) info = { exists: false, access: false, title: null };
    else {
      const access = bypass || await articleLayers.hasArticleAccess(article, user);
      info = { exists: true, access, title: access ? article.title : null };
    }
    articleCache.set(slug, info);
    return info;
  }

  const out = [];
  // Родители раньше детей: видимость ребёнка зависит от видимости родителя.
  const ordered = [];
  const visited = new Set();
  const visit = (z) => {
    if (visited.has(z.id)) return;
    visited.add(z.id);
    if (z.parentId && byId.has(z.parentId)) visit(byId.get(z.parentId));
    ordered.push(z);
  };
  map.zones.forEach(visit);

  for (const z of ordered) {
    const parentVisible = z.parentId ? visibility.get(z.parentId) !== false : true;
    let visible = parentVisible && (bypass || rolesMatch(z.roles, user, serverRoleIds));
    let article = z.article;
    let articleTitle = null;
    let articleMissing = false;
    let locked = false;

    if (visible && article) {
      const info = await articleInfo(article);
      if (!info.exists) {
        articleMissing = true;
      } else if (!info.access) {
        if (z.lockedMode === 'hide') visible = false;
        else { locked = true; article = null; }
      } else {
        articleTitle = info.title;
      }
    }
    visibility.set(z.id, visible);
    if (!visible) continue;

    out.push({
      id: z.id,
      parentId: z.parentId,
      typeId: z.typeId,
      title: z.title,
      article,
      articleTitle,
      articleMissing,
      locked,
      style: z.style || null,
      from: z.from,
      to: z.to,
      shapes: z.shapes
    });
  }

  // Метки: свои роли; метка в скрытой зоне скрыта вместе с зоной; закрытая
  // статья — «замок» или метка скрыта (как у зон).
  const markers = [];
  for (const m of map.markers || []) {
    if (m.zoneId && visibility.get(m.zoneId) === false) continue;
    if (!(bypass || rolesMatch(m.roles, user, serverRoleIds))) continue;
    let article = m.article;
    let articleTitle = null;
    let articleMissing = false;
    let locked = false;
    if (article) {
      const info = await articleInfo(article);
      if (!info.exists) articleMissing = true;
      else if (!info.access) {
        if (m.lockedMode === 'hide') continue;
        locked = true;
        article = null;
      } else articleTitle = info.title;
    }
    markers.push({ id: m.id, typeId: m.typeId, title: m.title, text: m.text, article, articleTitle, articleMissing, locked, from: m.from, to: m.to, pos: m.pos });
  }

  // События: связи — только с видимыми читателю зонами и метками; закрытая
  // статья события — без ссылки (само событие остаётся на шкале).
  const visibleZoneIds = new Set(out.map((z) => z.id));
  const visibleMarkerIds = new Set(markers.map((m) => m.id));
  const events = [];
  for (const e of map.events || []) {
    let article = e.article;
    let articleTitle = null;
    let articleMissing = false;
    let locked = false;
    if (article) {
      const info = await articleInfo(article);
      if (!info.exists) articleMissing = true;
      else if (!info.access) { locked = true; article = null; }
      else articleTitle = info.title;
    }
    events.push({
      id: e.id, from: e.from, to: e.to, title: e.title, text: e.text,
      article, articleTitle, articleMissing, locked,
      zoneIds: e.zoneIds.filter((id) => visibleZoneIds.has(id)),
      markerIds: e.markerIds.filter((id) => visibleMarkerIds.has(id))
    });
  }
  return { zones: out, markers, events };
}

module.exports = {
  bypasses,
  canViewMap,
  canEditMap,
  canDeleteMap,
  canCreateMapOn,
  isServerAdmin,
  getServerName,
  publicBasemaps,
  buildViewerMap
};
