const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

// Подключаемся к базе данных
const db = new sqlite3.Database(path.join(__dirname, 'users.db'), (err) => {
  if (err) {
    console.error('Error opening database', err);
    return;
  }
  
  console.log('Connected to database');
  
  // Создаем таблицу пользователей, если она не существует
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES roles (id)
  )`, (err) => {
    if (err) {
      console.error('Error creating users table:', err);
      return;
    }

    // Хешируем пароль для пользователя Ritchie
    bcrypt.hash('asdemo1986', 10, (err, hashedPassword1) => {
      if (err) {
        console.error('Error hashing password for Ritchie:', err);
        return;
      }

      // Добавляем пользователя Ritchie
      db.run(
        'INSERT OR IGNORE INTO users (username, password_hash, role_id) VALUES (?, ?, ?)',
        ['Ritchie', hashedPassword1, 4], // Роль 4 - администратор
        function(err) {
          if (err) {
            console.error('Error inserting user Ritchie:', err);
          } else {
            if (this.changes > 0) {
              console.log('User Ritchie created successfully');
            } else {
              console.log('User Ritchie already exists');
            }
          }
          
          // Теперь добавим второго пользователя
          bcrypt.hash('Corepse123Kodai1', 10, (err, hashedPassword2) => {
            if (err) {
              console.error('Error hashing password for Corepse Kodai:', err);
              return;
            }

            // Добавляем пользователя Corepse Kodai
            db.run(
              'INSERT OR IGNORE INTO users (username, password_hash, role_id) VALUES (?, ?, ?)',
              ['Corepse Kodai', hashedPassword2, 4], // Роль 4 - администратор
              function(err) {
                if (err) {
                  console.error('Error inserting user Corepse Kodai:', err);
                } else {
                  if (this.changes > 0) {
                    console.log('User Corepse Kodai created successfully');
                  } else {
                    console.log('User Corepse Kodai already exists');
                  }
                }
                
                // Закрываем соединение с базой данных
                db.close((err) => {
                  if (err) {
                    console.error('Error closing database:', err);
                  } else {
                    console.log('Database connection closed');
                  }
                });
              }
            );
          });
        }
      );
    });
  });
});