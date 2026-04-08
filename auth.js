const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { assignObserverRoleIfNeeded } = require('./server-membership-check');

// Подключение к новой базе данных пользователей
const db = new sqlite3.Database(path.join(__dirname, 'users.db'), (err) => {
  if (err) {
    console.error('Error opening users database', err);
  } else {
    console.log('Connected to users database');
  }
});

// Настройки JWT
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret';

// Регистрация пользователя
async function register(username, password, roleId = 4) { // По умолчанию используем роль 4 как у существующих пользователей
  // Хешируем пароль
  const hashedPassword = await bcrypt.hash(password, 10);
  
  return new Promise((resolve, reject) => {
    // Проверяем, существует ли пользователь
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      
      if (row) {
        reject(new Error('Username already exists'));
        return;
      }
      
      // Вставляем нового пользователя
      db.run(
        'INSERT INTO users (username, password, role_id) VALUES (?, ?, ?)', 
        [username, hashedPassword, roleId], 
        function(err) {
          if (err) {
            reject(err);
            return;
          }
          
          // Возвращаем нового пользователя
          const newUser = {
            id: this.lastID,
            username,
            role_id: roleId
          };
          
          resolve(newUser);
        }
      );
    });
  });
}

// Вход пользователя
async function login(username, password) {
  return new Promise((resolve, reject) => {
    // Получаем пользователя из базы
    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      
      if (!row) {
        reject(new Error('Invalid username or password'));
        return;
      }
      
      // Проверяем, есть ли хешированный пароль в базе
      if (!row.password) {
        // Если пароль отсутствует (NULL), используем "admin" как пароль по умолчанию
        if (password !== 'admin') {
          reject(new Error('Invalid username or password'));
          return;
        }
      } else if (row.password.length < 30) { // bcrypt хэши обычно длиннее 30 символов
        // Если пароль не хеширован (старый формат), сравниваем как обычную строку
        if (password !== row.password) {
          reject(new Error('Invalid username or password'));
          return;
        }
      } else {
        // Если пароль хеширован, используем bcrypt
        const isValid = await bcrypt.compare(password, row.password);
        if (!isValid) {
          reject(new Error('Invalid username or password'));
          return;
        }
      }
      
      // Проверяем, состоит ли пользователь в каком-либо сервере
      // Если нет, назначаем ему роль "наблюдатель" (только при первом входе)
      const serversDb = new sqlite3.Database(path.join(__dirname, 'servers.db'));
      serversDb.get(`
        SELECT COUNT(*) as server_count 
        FROM user_server_memberships 
        WHERE user_id = ?
      `, [row.id], (err, countRow) => {
        if (err) {
          console.error('Error checking user server membership:', err);
        } else {
          // Если пользователь не состоит ни в одном сервере, он считается наблюдателем
          // Эта логика будет обрабатываться на клиентской стороне
        }
        
        // Возвращаем пользователя без пароля
        const user = {
          id: row.id,
          username: row.username,
          role_id: row.role_id
        };
        
        serversDb.close();
        resolve(user);
      });
    });
  });
}

// Генерация токена
async function generateToken(user) {
  // Проверяем, нужно ли назначить роль наблюдателя
  const observerCheck = await assignObserverRoleIfNeeded(user.id);
  
  return jwt.sign(
    { 
      id: user.id, 
      username: user.username, 
      role_id: user.role_id,
      is_observer: observerCheck.assigned,
      observer_role: observerCheck.assigned ? observerCheck.role : null
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

// Аутентификация токена
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    
    req.user = user;
    next();
  });
}

// Получение пользователя по ID
function getUserById(id) {
  return new Promise((resolve, reject) => {
    db.get('SELECT id, username, role_id FROM users WHERE id = ?', [id], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      
      if (!row) {
        reject(new Error('User not found'));
        return;
      }
      
      resolve({
        id: row.id,
        username: row.username,
        role_id: row.role_id
      });
    });
  });
}

module.exports = {
  register,
  login,
  generateToken,
  authenticateToken,
  getUserById
};