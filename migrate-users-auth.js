const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'users.db'), (err) => {
  if (err) {
    console.error('Error opening users database', err);
    return;
  }

  console.log('Connected to users database for migration');

  const migrationSQL = `
    -- Добавляем поле display_name (отображаемое имя)
    ALTER TABLE users ADD COLUMN display_name TEXT;

    -- Добавляем поле status (pending, approved, rejected)
    ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'pending';

    -- Добавляем флаг root-пользователя
    ALTER TABLE users ADD COLUMN is_root INTEGER DEFAULT 0;

    -- Добавляем причину отклонения
    ALTER TABLE users ADD COLUMN rejection_reason TEXT;

    -- Обновляем существующих пользователей: все approved, не root
    UPDATE users SET status = 'approved' WHERE status IS NULL;
    UPDATE users SET is_root = 0 WHERE is_root IS NULL;
  `;

  // Выполняем миграцию (каждый ALTER TABLE выполнится, даже если колонка уже существует — обработаем ошибки)
  db.exec(migrationSQL, (err) => {
    if (err) {
      // SQLite не позволяет ALTER TABLE ADD COLUMN если колонка уже есть — это нормально
      if (err.message.includes('duplicate column')) {
        console.log('Migration already applied (columns exist).');
      } else {
        console.error('Error during migration:', err.message);
      }
    } else {
      console.log('Database migration completed successfully');
    }

    db.close((err) => {
      if (err) {
        console.error('Error closing database:', err);
      } else {
        console.log('Database connection closed');
      }
    });
  });
});
