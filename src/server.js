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
const { readSettings, writeSettings } = require('./services/backup-settings');

const pages = require('./routes/pages.routes');
const authRoutes = require('./routes/auth.routes');
const messagesRoutes = require('./routes/messages.routes');
const articlesRoutes = require('./routes/articles.routes');
const taxonomyRoutes = require('./routes/taxonomy.routes');
const serversRoutes = require('./routes/servers.routes');
const uploadsRoutes = require('./routes/uploads.routes');
const backupsRoutes = require('./routes/backups.routes');

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

// Маршруты API
app.use('/api', authRoutes);
app.use('/api', messagesRoutes);
app.use('/api', articlesRoutes);
app.use('/api', taxonomyRoutes);
app.use('/api', serversRoutes);
app.use('/api', uploadsRoutes);
app.use('/api', backupsRoutes);

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

  // readSettings() сам подставит значения по умолчанию, если файла ещё нет —
  // но пишем его явно один раз, чтобы он существовал на диске сразу.
  writeSettings(readSettings());

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

// Инициализируем планировщик очистки мусорных файлов (побочный эффект require)
require('./services/scheduled-cleanup');

app.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
  console.log(`Access locally: http://localhost:${PORT}`);
  console.log(`Access from network: http://[YOUR_LOCAL_IP]:${PORT} (replace [YOUR_LOCAL_IP] with your actual IP)`);
  console.log(`Test interface available at http://localhost:${PORT}/test.html or http://[YOUR_LOCAL_IP]:${PORT}/test.html`);

  initializeAutoBackup();
});
