const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Путь к директории с загрузками
const uploadsDir = path.join(__dirname, 'public', 'uploads');

// Функция для получения всех файлов в директории
function getAllFiles(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    console.error('Error reading directory:', err);
    return [];
  }
}

// Функция для извлечения имен файлов из URL
function extractFilenameFromUrl(url) {
  if (!url) return null;
  
  // Извлекаем имя файла из URL вида /uploads/filename.ext
  const match = url.match(/\/uploads\/(.+)$/);
  return match ? match[1] : null;
}

// Функция для извлечения имен файлов из содержимого (для сообщений)
function extractFilenamesFromContent(content) {
  if (!content) return [];
  
  const filenames = [];
  
  // Ищем все URL изображений в содержимом, учитываем различные хосты и порты
  const httpUrlRegex = /http:\/\/[\w\d\.:-]+\/uploads\/([^\s"'>]+)/g;
  let match;
  while ((match = httpUrlRegex.exec(content)) !== null) {
    filenames.push(match[1]);
  }
  
  // Также ищем относительные пути к изображениям вида /uploads/filename.png
  const relativeUrlRegex = /\/uploads\/([^\s"'<>?]+)/g;
  while ((match = relativeUrlRegex.exec(content)) !== null) {
    // Проверяем, что это не query параметр или часть другого URL
    if (!match[0].includes('?') || match[0].split('?')[0].endsWith(match[1])) {
      filenames.push(match[1]);
    }
  }
  
  return filenames;
}

// Основная функция очистки
async function cleanUnusedFiles() {
  console.log(`[${new Date().toISOString()}] Starting cleanup process...`);
  
  // Проверяем, существует ли директория загрузок
  if (!fs.existsSync(uploadsDir)) {
    console.log(`[${new Date().toISOString()}] Uploads directory does not exist`);
    return;
  }
  
  // Получаем все файлы в директории загрузок
  const allFiles = getAllFiles(uploadsDir);
  console.log(`[${new Date().toISOString()}] Found ${allFiles.length} files in uploads directory`);
  
  if (allFiles.length === 0) {
    console.log(`[${new Date().toISOString()}] No files to process`);
    return;
  }
  
  // Подключаемся к базам данных
  const articlesDb = new sqlite3.Database(path.join(__dirname, 'articles.db'));
  const messengerDb = new sqlite3.Database(path.join(__dirname, 'messenger.db'));
  
  try {
    // Получаем все используемые файлы из статей
    const usedFilesFromArticles = await new Promise((resolve, reject) => {
      articlesDb.all('SELECT image FROM articles WHERE image IS NOT NULL', (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const filenames = rows
            .map(row => extractFilenameFromUrl(row.image))
            .filter(filename => filename !== null);
          resolve(filenames);
        }
      });
    });
    
    console.log(`[${new Date().toISOString()}] Found ${usedFilesFromArticles.length} files used in articles`);
    
    // Получаем все используемые файлы из сообщений
    const usedFilesFromMessages = await new Promise((resolve, reject) => {
      messengerDb.all('SELECT content FROM messages', (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const filenames = rows
            .map(row => extractFilenamesFromContent(row.content))
            .flat();
          resolve(filenames);
        }
      });
    });
    
    console.log(`[${new Date().toISOString()}] Found ${usedFilesFromMessages.length} files used in messages`);
    
    // Объединяем все используемые файлы
    const usedFiles = new Set([...usedFilesFromArticles, ...usedFilesFromMessages]);
    console.log(`[${new Date().toISOString()}] Total unique used files: ${usedFiles.size}`);
    
    // Определяем неиспользуемые файлы
    const unusedFiles = allFiles.filter(file => !usedFiles.has(file));
    console.log(`[${new Date().toISOString()}] Found ${unusedFiles.length} unused files`);
    
    // Удаляем неиспользуемые файлы
    let deletedCount = 0;
    for (const file of unusedFiles) {
      try {
        const filePath = path.join(uploadsDir, file);
        fs.unlinkSync(filePath);
        console.log(`[${new Date().toISOString()}] Deleted unused file: ${file}`);
        deletedCount++;
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Error deleting file ${file}:`, err);
      }
    }
    
    console.log(`[${new Date().toISOString()}] Cleanup completed. Deleted ${deletedCount} unused files.`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error during cleanup process:`, err);
  } finally {
    // Закрываем соединения с базами данных
    articlesDb.close();
    messengerDb.close();
  }
}

// Запускаем очистку при старте сервера
console.log(`[${new Date().toISOString()}] Scheduled cleanup service started`);
// cleanUnusedFiles(); // Запускаем сразу при старте - отключено, т.к. может удалить используемые файлы

// Планируем выполнение очистки каждый день в 3:00 ночи
// Выражение cron: минуты часы день_месяца месяц день_недели
// 0 3 * * * означает каждый день в 3:00
cron.schedule('0 3 * * *', () => {
  cleanUnusedFiles();
}, {
  scheduled: true,
  timezone: "Europe/Moscow" // Установите ваш часовой пояс
});

module.exports = { cleanUnusedFiles };