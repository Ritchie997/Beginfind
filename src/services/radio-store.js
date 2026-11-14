// radio-store.js — хранилище для пользовательской медиатеки и радиостанций AllTell.
// Управляет треками/подкастами (radio_tracks), станциями/частотами (radio_stations)
// и 24/32-часовой сеткой вещания (radio_timeline_slots).

const { radioDb } = require('../db/connections');

// ===== Promise-обертки над sqlite3 =====

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    radioDb.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    radioDb.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    radioDb.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// ===== Управление треками и медиатекой =====

async function listTracks({ type = null, search = '', page = 1, limit = 30, userId = null } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const offset = (p - 1) * l;

  const conditions = [];
  const params = [];

  if (type && type !== 'all') {
    conditions.push('type = ?');
    params.push(type);
  }

  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }

  if (search && search.trim()) {
    conditions.push('(title LIKE ? OR author_name LIKE ?)');
    const term = `%${search.trim()}%`;
    params.push(term, term);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await get(`SELECT COUNT(*) AS total FROM radio_tracks ${whereClause}`, params);
  const total = countRow ? countRow.total : 0;

  const tracks = await all(
    `SELECT * FROM radio_tracks ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, l, offset]
  );

  return {
    tracks,
    total,
    page: p,
    limit: l,
    totalPages: Math.ceil(total / l) || 1
  };
}

async function getTrackById(id) {
  return get('SELECT * FROM radio_tracks WHERE id = ?', [id]);
}

async function createTrack({ userId, authorName, title, audioUrl, duration = 0, size = 0, format = 'mp3', type = 'track', coverUrl = null }) {
  const cleanTitle = String(title || '').trim() || 'Без названия';
  const cleanType = ['track', 'podcast', 'speech'].includes(type) ? type : 'track';
  const cleanFormat = String(format || 'mp3').toLowerCase().replace('.', '');

  const result = await run(
    `INSERT INTO radio_tracks (user_id, author_name, title, audio_url, duration, size, format, type, cover_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, authorName, cleanTitle, audioUrl, Number(duration) || 0, Number(size) || 0, cleanFormat, cleanType, coverUrl || null]
  );

  return getTrackById(result.lastID);
}

async function deleteTrack(id, actingUserId, isRootOrAdmin = false) {
  const track = await getTrackById(id);
  if (!track) return false;

  if (track.user_id !== actingUserId && !isRootOrAdmin) {
    throw new Error('Недостаточно прав для удаления трека');
  }

  await run('DELETE FROM radio_tracks WHERE id = ?', [id]);
  return true;
}

// ===== Управление радиостанциями (частотами) =====

async function listStations() {
  const stations = await all('SELECT * FROM radio_stations WHERE is_active = 1 ORDER BY frequency ASC');
  const now = new Date().toISOString();

  // Добавляем к каждой станции краткую информацию о текущем треке
  const enriched = await Promise.all(
    stations.map(async (st) => {
      const currentSlot = await get(
        `SELECT * FROM radio_timeline_slots 
         WHERE station_id = ? AND start_time <= ? AND end_time > ? 
         ORDER BY start_time ASC LIMIT 1`,
        [st.id, now, now]
      );
      return {
        ...st,
        currentTrack: currentSlot ? {
          title: currentSlot.title,
          type: currentSlot.type,
          duration: currentSlot.duration,
          startTime: currentSlot.start_time,
          endTime: currentSlot.end_time
        } : null,
        isLive: Boolean(currentSlot)
      };
    })
  );

  return enriched;
}

async function getStationById(id) {
  return get('SELECT * FROM radio_stations WHERE id = ?', [id]);
}

async function getStationByFrequency(frequency) {
  return get('SELECT * FROM radio_stations WHERE frequency = ?', [frequency]);
}

async function createStation({ frequency, name, description = '', ownerId, ownerName, avatarUrl = null, fallbackMode = 'loop' }) {
  const numFreq = Number(frequency);
  if (isNaN(numFreq) || numFreq <= 0) {
    throw new Error('Некорректная частота. Укажите положительное число (например, 101.5 или 42)');
  }

  const existing = await getStationByFrequency(numFreq);
  if (existing) {
    throw new Error(`Частота ${numFreq} уже занята станцией "${existing.name}"`);
  }

  const cleanName = String(name || '').trim();
  if (!cleanName) {
    throw new Error('Укажите название радиостанции');
  }

  const cleanFallback = ['loop', 'noise', 'silence'].includes(fallbackMode) ? fallbackMode : 'loop';

  const result = await run(
    `INSERT INTO radio_stations (frequency, name, description, owner_id, owner_name, avatar_url, fallback_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [numFreq, cleanName, String(description || '').trim(), ownerId, ownerName, avatarUrl || null, cleanFallback]
  );

  return getStationById(result.lastID);
}

async function updateStation(id, actingUserId, isRootOrAdmin, { name, description, avatarUrl, fallbackMode, isActive }) {
  const station = await getStationById(id);
  if (!station) throw new Error('Станция не найдена');

  if (station.owner_id !== actingUserId && !isRootOrAdmin) {
    throw new Error('Только владелец станции может изменять её настройки');
  }

  const updates = [];
  const params = [];

  if (name !== undefined) {
    updates.push('name = ?');
    params.push(String(name).trim() || station.name);
  }
  if (description !== undefined) {
    updates.push('description = ?');
    params.push(String(description).trim());
  }
  if (avatarUrl !== undefined) {
    updates.push('avatar_url = ?');
    params.push(avatarUrl || null);
  }
  if (fallbackMode !== undefined && ['loop', 'noise', 'silence'].includes(fallbackMode)) {
    updates.push('fallback_mode = ?');
    params.push(fallbackMode);
  }
  if (isActive !== undefined) {
    updates.push('is_active = ?');
    params.push(isActive ? 1 : 0);
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);

  if (updates.length > 1) {
    await run(`UPDATE radio_stations SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  return getStationById(id);
}

async function deleteStation(id, actingUserId, isRootOrAdmin) {
  const station = await getStationById(id);
  if (!station) return false;

  if (station.owner_id !== actingUserId && !isRootOrAdmin) {
    throw new Error('Недостаточно прав для удаления радиостанции');
  }

  await run('DELETE FROM radio_timeline_slots WHERE station_id = ?', [id]);
  await run('DELETE FROM radio_stations WHERE id = ?', [id]);
  return true;
}

// ===== Управление лентой времени (24h редактор и эфирные слоты) =====

async function getTimelineSlots(stationId, fromTime = null, toTime = null) {
  let sql = 'SELECT * FROM radio_timeline_slots WHERE station_id = ?';
  const params = [stationId];

  if (fromTime) {
    sql += ' AND end_time >= ?';
    params.push(fromTime);
  }
  if (toTime) {
    sql += ' AND start_time <= ?';
    params.push(toTime);
  }

  sql += ' ORDER BY start_time ASC';
  return all(sql, params);
}

/**
 * Сохранение / замена сетки вещания для радиостанции.
 * Рассчитывает слоты последовательно, максимум до 24 часов вперед.
 */
async function setTimelineSlots(stationId, slots = [], customStartTime = null) {
  const station = await getStationById(stationId);
  if (!station) throw new Error('Станция не найдена');

  let cursor = customStartTime ? new Date(customStartTime).getTime() : Date.now();
  if (isNaN(cursor)) cursor = Date.now();

  const maxDurationMs = 24 * 60 * 60 * 1000; // 24 часа максимум
  const endLimit = cursor + maxDurationMs;

  const preparedSlots = [];
  for (const s of slots) {
    const durSec = Math.max(1, Number(s.duration) || 0);
    const durMs = durSec * 1000;

    if (cursor >= endLimit) break; // Превышен лимит 24 часа

    const actualDurMs = Math.min(durMs, endLimit - cursor);
    const startTimeIso = new Date(cursor).toISOString();
    const endTimeIso = new Date(cursor + actualDurMs).toISOString();

    preparedSlots.push({
      stationId,
      trackId: s.track_id || s.trackId || null,
      title: String(s.title || 'Без названия').trim(),
      type: ['track', 'podcast', 'speech'].includes(s.type) ? s.type : 'track',
      audioUrl: s.audio_url || s.audioUrl,
      duration: actualDurMs / 1000,
      startTime: startTimeIso,
      endTime: endTimeIso
    });

    cursor += actualDurMs;
  }

  // Удаляем будущие слоты для этой станции начиная со времени customStartTime (или now)
  const replaceThreshold = new Date(customStartTime ? new Date(customStartTime).getTime() : Date.now()).toISOString();
  await run('DELETE FROM radio_timeline_slots WHERE station_id = ? AND start_time >= ?', [stationId, replaceThreshold]);

  for (const p of preparedSlots) {
    await run(
      `INSERT INTO radio_timeline_slots (station_id, track_id, title, type, audio_url, duration, start_time, end_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.stationId, p.trackId, p.title, p.type, p.audioUrl, p.duration, p.startTime, p.endTime]
    );
  }

  return getTimelineSlots(stationId, new Date(Date.now() - 8 * 3600 * 1000).toISOString());
}

/**
 * Получение текущего состояния прямого эфира станции
 */
async function getStationLiveState(stationId) {
  const station = await getStationById(stationId);
  if (!station) throw new Error('Станция не найдена');

  const now = new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  // Ищем слот, который должен играть прямо сейчас
  let currentSlot = await get(
    `SELECT * FROM radio_timeline_slots 
     WHERE station_id = ? AND start_time <= ? AND end_time > ? 
     ORDER BY start_time ASC LIMIT 1`,
    [stationId, nowIso, nowIso]
  );

  let offset = 0;
  let remaining = 0;
  let isVirtualLoop = false;

  // Если прямо сейчас нет слота, но режим fallback_mode === 'loop'
  if (!currentSlot && station.fallback_mode === 'loop') {
    // Проверяем, есть ли вообще слоты для станции (за последние 32 часа)
    const allSlots = await all(
      `SELECT * FROM radio_timeline_slots WHERE station_id = ? ORDER BY start_time ASC`,
      [stationId]
    );

    if (allSlots.length > 0) {
      const totalDurationSec = allSlots.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
      if (totalDurationSec > 0) {
        const firstStartMs = new Date(allSlots[0].start_time).getTime();
        const elapsedSec = ((nowMs - firstStartMs) / 1000) % totalDurationSec;
        const normalizedElapsed = elapsedSec >= 0 ? elapsedSec : (totalDurationSec + elapsedSec);

        let accumulator = 0;
        for (const slot of allSlots) {
          const slotDur = Number(slot.duration) || 0;
          if (accumulator + slotDur > normalizedElapsed) {
            currentSlot = { ...slot };
            offset = normalizedElapsed - accumulator;
            remaining = slotDur - offset;
            isVirtualLoop = true;
            break;
          }
          accumulator += slotDur;
        }
      }
    }
  } else if (currentSlot) {
    const startMs = new Date(currentSlot.start_time).getTime();
    offset = Math.max(0, (nowMs - startMs) / 1000);
    remaining = Math.max(0, (Number(currentSlot.duration) || 0) - offset);
  }

  // Ближайшие следующие слоты (до 10 шт.)
  const nextSlots = await all(
    `SELECT * FROM radio_timeline_slots 
     WHERE station_id = ? AND start_time > ? 
     ORDER BY start_time ASC LIMIT 10`,
    [stationId, nowIso]
  );

  // Прошедшие слоты (до 10 шт., для перемотки/отката)
  const prevSlots = await all(
    `SELECT * FROM radio_timeline_slots 
     WHERE station_id = ? AND end_time <= ? 
     ORDER BY start_time DESC LIMIT 10`,
    [stationId, nowIso]
  );

  return {
    station,
    serverTime: nowIso,
    isLive: Boolean(currentSlot),
    isVirtualLoop,
    fallback: !currentSlot ? station.fallback_mode : null,
    currentSlot: currentSlot ? {
      id: currentSlot.id,
      title: currentSlot.title,
      type: currentSlot.type,
      audioUrl: currentSlot.audio_url,
      duration: currentSlot.duration,
      startTime: currentSlot.start_time,
      endTime: currentSlot.end_time,
      trackId: currentSlot.track_id
    } : null,
    offset: Math.round(offset * 10) / 10,
    remaining: Math.round(remaining * 10) / 10,
    nextSlots: nextSlots.map(s => ({
      id: s.id,
      title: s.title,
      type: s.type,
      audioUrl: s.audio_url,
      duration: s.duration,
      startTime: s.start_time,
      endTime: s.end_time
    })),
    prevSlots: prevSlots.map(s => ({
      id: s.id,
      title: s.title,
      type: s.type,
      audioUrl: s.audio_url,
      duration: s.duration,
      startTime: s.start_time,
      endTime: s.end_time
    }))
  };
}

// ===== Очистка устаревших слотов сетки (хранение до 32 часов) =====

async function cleanupOldTimelineSlots() {
  const result = await run(
    `DELETE FROM radio_timeline_slots 
     WHERE datetime(end_time) < datetime('now', '-32 hours')`
  );
  if (result.changes > 0) {
    console.log(`[Radio Cleanup] Удалено ${result.changes} слотов старше 32 часов`);
  }
  return result.changes;
}

module.exports = {
  listTracks,
  getTrackById,
  createTrack,
  deleteTrack,
  listStations,
  getStationById,
  getStationByFrequency,
  createStation,
  updateStation,
  deleteStation,
  getTimelineSlots,
  setTimelineSlots,
  getStationLiveState,
  cleanupOldTimelineSlots
};
