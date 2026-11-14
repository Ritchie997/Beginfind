// radio.routes.js — HTTP-эндпоинты для вкладки «Радио», медиатеки треков и частот вещания.

const express = require('express');
const auth = require('../middleware/auth');
const radioStore = require('../services/radio-store');

const router = express.Router();

function getDisplayName(user) {
  return (user && (user.display_name || user.username)) || 'Аноним';
}

function isRootOrAdmin(user) {
  return Boolean(user && (user.is_root || (user.admin_level && user.admin_level > 0)));
}

// ===== 1. Медиатека: пользовательские треки и подкасты =====

// GET /api/radio/tracks — каталог аудиозаписей (музыка, подкасты, слова)
router.get('/radio/tracks', async (req, res) => {
  try {
    const { type, search, page, limit, userId } = req.query;
    const result = await radioStore.listTracks({ type, search, page, limit, userId });
    res.json(result);
  } catch (error) {
    console.error('[radio] Error listing tracks:', error);
    res.status(500).json({ error: 'Не удалось загрузить список треков: ' + error.message });
  }
});

// GET /api/radio/tracks/:id — конкретный трек
router.get('/radio/tracks/:id', async (req, res) => {
  try {
    const track = await radioStore.getTrackById(req.params.id);
    if (!track) {
      return res.status(404).json({ error: 'Трек не найден' });
    }
    res.json(track);
  } catch (error) {
    console.error('[radio] Error getting track:', error);
    res.status(500).json({ error: 'Не удалось получить трек: ' + error.message });
  }
});

// POST /api/radio/tracks — публикация аудиозаписи
router.post('/radio/tracks', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { title, audioUrl, audio_url, duration, size, format, type, coverUrl, cover_url } = req.body;
    const url = audioUrl || audio_url;

    if (!url) {
      return res.status(400).json({ error: 'Укажите ссылку на аудиофайл (audioUrl)' });
    }

    const track = await radioStore.createTrack({
      userId: req.user.id,
      authorName: getDisplayName(req.user),
      title: title || 'Новая аудиозапись',
      audioUrl: url,
      duration: duration || 0,
      size: size || 0,
      format: format || 'mp3',
      type: type || 'track',
      coverUrl: coverUrl || cover_url || null
    });

    res.status(201).json(track);
  } catch (error) {
    console.error('[radio] Error creating track:', error);
    res.status(500).json({ error: 'Не удалось опубликовать аудиозапись: ' + error.message });
  }
});

// DELETE /api/radio/tracks/:id — удаление трека автором или админом
router.delete('/radio/tracks/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const success = await radioStore.deleteTrack(req.params.id, req.user.id, isRootOrAdmin(req.user));
    if (!success) {
      return res.status(404).json({ error: 'Трек не найден' });
    }
    res.json({ success: true, message: 'Трек удален' });
  } catch (error) {
    console.error('[radio] Error deleting track:', error);
    res.status(403).json({ error: error.message });
  }
});

// ===== 2. Радиостанции: занятие частот и управление =====

// GET /api/radio/stations — список всех активных радиостанций
router.get('/radio/stations', async (req, res) => {
  try {
    const stations = await radioStore.listStations();
    res.json(stations);
  } catch (error) {
    console.error('[radio] Error listing stations:', error);
    res.status(500).json({ error: 'Не удалось получить список радиостанций: ' + error.message });
  }
});

// POST /api/radio/stations — регистрация новой радиостанции / занятие частоты
router.post('/radio/stations', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { frequency, name, description, avatarUrl, avatar_url, fallbackMode, fallback_mode } = req.body;

    const station = await radioStore.createStation({
      frequency,
      name,
      description,
      ownerId: req.user.id,
      ownerName: getDisplayName(req.user),
      avatarUrl: avatarUrl || avatar_url || null,
      fallbackMode: fallbackMode || fallback_mode || 'loop'
    });

    res.status(201).json(station);
  } catch (error) {
    console.error('[radio] Error creating station:', error);
    res.status(400).json({ error: error.message });
  }
});

// GET /api/radio/stations/:id — получение данных станции
router.get('/radio/stations/:id', async (req, res) => {
  try {
    const station = await radioStore.getStationById(req.params.id);
    if (!station) {
      return res.status(404).json({ error: 'Радиостанция не найдена' });
    }
    res.json(station);
  } catch (error) {
    console.error('[radio] Error getting station:', error);
    res.status(500).json({ error: 'Не удалось получить станцию: ' + error.message });
  }
});

// PUT /api/radio/stations/:id — обновление настроек станции владельцем
router.put('/radio/stations/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const { name, description, avatarUrl, avatar_url, fallbackMode, fallback_mode, isActive } = req.body;
    const updated = await radioStore.updateStation(req.params.id, req.user.id, isRootOrAdmin(req.user), {
      name,
      description,
      avatarUrl: avatarUrl || avatar_url,
      fallbackMode: fallbackMode || fallback_mode,
      isActive
    });
    res.json(updated);
  } catch (error) {
    console.error('[radio] Error updating station:', error);
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/radio/stations/:id — удаление радиостанции
router.delete('/radio/stations/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const success = await radioStore.deleteStation(req.params.id, req.user.id, isRootOrAdmin(req.user));
    if (!success) {
      return res.status(404).json({ error: 'Радиостанция не найдена' });
    }
    res.json({ success: true, message: 'Станция удалена' });
  } catch (error) {
    console.error('[radio] Error deleting station:', error);
    res.status(403).json({ error: error.message });
  }
});

// ===== 3. Эфир и Сетка вещания (Таймлайн) =====

// GET /api/radio/stations/:id/live — состояние прямого эфира станции
router.get('/radio/stations/:id/live', async (req, res) => {
  try {
    const state = await radioStore.getStationLiveState(req.params.id);
    res.json(state);
  } catch (error) {
    console.error('[radio] Error getting live state:', error);
    res.status(500).json({ error: 'Ошибка получения состояния эфира: ' + error.message });
  }
});

// GET /api/radio/stations/:id/timeline — просмотр сетки вещания станции
router.get('/radio/stations/:id/timeline', async (req, res) => {
  try {
    const { fromTime, toTime } = req.query;
    const slots = await radioStore.getTimelineSlots(req.params.id, fromTime, toTime);
    res.json(slots);
  } catch (error) {
    console.error('[radio] Error getting timeline:', error);
    res.status(500).json({ error: 'Не удалось загрузить ленту времени: ' + error.message });
  }
});

// PUT /api/radio/stations/:id/timeline — сохранение сетки вещания на 24 часа
router.put('/radio/stations/:id/timeline', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const station = await radioStore.getStationById(req.params.id);
    if (!station) {
      return res.status(404).json({ error: 'Радиостанция не найдена' });
    }

    if (station.owner_id !== req.user.id && !isRootOrAdmin(req.user)) {
      return res.status(403).json({ error: 'Только владелец станции может редактировать ленту времени' });
    }

    const { slots, startTime } = req.body;
    if (!Array.isArray(slots)) {
      return res.status(400).json({ error: 'slots должен быть массивом элементов эфира' });
    }

    const updatedSlots = await radioStore.setTimelineSlots(req.params.id, slots, startTime);
    res.json({ success: true, slots: updatedSlots });
  } catch (error) {
    console.error('[radio] Error updating timeline:', error);
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/radio/stations/:id/timeline — очистка сетки вещания (освободить эфир)
router.delete('/radio/stations/:id/timeline', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const station = await radioStore.getStationById(req.params.id);
    if (!station) {
      return res.status(404).json({ error: 'Радиостанция не найдена' });
    }

    if (station.owner_id !== req.user.id && !isRootOrAdmin(req.user)) {
      return res.status(403).json({ error: 'Только владелец станции может очистить эфир' });
    }

    await radioStore.clearTimelineSlots(req.params.id, req.user.id, isRootOrAdmin(req.user));
    res.json({ success: true, message: 'Сетка вещания радиостанции очищена' });
  } catch (error) {
    console.error('[radio] Error clearing timeline:', error);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
