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

router.post('/upload-images', auth.authenticateToken, auth.checkApproved, uploadImage.array('images', 60), (req, res) => {
  const files = req.files || [];
  const cleanupFiles = () => files.forEach((file) => fs.unlink(file.path, () => {}));
  try {
    if (!files.length) return res.status(400).json({ error: 'Файлы не загружены' });
    const maxFileSizeMb = readSettings().maxFileSize;
    const tooBig = files.find((file) => file.size > maxFileSizeMb * 1024 * 1024);
    if (tooBig) {
      cleanupFiles();
      return res.status(400).json({ error: `Файл «${tooBig.originalname}» больше ${maxFileSizeMb} МБ — лимит задан в Настройках` });
    }
    const urls = files.map((file) => {
      const filePath = path.join(UPLOADS_DIR, file.filename);
      if (!fs.existsSync(filePath)) throw new Error(`Загруженное изображение «${file.originalname}» не найдено`);
      return `/uploads/${file.filename}`;
    });
    res.status(201).json({ urls });
  } catch (error) {
    cleanupFiles();
    console.error('Upload images error:', error);
    res.status(500).json({ error: 'Не удалось загрузить изображения: ' + error.message });
  }
});

module.exports = router;
