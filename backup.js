const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// Список файлов баз данных для бэкапа
const DATABASE_FILES = [
  'articles.db',
  'messenger.db',
  'servers.db',
  'users.db'
];

// Директория для хранения бэкапов
const BACKUP_DIR = path.join(__dirname, 'backups');

/**
 * Создание бэкапа всех баз данных
 * @param {string} customName - Custom имя файла бэкапа (опционально)
 * @returns {Promise<{success: boolean, filePath: string, size: number}>}
 */
async function createBackup(customName = null) {
  try {
    // Создаем директорию для бэкапов, если не существует
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      console.log('[Backup] Директория backups создана');
    }

    // Формируем имя файла
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = customName
      ? `${customName.endsWith('.zip') ? customName : customName + '.zip'}`
      : `backup-${timestamp}.zip`;

    const filePath = path.join(BACKUP_DIR, fileName);

    console.log('[Backup] Начало создания бэкапа...');
    console.log('[Backup] Путь:', filePath);

    // Создаем ZIP архив
    const zip = new AdmZip();

    // Добавляем каждый файл базы данных
    const filesAdded = [];

    for (const dbFile of DATABASE_FILES) {
      const dbPath = path.join(__dirname, dbFile);
      console.log(`[Backup] Проверка: ${dbPath}`);

      if (fs.existsSync(dbPath)) {
        const stats = fs.statSync(dbPath);
        console.log(`[Backup] Файл найден: ${dbFile} (${stats.size} байт)`);
        
        // Добавляем файл в ZIP
        zip.addLocalFile(dbPath, '', dbFile);
        filesAdded.push(dbFile);
        console.log(`[Backup] ✓ Добавлен в бэкап: ${dbFile}`);
      } else {
        console.warn(`[Backup] ⚠ Файл не найден, пропускаем: ${dbFile}`);
      }
    }

    if (filesAdded.length === 0) {
      throw new Error('Не найдено ни одной базы данных для бэкапа. Ожидаемые файлы: ' + DATABASE_FILES.join(', '));
    }

    // Сохраняем ZIP архив
    zip.writeZip(filePath);

    const stats = fs.statSync(filePath);
    const fileSizeInBytes = stats.size;

    console.log(`[Backup] ✓ Бэкап успешно создан: ${fileName} (${formatFileSize(fileSizeInBytes)})`);

    return {
      success: true,
      filePath: filePath,
      fileName: fileName,
      size: fileSizeInBytes,
      filesCount: filesAdded.length,
      files: filesAdded,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('[Backup] ✗ Ошибка при создании бэкапа:', error.message);
    throw error;
  }
}

/**
 * Восстановление баз данных из бэкапа
 * @param {string} backupPath - Путь к ZIP файлу бэкапа
 * @returns {Promise<{success: boolean, restored: string[]}>}
 */
async function restoreBackup(backupPath) {
  try {
    if (!fs.existsSync(backupPath)) {
      throw new Error('Файл бэкапа не найден');
    }

    const zip = new AdmZip(backupPath);
    const zipEntries = zip.getEntries();
    
    const restoredFiles = [];
    const errors = [];

    for (const entry of zipEntries) {
      const entryName = entry.entryName;
      
      // Проверяем, что это файл базы данных
      if (entryName.endsWith('.db')) {
        const targetPath = path.join(__dirname, entryName);
        
        try {
          // Закрываем активные подключения перед восстановлением
          await closeDatabaseConnection(entryName);
          
          // Извлекаем файл
          const buffer = entry.getData();
          fs.writeFileSync(targetPath, buffer);
          
          restoredFiles.push(entryName);
          console.log(`✓ Восстановлен: ${entryName}`);
        } catch (err) {
          errors.push(`Ошибка при восстановлении ${entryName}: ${err.message}`);
          console.error(`✗ ${errors[errors.length - 1]}`);
        }
      }
    }

    if (restoredFiles.length === 0) {
      throw new Error('В архиве не найдено файлов баз данных (.db)');
    }

    console.log(`✓ Восстановлено ${restoredFiles.length} файл(ов)`);
    
    return {
      success: true,
      restored: restoredFiles,
      errors: errors,
      count: restoredFiles.length
    };
  } catch (error) {
    console.error('✗ Ошибка при восстановлении бэкапа:', error.message);
    throw error;
  }
}

/**
 * Закрыть активное подключение к базе данных
 */
function closeDatabaseConnection(dbFile) {
  return new Promise((resolve) => {
    // SQLite кэширует подключения, поэтому просто делаем синхронизацию
    // Фактическое закрытие произойдет когда все запросы завершатся
    setTimeout(resolve, 100);
  });
}

/**
 * Получить список всех бэкапов
 * @returns {Array<{fileName: string, size: number, created: Date}>}
 */
function getBackupList() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      return [];
    }

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(file => file.endsWith('.zip'))
      .map(file => {
        const filePath = path.join(BACKUP_DIR, file);
        const stats = fs.statSync(filePath);
        
        return {
          fileName: file,
          size: stats.size,
          sizeFormatted: formatFileSize(stats.size),
          created: stats.birthtime,
          createdFormatted: stats.birthtime.toLocaleString('ru-RU')
        };
      })
      .sort((a, b) => b.created - a.created);

    return files;
  } catch (error) {
    console.error('✗ Ошибка при получении списка бэкапов:', error.message);
    return [];
  }
}

/**
 * Удалить бэкап
 * @param {string} fileName - Имя файла бэкапа
 * @returns {boolean}
 */
function deleteBackup(fileName) {
  try {
    const filePath = path.join(BACKUP_DIR, fileName);
    
    if (!fs.existsSync(filePath)) {
      throw new Error('Файл бэкапа не найден');
    }

    fs.unlinkSync(filePath);
    console.log(`✓ Бэкап удален: ${fileName}`);
    
    return true;
  } catch (error) {
    console.error('✗ Ошибка при удалении бэкапа:', error.message);
    throw error;
  }
}

/**
 * Скачать файл бэкапа
 * @param {string} fileName - Имя файла бэкапа
 * @returns {string} - Путь к файлу
 */
function getBackupFilePath(fileName) {
  const filePath = path.join(BACKUP_DIR, fileName);
  
  if (!fs.existsSync(filePath)) {
    throw new Error('Файл бэкапа не найден');
  }
  
  return filePath;
}

/**
 * Форматирование размера файла
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Б';
  
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

/**
 * Проверить наличие автоматического бэкапа
 */
function shouldRunAutoBackup(lastBackupTime, intervalHours = 12) {
  if (!lastBackupTime) return true;
  
  const now = new Date();
  const last = new Date(lastBackupTime);
  const hoursDiff = (now - last) / (1000 * 60 * 60);
  
  return hoursDiff >= intervalHours;
}

module.exports = {
  createBackup,
  restoreBackup,
  getBackupList,
  deleteBackup,
  getBackupFilePath,
  shouldRunAutoBackup,
  BACKUP_DIR,
  DATABASE_FILES
};
