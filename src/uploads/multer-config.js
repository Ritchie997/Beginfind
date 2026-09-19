// multer-config.js — конфигурация загрузки файлов (multer).
// Два отдельных инстанса: изображения статей/чата и ZIP-бэкапы.
// Раньше был один общий multer с fileFilter только под image/*, из-за чего
// загрузка ZIP-бэкапа (POST /api/backups/upload) была фактически сломана —
// multer молча отклонял файл ещё до обработчика маршрута.

const path = require('path');
const os = require('os');
const fs = require('fs');
const multer = require('multer');
const { UPLOADS_DIR, STICKERS_DIR } = require('../config/paths');

// Директория стикеров — подпапка uploads/, её не создаёт initializeAutoBackup
// (тот знает только про сам UPLOADS_DIR), поэтому создаём здесь же, при
// загрузке модуля, до того как multer.diskStorage попробует туда писать.
if (!fs.existsSync(STICKERS_DIR)) {
  fs.mkdirSync(STICKERS_DIR, { recursive: true });
}

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
    // Технический потолок на уровне multer — не путать с настраиваемым
    // владельцем лимитом (Настройки → "Максимальный размер загружаемого
    // файла", 1-20 МБ, system-settings.js). Тот лимит нельзя выставить
    // прямо здесь: multer.limits.fileSize — статическое число на момент
    // создания этого объекта, а не значение, читаемое заново на каждый
    // запрос, тогда как настройку можно менять без перезапуска сервера.
    // Поэтому здесь — общий потолок, всегда достаточный для верхней границы
    // настройки (20 МБ), а сам сконфигурированный лимит проверяется уже
    // после успешной загрузки в POST /api/upload-image (uploads.routes.js).
    fileSize: 20 * 1024 * 1024
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

// Отдельный multer для стикеров: тот же набор расширений (включая .gif —
// на нём и держится анимация стикера), но лимит выше — анимированные GIF
// часто весят больше 5MB, которых достаточно для обычных картинок статей.
//
// Каждый набор пишет файлы в СВОЮ подпапку STICKERS_DIR/<packId>/, а не в
// общую плоскую папку — иначе на диске не различить, какой файл какому
// набору принадлежит (особенно если у двух наборов одинаковое название —
// slug с суффиксом -2 отличает их в БД, но плоская папка с файлами такого
// разделения не даёт). packId берём из :id в самом URL маршрута
// (POST /api/stickers/packs/:id/stickers, см. stickers.routes.js) — он уже
// разобран Express-роутером в req.params к моменту, когда multer вызывает
// эту функцию, ещё ДО тела обработчика маршрута. Валидируем как "только
// цифры" вручную: значение приходит из URL, и без проверки сюда можно было
// бы подсунуть "../../" и вылезти из STICKERS_DIR путём path traversal —
// автор набора/существование самого набора всё равно проверяется позже в
// addSticker(), но эта проверка про безопасность пути на диске, а не про
// права доступа.
const stickerStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const packId = String(req.params.id || '').trim();
    if (!/^[1-9][0-9]*$/.test(packId)) {
      cb(new Error('Некорректный ID набора стикеров'));
      return;
    }
    const packDir = path.join(STICKERS_DIR, packId);
    fs.mkdir(packDir, { recursive: true }, (err) => {
      if (err) cb(err);
      else cb(null, packDir);
    });
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'sticker-' + uniqueSuffix + ext);
  }
});

const uploadSticker = multer({
  storage: stickerStorage,
  limits: {
    fileSize: 15 * 1024 * 1024 // 15MB лимит — под анимированные GIF
  },
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith('image/') && ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Разрешены только изображения (jpg, jpeg, png, gif, webp)!'));
    }
  }
});

module.exports = { uploadImage, uploadBackupZip, uploadSticker, ALLOWED_IMAGE_EXTENSIONS };
