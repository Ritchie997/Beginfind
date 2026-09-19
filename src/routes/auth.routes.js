// auth.routes.js — регистрация, вход, профиль, управление заявками (root).

const express = require('express');
const auth = require('../middleware/auth');
const { readSettings } = require('../services/system-settings');
const { getServersForUser } = require('../services/server-system-logic');

const router = express.Router();

// POST /api/register — Регистрация (статус pending, без авто-логина)
router.post('/register', auth.rateLimitLimiter('registration'), async (req, res) => {
  try {
    if (readSettings().allowRegistration === false) {
      return res.status(403).json({ error: 'Регистрация новых пользователей временно отключена' });
    }

    const { display_name, password, username } = req.body;

    if (!display_name || !password) {
      return res.status(400).json({ error: 'Имя и пароль обязательны' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
    }

    if (password !== req.body.password_confirm) {
      return res.status(400).json({ error: 'Пароли не совпадают' });
    }

    console.log('Registration attempt for:', display_name);

    const user = await auth.register(display_name, password, username);

    console.log('Registration pending for user:', user.username);

    res.status(201).json({
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        status: user.status
      },
      message: 'Заявка отправлена. Ожидает подтверждения'
    });
  } catch (error) {
    console.error('Registration error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// POST /api/login — Вход
router.post('/login', auth.rateLimitLimiter('login'), async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Имя пользователя и пароль обязательны' });
    }

    console.log('Login attempt for username:', username);

    const user = await auth.login(username, password);
    const token = await auth.generateToken(user);

    console.log('Login successful for user:', user.username);

    res.json({
      user,
      token,
      message: 'Вход выполнен успешно'
    });
  } catch (error) {
    console.error('Login error:', error.message);
    // Специфичная обработка для pending/rejected/blocked статусов (auth.login
    // помечает такие ошибки полем .status — см. src/middleware/auth.js).
    if (error.status) {
      return res.status(403).json({
        error: error.message,
        status: error.status
      });
    }
    res.status(401).json({ error: error.message });
  }
});

// GET /api/profile — Профиль текущего пользователя
router.get('/profile', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const user = await auth.getUserById(req.user.id);
    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/profile — обновить своё публичное описание (bio). Роль/сервера/
// админ-заметка отсюда не меняются — заметка правится через /users/:id/note,
// роль и сервера пользователь себе назначить не может.
router.put('/profile', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const result = await auth.updateOwnBio(req.user.id, req.body.bio);
    res.json({ message: 'Профиль обновлён', ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/users/:id/profile — Профиль любого пользователя (свой или чужой):
// страница /profile/:id. admin_note в ответе присутствует только если у
// смотрящего есть право view_users_tab (см. auth.getUserProfile).
router.get('/users/:id/profile', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const [profile, servers] = await Promise.all([
      auth.getUserProfile(req.params.id, req.user),
      getServersForUser(req.params.id)
    ]);
    res.json({ profile: { ...profile, servers } });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

// PUT /api/users/:id/note — оставить/изменить приватную админ-заметку о
// пользователе (не путать с его собственным bio). Право проверяется внутри
// auth.updateAdminNote (view_users_tab или владелец).
router.put('/users/:id/note', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const result = await auth.updateAdminNote(req.user, req.params.id, req.body.note);
    res.json({ message: 'Заметка сохранена', ...result });
  } catch (error) {
    res.status(403).json({ error: error.message });
  }
});

// GET /api/profile/observer-status — Статус "наблюдателя" для текущего пользователя.
// Раньше делал require('./server-membership-check') — файла, которого больше
// нет в репозитории (логика уже встроена в auth.js), маршрут падал с 500 при
// каждом обращении. Теперь использует auth.assignObserverRoleIfNeeded напрямую.
router.get('/profile/observer-status', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const observerCheck = await auth.assignObserverRoleIfNeeded(req.user.id);
    res.json(observerCheck);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// МАРШРУТЫ УПРАВЛЕНИЯ ЗАЯВКАМИ — владелец или роль с manage_pending_users
// ========================================

// GET /api/pending-users — Список ожидающих подтверждения
router.get('/pending-users', auth.authenticateToken, auth.checkApproved, auth.checkPermission('manage_pending_users'), async (req, res) => {
  try {
    const pendingUsers = await auth.getPendingUsers();
    res.json({ users: pendingUsers });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/pending-users/:id/approve — Одобрить пользователя
router.put('/pending-users/:id/approve', auth.authenticateToken, auth.checkApproved, auth.checkPermission('manage_pending_users'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await auth.approveUser(id, req.user.username);
    res.json({ message: 'Пользователь одобрен', ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/pending-users/:id/reject — Отклонить пользователя
router.put('/pending-users/:id/reject', auth.authenticateToken, auth.checkApproved, auth.checkPermission('manage_pending_users'), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const result = await auth.rejectUser(id, reason, req.user.username);
    res.json({ message: 'Заявка отклонена', ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/all-users — Все пользователи (владелец или роль с view_users_tab)
router.get('/all-users', auth.authenticateToken, auth.checkApproved, auth.checkPermission('view_users_tab'), async (req, res) => {
  try {
    const users = await auth.getAllUsers();
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// КАТАЛОГ РОЛЕЙ АДМИНОВ (admin_roles) — гибкий конструктор ролей.
// Список ролей виден любому подтверждённому пользователю (нужен для
// выпадающих списков в интерфейсе), редактировать каталог (создавать,
// переименовывать роли, включать/выключать им права, менять level) может
// только владелец или один "доверенный админ" (checkRoleManager).
// ========================================

// GET /api/admin-roles — список ролей
router.get('/admin-roles', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const roles = await auth.getAllRoles();
    res.json({ roles, permission_keys: auth.PERMISSION_KEYS });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin-roles — создать роль
router.post('/admin-roles', auth.authenticateToken, auth.checkApproved, auth.checkRoleManager, async (req, res) => {
  try {
    const { name, level, permissions } = req.body;
    const role = await auth.createRole({ name, level, permissions });
    res.json({ message: 'Роль создана', role });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/admin-roles/:id — переименовать роль / изменить level / права
router.put('/admin-roles/:id', auth.authenticateToken, auth.checkApproved, auth.checkRoleManager, async (req, res) => {
  try {
    const { name, level, permissions } = req.body;
    const role = await auth.updateRole(req.params.id, { name, level, permissions });
    res.json({ message: 'Роль обновлена', role });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/admin-roles/:id — удалить роль (если она никому не назначена)
router.delete('/admin-roles/:id', auth.authenticateToken, auth.checkApproved, auth.checkRoleManager, async (req, res) => {
  try {
    const result = await auth.deleteRole(req.params.id);
    res.json({ message: 'Роль удалена', ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/users/:id/role-manager — назначить/снять "доверенного админа"
// (право редактировать сам каталог ролей). Только владелец, статус уникален
// (см. auth.setRoleManager).
router.put('/users/:id/role-manager', auth.authenticateToken, auth.checkApproved, auth.checkRoot, async (req, res) => {
  try {
    const { enabled } = req.body;
    const result = await auth.setRoleManager(req.params.id, !!enabled);
    res.json({ message: enabled ? 'Назначен доверенным администратором' : 'Статус доверенного администратора снят', ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ========================================
// МАРШРУТЫ УПРАВЛЕНИЯ ПОЛЬЗОВАТЕЛЯМИ — вкладка "Пользователи".
// Каждое действие проверяет право роли действующего пользователя и
// иерархию (нельзя тронуть владельца или того, кто равен/выше по рангу) —
// см. requirePermission/assertCanManage в src/middleware/auth.js. Владелец
// назначается только через CLI (см. scripts/make-owner.js) — здесь его
// нельзя ни создать, ни изменить.
// ========================================

// PUT /api/users/:id/role — назначить/снять роль админа (или "сделать
// пэром" — role.level <= уровня выдающего)
router.put('/users/:id/role', auth.authenticateToken, auth.checkApproved, auth.checkPermission('manage_admin_roles'), async (req, res) => {
  try {
    const { id } = req.params;
    const { roleId } = req.body;
    const result = await auth.assignUserRole(req.user, id, roleId || null);
    res.json({ message: roleId ? 'Роль назначена' : 'Роль снята', ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/users/:id/rename — переименовать пользователя
router.put('/users/:id/rename', auth.authenticateToken, auth.checkApproved, auth.checkPermission('rename_users'), async (req, res) => {
  try {
    const { id } = req.params;
    const { display_name, username } = req.body;
    const result = await auth.renameUser(req.user, id, { display_name, username });
    res.json({ message: 'Пользователь переименован', ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/users/:id/block — заблокировать пользователя
router.put('/users/:id/block', auth.authenticateToken, auth.checkApproved, auth.checkPermission('block_users'), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const result = await auth.blockUser(req.user, id, reason);
    res.json({ message: 'Пользователь заблокирован', ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/users/:id/unblock — разблокировать пользователя
router.put('/users/:id/unblock', auth.authenticateToken, auth.checkApproved, auth.checkPermission('block_users'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await auth.unblockUser(req.user, id);
    res.json({ message: 'Пользователь разблокирован', ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/users/:id/mute — временно замутить пользователя (минуты + причина)
router.put('/users/:id/mute', auth.authenticateToken, auth.checkApproved, auth.checkPermission('mute_users'), async (req, res) => {
  try {
    const { id } = req.params;
    const { minutes, reason } = req.body;
    const result = await auth.muteUser(req.user, id, minutes, reason);
    res.json({ message: 'Пользователь замучен', ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /api/users/:id/unmute — снять мут раньше срока
router.put('/users/:id/unmute', auth.authenticateToken, auth.checkApproved, auth.checkPermission('mute_users'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await auth.unmuteUser(req.user, id);
    res.json({ message: 'Мут снят', ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
