// uploads.routes.js — загрузка изображений (для статей/чата).

const express = require('express');
const fs = require('fs');
const path = require('path');
const auth = require('../middleware/auth');
const { uploadImage, uploadAudio } = require('../uploads/multer-config');
const { UPLOADS_DIR } = require('../config/paths');
const { readSettings } = require('../services/system-settings');
const { convertToMp3, decodeOriginalName } = require('../services/audio-converter');

const router = express.Router();

// GET /api/upload-limits — актуальные системные лимиты на загрузку файлов (изображения, аудио)
router.get('/upload-limits', (req, res) => {
  try {
    const maxFileSizeMb = readSettings().maxFileSize;
    res.json({
      maxFileSize: maxFileSizeMb,
      maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
      maxImageSizeMb: maxFileSizeMb,
      maxImageSizeBytes: maxFileSizeMb * 1024 * 1024,
      maxAudioSizeMb: 100,
      maxAudioSizeBytes: 100 * 1024 * 1024
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

router.post('/upload-audio', auth.authenticateToken, auth.checkApproved, uploadAudio.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Аудиофайл не загружен' });
    }

    const filePath = path.join(UPLOADS_DIR, req.file.filename);
    if (!fs.existsSync(filePath)) {
      console.error('Uploaded audio file not found:', filePath);
      return res.status(500).json({ error: 'Ошибка сохранения аудиофайла' });
    }

    // Автоматическая конвертация аудио в MP3 для экономии дискового пространства сервера
    // mp3 в mp3 не переделываем, а не-mp3 конвертируем и удаляем исходный тяжелый файл
    const conv = await convertToMp3(filePath);

    // Восстанавливаем оригинальное имя и заголовок с корректной кириллицей (устраняем сбой latin1 в multipart)
    const cleanOriginalName = decodeOriginalName(req.file.originalname);
    const bodyTitle = req.body && typeof req.body.title === 'string' ? decodeOriginalName(req.body.title.trim()) : '';
    const originalNameWithoutExt = path.basename(cleanOriginalName, path.extname(cleanOriginalName));
    const title = bodyTitle || originalNameWithoutExt;

    res.setHeader('Content-Type', 'application/json');
    res.status(201).json({
      success: true,
      url: `/uploads/${conv.filename}`,
      filename: conv.filename,
      originalname: cleanOriginalName,
      title: title,
      size: conv.size,
      format: conv.format
    });
  } catch (error) {
    console.error('Upload audio error:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера при загрузке аудио: ' + error.message });
  }
});

module.exports = router;
