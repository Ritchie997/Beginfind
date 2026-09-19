const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { ROOT_DIR, dbPath, BACKUPS_DIR, CONTENT_DIR, UPLOADS_DIR } = require('../config/paths');
const articlesStore = require('./articles-store');

// Список файлов баз данных для бэкапа. articles.db больше не хранит тексты
// статей (см. Этап 3 — они в content/*.json), но остаётся справочником
// категорий, поэтому по-прежнему бэкапится.
const DATABASE_FILES = [
  'articles.db',
  'messenger.db',
  'servers.db',
  'users.db',
  'bookmarks.db', // закладки статей Ibripedia, привязанные к профилю — см. src/db/connections.js
  'social.db', // лайки и комментарии статей Ibripedia — см. src/db/connections.js
  'stickers.db' // наборы стикеров, подписки, избранное — см. src/db/connections.js
];

// Файлы настроек сайта (Настройки → владелец). backup-settings.json сюда
// намеренно не входит: это расписание самих бэкапов конкретной установки
// (lastBackup и т.п.), переносить его между серверами не нужно.
const SETTINGS_FILES = [
  'system-settings.json',
  'cleanup-settings.json'
];

// Папка внутри ZIP-архива, где лежат статьи (content/*.json и корзина .trash/)
const CONTENT_ZIP_FOLDER = 'content';

// Папка внутри ZIP-архива для public/uploads/: картинки статей/чата и
// uploads/stickers/<packId>/* (файлы стикеров — без них записи в stickers.db
// указывали бы в пустоту).
const UPLOADS_ZIP_FOLDER = 'uploads';

// Те же расширения, что принимает загрузка (см. ALLOWED_IMAGE_EXTENSIONS в
// src/uploads/multer-config.js) — при восстановлении в публично раздаваемую
// public/uploads не пропускаем ничего другого (.html/.svg дали бы хранимый XSS).
const RESTORABLE_UPLOAD_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

// Директория для хранения бэкапов
const BACKUP_DIR = BACKUPS_DIR;

/**
 * Проверяет имя файла бэкапа и возвращает безопасный абсолютный путь внутри BACKUP_DIR.
 * Защита от directory traversal (например fileName = "../../.env").
 * @throws {Error} если имя файла некорректно или выходит за пределы BACKUP_DIR
 */
function resolveBackupPath(fileName) {
  if (!fileName || typeof fileName !== 'string') {
    throw new Error('Некорректное имя файла бэкапа');
  }
  // Отбрасываем любые директории из имени — работаем только с "голым" именем файла
  const safeName = path.basename(fileName);
  const resolved = path.resolve(BACKUP_DIR, safeName);
  if (safeName !== fileName || !resolved.startsWith(path.resolve(BACKUP_DIR) + path.sep)) {
    throw new Error('Недопустимое имя файла бэкапа');
  }
  return resolved;
}

// Количество файлов (не папок) в архиве под заданной папкой верхнего уровня.
function countZipFiles(zip, folder) {
  return zip.getEntries().filter((e) => e.entryName.startsWith(folder + '/') && !e.isDirectory).length;
}

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
      const dbFilePath = dbPath(dbFile);
      console.log(`[Backup] Проверка: ${dbFilePath}`);

      if (fs.existsSync(dbFilePath)) {
        const stats = fs.statSync(dbFilePath);
        console.log(`[Backup] Файл найден: ${dbFile} (${stats.size} байт)`);

        // Добавляем файл в ZIP
        zip.addLocalFile(dbFilePath, '', dbFile);
        filesAdded.push(dbFile);
        console.log(`[Backup] ✓ Добавлен в бэкап: ${dbFile}`);
      } else {
        console.warn(`[Backup] ⚠ Файл не найден, пропускаем: ${dbFile}`);
      }
    }

    // Файлы настроек сайта (в корне архива, рядом с базами)
    const settingsAdded = [];
    for (const settingsFile of SETTINGS_FILES) {
      const settingsPath = path.join(ROOT_DIR, settingsFile);
      if (fs.existsSync(settingsPath)) {
        zip.addLocalFile(settingsPath, '', settingsFile);
        settingsAdded.push(settingsFile);
      }
    }

    // Добавляем статьи (content/*.json, включая корзину content/.trash)
    let contentFilesAdded = 0;
    if (fs.existsSync(CONTENT_DIR)) {
      zip.addLocalFolder(CONTENT_DIR, CONTENT_ZIP_FOLDER);
      contentFilesAdded = countZipFiles(zip, CONTENT_ZIP_FOLDER);
      console.log(`[Backup] ✓ Добавлено файлов статей: ${contentFilesAdded}`);
    } else {
      console.warn('[Backup] ⚠ Директория content не найдена, статьи не добавлены в бэкап');
    }

    // Добавляем загруженные файлы: картинки статей и файлы стикеров
    // (public/uploads/**, включая uploads/stickers/<packId>/*)
    let uploadFilesAdded = 0;
    if (fs.existsSync(UPLOADS_DIR)) {
      zip.addLocalFolder(UPLOADS_DIR, UPLOADS_ZIP_FOLDER);
      uploadFilesAdded = countZipFiles(zip, UPLOADS_ZIP_FOLDER);
      console.log(`[Backup] ✓ Добавлено загруженных файлов (картинки, стикеры): ${uploadFilesAdded}`);
    } else {
      console.warn('[Backup] ⚠ Директория public/uploads не найдена, загруженные файлы не добавлены в бэкап');
    }

    if (filesAdded.length === 0 && contentFilesAdded === 0 && uploadFilesAdded === 0) {
      throw new Error('Не найдено ни одной базы данных, статьи или загруженного файла для бэкапа. Ожидаемые файлы: ' + DATABASE_FILES.join(', '));
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
      filesCount: filesAdded.length + settingsAdded.length + contentFilesAdded + uploadFilesAdded,
      files: filesAdded,
      settingsFiles: settingsAdded,
      contentFilesCount: contentFilesAdded,
      uploadFilesCount: uploadFilesAdded,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('[Backup] ✗ Ошибка при создании бэкапа:', error.message);
    throw error;
  }
}

/**
 * Разворачивает запись архива в targetRoot/<relative>, не выпуская путь за
 * пределы targetRoot (защита от zip slip: "content/../../x").
 * @returns {string|null} абсолютный путь назначения либо null, если путь небезопасен
 */
function resolveInside(targetRoot, relative) {
  const root = path.resolve(targetRoot);
  const target = path.resolve(root, relative);
  return target.startsWith(root + path.sep) ? target : null;
}

/**
 * Восстановление данных из бэкапа: базы данных и настройки (файлы
 * заменяются целиком), статьи и загруженные файлы (файлы из архива
 * записываются поверх, лишние текущие файлы НЕ удаляются).
 * @param {string} backupPath - Путь к ZIP файлу бэкапа
 * @returns {Promise<{success: boolean, restored: string[], errors: string[], count: number, summary: object}>}
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
    const summary = { databases: 0, settings: 0, articles: 0, uploads: 0 };

    // Записывает одну запись архива на диск и учитывает её в отчёте.
    const writeEntry = (entry, targetPath, category) => {
      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, entry.getData());
        restoredFiles.push(entry.entryName);
        summary[category] += 1;
      } catch (err) {
        errors.push(`Ошибка при восстановлении ${entry.entryName}: ${err.message}`);
        console.error(`✗ ${errors[errors.length - 1]}`);
      }
    };

    for (const entry of zipEntries) {
      const entryName = entry.entryName;
      if (entry.isDirectory) continue;

      // Базы данных и файлы настроек — только из белых списков и только из
      // корня архива: раньше проверялось лишь "заканчивается на .db", а путь
      // строился из entryName напрямую, что позволяло записи вида
      // "../../public/x.db" (zip slip) перезаписать произвольный файл на сервере.
      const isRootFile = path.basename(entryName) === entryName;
      if (isRootFile && DATABASE_FILES.includes(entryName)) {
        // Закрываем активные подключения перед восстановлением
        await closeDatabaseConnection(entryName);
        writeEntry(entry, dbPath(entryName), 'databases');
        continue;
      }
      if (isRootFile && SETTINGS_FILES.includes(entryName)) {
        writeEntry(entry, path.join(ROOT_DIR, entryName), 'settings');
        continue;
      }

      // Статьи (content/*.json, включая content/.trash/*)
      if (entryName.startsWith(CONTENT_ZIP_FOLDER + '/') && entryName.endsWith('.json')) {
        const targetPath = resolveInside(CONTENT_DIR, entryName.slice(CONTENT_ZIP_FOLDER.length + 1));
        if (!targetPath) {
          errors.push(`Пропущена небезопасная запись в архиве: ${entryName}`);
          continue;
        }
        writeEntry(entry, targetPath, 'articles');
        continue;
      }

      // Загруженные файлы: картинки статей и файлы стикеров (uploads/**)
      if (entryName.startsWith(UPLOADS_ZIP_FOLDER + '/')) {
        if (!RESTORABLE_UPLOAD_EXTENSIONS.has(path.extname(entryName).toLowerCase())) continue; // .gitkeep и т.п.
        const targetPath = resolveInside(UPLOADS_DIR, entryName.slice(UPLOADS_ZIP_FOLDER.length + 1));
        if (!targetPath) {
          errors.push(`Пропущена небезопасная запись в архиве: ${entryName}`);
          continue;
        }
        writeEntry(entry, targetPath, 'uploads');
      }
    }

    if (restoredFiles.length === 0) {
      throw new Error('В архиве не найдено баз данных, статей или загруженных файлов для восстановления');
    }

    console.log(`✓ Восстановлено ${restoredFiles.length} файл(ов): баз ${summary.databases}, настроек ${summary.settings}, статей ${summary.articles}, загруженных файлов ${summary.uploads}`);

    // Восстановленные статьи могли заменить содержимое content/ — сбрасываем
    // кэш списка статей, иначе сервер продолжит отдавать старые данные из памяти.
    articlesStore.invalidateCache();

    return {
      success: true,
      restored: restoredFiles,
      errors: errors,
      count: restoredFiles.length,
      summary
    };
  } catch (error) {
    console.error('✗ Ошибка при восстановлении бэкапа:', error.message);
    throw error;
  }
}

/**
 * Закрыть активное подключение к базе данных
 */
function closeDatabaseConnection(_dbFile) {
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
    const filePath = resolveBackupPath(fileName);

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
  const filePath = resolveBackupPath(fileName);

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
  DATABASE_FILES,
  SETTINGS_FILES
};
