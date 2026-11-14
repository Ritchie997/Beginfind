// radio-store.js — хранилище для пользовательской медиатеки и радиостанций AllTell.
// Управляет треками/подкастами (radio_tracks), станциями/частотами (radio_stations)
// и 24/32-часовой сеткой вещания (radio_timeline_slots).

const path = require('path');
const fs = require('fs');
const { radioDb } = require('../db/connections');
const { UPLOADS_DIR } = require('../config/paths');
const { convertToMp3 } = require('./audio-converter');

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

/**
 * Автоматически находит любые треки не в MP3 и конвертирует их в MP3,
 * обновляя записи в БД radio_tracks и radio_timeline_slots.
 */
async function ensureTracksConvertedToMp3() {
  try {
    const nonMp3Tracks = await all(
      "SELECT id, audio_url, format, size FROM radio_tracks WHERE format != 'mp3' OR audio_url NOT LIKE '%.mp3'"
    );
    if (!nonMp3Tracks || nonMp3Tracks.length === 0) return;

    for (const track of nonMp3Tracks) {
      if (track.audio_url && track.audio_url.startsWith('/uploads/')) {
        const fileName = path.basename(track.audio_url);
        const filePath = path.join(UPLOADS_DIR, fileName);
        if (fs.existsSync(filePath)) {
          const conv = await convertToMp3(filePath);
          const newUrl = `/uploads/${conv.filename}`;
          await run(
            'UPDATE radio_tracks SET audio_url = ?, format = ?, size = ? WHERE id = ?',
            [newUrl, 'mp3', conv.size, track.id]
          );
          await run(
            'UPDATE radio_timeline_slots SET audio_url = ? WHERE track_id = ? OR audio_url = ?',
            [newUrl, track.id, track.audio_url]
          );
        } else {
          const mp3Name = fileName.replace(/\.[^.]+$/, '.mp3');
          const mp3Path = path.join(UPLOADS_DIR, mp3Name);
          if (fs.existsSync(mp3Path)) {
            const stat = await fs.promises.stat(mp3Path);
            const newUrl = `/uploads/${mp3Name}`;
            await run(
              'UPDATE radio_tracks SET audio_url = ?, format = ?, size = ? WHERE id = ?',
              [newUrl, 'mp3', stat.size, track.id]
            );
            await run(
              'UPDATE radio_timeline_slots SET audio_url = ? WHERE track_id = ? OR audio_url = ?',
              [newUrl, track.id, track.audio_url]
            );
          } else {
            await run('UPDATE radio_tracks SET format = ? WHERE id = ?', ['mp3', track.id]);
          }
        }
      } else {
        await run('UPDATE radio_tracks SET format = ? WHERE id = ?', ['mp3', track.id]);
      }
    }
  } catch (err) {
    console.warn('[radio-store] Error auto-converting existing tracks to mp3:', err.message);
  }
}

async function listTracks({ type = null, search = '', page = 1, limit = 30, userId = null } = {}) {
  // Гарантируем, что любые ранее добавленные не-mp3 треки будут сконвертированы в mp3
  await ensureTracksConvertedToMp3();

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
  let cleanFormat = 'mp3';
  let cleanUrl = audioUrl;
  let cleanSize = Number(size) || 0;

  // Автоматическая конвертация любого загруженного аудиофайла в MP3 при публикации
  if (cleanUrl && cleanUrl.startsWith('/uploads/')) {
    const fileName = path.basename(cleanUrl);
    const filePath = path.join(UPLOADS_DIR, fileName);
    if (fs.existsSync(filePath)) {
      const conv = await convertToMp3(filePath);
      cleanUrl = `/uploads/${conv.filename}`;
      cleanFormat = conv.format;
      cleanSize = conv.size;
    }
  }

  const result = await run(
    `INSERT INTO radio_tracks (user_id, author_name, title, audio_url, duration, size, format, type, cover_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, authorName, cleanTitle, cleanUrl, Number(duration) || 0, cleanSize, cleanFormat, cleanType, coverUrl || null]
  );

  return getTrackById(result.lastID);
}

async function deleteTrack(id, actingUserId, isRootOrAdmin = false) {
  const track = await getTrackById(id);
  if (!track) return false;

  if (track.user_id !== actingUserId && !isRootOrAdmin) {
    throw new Error('Недостаточно прав для удаления трека');
  }

  await run('DELETE FROM radio_favorites WHERE track_id = ?', [id]);
  await run('DELETE FROM radio_playlist_tracks WHERE track_id = ?', [id]);
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

async function clearTimelineSlots(stationId, actingUserId, isRootOrAdmin) {
  const station = await getStationById(stationId);
  if (!station) throw new Error('Станция не найдена');

  if (station.owner_id !== actingUserId && !isRootOrAdmin) {
    throw new Error('Недостаточно прав для очистки эфира');
  }

  await run('DELETE FROM radio_timeline_slots WHERE station_id = ?', [stationId]);
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

// ===== Управление избранным ("Моё") =====

async function getUserFavoriteTrackIds(userId) {
  if (!userId) return [];
  const rows = await all('SELECT track_id FROM radio_favorites WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  return rows.map((r) => r.track_id);
}

async function getUserFavorites(userId, { page = 1, limit = 50 } = {}) {
  if (!userId) return { tracks: [], total: 0, page: 1, limit, totalPages: 1 };
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const offset = (p - 1) * l;

  const countRow = await get(
    'SELECT COUNT(*) AS total FROM radio_favorites f JOIN radio_tracks t ON f.track_id = t.id WHERE f.user_id = ?',
    [userId]
  );
  const total = countRow ? countRow.total : 0;

  const tracks = await all(
    `SELECT t.*, f.created_at AS favorited_at
     FROM radio_favorites f
     JOIN radio_tracks t ON f.track_id = t.id
     WHERE f.user_id = ?
     ORDER BY f.created_at DESC
     LIMIT ? OFFSET ?`,
    [userId, l, offset]
  );

  return { tracks, total, page: p, limit: l, totalPages: Math.ceil(total / l) || 1 };
}

async function addFavorite(userId, trackId) {
  if (!userId || !trackId) return false;
  await run('INSERT OR IGNORE INTO radio_favorites (user_id, track_id) VALUES (?, ?)', [userId, trackId]);
  return true;
}

async function removeFavorite(userId, trackId) {
  if (!userId || !trackId) return false;
  await run('DELETE FROM radio_favorites WHERE user_id = ? AND track_id = ?', [userId, trackId]);
  return true;
}

async function toggleFavorite(userId, trackId) {
  if (!userId || !trackId) return { favorited: false };
  const existing = await get('SELECT id FROM radio_favorites WHERE user_id = ? AND track_id = ?', [userId, trackId]);
  if (existing) {
    await run('DELETE FROM radio_favorites WHERE id = ?', [existing.id]);
    return { favorited: false };
  } else {
    await run('INSERT INTO radio_favorites (user_id, track_id) VALUES (?, ?)', [userId, trackId]);
    return { favorited: true };
  }
}

async function isFavorite(userId, trackId) {
  if (!userId || !trackId) return false;
  const row = await get('SELECT id FROM radio_favorites WHERE user_id = ? AND track_id = ?', [userId, trackId]);
  return Boolean(row);
}

// ===== Управление плейлистами (своими и публичными) =====

async function createPlaylist({ userId, authorName, title, description = '', isPublic = 1, coverUrl = null }) {
  const cleanTitle = String(title || '').trim() || 'Новый плейлист';
  const pub = (isPublic === 0 || isPublic === '0' || isPublic === false) ? 0 : 1;
  const res = await run(
    `INSERT INTO radio_playlists (user_id, author_name, title, description, is_public, cover_url)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, authorName, cleanTitle, description || '', pub, coverUrl || null]
  );
  return getPlaylistById(res.lastID, userId, true);
}

async function getPlaylistById(id, requestingUserId = null, isAdmin = false) {
  const pl = await get('SELECT * FROM radio_playlists WHERE id = ?', [id]);
  if (!pl) return null;
  if (!pl.is_public && pl.user_id !== requestingUserId && !isAdmin) {
    return null;
  }
  const tracks = await all(
    `SELECT t.*, pt.position, pt.created_at AS added_to_playlist_at
     FROM radio_playlist_tracks pt
     JOIN radio_tracks t ON pt.track_id = t.id
     WHERE pt.playlist_id = ?
     ORDER BY pt.position ASC, pt.id ASC`,
    [id]
  );
  pl.tracks = tracks;
  pl.trackCount = tracks.length;
  pl.totalDuration = tracks.reduce((acc, t) => acc + (parseFloat(t.duration) || 0), 0);
  return pl;
}

async function listPlaylists({ userId = null, requestingUserId = null, isAdmin = false, isPublic = null, search = '', page = 1, limit = 30 } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const offset = (p - 1) * l;

  const conditions = [];
  const params = [];

  if (userId) {
    conditions.push('p.user_id = ?');
    params.push(userId);
    if (userId !== requestingUserId && !isAdmin) {
      conditions.push('p.is_public = 1');
    }
  } else if (isPublic !== null) {
    conditions.push('p.is_public = ?');
    params.push(isPublic ? 1 : 0);
  } else if (!isAdmin) {
    if (requestingUserId) {
      conditions.push('(p.is_public = 1 OR p.user_id = ?)');
      params.push(requestingUserId);
    } else {
      conditions.push('p.is_public = 1');
    }
  }

  if (search && search.trim()) {
    conditions.push('(p.title LIKE ? OR p.author_name LIKE ?)');
    const term = `%${search.trim()}%`;
    params.push(term, term);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await get(`SELECT COUNT(*) AS total FROM radio_playlists p ${whereClause}`, params);
  const total = countRow ? countRow.total : 0;

  const playlists = await all(
    `SELECT p.*,
            (SELECT COUNT(*) FROM radio_playlist_tracks pt WHERE pt.playlist_id = p.id) AS trackCount,
            (SELECT COALESCE(SUM(t.duration), 0) FROM radio_playlist_tracks pt JOIN radio_tracks t ON pt.track_id = t.id WHERE pt.playlist_id = p.id) AS totalDuration
     FROM radio_playlists p
     ${whereClause}
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, l, offset]
  );

  return { playlists, total, page: p, limit: l, totalPages: Math.ceil(total / l) || 1 };
}

async function updatePlaylist(id, userId, isAdmin, { title, description, isPublic, coverUrl }) {
  const pl = await get('SELECT * FROM radio_playlists WHERE id = ?', [id]);
  if (!pl) return null;
  if (pl.user_id !== userId && !isAdmin) {
    throw new Error('Вы не являетесь владельцем этого плейлиста');
  }
  const cleanTitle = title !== undefined ? String(title).trim() || pl.title : pl.title;
  const cleanDesc = description !== undefined ? description : pl.description;
  const cleanPublic = isPublic !== undefined ? ((isPublic === 0 || isPublic === '0' || isPublic === false) ? 0 : 1) : pl.is_public;
  const cleanCover = coverUrl !== undefined ? coverUrl : pl.cover_url;

  await run(
    `UPDATE radio_playlists
     SET title = ?, description = ?, is_public = ?, cover_url = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [cleanTitle, cleanDesc, cleanPublic, cleanCover, id]
  );
  return getPlaylistById(id, userId, true);
}

async function deletePlaylist(id, userId, isAdmin) {
  const pl = await get('SELECT * FROM radio_playlists WHERE id = ?', [id]);
  if (!pl) return false;
  if (pl.user_id !== userId && !isAdmin) {
    throw new Error('Вы не являетесь владельцем этого плейлиста');
  }
  await run('DELETE FROM radio_playlist_tracks WHERE playlist_id = ?', [id]);
  await run('DELETE FROM radio_playlists WHERE id = ?', [id]);
  return true;
}

async function addTrackToPlaylist(playlistId, trackId, userId, isAdmin) {
  const pl = await get('SELECT * FROM radio_playlists WHERE id = ?', [playlistId]);
  if (!pl) throw new Error('Плейлист не найден');
  if (pl.user_id !== userId && !isAdmin) {
    throw new Error('У вас нет прав на редактирование этого плейлиста');
  }
  const track = await getTrackById(trackId);
  if (!track) throw new Error('Трек не найден');

  const existing = await get('SELECT id FROM radio_playlist_tracks WHERE playlist_id = ? AND track_id = ?', [playlistId, trackId]);
  if (existing) return { added: true, alreadyExists: true };

  const maxPosRow = await get('SELECT MAX(position) AS maxPos FROM radio_playlist_tracks WHERE playlist_id = ?', [playlistId]);
  const nextPos = (maxPosRow && maxPosRow.maxPos !== null ? maxPosRow.maxPos : -1) + 1;

  await run(
    'INSERT INTO radio_playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)',
    [playlistId, trackId, nextPos]
  );
  return { added: true, alreadyExists: false };
}

async function removeTrackFromPlaylist(playlistId, trackId, userId, isAdmin) {
  const pl = await get('SELECT * FROM radio_playlists WHERE id = ?', [playlistId]);
  if (!pl) throw new Error('Плейлист не найден');
  if (pl.user_id !== userId && !isAdmin) {
    throw new Error('У вас нет прав на редактирование этого плейлиста');
  }
  await run('DELETE FROM radio_playlist_tracks WHERE playlist_id = ? AND track_id = ?', [playlistId, trackId]);
  return { removed: true };
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
  ensureTracksConvertedToMp3,
  getUserFavoriteTrackIds,
  getUserFavorites,
  addFavorite,
  removeFavorite,
  toggleFavorite,
  isFavorite,
  createPlaylist,
  getPlaylistById,
  listPlaylists,
  updatePlaylist,
  deletePlaylist,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  listStations,
  getStationById,
  getStationByFrequency,
  createStation,
  updateStation,
  deleteStation,
  clearTimelineSlots,
  getTimelineSlots,
  setTimelineSlots,
  getStationLiveState,
  cleanupOldTimelineSlots
};
