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

  // Хешируем пароль
  bcrypt.hash('asdemo1986', 10, (err, hashedPassword) => {
    if (err) {
      console.error('Error hashing password:', err);
      return;
    }

    // Добавляем пользователя Ritchie
    db.run(
      'INSERT OR IGNORE INTO users (username, password, role_id) VALUES (?, ?, ?)',
      ['Ritchie', hashedPassword, 4], // Роль с ID 4 - это администратор
      function(err) {
        if (err) {
          console.error('Error inserting user:', err);
        } else {
          if (this.changes > 0) {
            console.log('User Ritchie created successfully');
          } else {
            console.log('User Ritchie already exists');
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
});