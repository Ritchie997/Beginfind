// uploads.routes.js — загрузка изображений (для статей/чата).

const express = require('express');
const fs = require('fs');
const path = require('path');
const auth = require('../middleware/auth');
const { uploadImage } = require('../uploads/multer-config');
const { UPLOADS_DIR } = require('../config/paths');
const { readSettings } = require('../services/system-settings');

const router = express.Router();

router.post('/upload-image', auth.authenticateToken, auth.checkApproved, uploadImage.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }

    // Проверяем, что файл действительно существует
    const filePath = path.join(UPLOADS_DIR, req.file.filename);

    if (!fs.existsSync(filePath)) {
      console.error('Uploaded file not found:', filePath);
      return res.status(500).json({ error: 'Ошибка сохранения файла' });
    }

    // Настраиваемый владельцем лимит (Настройки → "Максимальный размер
    // загружаемого файла") — multer уже пропустил файл по своему статическому
    // потолку (см. комментарий у uploadImage в multer-config.js), здесь же
    // проверяем актуальное значение из system-settings.json на момент запроса.
    const maxFileSizeMb = readSettings().maxFileSize;
    if (req.file.size > maxFileSizeMb * 1024 * 1024) {
      fs.unlink(filePath, () => {});
      return res.status(400).json({ error: `Файл больше ${maxFileSizeMb} МБ — лимит задан в Настройках` });
    }

    // Возвращаем путь к загруженному файлу (без домена), чтобы сервер мог его нормализовать
    res.setHeader('Content-Type', 'application/json');
    res.json({ url: `/uploads/${req.file.filename}` });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера при загрузке: ' + error.message });
  }
});

module.exports = router;
