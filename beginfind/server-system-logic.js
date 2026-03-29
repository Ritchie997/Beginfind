// server-system-logic.js - Базовая логика для системы серверов

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Функция для подключения к базе данных
function getDatabaseConnection() {
  return new sqlite3.Database(path.join(__dirname, 'servers.db'));
}

// === CRUD операции для серверов ===

// Создание нового сервера
function createServer(name, description, ownerId) {
  return new Promise((resolve, reject) => {
    const db = getDatabaseConnection();
    const query = 'INSERT INTO servers (name, description, owner_id) VALUES (?, ?, ?)';
    
    db.run(query, [name, description, ownerId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve({ id: this.lastID, name, description, owner_id: ownerId });
      }
      db.close();
    });
  });
}

// Получение сервера по ID
function getServerById(serverId) {
  return new Promise((resolve, reject) => {
    const db = getDatabaseConnection();
    const query = `
      SELECT s.*, u.username as owner_username
      FROM servers s
      JOIN users u ON s.owner_id = u.id
      WHERE s.id = ?
    `;
    
    db.get(query, [serverId], (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
      db.close();
    });
  });
}

// Обновление сервера
function updateServer(serverId, name, description) {
  return new Promise((resolve, reject) => {
    const db = getDatabaseConnection();
    const query = 'UPDATE servers SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
    
    db.run(query, [name, description, serverId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve({ changes: this.changes, serverId });
      }
      db.close();
    });
  });
}

// Удаление сервера
function deleteServer(serverId) {
  return new Promise((resolve, reject) => {
    const db = getDatabaseConnection();
    const query = 'DELETE FROM servers WHERE id = ?';
    
    db.run(query, [serverId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve({ changes: this.changes, serverId });
      }
      db.close();
    });
  });
}

// Получение всех серверов
function getAllServers() {
  return new Promise((resolve, reject) => {
    const db = getDatabaseConnection();
    const query = 'SELECT * FROM servers ORDER BY created_at DESC';
    
    db.all(query, [], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
      db.close();
    });
  });
}

// === Работа с ролями на сервере ===

// Создание кастомной роли на сервере
function createRoleOnServer(serverId, roleName, hierarchyLevel, permissions) {
  return new Promise((resolve, reject) => {
    const db = getDatabaseConnection();
    const permissionsStr = JSON.stringify(permissions);
    const query = 'INSERT INTO server_roles (server_id, name, role_type, hierarchy_level, permissions) VALUES (?, ?, "custom", ?, ?)';
    
    db.run(query, [serverId, roleName, hierarchyLevel, permissionsStr], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve({ id: this.lastID, server_id: serverId, name: roleName, role_type: 'custom', hierarchy_level: hierarchyLevel, permissions });
      }
      db.close();
    });
  });
}

// Получение всех ролей на сервере (включая системные)
function getRolesOnServer(serverId) {
  return new Promise((resolve, reject) => {
    const db = getDatabaseConnection();
    const query = `SELECT * FROM server_roles WHERE server_id = ? OR (server_id IS NULL AND role_type = 'system') ORDER BY hierarchy_level DESC`;
    
    db.all(query, [serverId], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        // Преобразуем JSON строки с правами в объекты
        const processedRows = rows.map(row => {
          try {
            return {
              ...row,
              permissions: row.permissions ? JSON.parse(row.permissions) : {}
            };
          } catch (e) {
            console.error('Error parsing permissions JSON:', e);
            return {
              ...row,
              permissions: {}
            };
          }
        });
        resolve(processedRows);
      }
      db.close();
    });
  });
}

// === Управление пользователями на сервере ===

// Добавление пользователя к серверу
function addUserToServer(userId, serverId) {
  return new Promise((resolve, reject) => {
    const db = getDatabaseConnection();
    const query = 'INSERT INTO user_server_memberships (user_id, server_id) VALUES (?, ?)';
    
    db.run(query, [userId, serverId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve({ id: this.lastID, user_id: userId, server_id: serverId });
      }
      db.close();
    });
  });
}

// Назначение роли пользователю на сервере
function assignRoleToUserOnServer(userId, serverId, roleId) {
  return new Promise((resolve, reject) => {
    const db = getDatabaseConnection();
    const query = 'INSERT INTO user_server_role_assignments (user_id, server_id, role_id) VALUES (?, ?, ?)';
    
    db.run(query, [userId, serverId, roleId], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve({ id: this.lastID, user_id: userId, server_id: serverId, role_id: roleId });
      }
      db.close();
    });
  });
}

// Получение всех пользователей на сервере
function getUsersOnServer(serverId) {
  return new Promise((resolve, reject) => {
    const serversDb = getDatabaseConnection();
    const usersDb = new sqlite3.Database(path.join(__dirname, 'users.db'));
    
    // Сначала получаем всех пользователей, состоящих в этом сервере
    serversDb.all(`
      SELECT usm.user_id
      FROM user_server_memberships usm
      WHERE usm.server_id = ?
    `, [serverId], (err, membershipRows) => {
      if (err) {
        reject(err);
        serversDb.close();
        usersDb.close();
        return;
      }
      
      if (membershipRows.length === 0) {
        // Если нет участников, возвращаем пустой массив
        serversDb.close();
        usersDb.close();
        resolve([]);
        return;
      }
      
      // Получаем ID пользователей
      const userIds = membershipRows.map(row => row.user_id);
      const placeholders = userIds.map(() => '?').join(',');
      
      // Теперь получаем информацию о пользователях из базы пользователей
      usersDb.all(`
        SELECT id, username
        FROM users
        WHERE id IN (${placeholders})
      `, userIds, (err, userRows) => {
        if (err) {
          reject(err);
          serversDb.close();
          usersDb.close();
          return;
        }
        
        // Для каждого пользователя получаем его роли на этом сервере
        const users = {};
        userRows.forEach(userRow => {
          users[userRow.id] = {
            id: userRow.id,
            username: userRow.username,
            roles: []
          };
        });
        
        // Теперь получаем роли пользователей на сервере
        serversDb.all(`
          SELECT ura.user_id, ura.role_id, sr.name as role_name, sr.role_type, sr.hierarchy_level
          FROM user_server_role_assignments ura
          LEFT JOIN server_roles sr ON ura.role_id = sr.id
          WHERE ura.server_id = ?
        `, [serverId], (err, roleRows) => {
          if (err) {
            console.error('Error fetching user roles:', err);
          } else {
            // Привязываем роли к пользователям
            roleRows.forEach(roleRow => {
              if (users[roleRow.user_id]) {
                users[roleRow.user_id].roles.push({
                  id: roleRow.role_id,
                  name: roleRow.role_name,
                  type: roleRow.role_type,
                  hierarchy_level: roleRow.hierarchy_level
                });
              }
            });
          }
          
          serversDb.close();
          usersDb.close();
          resolve(Object.values(users));
        });
      });
    });
  });
}

// === Функции для администрирования ===

// Получение всех серверов с информацией о пользователях
function getAllServersWithUserCount() {
  return new Promise((resolve, reject) => {
    const serversDb = getDatabaseConnection();
    const usersDb = new sqlite3.Database(path.join(__dirname, 'users.db'));
    
    // Сначала получаем все сервера
    serversDb.all(`
      SELECT s.id, s.name, s.description, s.owner_id, s.created_at,
             s.updated_at
      FROM servers s
      ORDER BY s.created_at DESC
    `, [], (err, rows) => {
      if (err) {
        reject(err);
        serversDb.close();
        return;
      }
      
      // Для каждого сервера получаем количество участников
      const result = [];
      let processed = 0;
      
      if (rows.length === 0) {
        serversDb.close();
        usersDb.close();
        resolve([]);
        return;
      }
      
      rows.forEach(row => {
        serversDb.get('SELECT COUNT(user_id) as user_count FROM user_server_memberships WHERE server_id = ?', [row.id], (err, countRow) => {
          if (err) {
            console.error('Error counting users for server:', err);
            result.push({
              ...row,
              user_count: 0
            });
          } else {
            result.push({
              ...row,
              user_count: countRow.user_count || 0
            });
          }
          
          processed++;
          
          // Когда обработали все сервера, получаем имена владельцев
          if (processed === rows.length) {
            // Теперь получим имена владельцев
            const userIds = result.map(server => server.owner_id);
            if (userIds.length > 0) {
              const placeholders = userIds.map(() => '?').join(',');
              usersDb.all(`SELECT id, username FROM users WHERE id IN (${placeholders})`, userIds, (err, userRows) => {
                if (err) {
                  console.error('Error fetching owner usernames:', err);
                  // Добавляем пустые имена владельцев
                  result.forEach(server => {
                    server.owner_username = 'Unknown';
                  });
                } else {
                  // Добавляем имена владельцев к серверам
                  result.forEach(server => {
                    const user = userRows.find(u => u.id === server.owner_id);
                    server.owner_username = user ? user.username : 'Unknown';
                  });
                }
                
                serversDb.close();
                usersDb.close();
                resolve(result);
              });
            } else {
              serversDb.close();
              usersDb.close();
              resolve(result);
            }
          }
        });
      });
    });
  });
}

// Получение сервера с детальной информацией
function getServerWithDetails(serverId) {
  return new Promise((resolve, reject) => {
    const serversDb = getDatabaseConnection();
    const usersDb = new sqlite3.Database(path.join(__dirname, 'users.db'));
    
    // Получаем основную информацию о сервере
    serversDb.get(`
      SELECT s.id, s.name, s.description, s.owner_id, s.created_at, s.updated_at
      FROM servers s
      WHERE s.id = ?
    `, [serverId], (err, serverRow) => {
      if (err) {
        reject(err);
        serversDb.close();
        usersDb.close();
        return;
      }
      
      if (!serverRow) {
        serversDb.close();
        usersDb.close();
        resolve(null);
        return;
      }
      
      // Получаем количество участников
      serversDb.get('SELECT COUNT(user_id) as user_count FROM user_server_memberships WHERE server_id = ?', [serverId], (err, countRow) => {
        if (err) {
          console.error('Error counting users for server:', err);
          serverRow.user_count = 0;
        } else {
          serverRow.user_count = countRow.user_count || 0;
        }
        
        // Получаем количество каналов
        serversDb.get('SELECT COUNT(id) as channel_count FROM server_channels WHERE server_id = ?', [serverId], (err, channelCountRow) => {
          if (err) {
            console.error('Error counting channels for server:', err);
            serverRow.channel_count = 0;
          } else {
            serverRow.channel_count = channelCountRow.channel_count || 0;
          }
          
          // Получаем имя владельца
          usersDb.get('SELECT username FROM users WHERE id = ?', [serverRow.owner_id], (err, userRow) => {
            if (err) {
              console.error('Error fetching owner username:', err);
              serverRow.owner_username = 'Unknown';
            } else {
              serverRow.owner_username = userRow ? userRow.username : 'Unknown';
            }
            
            serversDb.close();
            usersDb.close();
            resolve(serverRow);
          });
        });
      });
    });
  });
}

module.exports = {
  createServer,
  getServerById,
  updateServer,
  deleteServer,
  getAllServers,
  createRoleOnServer,
  getRolesOnServer,
  addUserToServer,
  assignRoleToUserOnServer,
  getUsersOnServer,
  getAllServersWithUserCount,
  getServerWithDetails
};