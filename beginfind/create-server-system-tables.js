const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Подключаемся к базе данных
const db = new sqlite3.Database(path.join(__dirname, 'servers.db'), (err) => {
  if (err) {
    console.error('Error opening database', err);
    return;
  }
  
  console.log('Connected to database');

  // SQL команды для создания таблиц
  const createTablesSQL = `
    -- Таблица серверов
    CREATE TABLE IF NOT EXISTS servers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        owner_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_id) REFERENCES users(id)
    );
    
    -- Таблица ролей на серверах
    CREATE TABLE IF NOT EXISTS server_roles (
        id INTEGER PRIMARY KEY,
        server_id INTEGER,
        name TEXT NOT NULL,
        role_type TEXT DEFAULT 'custom' CHECK(role_type IN ('system', 'custom')),
        hierarchy_level INTEGER DEFAULT 0,
        permissions TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (server_id) REFERENCES servers(id),
        UNIQUE(server_id, name)
    );
    
    -- Таблица участия пользователей в серверах
    CREATE TABLE IF NOT EXISTS user_server_memberships (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        server_id INTEGER NOT NULL,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (server_id) REFERENCES servers(id),
        UNIQUE(user_id, server_id)
    );
    
    -- Таблица связей ролей с пользователями на сервере
    CREATE TABLE IF NOT EXISTS user_server_role_assignments (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        server_id INTEGER NOT NULL,
        role_id INTEGER NOT NULL,
        assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (server_id) REFERENCES servers(id),
        FOREIGN KEY (role_id) REFERENCES server_roles(id),
        UNIQUE(user_id, server_id, role_id)
    );
    
    -- Таблица чатов на серверах
    CREATE TABLE IF NOT EXISTS server_channels (
        id INTEGER PRIMARY KEY,
        server_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        channel_type TEXT DEFAULT 'text' CHECK(channel_type IN ('text', 'voice')),
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (server_id) REFERENCES servers(id)
    );
    
    -- Таблица сообщений в чатах сервера
    CREATE TABLE IF NOT EXISTS server_messages (
        id INTEGER PRIMARY KEY,
        channel_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES server_channels(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    );
    
    -- Таблица медиафайлов на серверах
    CREATE TABLE IF NOT EXISTS server_media (
        id INTEGER PRIMARY KEY,
        server_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        filename TEXT NOT NULL,
        filepath TEXT NOT NULL,
        file_type TEXT,
        size_bytes INTEGER,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (server_id) REFERENCES servers(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    );
    
    -- Вставка системных ролей по умолчанию (если они еще не существуют)
    INSERT OR IGNORE INTO server_roles (name, role_type, hierarchy_level, permissions, server_id) VALUES
    ('admin', 'system', 100, '{"send_messages": true, "manage_channels": true, "ban_users": true, "manage_roles": true, "read_messages": true}', NULL),
    ('observer', 'system', 1, '{"send_messages": false, "manage_channels": false, "ban_users": false, "manage_roles": false, "read_messages": true}', NULL),
    ('member', 'system', 10, '{"send_messages": true, "manage_channels": false, "ban_users": false, "manage_roles": false, "read_messages": true}', NULL);
  `;

  // Выполняем команды
  db.exec(createTablesSQL, (err) => {
    if (err) {
      console.error('Error creating tables:', err);
    } else {
      console.log('Tables created successfully or already exist');
    }
    
    // Закрываем соединение
    db.close((err) => {
      if (err) {
        console.error('Error closing database:', err);
      } else {
        console.log('Database connection closed');
      }
    });
  });
});