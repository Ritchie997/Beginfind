// servers.routes.js — API "серверов" (Discord-подобные пространства):
// CRUD серверов, ролей на сервере, участников и владения.

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const auth = require('../middleware/auth');
const serverSystem = require('../services/server-system-logic');
const { isAdminOnServer, canManageUser } = require('../services/server-permissions');
const { dbPath } = require('../config/paths');

const router = express.Router();

// Получение всех серверов
router.get('/servers', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const servers = await serverSystem.getAllServersWithUserCount();
    res.json(servers);
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
    const { name, description } = req.body;
    const server = await serverSystem.createServer(name, description, req.user.id);
    // Добавляем владельца как администратора сервера
    await serverSystem.addUserToServer(req.user.id, server.id);
    const roles = await serverSystem.getRolesOnServer(server.id);
    const adminRole = roles.find(role => role.name === 'admin' && role.role_type === 'system');
    if (adminRole) {
      await serverSystem.assignRoleToUserOnServer(req.user.id, server.id, adminRole.id);
    }
    res.json(server);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Обновление сервера (только владелец)
router.put('/servers/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
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

      if (row.owner_id !== userId) {
        res.status(403).json({ error: 'Only server owner can update server' });
        serversDb.close();
        return;
      }

      const result = await serverSystem.updateServer(id, name, description);
      if (result.changes === 0) {
        res.status(404).json({ error: 'Server not found' });
      } else {
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

    serversDb.get('SELECT owner_id FROM servers WHERE id = ?', [id], async (err, row) => {
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

    const isAdmin = await isAdminOnServer(userId, parseInt(id));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can create roles' });
    }

    const role = await serverSystem.createRoleOnServer(id, name, hierarchy_level, permissions);
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
    const { serverId, userId } = req.params;
    const currentUserId = req.user.id;

    if (parseInt(userId) !== currentUserId) {
      const isAdmin = await isAdminOnServer(currentUserId, parseInt(serverId));
      if (!isAdmin) {
        return res.status(403).json({ error: 'Можно добавить только себя, либо быть администратором сервера' });
      }
    }

    const result = await serverSystem.addUserToServer(userId, serverId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Назначение роли пользователю на сервере
router.post('/servers/:serverId/users/:userId/roles/:roleId', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { serverId, userId, roleId } = req.params;
    const currentUserId = req.user.id;

    const isAdmin = await isAdminOnServer(currentUserId, parseInt(serverId));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can assign roles' });
    }

    const canManage = await canManageUser(currentUserId, parseInt(userId), parseInt(serverId));
    if (!canManage) {
      return res.status(403).json({ error: 'Cannot assign roles to users with higher or equal hierarchy level' });
    }

    const result = await serverSystem.assignRoleToUserOnServer(userId, serverId, roleId);
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

    const isAdmin = await isAdminOnServer(currentUserId, parseInt(serverId));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can remove roles' });
    }

    const canManage = await canManageUser(currentUserId, parseInt(userId), parseInt(serverId));
    if (!canManage) {
      return res.status(403).json({ error: 'Cannot remove roles from users with higher or equal hierarchy level' });
    }

    const serversDb = new sqlite3.Database(dbPath('servers.db'));
    serversDb.run('DELETE FROM user_server_role_assignments WHERE user_id = ? AND server_id = ? AND role_id = ?',
      [userId, serverId, roleId], function(err) {
        if (err) {
          res.status(500).json({ error: err.message });
        } else {
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

    const isAdmin = await isAdminOnServer(currentUserId, parseInt(serverId));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can delete roles' });
    }

    const serversDb = new sqlite3.Database(dbPath('servers.db'));

    // Не позволяем удалять системные роли
    serversDb.get('SELECT role_type FROM server_roles WHERE id = ? AND server_id = ?', [roleId, serverId], (err, row) => {
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

      serversDb.run('DELETE FROM server_roles WHERE id = ? AND server_id = ?', [roleId, serverId], function(err) {
        if (err) {
          res.status(500).json({ error: err.message });
        } else {
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

    const isAdmin = await isAdminOnServer(currentUserId, parseInt(serverId));
    if (!isAdmin) {
      return res.status(403).json({ error: 'Only administrators can update roles' });
    }

    const serversDb = new sqlite3.Database(dbPath('servers.db'));
    const permissionsStr = JSON.stringify(permissions);

    serversDb.run('UPDATE server_roles SET name = ?, hierarchy_level = ?, permissions = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND server_id = ?',
      [name, hierarchy_level, permissionsStr, roleId, serverId], function(err) {
        if (err) {
          res.status(500).json({ error: err.message });
        } else if (this.changes === 0) {
          res.status(404).json({ error: 'Role not found or does not belong to this server' });
        } else {
          res.json({ updated: this.changes, roleId, serverId, name, hierarchy_level, permissions });
        }
        serversDb.close();
      });
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
    serversDb.run('UPDATE servers SET owner_id = ? WHERE id = ?', [newOwnerId, serverId], function(err) {
      if (err) {
        res.status(500).json({ error: err.message });
      } else if (this.changes === 0) {
        res.status(404).json({ error: 'Server not found' });
      } else {
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
    usersDb.all('SELECT id, username FROM users ORDER BY username', [], (err, rows) => {
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

module.exports = router;
