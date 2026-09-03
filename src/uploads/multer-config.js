// multer-config.js — конфигурация загрузки файлов (multer).
// Два отдельных инстанса: изображения статей/чата и ZIP-бэкапы.
// Раньше был один общий multer с fileFilter только под image/*, из-за чего
// загрузка ZIP-бэкапа (POST /api/backups/upload) была фактически сломана —
// multer молча отклонял файл ещё до обработчика маршрута.

const path = require('path');
const os = require('os');
const multer = require('multer');
const { UPLOADS_DIR } = require('../config/paths');

// Разрешённые расширения для загружаемых изображений. mimetype легко подделать
// в запросе, поэтому дополнительно проверяем и реальное расширение файла —
// иначе можно было бы загрузить, например, .svg/.html с image/* заголовком
// и получить хранимый XSS при открытии файла напрямую из /uploads.
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

const imageStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const uploadImage = multer({
  storage: imageStorage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB лимит
  },
  fileFilter: function (req, file, cb) {
    // Проверяем и заявленный mimetype, и реальное расширение файла
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith('image/') && ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Разрешены только изображения (jpg, jpeg, png, gif, webp)!'));
    }
  }
});

// Отдельный multer для загрузки ZIP-бэкапов.
const uploadBackupZip = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, os.tmpdir());
    },
    filename: function (req, file, cb) {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, 'backup-upload-' + uniqueSuffix + '.zip');
    }
  }),
  limits: {
    fileSize: 200 * 1024 * 1024 // 200MB лимит на бэкап
  },
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.zip') {
      cb(null, true);
    } else {
      cb(new Error('Разрешены только ZIP файлы!'));
    }
  }
});

module.exports = { uploadImage, uploadBackupZip, ALLOWED_IMAGE_EXTENSIONS };
