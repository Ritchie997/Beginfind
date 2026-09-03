// uploads.routes.js — загрузка изображений (для статей/чата).

const express = require('express');
const fs = require('fs');
const path = require('path');
const auth = require('../middleware/auth');
const { uploadImage } = require('../uploads/multer-config');
const { UPLOADS_DIR } = require('../config/paths');

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

    // Возвращаем путь к загруженному файлу (без домена), чтобы сервер мог его нормализовать
    res.setHeader('Content-Type', 'application/json');
    res.json({ url: `/uploads/${req.file.filename}` });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера при загрузке: ' + error.message });
  }
});

module.exports = router;
