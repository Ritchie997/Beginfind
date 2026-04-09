const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

/**
 * Проверяет участие пользователя в серверах и назначает роль "наблюдатель" если нужно
 * (встроена из удалённого server-membership-check.js)
 */
async function assignObserverRoleIfNeeded(userId) {
  return new Promise((resolve) => {
    const serversDb = new sqlite3.Database(path.join(__dirname, 'servers.db'));
    const usersDb = new sqlite3.Database(path.join(__dirname, 'users.db'));

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
const db = new sqlite3.Database(path.join(__dirname, 'users.db'), (err) => {
  if (err) {
    console.error('Error opening users database', err);
  } else {
    console.log('Connected to users database');
  }
});

// Настройки JWT
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

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

      // Проверяем пароль
      let isValid = false;

      if (!row.password) {
        // Пароль отсутствует — используем «admin» как fallback для старых аккаунтов
        if (password === 'admin') {
          isValid = true;
        }
      } else if (row.password.length < 30) {
        // Не-хешированный пароль (legacy)
        if (password === row.password) {
          isValid = true;
        }
      } else {
        // bcrypt хеш
        isValid = await bcrypt.compare(password, row.password);
      }

      if (!isValid) {
        reject(new Error('Неверное имя пользователя или пароль'));
        return;
      }

      // Проверяем статус аккаунта
      const status = row.status || 'pending';

      if (status === 'rejected') {
        const reason = row.rejection_reason || 'Ваша заявка была отклонена.';
        reject(new Error(`Доступ отклонён. Причина: ${reason}`));
        return;
      }

      if (status === 'pending') {
        reject(new Error('Аккаунт ожидает подтверждения администратором'));
        return;
      }

      // status === 'approved' — всё в порядке

      // Проверяем, нужно ли назначить роль наблюдателя
      const observerCheck = await assignObserverRoleIfNeeded(row.id);

      const user = {
        id: row.id,
        username: row.username,
        display_name: row.display_name || row.username,
        role_id: row.role_id,
        status: status,
        is_root: !!row.is_root,
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
 * Генерация access токена
 */
async function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      role_id: user.role_id,
      status: user.status,
      is_root: user.is_root,
      is_observer: user.is_observer || false
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
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
      return res.status(403).json({ error: 'Неверный или просроченный токен' });
    }

    req.user = user;
    next();
  });
}

// ========================================
// MIDDLEWARE — ПРОВЕРКА СТАТУСА
// ========================================

/**
 * Middleware: допускает только пользователей со статусом approved
 */
function checkApproved(req, res, next) {
  if (req.user.status !== 'approved') {
    return res.status(403).json({
      error: 'Доступ запрещён: аккаунт не подтверждён',
      status: req.user.status
    });
  }
  next();
}

/**
 * Middleware: допускает только root-пользователей
 */
function checkRoot(req, res, next) {
  if (!req.user.is_root) {
    return res.status(403).json({ error: 'Доступно только root-пользователю' });
  }
  next();
}

// ========================================
// УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ
// ========================================

/**
 * Получить пользователя по ID
 */
function getUserById(id) {
  return new Promise((resolve, reject) => {
    db.get('SELECT id, username, display_name, role_id, status, is_root FROM users WHERE id = ?', [id], (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      if (!row) {
        reject(new Error('Пользователь не найден'));
        return;
      }

      resolve({
        id: row.id,
        username: row.username,
        display_name: row.display_name || row.username,
        role_id: row.role_id,
        status: row.status || 'pending',
        is_root: !!row.is_root
      });
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
 * Получить всех пользователей (для root-админки)
 */
function getAllUsers() {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT id, username, display_name, role_id, status, is_root, created_at FROM users ORDER BY created_at DESC',
      [],
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
  getUserById,
  getPendingUsers,
  approveUser,
  rejectUser,
  getAllUsers,
  rateLimitLimiter,
  JWT_SECRET
};
