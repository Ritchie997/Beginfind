// server.js — точка входа сервера BeginFind.
//
// Раньше весь сервер (маршруты, подключения к БД, multer, бэкапы) жил в
// одном файле index.js (~1900 строк) в корне проекта. Здесь та же логика
// разложена по src/{config,db,middleware,services,uploads,routes} — поведение
// эндпоинтов не менялось (кроме отмеченных в CHANGELOG/README исправлений),
// менялась только организация файлов.

// config/env должен грузиться первым — он вызывает dotenv.config(), и от
// process.env.JWT_SECRET зависит middleware/auth.js, который требуют почти
// все остальные модули ниже.
const { PORT, HOST } = require('./config/env');

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
const cron = require('node-cron');

const { PUBLIC_DIR, UPLOADS_DIR, BACKUPS_DIR } = require('./config/paths');
const backup = require('./services/backup');
const { readSettings, writeSettings, SETTINGS_PATH } = require('./services/backup-settings');
const cleanup = require('./services/cleanup');
const { readSettings: readCleanupSettings, writeSettings: writeCleanupSettings, SETTINGS_PATH: CLEANUP_SETTINGS_PATH } = require('./services/cleanup-settings');
const { maintenanceGate } = require('./middleware/maintenance');
const { dedupeRequests } = require('./middleware/dedupe-requests');

const pages = require('./routes/pages.routes');
const authRoutes = require('./routes/auth.routes');
const messagesRoutes = require('./routes/messages.routes');
const articlesRoutes = require('./routes/articles.routes');
const taxonomyRoutes = require('./routes/taxonomy.routes');
const serversRoutes = require('./routes/servers.routes');
const uploadsRoutes = require('./routes/uploads.routes');
const backupsRoutes = require('./routes/backups.routes');
const settingsRoutes = require('./routes/settings.routes');
const bookmarksRoutes = require('./routes/bookmarks.routes');
const draftsRoutes = require('./routes/drafts.routes');
const stickersRoutes = require('./routes/stickers.routes');
const cleanupRoutes = require('./routes/cleanup.routes');
const notificationsRoutes = require('./routes/notifications.routes');

const app = express();

// Middleware для обработки кэширования JavaScript файлов
app.use(/\.js$/, (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Статические файлы
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

// "Красивые" URL SPA (/, /articles.html, /dashboard.html и т.д.)
app.use(pages.router);

// Поддержка CORS для разных IP-адресов
const corsOptions = {
  origin: function (origin, callback) {
    // Разрешаем запросы без источника (например, мобильные приложения или curl)
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      'http://localhost',
      'http://127.0.0.1',
      'http://0.0.0.0',
      /http:\/\/\d+\.\d+\.\d+\.\d+/,  // разрешаем IP-адреса через http
      /https?:\/\/.*duckdns\.org/     // разрешаем домены DuckDNS
    ];

    const isAllowed = allowedOrigins.some(pattern => {
      if (typeof pattern === 'string') {
        return origin === pattern || origin?.startsWith(pattern);
      } else if (pattern instanceof RegExp) {
        return pattern.test(origin);
      }
      return false;
    });

    callback(null, isAllowed);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

// Middleware для API
app.use('/api/*', express.json({ limit: '10mb' }));
app.use('/api/*', express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/api/*', cors(corsOptions));
// Шлагбаум режима техобслуживания — после json/cors (нужен req.body ни для
// чего тут, но порядок ради единообразия), ДО всех настоящих маршрутов, иначе
// they успеют отработать до проверки. См. src/middleware/maintenance.js —
// пропускает владельца и сам /api/login, всех остальных отбивает 503.
app.use('/api/*', maintenanceGate);
// Повторные одинаковые изменяющие запросы (многократное нажатие "Создать",
// одновременное нажатие в двух вкладках) не выполняются второй раз, а
// получают ответ первого — см. src/middleware/dedupe-requests.js.
app.use('/api/*', dedupeRequests);

// Маршруты API
app.use('/api', authRoutes);
app.use('/api', messagesRoutes);
app.use('/api', articlesRoutes);
app.use('/api', taxonomyRoutes);
app.use('/api', serversRoutes);
app.use('/api', uploadsRoutes);
app.use('/api', backupsRoutes);
app.use('/api', settingsRoutes);
app.use('/api', bookmarksRoutes);
app.use('/api', draftsRoutes);
app.use('/api', stickersRoutes);
app.use('/api', cleanupRoutes);
app.use('/api', notificationsRoutes);

// Обработка ошибок multer (загрузка изображений/бэкапов) — единый обработчик
// для всех маршрутов, использующих multer. Раньше он был подключён между
// маршрутами и не покрывал часть из них (например /api/backups/upload),
// из-за чего ошибки multer там улетали в дефолтный HTML-обработчик Express
// вместо аккуратного JSON-ответа.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('Multer error:', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Файл слишком большой' });
    }
    return res.status(400).json({ error: 'Ошибка загрузки файла: ' + err.message });
  } else if (err) {
    console.error('General upload error:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера: ' + err.message });
  }
  next();
});

// Catch-all для остальных путей SPA — обязательно последним
app.get('*', pages.spaCatchAll);

/**
 * Инициализация автоматического бэкапа: создаёт нужные директории и настройки
 * по умолчанию, затем каждые 5 минут проверяет, не пора ли снять бэкап.
 */
function initializeAutoBackup() {
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    console.log('[Auto Backup] Директория backups создана');
  }

  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    console.log('[Uploads] Директория uploads создана');
  }

  // Создаём файл настроек только если его ещё нет. Раньше здесь стояло
  // writeSettings(readSettings()) безусловно — при каждом старте сервера
  // это перезаписывало backup-settings.json на диске, а nodemon (который
  // по умолчанию следит и за .json-файлами в корне проекта) воспринимал
  // это как изменение и перезапускал сервер — который тут же снова
  // перезаписывал файл, и так по кругу (бесконечный restart-loop в `npm
  // run dev`).
  if (!fs.existsSync(SETTINGS_PATH)) {
    writeSettings(readSettings());
  }

  cron.schedule('*/5 * * * *', async () => {
    try {
      const settings = readSettings();

      if (settings.enabled) {
        const lastBackup = settings.lastBackup ? new Date(settings.lastBackup) : null;

        if (!lastBackup || backup.shouldRunAutoBackup(lastBackup, settings.intervalHours)) {
          console.log('[Auto Backup] Создаю автоматический бэкап...');
          const result = await backup.createBackup();

          settings.lastBackup = new Date().toISOString();
          writeSettings(settings);

          console.log(`[Auto Backup] Бэкап создан: ${result.fileName} (${formatFileSize(result.size)})`);
        }
      }
    } catch (error) {
      console.error('[Auto Backup] Ошибка:', error.message);
    }
  });

  console.log('[Auto Backup] Система автоматического бэкапа инициализирована');
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

/**
 * Инициализация автоматической очистки серверного мусора (статьи в корзине,
 * файлы-сироты в uploads/ и uploads/stickers/*) — та же схема, что и у
 * initializeAutoBackup выше: cron проверяет раз в несколько минут, не пора
 * ли запустить, по cleanup-settings.json (см. src/services/cleanup.js и
 * src/routes/cleanup.routes.js — там же ручной "Запустить сейчас"/предпросмотр).
 */
function initializeAutoCleanup() {
  if (!fs.existsSync(CLEANUP_SETTINGS_PATH)) {
    writeCleanupSettings(readCleanupSettings());
  }

  cron.schedule('*/5 * * * *', async () => {
    try {
      const settings = readCleanupSettings();
      if (!settings.enabled) return;
      if (!cleanup.shouldRunScheduled(settings.lastRun, settings.intervalHours)) return;

      console.log('[Cleanup] Запускаю автоматическую очистку мусора...');
      const result = await cleanup.runCleanup(settings, { dryRun: false });

      writeCleanupSettings({
        ...settings,
        lastRun: result.at,
        lastReport: {
          totalCount: result.totalCount,
          totalBytes: result.totalBytes,
          trashCount: result.trashCount,
          uploadsCount: result.uploadsCount,
          stickersCount: result.stickersCount,
          at: result.at
        }
      });

      console.log(`[Cleanup] Готово: удалено ${result.totalCount} файл(ов) (${formatFileSize(result.totalBytes)})`);
    } catch (error) {
      console.error('[Cleanup] Ошибка автоматической очистки:', error.message);
    }
  });

  console.log('[Cleanup] Система автоматической очистки мусора инициализирована');
}

// Сущность "Категории" удалена — вычищаем устаревшее поле categories из
// файлов статей (идемпотентно: уже чистые файлы не трогаются).
try {
  const cleaned = require('./services/articles-store').stripLegacyCategoryFields();
  if (cleaned > 0) console.log(`[articles] Убрано устаревшее поле categories из статей: ${cleaned}`);
} catch (e) {
  console.error('[articles] Не удалось убрать устаревшее поле categories:', e);
}

app.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
  console.log(`Access locally: http://localhost:${PORT}`);
  console.log(`Access from network: http://[YOUR_LOCAL_IP]:${PORT} (replace [YOUR_LOCAL_IP] with your actual IP)`);
  console.log(`Test interface available at http://localhost:${PORT}/test.html or http://[YOUR_LOCAL_IP]:${PORT}/test.html`);

  initializeAutoBackup();
  initializeAutoCleanup();
});
