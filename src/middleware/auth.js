// auth.js — аутентификация, регистрация и middleware проверки токена/статуса.
// Переехал из корня проекта (./auth.js) без изменения логики, кроме путей
// к БД (см. src/config/paths.js) и явного экспорта assignObserverRoleIfNeeded
// (см. комментарий у объявления функции).
//
// Важно: этот модуль читает process.env.JWT_SECRET на этапе загрузки, поэтому
// src/config/env.js (который вызывает dotenv.config()) должен быть
// require()-нут раньше, чем этот файл — это гарантируется тем, что
// src/server.js требует config/env первым.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const { dbPath } = require('../config/paths');
const { ensureUserSchema, PERMISSION_KEYS } = require('../db/migrate-users-schema');
const { readSettings: readSystemSettings } = require('../services/system-settings');

/**
 * Проверяет участие пользователя в серверах и назначает роль "наблюдатель" если нужно
 * (встроена из удалённого server-membership-check.js).
 * Экспортируется отдельно — раньше GET /api/profile/observer-status делал
 * require('./server-membership-check'), которого уже не существует в
 * репозитории, и маршрут падал с 500 при каждом обращении.
 */
async function assignObserverRoleIfNeeded(userId) {
  return new Promise((resolve) => {
    const serversDb = new sqlite3.Database(dbPath('servers.db'));
    const usersDb = new sqlite3.Database(dbPath('users.db'));

    serversDb.get(`
      SELECT COUNT(*) as server_count
      FROM user_server_memberships
      WHERE user_id = ?
    `, [userId], (err, row) => {
      if (err || !row || row.server_count > 0) {
        serversDb.close();
        usersDb.close();
        resolve(null);
        return;
      }

      // Пользователь не состоит ни в одном сервере — назначаем роль наблюдателя
      usersDb.get('SELECT role_id FROM users WHERE id = ?', [userId], (err, userRow) => {
        if (err || !userRow) {
          serversDb.close();
          usersDb.close();
          resolve(null);
          return;
        }

        serversDb.get('SELECT id FROM server_roles WHERE name = ?', ['наблюдатель'], (err, roleRow) => {
          if (err || !roleRow) {
            serversDb.close();
            usersDb.close();
            resolve(null);
            return;
          }

          usersDb.run('UPDATE users SET role_id = ? WHERE id = ?', [roleRow.id, userId], function(err) {
            serversDb.close();
            usersDb.close();
            if (err) {
              resolve(null);
            } else {
              resolve({ assigned: true, roleId: roleRow.id });
            }
          });
        });
      });
    });
  });
}

// Подключение к базе данных пользователей
const db = new sqlite3.Database(dbPath('users.db'), (err) => {
  if (err) {
    console.error('Error opening users database', err);
  } else {
    console.log('Connected to users database');
    ensureUserSchema(db).catch((schemaErr) => {
      console.error('Не удалось применить миграцию схемы users/admin_roles:', schemaErr);
    });
  }
});

// Настройки JWT
// Раньше при отсутствии JWT_SECRET в окружении тихо подставлялся предсказуемый
// 'default_secret' — с ним любой мог подделать токен (в т.ч. root/is_root).
// Теперь сервер лучше не запустить вовсе, чем запустить с предсказуемым секретом.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET не задан в переменных окружения. Задайте его в .env ' +
    '(node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))") перед запуском сервера.'
  );
}
// Срок жизни access-токена раньше был здесь же (JWT_EXPIRES_IN = env || '8h'),
// фиксированный на момент запуска сервера. Теперь он настраивается владельцем
// на вкладке "Настройки" (system-settings.json::sessionDurationHours) и
// читается заново при КАЖДОМ логине — см. generateToken ниже — поэтому смена
// значения не требует перезапуска сервера.
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

// ========================================
// РОЛИ АДМИНОВ — гибкий конструктор (admin_roles), иерархия, права
// ========================================
//
// Владелец (is_root) стоит вне этой системы — у него всегда все права и
// самый высокий уровень, независимо от таблицы admin_roles.
//
// Уровень (level) и права роли НЕ кэшируются подолгу — при каждом запросе
// (см. checkApproved) они читаются заново через JOIN с admin_roles, поэтому
// правка роли владельцем (переименование, смена level, переключение прав)
// действует сразу для всех, кому она назначена, без релогина. Столбец
// users.admin_level всё ещё обновляется при назначении роли — это просто
// офлайн-снимок для CLI (scripts/make-owner.js), источником истины он не
// является.

function parsePermissions(json) {
  let parsed = {};
  if (json) {
    try { parsed = JSON.parse(json); } catch (e) { parsed = {}; }
  }
  const result = {};
  PERMISSION_KEYS.forEach((key) => { result[key] = !!parsed[key]; });
  return result;
}

function allPermissionsTrue() {
  const result = {};
  PERMISSION_KEYS.forEach((key) => { result[key] = true; });
  return result;
}

function allPermissionsFalse() {
  const result = {};
  PERMISSION_KEYS.forEach((key) => { result[key] = false; });
  return result;
}

/**
 * Полная актуальная информация о пользователе, включая роль (JOIN
 * admin_roles) — единая точка правды для checkApproved и всех проверок
 * иерархии/прав ниже. admin_level здесь — ВСЕГДА производное от роли
 * (level роли, или 0 если роли нет), а не значение из кэш-столбца.
 */
function getUserFull(id) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT u.id, u.username, u.display_name, u.role_id, u.status, u.is_root,
              u.admin_role_id, u.is_role_manager, u.muted_until, u.mute_reason,
              u.rejection_reason, u.created_at,
              r.name as role_name, r.level as role_level, r.permissions as role_permissions
       FROM users u
       LEFT JOIN admin_roles r ON u.admin_role_id = r.id
       WHERE u.id = ?`,
      [id],
      (err, row) => {
        if (err) { reject(err); return; }
        if (!row) { resolve(null); return; }

        const isRoot = !!row.is_root;
        resolve({
          id: row.id,
          username: row.username,
          display_name: row.display_name || row.username,
          role_id: row.role_id,
          status: row.status || 'pending',
          is_root: isRoot,
          admin_role_id: row.admin_role_id || null,
          role_name: row.role_name || null,
          admin_level: isRoot ? Infinity : (row.role_level || 0),
          permissions: isRoot ? allPermissionsTrue() : (row.admin_role_id ? parsePermissions(row.role_permissions) : allPermissionsFalse()),
          is_role_manager: !!row.is_role_manager,
          muted_until: row.muted_until || null,
          mute_reason: row.mute_reason || null,
          rejection_reason: row.rejection_reason || null,
          created_at: row.created_at
        });
      }
    );
  });
}

function isMuted(user) {
  return !!(user && user.muted_until && new Date(user.muted_until).getTime() > Date.now());
}

/**
 * Бросает ошибку, если actingUser не может управлять targetUserId:
 * владельца трогать нельзя никому, кроме самого владельца (is_root); для
 * не-владельца цель должна быть строго ниже по иерархии (admin_level).
 * Возвращает свежие данные цели (getUserFull) для дальнейшего использования.
 */
async function assertCanManage(actingUser, targetUserId) {
  const target = await getUserFull(targetUserId);
  if (!target) throw new Error('Пользователь не найден');
  if (target.is_root) throw new Error('Это действие недоступно в отношении владельца');

  if (!actingUser.is_root) {
    const actingLevel = actingUser.admin_level || 0;
    if (target.admin_level >= actingLevel) {
      throw new Error('Недостаточно прав: пользователь равен вам или выше по иерархии админов');
    }
  }
  return target;
}

function requirePermission(actingUser, key) {
  if (actingUser.is_root) return;
  if (!actingUser.permissions || !actingUser.permissions[key]) {
    throw new Error('Недостаточно прав для этого действия');
  }
}

// ========================================
// РЕГИСТРАЦИЯ
// ========================================

/**
 * Регистрация нового пользователя
 * @param {string} display_name - Отображаемое имя
 * @param {string} password - Пароль (открытый текст)
 * @param {string} username - Уникальный логин (опционально, по умолчанию = display_name)
 * @returns {Promise<{id, username, display_name, status}>}
 */
async function register(display_name, password, username = null) {
  const hashedPassword = await bcrypt.hash(password, 12);
  const loginName = username || display_name;

  return new Promise((resolve, reject) => {
    // Проверяем, существует ли пользователь
    db.get('SELECT * FROM users WHERE username = ?', [loginName], (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      if (row) {
        reject(new Error('Имя пользователя уже занято'));
        return;
      }

      // Вставляем нового пользователя со статусом pending
      db.run(
        `INSERT INTO users (username, display_name, password, role_id, status, is_root)
         VALUES (?, ?, ?, 4, 'pending', 0)`,
        [loginName, display_name, hashedPassword],
        function (err) {
          if (err) {
            reject(err);
            return;
          }

          resolve({
            id: this.lastID,
            username: loginName,
            display_name: display_name,
            status: 'pending',
            is_root: false
          });
        }
      );
    });
  });
}

// ========================================
// ВХОД
// ========================================

/**
 * Вход пользователя с проверкой статуса
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{id, username, display_name, status, is_root, role_id}>}
 */
async function login(username, password) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      if (!row) {
        reject(new Error('Неверное имя пользователя или пароль'));
        return;
      }

      // Проверяем пароль. Раньше здесь был fallback на пароль "admin" для
      // аккаунтов без хеша и сравнение в открытом виде для нехешированных
      // паролей короче 30 символов — это фактически бэкдор (любой аккаунт с
      // пустым/повреждённым полем password пускал по паролю "admin"). Все
      // текущие аккаунты хранят полноценный bcrypt-хеш, поэтому легаси-ветки
      // убраны: пароль всегда проверяется через bcrypt.
      let isValid = false;

      if (row.password) {
        isValid = await bcrypt.compare(password, row.password);
      }

      if (!isValid) {
        reject(new Error('Неверное имя пользователя или пароль'));
        return;
      }

      // Проверяем статус аккаунта
      const status = row.status || 'pending';

      if (status === 'blocked') {
        const reason = row.rejection_reason || 'Аккаунт заблокирован администратором.';
        const err = new Error(`Аккаунт заблокирован. Причина: ${reason}`);
        err.status = 'blocked';
        reject(err);
        return;
      }

      if (status === 'rejected') {
        const reason = row.rejection_reason || 'Ваша заявка была отклонена.';
        const err = new Error(`Доступ отклонён. Причина: ${reason}`);
        err.status = 'rejected';
        reject(err);
        return;
      }

      if (status === 'pending') {
        const err = new Error('Аккаунт ожидает подтверждения администратором');
        err.status = 'pending';
        reject(err);
        return;
      }

      // status === 'approved' — всё в порядке

      // Проверяем, нужно ли назначить роль наблюдателя
      const observerCheck = await assignObserverRoleIfNeeded(row.id);
      const full = await getUserFull(row.id);

      const user = {
        id: row.id,
        username: row.username,
        display_name: row.display_name || row.username,
        role_id: row.role_id,
        status: status,
        is_root: !!row.is_root,
        admin_role_id: full ? full.admin_role_id : null,
        role_name: full ? full.role_name : null,
        admin_level: full && Number.isFinite(full.admin_level) ? full.admin_level : 0,
        permissions: full ? full.permissions : allPermissionsFalse(),
        is_role_manager: full ? full.is_role_manager : false,
        is_observer: observerCheck?.assigned || false
      };

      resolve(user);
    });
  });
}

// ========================================
// JWT ТОКЕНЫ
// ========================================

/**
 * Генерация access токена. Срок жизни — читается заново из
 * system-settings.json при каждом вызове (а не константа на старте сервера),
 * чтобы владелец мог поменять его на вкладке "Настройки" без рестарта —
 * подействует на следующий же логин, уже выданные токены не трогает.
 */
async function generateToken(user) {
  const hours = Number(readSystemSettings().sessionDurationHours) || 8;
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      role_id: user.role_id,
      status: user.status,
      is_root: user.is_root,
      admin_level: user.admin_level || 0,
      is_observer: user.is_observer || false
    },
    JWT_SECRET,
    { expiresIn: hours * 60 * 60 }
  );
}

/**
 * Генерация refresh токена
 */
function generateRefreshToken(user) {
  return jwt.sign(
    { id: user.id, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRES_IN }
  );
}

/**
 * Аутентификация токена
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Требуется токен доступа' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      // 401, а не 403 — это отсутствие валидной аутентификации (просрочен/
      // подделан токен), а не запрет действия аутентифицированному пользователю.
      // Фронт (см. makeAuthenticatedRequest в public/app.js) разлогинивает
      // именно по 401 — раньше оба случая шли под 403, и любой "доступ
      // запрещён" (например GET /servers/:id/audit-log не-админу) тоже
      // выкидывал пользователя на экран входа.
      return res.status(401).json({ error: 'Неверный или просроченный токен' });
    }

    req.user = user;
    next();
  });
}

// ========================================
// MIDDLEWARE — ПРОВЕРКА СТАТУСА / ПРАВ
// ========================================

/**
 * Middleware: допускает только пользователей со статусом approved.
 *
 * Раньше статус/is_root/роль брались из самого JWT — он живёт часами (см.
 * sessionDurationHours в generateToken выше, теперь настраивается владельцем
 * и может быть заметно дольше), поэтому блокировка пользователя или выдача/снятие
 * админских прав владельцем не действовали, пока пользователь не
 * перелогинится. Теперь при каждом запросе статус и права читаются заново
 * из БД (через getUserFull, с JOIN на admin_roles) и req.user обновляется
 * свежими значениями — блокировка, мут и изменения иерархии/прав
 * применяются мгновенно, на следующем же запросе.
 */
function checkApproved(req, res, next) {
  getUserFull(req.user.id)
    .then((row) => {
      if (!row) {
        return res.status(401).json({ error: 'Пользователь не найден' });
      }

      if (row.status !== 'approved') {
        return res.status(403).json({
          error: row.status === 'blocked'
            ? `Аккаунт заблокирован${row.rejection_reason ? `. Причина: ${row.rejection_reason}` : ''}`
            : 'Доступ запрещён: аккаунт не подтверждён',
          status: row.status
        });
      }

      // Обновляем req.user свежими данными из БД для всех обработчиков ниже
      // по цепочке — is_root/admin_level/permissions особенно важны для
      // проверок прав (см. canAccessArticle/canDeleteArticle и мут в
      // articles.routes.js, messages.routes.js).
      req.user.status = row.status;
      req.user.is_root = row.is_root;
      req.user.admin_role_id = row.admin_role_id;
      req.user.role_name = row.role_name;
      req.user.admin_level = Number.isFinite(row.admin_level) ? row.admin_level : 0;
      req.user.permissions = row.permissions;
      req.user.is_role_manager = row.is_role_manager;
      req.user.muted_until = row.muted_until;
      req.user.mute_reason = row.mute_reason;
      req.user.display_name = row.display_name;

      next();
    })
    .catch(() => res.status(500).json({ error: 'Ошибка проверки пользователя' }));
}

/**
 * Middleware: допускает только root-пользователей (владельца)
 */
function checkRoot(req, res, next) {
  if (!req.user.is_root) {
    return res.status(403).json({ error: 'Доступно только владельцу' });
  }
  next();
}

/**
 * Middleware-фабрика: допускает владельца ИЛИ пользователя, чья роль
 * включает указанное право (req.user.permissions[key] — см. PERMISSION_KEYS
 * и checkApproved, который наполняет req.user.permissions свежими данными).
 */
function checkPermission(key) {
  return (req, res, next) => {
    if (req.user.is_root) return next();
    if (req.user.permissions && req.user.permissions[key]) return next();
    return res.status(403).json({ error: 'Недостаточно прав для этого действия' });
  };
}

/**
 * Middleware: допускает владельца или "доверенного админа" (is_role_manager)
 * — единственного не-владельца, кому разрешено редактировать сам каталог
 * ролей (создавать/переименовывать/удалять роли, менять их права и level).
 */
function checkRoleManager(req, res, next) {
  if (req.user.is_root || req.user.is_role_manager) return next();
  return res.status(403).json({ error: 'Доступно только владельцу или доверенному администратору' });
}

/**
 * Middleware: запрещает действие, если пользователь временно в муте
 * (req.user.muted_until в будущем — см. checkApproved). Используется на
 * создании/редактировании статей и отправке сообщений.
 */
function checkNotMuted(req, res, next) {
  if (isMuted(req.user)) {
    return res.status(403).json({
      error: `Вы временно в муте${req.user.mute_reason ? `. Причина: ${req.user.mute_reason}` : ''}. Истекает: ${new Date(req.user.muted_until).toLocaleString('ru-RU')}`,
      muted_until: req.user.muted_until
    });
  }
  next();
}

// ========================================
// УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ
// ========================================

/**
 * Получить пользователя по ID
 */
async function getUserById(id) {
  const full = await getUserFull(id);
  if (!full) throw new Error('Пользователь не найден');
  return {
    id: full.id,
    username: full.username,
    display_name: full.display_name,
    role_id: full.role_id,
    status: full.status,
    is_root: full.is_root,
    admin_role_id: full.admin_role_id,
    role_name: full.role_name,
    admin_level: Number.isFinite(full.admin_level) ? full.admin_level : 0,
    permissions: full.permissions,
    is_role_manager: full.is_role_manager
  };
}

/**
 * Профиль пользователя для страницы /profile/:id — свой или чужой.
 * bio (публичное описание "о себе") видно всем; admin_note (приватная
 * заметка админ-панели) — только viewer'у с правом view_users_tab или
 * владельцу (см. комментарий у столбцов в migrate-users-schema.js).
 * can_edit_bio/can_edit_note подсказывают фронту, показывать ли поля
 * редактирования — сама проверка прав всё равно дублируется на PUT-эндпоинтах.
 */
async function getUserProfile(targetId, viewer) {
  const target = await getUserFull(targetId);
  if (!target) throw new Error('Пользователь не найден');

  const canSeeNote = !!(viewer && (viewer.is_root || (viewer.permissions && viewer.permissions.view_users_tab)));
  const isSelf = !!(viewer && String(viewer.id) === String(targetId));

  return new Promise((resolve, reject) => {
    db.get('SELECT bio, admin_note FROM users WHERE id = ?', [targetId], (err, row) => {
      if (err) { reject(err); return; }

      const profile = {
        id: target.id,
        username: target.username,
        display_name: target.display_name,
        is_root: target.is_root,
        admin_role_id: target.admin_role_id,
        role_name: target.role_name,
        admin_level: Number.isFinite(target.admin_level) ? target.admin_level : 0,
        is_role_manager: target.is_role_manager,
        status: target.status,
        created_at: target.created_at,
        bio: (row && row.bio) || '',
        can_edit_bio: isSelf
      };

      if (canSeeNote) {
        profile.admin_note = (row && row.admin_note) || '';
        profile.can_edit_note = true;
        // Мут — деталь того же уровня приватности, что и статус/заметка
        // (см. profile-status-badge на фронте, statusLabelForUser).
        profile.muted_until = target.muted_until;
        profile.mute_reason = target.mute_reason;
      }

      resolve(profile);
    });
  });
}

/**
 * Обновить своё публичное описание (bio) — только сам пользователь.
 */
function updateOwnBio(userId, bio) {
  const trimmed = String(bio == null ? '' : bio).slice(0, 2000);
  return new Promise((resolve, reject) => {
    db.run('UPDATE users SET bio = ? WHERE id = ?', [trimmed, userId], (err) => {
      if (err) reject(err); else resolve({ bio: trimmed });
    });
  });
}

/**
 * Обновить приватную админ-заметку о пользователе. Право проверяется тут
 * же (не завязано на checkPermission в роуте, т.к. это не одно из "жёстких"
 * управляющих действий типа блокировки — переиспользуем view_users_tab:
 * кто видит вкладку "Пользователи", тот может оставить заметку).
 */
function updateAdminNote(actingUser, targetId, note) {
  const allowed = !!(actingUser && (actingUser.is_root || (actingUser.permissions && actingUser.permissions.view_users_tab)));
  if (!allowed) return Promise.reject(new Error('Недостаточно прав для этого действия'));

  const trimmed = String(note == null ? '' : note).slice(0, 2000);
  return new Promise((resolve, reject) => {
    db.run('UPDATE users SET admin_note = ? WHERE id = ?', [trimmed, targetId], (err) => {
      if (err) reject(err); else resolve({ admin_note: trimmed });
    });
  });
}

/**
 * Получить всех пользователей со статусом pending
 */
function getPendingUsers() {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT id, username, display_name, role_id, status, created_at FROM users WHERE status = ? ORDER BY created_at DESC',
      ['pending'],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows);
      }
    );
  });
}

/**
 * Одобрить пользователя
 */
function approveUser(userId, approvedBy) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET status = ? WHERE id = ?',
      ['approved', userId],
      function (err) {
        if (err) {
          reject(err);
          return;
        }
        if (this.changes === 0) {
          reject(new Error('Пользователь не найден'));
          return;
        }
        console.log(`Пользователь ${userId} одобрен пользователем ${approvedBy}`);
        resolve({ success: true, userId });
      }
    );
  });
}

/**
 * Отклонить пользователя
 */
function rejectUser(userId, reason, rejectedBy) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET status = ?, rejection_reason = ? WHERE id = ?',
      ['rejected', reason || 'Заявка отклонена администратором', userId],
      function (err) {
        if (err) {
          reject(err);
          return;
        }
        if (this.changes === 0) {
          reject(new Error('Пользователь не найден'));
          return;
        }
        console.log(`Пользователь ${userId} отклонён пользователем ${rejectedBy}. Причина: ${reason}`);
        resolve({ success: true, userId });
      }
    );
  });
}

/**
 * Получить всех пользователей (вкладка "Пользователи"). Порядок: сперва
 * владелец, затем админы по убыванию уровня их роли, затем обычные
 * пользователи — см. требование "админы всегда вверху списка".
 */
function getAllUsers() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT u.id, u.username, u.display_name, u.role_id, u.status, u.is_root,
              u.admin_role_id, u.is_role_manager, u.muted_until, u.mute_reason,
              u.rejection_reason, u.created_at,
              r.name as role_name, r.level as role_level
       FROM users u
       LEFT JOIN admin_roles r ON u.admin_role_id = r.id
       ORDER BY u.is_root DESC, COALESCE(r.level, 0) DESC, u.created_at DESC`,
      [],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows.map((r) => ({
          id: r.id,
          username: r.username,
          display_name: r.display_name,
          role_id: r.role_id,
          status: r.status,
          is_root: !!r.is_root,
          admin_role_id: r.admin_role_id || null,
          role_name: r.role_name || null,
          admin_level: r.role_level || 0,
          is_role_manager: !!r.is_role_manager,
          muted_until: r.muted_until || null,
          mute_reason: r.mute_reason || null,
          rejection_reason: r.rejection_reason || null,
          created_at: r.created_at
        })));
      }
    );
  });
}

// ========================================
// ВЛАДЕЛЕЦ/ДОВЕРЕННЫЙ АДМИН — каталог ролей (admin_roles)
// ========================================

function getAllRoles() {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM admin_roles ORDER BY level DESC', [], (err, rows) => {
      if (err) { reject(err); return; }
      resolve(rows.map((r) => ({ id: r.id, name: r.name, level: r.level, permissions: parsePermissions(r.permissions), created_at: r.created_at })));
    });
  });
}

function validatePermissionsInput(permissions) {
  const result = {};
  PERMISSION_KEYS.forEach((key) => { result[key] = !!(permissions && permissions[key]); });
  return result;
}

async function createRole({ name, level, permissions }) {
  const cleanName = (name || '').trim();
  if (!cleanName) throw new Error('Название роли обязательно');
  const numericLevel = Number(level);
  if (!Number.isInteger(numericLevel) || numericLevel < 0) throw new Error('Уровень должен быть целым числом ≥ 0');

  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO admin_roles (name, level, permissions) VALUES (?, ?, ?)',
      [cleanName, numericLevel, JSON.stringify(validatePermissionsInput(permissions))],
      function (err) {
        if (err) {
          if (String(err.message).includes('UNIQUE')) reject(new Error('Роль с таким названием уже существует'));
          else reject(err);
          return;
        }
        resolve({ id: this.lastID, name: cleanName, level: numericLevel, permissions: validatePermissionsInput(permissions) });
      }
    );
  });
}

async function updateRole(roleId, { name, level, permissions }) {
  const existing = await new Promise((resolve, reject) => {
    db.get('SELECT * FROM admin_roles WHERE id = ?', [roleId], (err, row) => (err ? reject(err) : resolve(row)));
  });
  if (!existing) throw new Error('Роль не найдена');

  const cleanName = name != null ? name.trim() : existing.name;
  if (!cleanName) throw new Error('Название роли обязательно');
  const numericLevel = level != null ? Number(level) : existing.level;
  if (!Number.isInteger(numericLevel) || numericLevel < 0) throw new Error('Уровень должен быть целым числом ≥ 0');
  const finalPermissions = permissions != null ? validatePermissionsInput(permissions) : parsePermissions(existing.permissions);

  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE admin_roles SET name = ?, level = ?, permissions = ? WHERE id = ?',
      [cleanName, numericLevel, JSON.stringify(finalPermissions), roleId],
      function (err) {
        if (err) {
          if (String(err.message).includes('UNIQUE')) reject(new Error('Роль с таким названием уже существует'));
          else reject(err);
          return;
        }
        resolve({ id: roleId, name: cleanName, level: numericLevel, permissions: finalPermissions });
      }
    );
  });
}

async function deleteRole(roleId) {
  const inUse = await new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as cnt FROM users WHERE admin_role_id = ?', [roleId], (err, row) => (err ? reject(err) : resolve(row.cnt)));
  });
  if (inUse > 0) throw new Error(`Роль назначена ${inUse} польз.: сначала снимите её у них`);

  return new Promise((resolve, reject) => {
    db.run('DELETE FROM admin_roles WHERE id = ?', [roleId], function (err) {
      if (err) { reject(err); return; }
      if (this.changes === 0) { reject(new Error('Роль не найдена')); return; }
      resolve({ success: true, roleId });
    });
  });
}

/**
 * Назначить/снять "доверенного админа" (is_role_manager) — уникальный
 * статус, максимум один пользователь одновременно. Выдаётся только
 * владельцем (проверка — на уровне маршрута, auth.checkRoot).
 */
async function setRoleManager(userId, enabled) {
  const target = await getUserFull(userId);
  if (!target) throw new Error('Пользователь не найден');
  if (target.is_root) throw new Error('У владельца это право есть всегда');

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      if (enabled) {
        db.run('UPDATE users SET is_role_manager = 0 WHERE is_role_manager = 1');
      }
      db.run('UPDATE users SET is_role_manager = ? WHERE id = ?', [enabled ? 1 : 0, userId], function (err) {
        if (err) reject(err);
        else resolve({ success: true, userId, is_role_manager: !!enabled });
      });
    });
  });
}

// ========================================
// ВЛАДЕЛЕЦ/АДМИНЫ (по правам роли) — назначение роли, переименование,
// блокировка, мут. Каждая функция сама проверяет право и иерархию через
// requirePermission/assertCanManage — маршруты передают actingUser (уже
// живьём обновлённый checkApproved).
// ========================================

/**
 * Назначить пользователю роль из каталога admin_roles (или снять роль,
 * если roleId пуст/0). Владельца трогать нельзя; не-владелец не может ни
 * назначить роль пользователю, который уже равен ему или выше по рангу, ни
 * выдать роль с уровнем выше своего собственного (пэры — можно).
 */
async function assignUserRole(actingUser, userId, roleId) {
  requirePermission(actingUser, 'manage_admin_roles');
  const target = await assertCanManage(actingUser, userId);
  if (target.status !== 'approved') throw new Error('Роль можно выдать только подтверждённому пользователю');

  if (!roleId) {
    return new Promise((resolve, reject) => {
      db.run('UPDATE users SET admin_role_id = NULL, admin_level = 0 WHERE id = ?', [userId], function (err) {
        if (err) reject(err);
        else resolve({ success: true, userId, admin_role_id: null });
      });
    });
  }

  const role = await new Promise((resolve, reject) => {
    db.get('SELECT * FROM admin_roles WHERE id = ?', [roleId], (err, row) => (err ? reject(err) : resolve(row)));
  });
  if (!role) throw new Error('Роль не найдена');

  if (!actingUser.is_root && role.level > (actingUser.admin_level || 0)) {
    throw new Error('Нельзя выдать роль выше своего собственного уровня');
  }

  return new Promise((resolve, reject) => {
    db.run('UPDATE users SET admin_role_id = ?, admin_level = ? WHERE id = ?', [role.id, role.level, userId], function (err) {
      if (err) reject(err);
      else resolve({ success: true, userId, admin_role_id: role.id, role_name: role.name, admin_level: role.level });
    });
  });
}

/**
 * Переименовать пользователя (display_name и, опционально, username-логин).
 * Владельца переименовать нельзя — этим не управляет никто через панель.
 */
async function renameUser(actingUser, userId, { display_name, username }) {
  requirePermission(actingUser, 'rename_users');
  const target = await assertCanManage(actingUser, userId);

  const newDisplayName = (display_name || '').trim();
  if (!newDisplayName) throw new Error('Имя не может быть пустым');

  let newUsername = target.username;
  if (username != null && username.trim() && username.trim() !== target.username) {
    newUsername = username.trim();
    const existing = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM users WHERE username = ? AND id != ?', [newUsername, userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (existing) throw new Error('Логин уже занят');
  }

  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET display_name = ?, username = ? WHERE id = ?',
      [newDisplayName, newUsername, userId],
      function (err) {
        if (err) reject(err);
        else resolve({ success: true, userId, display_name: newDisplayName, username: newUsername });
      }
    );
  });
}

/**
 * Заблокировать пользователя — переиспользует существующий status
 * (как pending/rejected) и rejection_reason как причину блокировки.
 * Живой запрет входа для уже открытых сессий обеспечивает checkApproved
 * (читает статус из БД при каждом запросе, а не из JWT).
 */
async function blockUser(actingUser, userId, reason) {
  requirePermission(actingUser, 'block_users');
  const target = await assertCanManage(actingUser, userId);
  if (target.status !== 'approved') throw new Error('Заблокировать можно только подтверждённого пользователя');

  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET status = ?, rejection_reason = ? WHERE id = ?',
      ['blocked', reason || 'Заблокирован администратором', userId],
      function (err) {
        if (err) reject(err);
        else resolve({ success: true, userId });
      }
    );
  });
}

/**
 * Разблокировать пользователя — возвращает status в 'approved'.
 */
async function unblockUser(actingUser, userId) {
  requirePermission(actingUser, 'block_users');
  const target = await assertCanManage(actingUser, userId);
  if (target.status !== 'blocked') throw new Error('Пользователь не заблокирован');

  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET status = ?, rejection_reason = NULL WHERE id = ?',
      ['approved', userId],
      function (err) {
        if (err) reject(err);
        else resolve({ success: true, userId });
      }
    );
  });
}

/**
 * Временно замутить пользователя (не пускает писать сообщения и
 * создавать/редактировать статьи — см. checkNotMuted в
 * articles.routes.js/messages.routes.js) на N минут.
 */
async function muteUser(actingUser, userId, minutes, reason) {
  requirePermission(actingUser, 'mute_users');
  await assertCanManage(actingUser, userId);

  const numericMinutes = Number(minutes);
  if (!Number.isFinite(numericMinutes) || numericMinutes <= 0) {
    throw new Error('Длительность мута должна быть положительным числом минут');
  }
  const mutedUntil = new Date(Date.now() + numericMinutes * 60 * 1000).toISOString();

  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET muted_until = ?, mute_reason = ? WHERE id = ?',
      [mutedUntil, reason || 'Временный мут', userId],
      function (err) {
        if (err) reject(err);
        else resolve({ success: true, userId, muted_until: mutedUntil });
      }
    );
  });
}

/**
 * Снять мут раньше срока.
 */
async function unmuteUser(actingUser, userId) {
  requirePermission(actingUser, 'mute_users');
  await assertCanManage(actingUser, userId);

  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET muted_until = NULL, mute_reason = NULL WHERE id = ?',
      [userId],
      function (err) {
        if (err) reject(err);
        else resolve({ success: true, userId });
      }
    );
  });
}

// ========================================
// RATE-LIMIT ХЕЛПЕР
// ========================================

const loginAttempts = new Map();
const registrationAttempts = new Map();

const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 минут
const MAX_LOGIN_ATTEMPTS = 10;
const MAX_REGISTRATION_ATTEMPTS = 5;

/**
 * Rate-limit middleware для login/register
 */
function rateLimitLimiter(type) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const attemptsMap = type === 'login' ? loginAttempts : registrationAttempts;
    const maxAttempts = type === 'login' ? MAX_LOGIN_ATTEMPTS : MAX_REGISTRATION_ATTEMPTS;

    const key = `${ip}:${type}`;
    const now = Date.now();
    const record = attemptsMap.get(key);

    if (record && now - record.startTime < RATE_LIMIT_WINDOW) {
      record.count++;
      if (record.count > maxAttempts) {
        const retryAfter = Math.ceil((record.startTime + RATE_LIMIT_WINDOW - now) / 1000);
        return res.status(429).json({
          error: `Слишком много попыток. Попробуйте через ${retryAfter} сек.`
        });
      }
    } else {
      attemptsMap.set(key, { count: 1, startTime: now });
    }

    next();
  };
}

// Сбрасываем старые записи каждый час
setInterval(() => {
  const now = Date.now();
  [loginAttempts, registrationAttempts].forEach(map => {
    for (const [key, record] of map.entries()) {
      if (now - record.startTime > RATE_LIMIT_WINDOW) {
        map.delete(key);
      }
    }
  });
}, 3600000);

// ========================================
// ЭКСПОРТ
// ========================================

module.exports = {
  register,
  login,
  generateToken,
  generateRefreshToken,
  authenticateToken,
  checkApproved,
  checkRoot,
  checkPermission,
  checkRoleManager,
  checkNotMuted,
  isMuted,
  getUserById,
  getUserProfile,
  updateOwnBio,
  updateAdminNote,
  getPendingUsers,
  approveUser,
  rejectUser,
  getAllUsers,
  getAllRoles,
  createRole,
  updateRole,
  deleteRole,
  setRoleManager,
  assignUserRole,
  renameUser,
  blockUser,
  unblockUser,
  muteUser,
  unmuteUser,
  rateLimitLimiter,
  assignObserverRoleIfNeeded,
  getUserFull,
  PERMISSION_KEYS,
  JWT_SECRET
};
