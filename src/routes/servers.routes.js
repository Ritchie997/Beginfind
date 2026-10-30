// servers.routes.js — API "серверов" (Discord-подобные пространства):
// CRUD серверов, ролей на сервере, участников и владения.

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const auth = require('../middleware/auth');
const serverSystem = require('../services/server-system-logic');
const { isAdminOnServer, canManageUser } = require('../services/server-permissions');
const { dbPath } = require('../config/paths');
const articlesStore = require('../services/articles-store');
const { serversSchemaReady } = require('../db/connections');

const router = express.Router();
const HUB_STATUSES = new Set(['active', 'paused', 'finished']);

router.use((req, res, next) => {
  serversSchemaReady.then(() => next()).catch(() => {
    res.status(500).json({ error: 'Не удалось подготовить базу франшиз' });
  });
});

// "Админ сервера" для проверок в этом файле: владелец системы (is_root)
// администрирует любой сервер, а владелец сервера сохраняет права независимо
// от назначенных ролей. Остальным нужна системная роль admin.
async function isServerAdmin(user, serverId) {
  if (user.is_root) return true;
  if (await isServerOwner(user.id, serverId)) return true;
  return isAdminOnServer(user.id, serverId);
}

async function isServerOwner(userId, serverId) {
  const server = await dbGet('servers.db', 'SELECT owner_id FROM servers WHERE id = ?', [serverId]);
  return !!server && Number(server.owner_id) === Number(userId);
}

// Одиночный SELECT к указанной БД (отдельное соединение на запрос, как и
// в остальном файле).
function dbGet(dbFile, sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath(dbFile));
    db.get(sql, params, (err, row) => {
      db.close();
      if (err) reject(err); else resolve(row);
    });
  });
}

function dbAll(dbFile, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath(dbFile));
    db.all(sql, params, (err, rows) => {
      db.close();
      if (err) reject(err); else resolve(rows);
    });
  });
}

function dbRun(dbFile, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath(dbFile));
    db.run(sql, params, function(err) {
      db.close();
      if (err) reject(err); else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

async function hubSummariesByServer() {
  const rows = await dbAll('servers.db', `
    SELECT server_id, status, COUNT(*) AS count
    FROM franchise_hubs
    GROUP BY server_id, status
  `);
  const summaries = new Map();
  for (const row of rows) {
    if (!summaries.has(row.server_id)) {
      summaries.set(row.server_id, { total: 0, active: 0, paused: 0, finished: 0 });
    }
    const summary = summaries.get(row.server_id);
    summary[row.status] = row.count;
    summary.total += row.count;
  }
  return summaries;
}

function hubActorName(user) {
  return user.display_name || user.username || `Пользователь ${user.id}`;
}

// Получение всех серверов
router.get('/servers', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const [servers, summaries] = await Promise.all([
      serverSystem.getAllServersWithUserCount(),
      hubSummariesByServer()
    ]);
    for (const server of servers) {
      server.hub_summary = summaries.get(server.id) || { total: 0, active: 0, paused: 0, finished: 0 };
    }
    res.json(servers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Хабы франшизы (внутреннее имя верхнего уровня — server).
router.get('/servers/:id/hubs', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const serverId = Number(req.params.id);
    const server = await dbGet('servers.db', 'SELECT id FROM servers WHERE id = ?', [serverId]);
    if (!server) return res.status(404).json({ error: 'Franchise not found' });
    const canManage = await isServerAdmin(req.user, serverId);
    const hubs = await dbAll('servers.db', `
      SELECT id, server_id, name, description, avatar_url, status, created_by,
             created_by_name, is_public, status_updated_at, status_updated_by,
             status_updated_by_name, created_at, updated_at
      FROM franchise_hubs
      WHERE server_id = ? AND (is_public = 1 OR ? = 1)
      ORDER BY created_at DESC, id DESC
    `, [serverId, canManage ? 1 : 0]);
    res.json(hubs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/servers/:id/hubs', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const serverId = Number(req.params.id);
    if (!Number.isInteger(serverId) || serverId < 1) return res.status(400).json({ error: 'Invalid franchise id' });
    if (!(await dbGet('servers.db', 'SELECT id FROM servers WHERE id = ?', [serverId]))) {
      return res.status(404).json({ error: 'Franchise not found' });
    }
    if (!(await isServerAdmin(req.user, serverId))) {
      return res.status(403).json({ error: 'Only the franchise creator or an administrator can manage hubs' });
    }
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
    if (!name || name.length > 120) return res.status(400).json({ error: 'Hub name is required and must be at most 120 characters' });
    if (description.length > 1000) return res.status(400).json({ error: 'Hub description must be at most 1000 characters' });
    const actor = hubActorName(req.user);
    const isPublic = req.body.is_public === true;
    const avatarUrl = typeof req.body.avatar_url === 'string' ? (req.body.avatar_url.trim() || null) : null;
    const result = await dbRun('servers.db', `
      INSERT INTO franchise_hubs (server_id, name, description, is_public, avatar_url, created_by, created_by_name, status_updated_by, status_updated_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [serverId, name, description, isPublic ? 1 : 0, avatarUrl, req.user.id, actor, req.user.id, actor]);
    const hub = await dbGet('servers.db', 'SELECT * FROM franchise_hubs WHERE id = ?', [result.lastID]);
    await serverSystem.logServerAction(serverId, req.user.id, actor, 'hub_created', { hubId: hub.id, name, isPublic });
    res.status(201).json(hub);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/servers/:id/hubs/:hubId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const serverId = Number(req.params.id);
    const hubId = Number(req.params.hubId);
    if (!(await isServerAdmin(req.user, serverId))) {
      return res.status(403).json({ error: 'Only the franchise creator or an administrator can manage hubs' });
    }
    const existing = await dbGet('servers.db', 'SELECT * FROM franchise_hubs WHERE id = ? AND server_id = ?', [hubId, serverId]);
    if (!existing) return res.status(404).json({ error: 'Hub not found in this franchise' });
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
    if (!name || name.length > 120) return res.status(400).json({ error: 'Hub name is required and must be at most 120 characters' });
    if (description.length > 1000) return res.status(400).json({ error: 'Hub description must be at most 1000 characters' });
    if (req.body.is_public != null && typeof req.body.is_public !== 'boolean') {
      return res.status(400).json({ error: 'Visibility must be a boolean' });
    }
    const isPublic = req.body.is_public == null ? existing.is_public === 1 : req.body.is_public;
    const avatarUrl = req.body.avatar_url !== undefined
      ? (typeof req.body.avatar_url === 'string' ? req.body.avatar_url.trim() : null)
      : existing.avatar_url;
    await dbRun('servers.db', `
      UPDATE franchise_hubs SET name = ?, description = ?, is_public = ?, avatar_url = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND server_id = ?
    `, [name, description, isPublic ? 1 : 0, avatarUrl, hubId, serverId]);
    const actor = hubActorName(req.user);
    await serverSystem.logServerAction(serverId, req.user.id, actor, 'hub_updated', { hubId, name, isPublic });
    res.json(await dbGet('servers.db', 'SELECT * FROM franchise_hubs WHERE id = ?', [hubId]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/servers/:id/hubs/:hubId/status', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const serverId = Number(req.params.id);
    const hubId = Number(req.params.hubId);
    if (!(await isServerAdmin(req.user, serverId))) {
      return res.status(403).json({ error: 'Only the franchise creator or an administrator can manage hubs' });
    }
    const status = req.body.status;
    if (!HUB_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid hub status' });
    const existing = await dbGet('servers.db', 'SELECT id, status FROM franchise_hubs WHERE id = ? AND server_id = ?', [hubId, serverId]);
    if (!existing) return res.status(404).json({ error: 'Hub not found in this franchise' });
    const actor = hubActorName(req.user);
    await dbRun('servers.db', `
      UPDATE franchise_hubs
      SET status = ?, status_updated_at = CURRENT_TIMESTAMP, status_updated_by = ?,
          status_updated_by_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND server_id = ?
    `, [status, req.user.id, actor, hubId, serverId]);
    await serverSystem.logServerAction(serverId, req.user.id, actor, 'hub_status_changed', { hubId, from: existing.status, to: status });
    res.json(await dbGet('servers.db', 'SELECT * FROM franchise_hubs WHERE id = ?', [hubId]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/servers/:id/hubs/:hubId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const serverId = Number(req.params.id);
    const hubId = Number(req.params.hubId);
    if (!(await isServerAdmin(req.user, serverId))) {
      return res.status(403).json({ error: 'Only the franchise creator or an administrator can manage hubs' });
    }
    const hub = await dbGet('servers.db', 'SELECT id, name FROM franchise_hubs WHERE id = ? AND server_id = ?', [hubId, serverId]);
    if (!hub) return res.status(404).json({ error: 'Hub not found in this franchise' });
    const linkedPosts = await dbGet('servers.db', 'SELECT COUNT(*) AS count FROM franchise_posts WHERE hub_id = ?', [hubId]);
    if (linkedPosts && linkedPosts.count > 0) {
      return res.status(409).json({
        error: `Hub is linked to ${linkedPosts.count} franchise publication(s). Remove or change those links before deleting it.`,
        linked_posts: linkedPosts.count
      });
    }
    const linkedArticles = [...articlesStore.listArticles(), ...articlesStore.listTrashedArticles()]
      .filter(article => Number(article.hub_id) === hubId).length;
    if (linkedArticles) {
      return res.status(409).json({
        error: `Hub is linked to ${linkedArticles} article(s). Remove or change those links before deleting it.`,
        linked_articles: linkedArticles
      });
    }
    await dbRun('servers.db', 'DELETE FROM franchise_hubs WHERE id = ? AND server_id = ?', [hubId, serverId]);
    await serverSystem.logServerAction(serverId, req.user.id, hubActorName(req.user), 'hub_deleted', { hubId, name: hub.name });
    res.json({ deleted: 1, hubId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получение сервера по ID
router.get('/servers/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { id } = req.params;
    const server = await serverSystem.getServerWithDetails(id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }
    res.json(server);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Создание нового сервера
router.post('/servers', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { name, description, avatar_url } = req.body;
    const server = await serverSystem.createServer(name, description, req.user.id, avatar_url);
    // Добавляем владельца как администратора сервера
    await serverSystem.addUserToServer(req.user.id, server.id);
    const roles = await serverSystem.getRolesOnServer(server.id);
    const adminRole = roles.find(role => role.name === 'admin' && role.role_type === 'system');
    if (adminRole) {
      await serverSystem.assignRoleToUserOnServer(req.user.id, server.id, adminRole.id);
    }
    await serverSystem.logServerAction(server.id, req.user.id, (req.user.display_name || req.user.username), 'server_created', { name });
    res.json(server);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Обновление сервера (владелец сервера или root)
router.put('/servers/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, avatar_url } = req.body;
    const userId = req.user.id;

    const serversDb = new sqlite3.Database(dbPath('servers.db'));

    serversDb.get('SELECT owner_id FROM servers WHERE id = ?', [id], async (err, row) => {
      if (err) {
        res.status(500).json({ error: err.message });
        serversDb.close();
        return;
      }

      if (!row) {
        res.status(404).json({ error: 'Server not found' });
        serversDb.close();
        return;
      }

      if (row.owner_id !== userId && !req.user.is_root) {
        res.status(403).json({ error: 'Only server owner or root can update server' });
        serversDb.close();
        return;
      }

      const result = await serverSystem.updateServer(id, name, description, avatar_url);
      if (result.changes === 0) {
        res.status(404).json({ error: 'Server not found' });
      } else {
        await serverSystem.logServerAction(id, req.user.id, (req.user.display_name || req.user.username), 'server_updated', { name, description });
        res.json({ updated: result.changes, serverId: id });
      }
      serversDb.close();
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Удаление сервера (владелец сервера или root) вместе со всеми связанными
// данными (роли, участники, назначения ролей, каналы).
//
// Раньше в проекте было два независимых обработчика на один и тот же путь
// (DELETE /api/servers/:id и DELETE /api/servers/:serverId) — Express всегда
// вызывал первый, поэтому второй (с root-проверкой через сломанный
// role_id === 1 и с каскадной очисткой связанных таблиц) был мёртвым кодом.
// Здесь оба поведения объединены в один рабочий маршрут.
router.delete('/servers/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const serversDb = new sqlite3.Database(dbPath('servers.db'));

    serversDb.get('SELECT owner_id, name FROM servers WHERE id = ?', [id], async (err, row) => {
      serversDb.close();

      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }

      if (!row) {
        res.status(404).json({ error: 'Server not found' });
        return;
      }

      if (row.owner_id !== userId && !req.user.is_root) {
        res.status(403).json({ error: 'Only server owner or root can delete server' });
        return;
      }

      try {
        const hubCount = await dbGet('servers.db', 'SELECT COUNT(*) AS count FROM franchise_hubs WHERE server_id = ?', [id]);
        if (hubCount && hubCount.count > 0) {
          res.status(409).json({ error: 'Сначала удалите хабы франшизы; хабы со связанными статьями удалить нельзя' });
          return;
        }
        // Пишем в журнал ДО удаления — после deleteServer строка сервера
        // (и всё, что на неё формально "ссылалось" бы) уже не существует,
        // но сама запись в server_audit_log остаётся историческим следом
        // ("сервер X удалён пользователем Y") — таблицу журнала
        // deleteServer намеренно не трогает.
        await serverSystem.logServerAction(id, req.user.id, (req.user.display_name || req.user.username), 'server_deleted', { name: row.name });
        const result = await serverSystem.deleteServer(id);
        if (result.changes === 0) {
          res.status(404).json({ error: 'Server not found' });
        } else {
          res.json({ deleted: result.changes, serverId: id });
        }
      } catch (deleteErr) {
        res.status(500).json({ error: deleteErr.message });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получение пользователей на сервере
router.get('/servers/:id/users', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { id } = req.params;
    const users = await serverSystem.getUsersOnServer(id);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получение ролей на сервере
router.get('/servers/:id/roles', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { id } = req.params;
    const roles = await serverSystem.getRolesOnServer(id);
    res.json(roles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Создание роли на сервере
router.post('/servers/:id/roles', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, hierarchy_level, permissions } = req.body;
    const userId = req.user.id;

    const isAdmin = await isServerAdmin(req.user, parseInt(id));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can create roles' });
    }

    const role = await serverSystem.createRoleOnServer(id, name, hierarchy_level, permissions);
    await serverSystem.logServerAction(id, userId, (req.user.display_name || req.user.username), 'role_created', { name, hierarchy_level });
    res.json(role);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Добавление пользователя к серверу — либо сам пользователь (вступление),
// либо администратор сервера (раньше это мог сделать любой approved-пользователь
// для произвольного userId/serverId).
router.post('/servers/:serverId/users/:userId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { serverId } = req.params;
    const userId = Number(req.params.userId);
    const currentUserId = req.user.id;

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Некорректный ID пользователя' });
    }

    if (userId !== currentUserId) {
      const isAdmin = await isServerAdmin(req.user, parseInt(serverId));
      if (!isAdmin) {
        return res.status(403).json({ error: 'Можно добавить только себя, либо быть администратором сервера' });
      }
    }

    // Пользователи и сервера лежат в разных БД, поэтому внешний ключ на
    // users не работает — раньше членство создавалось для любого числа,
    // и "фантомный" участник увеличивал счётчик, не появляясь в списке.
    const targetUser = await dbGet('users.db', 'SELECT id FROM users WHERE id = ?', [userId]);
    if (!targetUser) {
      return res.status(404).json({ error: `Пользователь с ID ${userId} не найден` });
    }
    const server = await dbGet('servers.db', 'SELECT id, is_published FROM servers WHERE id = ?', [serverId]);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }
    if (userId === currentUserId && !server.is_published && !(await isServerAdmin(req.user, serverId))) {
      return res.status(404).json({ error: 'Франшиза не опубликована' });
    }
    const existing = await dbGet('servers.db', 'SELECT 1 FROM user_server_memberships WHERE user_id = ? AND server_id = ?', [userId, serverId]);
    if (existing) {
      return res.status(409).json({ error: 'Пользователь уже состоит на этом сервере' });
    }

    const result = await serverSystem.addUserToServer(userId, serverId);
    await serverSystem.logServerAction(serverId, currentUserId, (req.user.display_name || req.user.username), 'member_added', { targetUserId: userId, self: userId === currentUserId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Удаление пользователя с сервера — сам пользователь (выход из сервера)
// либо администратор сервера. Владельца нельзя удалить как рядового
// участника — сначала нужно передать владение (PUT /servers/:id/owner,
// root) или удалить сам сервер целиком (DELETE /servers/:id), иначе
// servers.owner_id осиротел бы на несуществующего участника.
//
// Раньше этого маршрута не было вовсе, хотя фронтенд (public/spa-router.js,
// apiClient.removeServerUser) всегда вызывал именно его
// (DELETE /api/servers/:serverId/users/:userId) — кнопка "Удалить участника"
// у любого сервера всегда возвращала 404 и ничего не удаляла.
router.delete('/servers/:serverId/users/:userId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { serverId, userId } = req.params;
    const currentUserId = req.user.id;

    if (parseInt(userId) !== currentUserId) {
      const isAdmin = await isServerAdmin(req.user, parseInt(serverId));
      if (!isAdmin) {
        return res.status(403).json({ error: 'Можно удалить только себя, либо быть администратором сервера' });
      }
    }

    const serversDb = new sqlite3.Database(dbPath('servers.db'));

    serversDb.get('SELECT owner_id FROM servers WHERE id = ?', [serverId], (err, row) => {
      if (err) {
        serversDb.close();
        return res.status(500).json({ error: err.message });
      }

      if (!row) {
        serversDb.close();
        return res.status(404).json({ error: 'Server not found' });
      }

      if (row.owner_id === parseInt(userId)) {
        serversDb.close();
        return res.status(403).json({ error: 'Нельзя удалить владельца сервера — сначала передайте владение или удалите сервер' });
      }

      serversDb.serialize(() => {
        serversDb.run('DELETE FROM user_server_role_assignments WHERE user_id = ? AND server_id = ?', [userId, serverId], (err) => {
          if (err) {
            serversDb.close();
            return res.status(500).json({ error: err.message });
          }

          serversDb.run('DELETE FROM user_server_memberships WHERE user_id = ? AND server_id = ?', [userId, serverId], async function (err) {
            serversDb.close();
            if (err) {
              return res.status(500).json({ error: err.message });
            }
            const isSelf = parseInt(userId) === currentUserId;
            await serverSystem.logServerAction(serverId, currentUserId, (req.user.display_name || req.user.username), 'member_removed', { targetUserId: parseInt(userId), self: isSelf });
            res.json({ deleted: this.changes, userId, serverId });
          });
        });
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Назначение роли пользователю на сервере
router.post('/servers/:serverId/users/:userId/roles/:roleId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { serverId, userId, roleId } = req.params;
    const currentUserId = req.user.id;

    const isAdmin = await isServerAdmin(req.user, parseInt(serverId));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can assign roles' });
    }

    const isOwner = await isServerOwner(currentUserId, parseInt(serverId));
    const canManage = req.user.is_root || isOwner || await canManageUser(currentUserId, parseInt(userId), parseInt(serverId));
    if (!canManage) {
      return res.status(403).json({ error: 'Cannot assign roles to users with higher or equal hierarchy level' });
    }

    const result = await serverSystem.assignRoleToUserOnServer(userId, serverId, roleId);
    await serverSystem.logServerAction(serverId, currentUserId, (req.user.display_name || req.user.username), 'role_assigned', { targetUserId: parseInt(userId), roleId: parseInt(roleId) });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Удаление роли с пользователя на сервере
router.delete('/servers/:serverId/users/:userId/roles/:roleId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { serverId, userId, roleId } = req.params;
    const currentUserId = req.user.id;

    const isAdmin = await isServerAdmin(req.user, parseInt(serverId));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can remove roles' });
    }

    const isOwner = await isServerOwner(currentUserId, parseInt(serverId));
    const canManage = req.user.is_root || isOwner || await canManageUser(currentUserId, parseInt(userId), parseInt(serverId));
    if (!canManage) {
      return res.status(403).json({ error: 'Cannot remove roles from users with higher or equal hierarchy level' });
    }

    const serversDb = new sqlite3.Database(dbPath('servers.db'));
    serversDb.run('DELETE FROM user_server_role_assignments WHERE user_id = ? AND server_id = ? AND role_id = ?',
      [userId, serverId, roleId], async function(err) {
        if (err) {
          res.status(500).json({ error: err.message });
        } else {
          await serverSystem.logServerAction(serverId, currentUserId, (req.user.display_name || req.user.username), 'role_unassigned', { targetUserId: parseInt(userId), roleId: parseInt(roleId) });
          res.json({ deleted: this.changes, userId, serverId, roleId });
        }
        serversDb.close();
      });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Удаление роли на сервере
router.delete('/servers/:serverId/roles/:roleId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { serverId, roleId } = req.params;
    const currentUserId = req.user.id;

    const isAdmin = await isServerAdmin(req.user, parseInt(serverId));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can delete roles' });
    }

    const serversDb = new sqlite3.Database(dbPath('servers.db'));

    // Не позволяем удалять системные роли
    serversDb.get('SELECT role_type, name FROM server_roles WHERE id = ? AND server_id = ?', [roleId, serverId], (err, row) => {
      if (err) {
        res.status(500).json({ error: err.message });
        serversDb.close();
        return;
      }

      if (!row) {
        res.status(404).json({ error: 'Role not found' });
        serversDb.close();
        return;
      }

      if (row.role_type === 'system') {
        res.status(403).json({ error: 'Cannot delete system roles' });
        serversDb.close();
        return;
      }

      serversDb.run('DELETE FROM server_roles WHERE id = ? AND server_id = ?', [roleId, serverId], async function(err) {
        if (err) {
          res.status(500).json({ error: err.message });
        } else {
          await serverSystem.logServerAction(serverId, currentUserId, (req.user.display_name || req.user.username), 'role_deleted', { roleId: parseInt(roleId), name: row.name });
          res.json({ deleted: this.changes, roleId, serverId });
        }
        serversDb.close();
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Обновление роли на сервере
router.put('/servers/:serverId/roles/:roleId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { serverId, roleId } = req.params;
    const { name, hierarchy_level, permissions } = req.body;
    const currentUserId = req.user.id;

    const isAdmin = await isServerAdmin(req.user, parseInt(serverId));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can update roles' });
    }

    const serversDb = new sqlite3.Database(dbPath('servers.db'));
    const permissionsStr = JSON.stringify(permissions);

    serversDb.run('UPDATE server_roles SET name = ?, hierarchy_level = ?, permissions = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND server_id = ?',
      [name, hierarchy_level, permissionsStr, roleId, serverId], async function(err) {
        if (err) {
          res.status(500).json({ error: err.message });
        } else if (this.changes === 0) {
          res.status(404).json({ error: 'Role not found or does not belong to this server' });
        } else {
          await serverSystem.logServerAction(serverId, currentUserId, (req.user.display_name || req.user.username), 'role_updated', { roleId: parseInt(roleId), name, hierarchy_level });
          res.json({ updated: this.changes, roleId, serverId, name, hierarchy_level, permissions });
        }
        serversDb.close();
      });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Каналы сервера ===
// Таблица server_channels в servers.db существует с самого начала (учтена
// в каскадном удалении сервера и в channel_count у GET /servers/:id), но
// маршрутов для неё не было вовсе — управлять каналами было нечем.

// Список каналов — читать может любой approved-пользователь (тот же уровень
// доступа, что и у GET /servers/:id/users и /roles выше).
router.get('/servers/:id/channels', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const channels = await serverSystem.getChannelsOnServer(req.params.id);
    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Создание канала — только администратор сервера.
router.post('/servers/:id/channels', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, channel_type, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Название канала обязательно' });
    }
    if (channel_type && !['text', 'voice'].includes(channel_type)) {
      return res.status(400).json({ error: 'channel_type должен быть "text" или "voice"' });
    }

    const isAdmin = await isServerAdmin(req.user, parseInt(id));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can create channels' });
    }

    const channel = await serverSystem.createChannelOnServer(id, name.trim(), channel_type, description);
    await serverSystem.logServerAction(id, req.user.id, (req.user.display_name || req.user.username), 'channel_created', { name: channel.name, channel_type: channel.channel_type });
    res.json(channel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Изменение канала — только администратор сервера.
router.put('/servers/:serverId/channels/:channelId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { serverId, channelId } = req.params;
    const { name, channel_type, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Название канала обязательно' });
    }
    if (channel_type && !['text', 'voice'].includes(channel_type)) {
      return res.status(400).json({ error: 'channel_type должен быть "text" или "voice"' });
    }

    const isAdmin = await isServerAdmin(req.user, parseInt(serverId));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can update channels' });
    }

    const result = await serverSystem.updateChannel(serverId, channelId, name.trim(), channel_type, description);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    await serverSystem.logServerAction(serverId, req.user.id, (req.user.display_name || req.user.username), 'channel_updated', { channelId: parseInt(channelId), name: name.trim() });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Удаление канала — только администратор сервера.
router.delete('/servers/:serverId/channels/:channelId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { serverId, channelId } = req.params;

    const isAdmin = await isServerAdmin(req.user, parseInt(serverId));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can delete channels' });
    }

    const result = await serverSystem.deleteChannel(serverId, channelId);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    await serverSystem.logServerAction(serverId, req.user.id, (req.user.display_name || req.user.username), 'channel_deleted', { channelId: parseInt(channelId) });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Обновление владельца сервера (root only).
// Раньше проверка была `currentUser.role_id !== 1` с комментарием "role_id=1
// для администраторов" — в реальных данных role_id=1 это обычная
// "Пользователь", а не админ (в таблице roles id=2 — "Администратор"), и
// is_root вообще не проверялся. Из-за этого маршрут либо пропускал не тех,
// либо не пускал вообще никого. Используем req.user.is_root — тот же
// признак, которым защищены все остальные "root only" маршруты в проекте.
router.put('/servers/:serverId/owner', auth.authenticateToken, auth.checkApproved, auth.checkRoot, async (req, res) => {
  try {
    const { serverId } = req.params;
    const { newOwnerId } = req.body;

    // Проверяем, что новый владелец существует
    const newOwner = await auth.getUserById(newOwnerId);
    if (!newOwner) {
      return res.status(404).json({ error: 'New owner not found' });
    }

    const serversDb = new sqlite3.Database(dbPath('servers.db'));
    serversDb.run('UPDATE servers SET owner_id = ? WHERE id = ?', [newOwnerId, serverId], async function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
      } else if (this.changes === 0) {
        res.status(404).json({ error: 'Server not found' });
      } else {
        await serverSystem.logServerAction(serverId, req.user.id, (req.user.display_name || req.user.username), 'owner_changed', { newOwnerId: parseInt(newOwnerId), newOwnerUsername: newOwner.display_name || newOwner.username });
        res.json({ updated: this.changes, serverId, newOwnerId });
      }
      serversDb.close();
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получение всех пользователей (для выбора нового владельца сервера, root only).
// Тот же фикс, что и выше — раньше гейтилось сломанным role_id === 1.
router.get('/users', auth.authenticateToken, auth.checkApproved, auth.checkRoot, async (req, res) => {
  try {
    const usersDb = new sqlite3.Database(dbPath('users.db'));
    // Отдаём и имя, и логин: эндпоинт только для владельца (выбор нового
    // владельца сервера), display_name — то, что показывается в списке.
    usersDb.all("SELECT id, username, COALESCE(NULLIF(display_name, ''), username) AS display_name FROM users ORDER BY display_name", [], (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        res.json({ success: true, data: rows });
      }
      usersDb.close();
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Быстрый поиск пользователей по имени — используется в модалке "Добавить
// участника" вместо ручного ввода ID. Не root-only, в отличие от GET /users
// выше: отдаёт только id+имя (display_name), ровно то же самое, что уже видно
// любому approved-пользователю в списке участников любого сервера
// (GET /servers/:id/users). Ищем и отдаём именно имя, а не логин: логин —
// часть учётных данных и не должен подбираться через публичный поиск.
router.get('/users/search', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);

    const usersDb = new sqlite3.Database(dbPath('users.db'));
    usersDb.all(
      "SELECT id, COALESCE(NULLIF(display_name, ''), username) AS display_name FROM users WHERE status = 'approved' AND COALESCE(NULLIF(display_name, ''), username) LIKE ? ORDER BY display_name LIMIT 10",
      [`%${q}%`],
      (err, rows) => {
        usersDb.close();
        if (err) {
          res.status(500).json({ error: err.message });
        } else {
          res.json(rows);
        }
      }
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Журнал действий сервера ===
// Кто/что/когда сделал на сервере — создание/удаление сервера, ролей,
// каналов, добавление/удаление участников, назначение ролей, смена
// владельца (см. logServerAction во всех маршрутах выше и
// server_audit_log в src/db/connections.js). Доступно только
// администратору сервера — этот срез действий чувствительнее, чем просто
// список участников/ролей, который открыт любому approved-пользователю.
router.get('/servers/:id/audit-log', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { id } = req.params;
    const isAdmin = await isServerAdmin(req.user, parseInt(id));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can view the audit log' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const entries = await serverSystem.getServerAuditLog(id, limit);
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
