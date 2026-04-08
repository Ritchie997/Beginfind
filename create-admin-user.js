const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

// Подключаемся к базе данных пользователей
const db = new sqlite3.Database(path.join(__dirname, 'users.db'), (err) => {
  if (err) {
    console.error('Ошибка подключения к базе данных пользователей', err);
    return;
  }
  
  console.log('Подключено к базе данных пользователей');
  
  // Хешируем пароль "admin"
  bcrypt.hash('admin', 10, (err, hashedPassword) => {
    if (err) {
      console.error('Ошибка хеширования пароля:', err);
      return;
    }

    // Добавляем пользователя admin с ролью администратора (предположим, что role_id = 2 для администратора)
    db.run(
      'INSERT OR IGNORE INTO users (username, password, role_id) VALUES (?, ?, ?)',
      ['admin', hashedPassword, 2], // role_id 2 для администратора
      function(err) {
        if (err) {
          console.error('Ошибка добавления пользователя:', err);
        } else {
          if (this.changes > 0) {
            console.log('Пользователь admin создан успешно');
          } else {
            console.log('Пользователь admin уже существует');
          }
        }
        
        // Закрываем соединение с базой данных
        db.close((err) => {
          if (err) {
            console.error('Ошибка закрытия базы данных:', err);
          } else {
            console.log('Соединение с базой данных закрыто');
          }
        });
      }
    );
  });
});