// server-permissions.js - Утилиты для проверки прав доступа на сервере
const serverSystem = require('./server-system-logic');

// Функция проверки, имеет ли пользователь определенное право на сервере
async function hasPermission(userId, serverId, permission) {
  try {
    // Получаем все роли пользователя на этом сервере
    const db = require('sqlite3').verbose().Database;
    const path = require('path');
    const database = new db(path.join(__dirname, 'servers.db'));
    
    return new Promise((resolve, reject) => {
      // Запрос для получения всех прав пользователя на сервере
      const query = `
        SELECT sr.permissions
        FROM user_server_role_assignments ura
        JOIN server_roles sr ON ura.role_id = sr.id
        WHERE ura.user_id = ? AND ura.server_id = ?
      `;
      
      database.all(query, [userId, serverId], (err, rows) => {
        if (err) {
          reject(err);
          database.close();
          return;
        }
        
        // Объединяем все права из всех ролей пользователя
        let userPermissions = {};
        for (const row of rows) {
          try {
            const permissions = JSON.parse(row.permissions);
            userPermissions = { ...userPermissions, ...permissions };
          } catch (e) {
            console.error('Error parsing permissions JSON:', e);
          }
        }
        
        // Проверяем, есть ли у пользователя запрашиваемое право
        const hasPerm = userPermissions[permission] === true;
        resolve(hasPerm);
        database.close();
      });
    });
  } catch (error) {
    console.error('Error checking permission:', error);
    return false;
  }
}

// Функция проверки, является ли пользователь администратором сервера
async function isAdminOnServer(userId, serverId) {
  try {
    const db = require('sqlite3').verbose().Database;
    const path = require('path');
    const database = new db(path.join(__dirname, 'servers.db'));
    
    return new Promise((resolve, reject) => {
      // Запрос для проверки, есть ли у пользователя роль администратора на сервере
      const query = `
        SELECT sr.id
        FROM user_server_role_assignments ura
        JOIN server_roles sr ON ura.role_id = sr.id
        WHERE ura.user_id = ? AND ura.server_id = ? AND sr.name = 'admin' AND sr.role_type = 'system'
      `;
      
      database.get(query, [userId, serverId], (err, row) => {
        if (err) {
          reject(err);
          database.close();
          return;
        }
        
        resolve(!!row); // Преобразуем в boolean
        database.close();
      });
    });
  } catch (error) {
    console.error('Error checking admin status:', error);
    return false;
  }
}

// Функция проверки иерархии ролей (пользователь с ролью с более высоким уровнем может управлять пользователями с более низким уровнем)
async function canManageUser(currentUserId, targetUserId, serverId) {
  try {
    const db = require('sqlite3').verbose().Database;
    const path = require('path');
    const database = new db(path.join(__dirname, 'servers.db'));
    
    return new Promise((resolve, reject) => {
      // Получаем максимальный уровень иерархии текущего пользователя
      const currentUserQuery = `
        SELECT MAX(sr.hierarchy_level) as max_level
        FROM user_server_role_assignments ura
        JOIN server_roles sr ON ura.role_id = sr.id
        WHERE ura.user_id = ? AND ura.server_id = ?
      `;
      
      // Получаем максимальный уровень иерархии целевого пользователя
      const targetUserQuery = `
        SELECT MAX(sr.hierarchy_level) as max_level
        FROM user_server_role_assignments ura
        JOIN server_roles sr ON ura.role_id = sr.id
        WHERE ura.user_id = ? AND ura.server_id = ?
      `;
      
      database.get(currentUserQuery, [currentUserId, serverId], (err, currentUserRow) => {
        if (err) {
          reject(err);
          database.close();
          return;
        }
        
        database.get(targetUserQuery, [targetUserId, serverId], (err, targetUserRow) => {
          if (err) {
            reject(err);
            database.close();
            return;
          }
          
          const currentUserLevel = currentUserRow ? currentUserRow.max_level : 0;
          const targetUserLevel = targetUserRow ? targetUserRow.max_level : 0;
          
          // Пользователь может управлять другим пользователем, если его уровень иерархии выше
          resolve(currentUserLevel > targetUserLevel);
          database.close();
        });
      });
    });
  } catch (error) {
    console.error('Error checking user hierarchy:', error);
    return false;
  }
}

module.exports = {
  hasPermission,
  isAdminOnServer,
  canManageUser
};