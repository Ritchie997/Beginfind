// server-membership-check.js - Проверка участия пользователя в серверах и автоматическое назначение роли наблюдателя

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Функция для проверки, состоит ли пользователь в каком-либо сервере
async function isUserMemberOfAnyServer(userId) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path.join(__dirname, 'servers.db'));
    
    db.get(`
      SELECT COUNT(*) as server_count 
      FROM user_server_memberships 
      WHERE user_id = ?
    `, [userId], (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row.server_count > 0);
      }
      db.close();
    });
  });
}

// Функция для проверки, является ли пользователь администратором (имеет флаг isAdmin)
async function isUserAdmin(userId) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path.join(__dirname, 'users.db'));
    
    // Сначала проверяем, существует ли колонка isAdmin
    db.all(`
      PRAGMA table_info(users)
    `, [], (err, rows) => {
      if (err) {
        reject(err);
        db.close();
        return;
      }
      
      // Проверяем, есть ли колонка isAdmin в таблице
      const hasIsAdminColumn = rows.some(row => row.name === 'isAdmin');
      
      if (hasIsAdminColumn) {
        // Если колонка существует, используем ее
        db.get(`
          SELECT isAdmin 
          FROM users 
          WHERE id = ?
        `, [userId], (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row && row.isAdmin === 1);
          }
          db.close();
        });
      } else {
        // Если колонки нет, проверяем по role_id (предполагаем, что role_id = 1 или 4 для админов)
        db.get(`
          SELECT role_id 
          FROM users 
          WHERE id = ?
        `, [userId], (err, row) => {
          if (err) {
            reject(err);
          } else {
            // Предполагаем, что role_id = 1 или 4 для администраторов
            resolve(row && (row.role_id === 1 || row.role_id === 4));
          }
          db.close();
        });
      }
    });
  });
}

// Функция для автоматического назначения роли "наблюдатель" пользователю при первом входе
// если он не состоит ни в одном сервере и не является администратором
async function assignObserverRoleIfNeeded(userId) {
  try {
    // Проверяем, является ли пользователь администратором
    const isAdmin = await isUserAdmin(userId);
    if (isAdmin) {
      // Администраторы имеют полный доступ ко всему, не нуждаются в роли наблюдателя
      return { assigned: false, reason: 'User is administrator' };
    }
    
    // Проверяем, состоит ли пользователь в каком-либо сервере
    const isMember = await isUserMemberOfAnyServer(userId);
    if (isMember) {
      // Пользователь уже состоит в сервере, не нуждается в роли наблюдателя
      return { assigned: false, reason: 'User is member of server' };
    }
    
    // Пользователь не состоит ни в одном сервере и не является администратором
    // Он считается наблюдателем по умолчанию
    return { 
      assigned: true, 
      reason: 'User assigned as observer by default',
      role: {
        id: 0,
        name: 'Наблюдатель',
        code: 'observer',
        permissions: {
          read_content: true,
          send_messages: false,
          manage_content: false
        }
      }
    };
  } catch (error) {
    console.error('Error assigning observer role:', error);
    return { assigned: false, error: error.message };
  }
}

module.exports = {
  isUserMemberOfAnyServer,
  isUserAdmin,
  assignObserverRoleIfNeeded
};