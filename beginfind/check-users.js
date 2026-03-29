const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Подключение к базе данных
const db = new sqlite3.Database(path.join(__dirname, 'users.db'), (err) => {
  if (err) {
    console.error('Error opening database', err);
  } else {
    console.log('Connected to SQLite database');
  }
});

// Получение всех пользователей
db.all('SELECT * FROM users', [], (err, rows) => {
  if (err) {
    console.error('Error fetching users:', err);
    return;
  }

  console.log('Users in database:');
  rows.forEach((row) => {
    console.log(`ID: ${row.id}, Username: ${row.username}, Password (hashed): ${row.password ? 'Exists' : 'NULL'}, Role ID: ${row.role_id}`);
  });

  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err);
    } else {
      console.log('Database connection closed');
    }
  });
});