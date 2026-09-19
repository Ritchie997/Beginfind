// backups.routes.js — управление бэкапами баз данных (root only).

const express = require('express');
const fs = require('fs');
const path = require('path');
const auth = require('../middleware/auth');
const backup = require('../services/backup');
const { readSettings, writeSettings } = require('../services/backup-settings');
const { uploadBackupZip } = require('../uploads/multer-config');

const router = express.Router();

// Создание бэкапа баз данных
router.post('/backups/create', auth.authenticateToken, auth.checkApproved, auth.checkRoot, async (req, res) => {
  try {
    const { name } = req.body;
    const result = await backup.createBackup(name);

    res.json({
      success: true,
      message: 'Бэкап успешно создан',
      data: {
        fileName: result.fileName,
        size: result.size,
        filesCount: result.filesCount,
        timestamp: result.timestamp
      }
    });
  } catch (error) {
    console.error('Backup create error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Восстановление из бэкапа
router.post('/backups/restore/:fileName', auth.authenticateToken, auth.checkApproved, auth.checkRoot, async (req, res) => {
  try {
    const { fileName } = req.params;
    const filePath = backup.getBackupFilePath(fileName);
    const result = await backup.restoreBackup(filePath);

    res.json({
      success: true,
      message: `Восстановлено ${result.count} файл(ов)`,
      data: {
        restored: result.restored,
        errors: result.errors,
        summary: result.summary
      }
    });
  } catch (error) {
    console.error('Backup restore error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Загрузка бэкапа из файла
router.post('/backups/upload', auth.authenticateToken, auth.checkApproved, auth.checkRoot, uploadBackupZip.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Файл бэкапа не загружен' });
    }

    // Проверяем расширение файла
    if (!req.file.originalname.endsWith('.zip')) {
      return res.status(400).json({ success: false, error: 'Разрешены только ZIP файлы' });
    }

    // Создаем директорию для бэкапов, если не существует
    if (!fs.existsSync(backup.BACKUP_DIR)) {
      fs.mkdirSync(backup.BACKUP_DIR, { recursive: true });
    }

    // Перемещаем файл в директорию бэкапов. Используем только "голое" имя файла
    // (path.basename) — req.file.originalname приходит от клиента и может
    // содержать "../", что позволило бы записать файл вне BACKUP_DIR.
    const safeOriginalName = path.basename(req.file.originalname);
    const destPath = path.join(backup.BACKUP_DIR, safeOriginalName);
    fs.renameSync(req.file.path, destPath);

    res.json({
      success: true,
      message: 'Бэкап успешно загружен',
      data: {
        fileName: safeOriginalName,
        size: req.file.size
      }
    });
  } catch (error) {
    console.error('Backup upload error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Получение списка всех бэкапов
router.get('/backups', auth.authenticateToken, auth.checkApproved, auth.checkRoot, (req, res) => {
  try {
    const backups = backup.getBackupList();
    res.json({ success: true, data: backups });
  } catch (error) {
    console.error('Get backups list error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Удаление бэкапа
router.delete('/backups/:fileName', auth.authenticateToken, auth.checkApproved, auth.checkRoot, (req, res) => {
  try {
    const { fileName } = req.params;
    backup.deleteBackup(fileName);

    res.json({
      success: true,
      message: 'Бэкап успешно удален'
    });
  } catch (error) {
    console.error('Backup delete error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Скачивание бэкапа
router.get('/backups/download/:fileName', auth.authenticateToken, auth.checkApproved, auth.checkRoot, (req, res) => {
  try {
    const { fileName } = req.params;
    const filePath = backup.getBackupFilePath(fileName);

    res.download(filePath, fileName);
  } catch (error) {
    console.error('Backup download error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Получение настроек автоматического бэкапа
router.get('/backups/auto/settings', auth.authenticateToken, auth.checkApproved, auth.checkRoot, (req, res) => {
  try {
    res.json({ success: true, data: readSettings() });
  } catch (error) {
    console.error('Get auto backup settings error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Обновление настроек автоматического бэкапа
router.put('/backups/auto/settings', auth.authenticateToken, auth.checkApproved, auth.checkRoot, (req, res) => {
  try {
    const { enabled, intervalHours } = req.body;

    const settings = {
      enabled: enabled || false,
      intervalHours: intervalHours || 12,
      lastBackup: null
    };
    writeSettings(settings);

    res.json({
      success: true,
      message: 'Настройки автоматического бэкапа сохранены',
      data: settings
    });
  } catch (error) {
    console.error('Update auto backup settings error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Запуск автоматического бэкапа
router.post('/backups/auto/run', auth.authenticateToken, auth.checkApproved, auth.checkRoot, async (req, res) => {
  try {
    const result = await backup.createBackup();

    const settings = readSettings();
    settings.lastBackup = new Date().toISOString();
    writeSettings(settings);

    res.json({
      success: true,
      message: 'Автоматический бэкап создан',
      data: {
        fileName: result.fileName,
        timestamp: result.timestamp
      }
    });
  } catch (error) {
    console.error('Auto backup run error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
