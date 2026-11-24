// radio-store.js — хранилище для пользовательской медиатеки и радиостанций AllTell.
// Управляет треками/подкастами (radio_tracks), станциями/частотами (radio_stations)
// и 24/32-часовой сеткой вещания (radio_timeline_slots).

const path = require('path');
const fs = require('fs');
const { radioDb } = require('../db/connections');
const { UPLOADS_DIR } = require('../config/paths');
const { convertToMp3, decodeOriginalName, probeAudioDuration } = require('./audio-converter');
const { getEffectiveServerTime } = require('./system-settings');

function getEffectiveNow() {
  return typeof getEffectiveServerTime === 'function' ? getEffectiveServerTime() : new Date();
}

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

    // Автоматическое восстановление длительности треков (00:00) из файлов в uploads/
    const zeroDurationTracks = await all(
      "SELECT id, audio_url FROM radio_tracks WHERE (duration <= 0 OR duration IS NULL) AND audio_url LIKE '/uploads/%'"
    );
    for (const track of zeroDurationTracks) {
      if (track.audio_url) {
        const fileName = path.basename(track.audio_url);
        const filePath = path.join(UPLOADS_DIR, fileName);
        if (fs.existsSync(filePath)) {
          const probed = probeAudioDuration(filePath);
          if (probed > 0) {
            await run('UPDATE radio_tracks SET duration = ? WHERE id = ?', [probed, track.id]);
            await run('UPDATE radio_timeline_slots SET duration = ? WHERE track_id = ? AND (duration <= 0 OR duration IS NULL)', [probed, track.id]);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[radio-store] Error auto-converting existing tracks to mp3:', err.message);
  }
}

async function listTracks({ type = null, search = '', page = 1, limit = 50, userId = null } = {}) {
  // Гарантируем, что любые ранее добавленные не-mp3 треки будут сконвертированы в mp3
  await ensureTracksConvertedToMp3();

  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
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
  const track = await get('SELECT * FROM radio_tracks WHERE id = ?', [id]);
  if (track && (Number(track.duration) <= 0 || !track.duration) && track.audio_url && track.audio_url.startsWith('/uploads/')) {
    const fileName = path.basename(track.audio_url);
    const filePath = path.join(UPLOADS_DIR, fileName);
    if (fs.existsSync(filePath)) {
      const probed = probeAudioDuration(filePath);
      if (probed > 0) {
        track.duration = probed;
        await run('UPDATE radio_tracks SET duration = ? WHERE id = ?', [probed, track.id]);
        await run('UPDATE radio_timeline_slots SET duration = ? WHERE track_id = ? AND (duration <= 0 OR duration IS NULL)', [probed, track.id]);
      }
    }
  }
  return track;
}

async function createTrack({ userId, authorName, title, audioUrl, duration = 0, size = 0, format = 'mp3', type = 'track', coverUrl = null }) {
  const cleanTitle = decodeOriginalName(String(title || '').trim()) || 'Без названия';
  const cleanType = ['track', 'podcast', 'speech'].includes(type) ? type : 'track';
  let cleanFormat = 'mp3';
  let cleanUrl = audioUrl;
  let cleanSize = Number(size) || 0;
  let cleanDuration = Math.round(Number(duration)) || 0;

  // Автоматическая конвертация любого загруженного аудиофайла в MP3 при публикации
  if (cleanUrl && cleanUrl.startsWith('/uploads/')) {
    const fileName = path.basename(cleanUrl);
    const filePath = path.join(UPLOADS_DIR, fileName);
    if (fs.existsSync(filePath)) {
      const conv = await convertToMp3(filePath);
      cleanUrl = `/uploads/${conv.filename}`;
      cleanFormat = conv.format;
      cleanSize = conv.size;
      if (cleanDuration <= 0 && conv.duration > 0) {
        cleanDuration = conv.duration;
      }
    }
  }

  // Если длительность всё ещё 0, пробуем измерить локальный файл через ffprobe/ffmpeg
  if (cleanDuration <= 0 && cleanUrl && cleanUrl.startsWith('/uploads/')) {
    const fileName = path.basename(cleanUrl);
    const filePath = path.join(UPLOADS_DIR, fileName);
    if (fs.existsSync(filePath)) {
      cleanDuration = probeAudioDuration(filePath) || 0;
    }
  }

  const result = await run(
    `INSERT INTO radio_tracks (user_id, author_name, title, audio_url, duration, size, format, type, cover_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, authorName, cleanTitle, cleanUrl, cleanDuration, cleanSize, cleanFormat, cleanType, coverUrl || null]
  );

  return getTrackById(result.lastID);
}

async function updateTrackDuration(id, duration) {
  const durSec = Math.round(Number(duration));
  if (!Number.isFinite(durSec) || durSec <= 0) return null;
  await run('UPDATE radio_tracks SET duration = ? WHERE id = ?', [durSec, id]);
  await run('UPDATE radio_timeline_slots SET duration = ? WHERE track_id = ? AND (duration <= 0 OR duration IS NULL)', [durSec, id]);
  return getTrackById(id);
}

async function deleteTrack(id, actingUserId, isRootOrAdmin = false) {
  const track = await getTrackById(id);
  if (!track) return false;

  if (Number(track.user_id) !== Number(actingUserId) && !isRootOrAdmin) {
    throw new Error('Недостаточно прав для удаления трека');
  }

  await run('DELETE FROM radio_favorites WHERE track_id = ?', [id]);
  await run('DELETE FROM radio_playlist_tracks WHERE track_id = ?', [id]);
  await run('DELETE FROM radio_timeline_slots WHERE track_id = ?', [id]);
  await run('DELETE FROM radio_tracks WHERE id = ?', [id]);
  return true;
}

// ===== Управление радиостанциями (частотами) =====

async function listStations() {
  const stations = await all('SELECT * FROM radio_stations WHERE is_active = 1 ORDER BY frequency ASC');
  const now = getEffectiveNow().toISOString();

  // Добавляем к каждой станции краткую информацию о текущем треке
  const enriched = await Promise.all(
    stations.map(async (st) => {
      if (st.broadcast_status === 'offline') {
        return {
          ...st,
          currentTrack: null,
          isLive: false
        };
      }
      let currentSlot = await get(
        `SELECT * FROM radio_timeline_slots 
         WHERE station_id = ? AND start_time <= ? AND end_time > ? 
         ORDER BY slot_order ASC, start_time ASC LIMIT 1`,
        [st.id, now, now]
      );
      if (!currentSlot && (st.fallback_mode === 'loop' || st.is_eternal)) {
        try {
          const liveState = await getStationLiveState(st.id);
          if (liveState && liveState.currentSlot) {
            currentSlot = liveState.currentSlot;
          }
        } catch (_) {}
      }
      return {
        ...st,
        currentTrack: currentSlot ? {
          title: currentSlot.title,
          type: currentSlot.type,
          duration: currentSlot.duration,
          startTime: currentSlot.start_time || currentSlot.startTime,
          endTime: currentSlot.end_time || currentSlot.endTime
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

async function createStation({ frequency, name, description = '', ownerId, ownerName, avatarUrl = null, fallbackMode = 'loop', hostName, host_name, isEternal, is_eternal }) {
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

  const chosenOwner = String(hostName || host_name || '').trim() || ownerName || 'Ведущий';
  const cleanEternal = (isEternal === 1 || isEternal === true || is_eternal === 1 || is_eternal === true) ? 1 : 0;
  let cleanFallback = ['loop', 'noise', 'silence'].includes(fallbackMode) ? fallbackMode : 'loop';
  if (cleanEternal === 1 && !fallbackMode) {
    cleanFallback = 'loop';
  }

  const result = await run(
    `INSERT INTO radio_stations (frequency, name, description, owner_id, owner_name, avatar_url, fallback_mode, is_eternal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [numFreq, cleanName, String(description || '').trim(), ownerId, chosenOwner, avatarUrl || null, cleanFallback, cleanEternal]
  );

  return getStationById(result.lastID);
}

async function updateStation(id, actingUserId, isRootOrAdmin, { name, description, avatarUrl, fallbackMode, isActive, ownerName, owner_name, host, host_name, isEternal, is_eternal }) {
  const station = await getStationById(id);
  if (!station) throw new Error('Станция не найдена');

  const isOwner = actingUserId != null && String(station.owner_id) === String(actingUserId);
  if (!isOwner && !isRootOrAdmin) {
    throw new Error('Только владелец станции может изменять её настройки');
  }

  const updates = [];
  const params = [];

  if (name !== undefined) {
    updates.push('name = ?');
    params.push(String(name).trim() || station.name);
  }
  const customHost = ownerName !== undefined ? ownerName : (owner_name !== undefined ? owner_name : (host !== undefined ? host : host_name));
  if (customHost !== undefined) {
    const cleanHost = String(customHost || '').trim();
    if (cleanHost) {
      updates.push('owner_name = ?');
      params.push(cleanHost);
    }
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
  const eternalVal = isEternal !== undefined ? isEternal : is_eternal;
  if (eternalVal !== undefined) {
    const cleanEternal = (eternalVal === 1 || eternalVal === true || eternalVal === '1' || eternalVal === 'true') ? 1 : 0;
    updates.push('is_eternal = ?');
    params.push(cleanEternal);
    if (cleanEternal === 1 && fallbackMode === undefined) {
      updates.push('fallback_mode = ?');
      params.push('loop');
    }
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

  const isOwner = actingUserId != null && String(station.owner_id) === String(actingUserId);
  if (!isOwner && !isRootOrAdmin) {
    throw new Error('Недостаточно прав для удаления радиостанции');
  }

  await run('DELETE FROM radio_timeline_slots WHERE station_id = ?', [id]);
  await run('DELETE FROM radio_stations WHERE id = ?', [id]);
  return true;
}

async function clearTimelineSlots(stationId, actingUserId, isRootOrAdmin) {
  const station = await getStationById(stationId);
  if (!station) throw new Error('Станция не найдена');

  const isOwner = actingUserId != null && String(station.owner_id) === String(actingUserId);
  if (!isOwner && !isRootOrAdmin) {
    throw new Error('Недостаточно прав для очистки эфира');
  }

  await run('DELETE FROM radio_timeline_slots WHERE station_id = ?', [stationId]);
  return true;
}

// ===== Календарное планирование эфиров (radio_scheduled_broadcasts) =====

async function createScheduledBroadcast(stationId, actingUserId, isRootOrAdmin, data = {}) {
  const station = await getStationById(stationId);
  if (!station) throw new Error('Станция не найдена');

  const isOwner = actingUserId != null && String(station.owner_id) === String(actingUserId);
  if (!isOwner && !isRootOrAdmin) {
    throw new Error('Только владелец станции может планировать эфиры');
  }

  const title = data.title;
  const description = data.description || '';
  const startTime = data.startTime || data.start_time;
  const slots = data.slots || data.slots_data || [];
  const isLoop = Boolean(data.isLoop !== undefined ? data.isLoop : data.is_loop);
  const fallbackAction = data.fallbackAction || data.fallback_action || 'return_to_normal';
  const coverUrl = data.coverUrl || data.cover_url || null;

  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) {
    throw new Error('Укажите название запланированной передачи');
  }

  const startMs = new Date(startTime).getTime();
  if (isNaN(startMs)) {
    throw new Error('Укажите корректную дату и время старта передачи');
  }

  const startIso = new Date(startMs).toISOString();
  let totalDurationSec = 0;
  let endIso = null;
  const preparedSlots = [];

  if (Array.isArray(slots) && slots.length > 0) {
    let orderIndex = 0;
    let cursor = startMs;

    for (const s of slots) {
      const durSec = Math.max(1, Number(s.duration) || 0);
      const durMs = Math.round(durSec * 1000);
      const sStart = new Date(cursor).toISOString();
      const sEnd = new Date(cursor + durMs).toISOString();

      let audioUrl = s.audio_url || s.audioUrl;
      if (!audioUrl && (s.track_id || s.trackId)) {
        const dbTrack = await get('SELECT audio_url FROM radio_tracks WHERE id = ?', [s.track_id || s.trackId]);
        if (dbTrack && dbTrack.audio_url) audioUrl = dbTrack.audio_url;
      }
      if (!audioUrl) audioUrl = '';

      preparedSlots.push({
        slotOrder: orderIndex++,
        trackId: s.track_id || s.trackId || null,
        title: String(s.title || 'Без названия').trim(),
        type: ['track', 'podcast', 'speech'].includes(s.type) ? s.type : 'track',
        audioUrl,
        duration: durSec,
        startTime: sStart,
        endTime: sEnd
      });

      cursor += durMs;
    }

    totalDurationSec = preparedSlots.reduce((sum, s) => sum + s.duration, 0);
    endIso = new Date(cursor).toISOString();
  } else {
    // Разрешено создание пустой передачи (наполняется в редакторе позже)
    totalDurationSec = Math.max(60, Number(data.duration) || 3600);
    endIso = new Date(startMs + totalDurationSec * 1000).toISOString();
  }

  // Проверка наложения по времени с другими передачами этой же станции
  const overlap = await get(
    `SELECT id, title, start_time, end_time FROM radio_scheduled_broadcasts 
     WHERE station_id = ? AND status != 'cancelled' 
       AND start_time < ? AND end_time > ? LIMIT 1`,
    [stationId, endIso, startIso]
  );
  if (overlap) {
    throw new Error(`Пересечение по времени с передачей «${overlap.title}» (${overlap.start_time} — ${overlap.end_time})`);
  }

  const cleanFallbackAction = ['return_to_regular', 'silence', 'noise'].includes(fallbackAction) ? fallbackAction : 'return_to_regular';

  const res = await run(
    `INSERT INTO radio_scheduled_broadcasts (
      station_id, title, description, start_time, end_time, duration, 
      status, is_loop, fallback_action, slots_data, cover_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      stationId,
      cleanTitle,
      String(description || '').trim(),
      startIso,
      endIso,
      totalDurationSec,
      'planned',
      isLoop ? 1 : 0,
      cleanFallbackAction,
      JSON.stringify(preparedSlots),
      coverUrl || null
    ]
  );

  return getScheduledBroadcastById(res.lastID);
}

async function getScheduledBroadcasts(stationId, fromTime = null, toTime = null) {
  let sql = "SELECT * FROM radio_scheduled_broadcasts WHERE station_id = ? AND status != 'cancelled'";
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
  const rows = await all(sql, params);
  return rows.map((r) => {
    let slots = [];
    try { slots = JSON.parse(r.slots_data || '[]'); } catch (_) {}
    return {
      ...r,
      is_loop: Boolean(r.is_loop),
      slots
    };
  });
}

async function getScheduledBroadcastById(id) {
  const row = await get('SELECT * FROM radio_scheduled_broadcasts WHERE id = ?', [id]);
  if (!row) return null;
  let slots = [];
  try { slots = JSON.parse(row.slots_data || '[]'); } catch (_) {}
  return {
    ...row,
    is_loop: Boolean(row.is_loop),
    slots
  };
}

async function updateScheduledBroadcast(id, actingUserId, isRootOrAdmin, data = {}) {
  const existing = await getScheduledBroadcastById(id);
  if (!existing) throw new Error('Запланированная передача не найдена');

  const station = await getStationById(existing.station_id);
  if (!station) throw new Error('Станция не найдена');

  const isOwner = actingUserId != null && String(station.owner_id) === String(actingUserId);
  if (!isOwner && !isRootOrAdmin) {
    throw new Error('Только владелец станции может изменять расписание');
  }

  const title = data.title;
  const description = data.description;
  const startTime = data.startTime !== undefined ? data.startTime : data.start_time;
  const slots = data.slots !== undefined ? data.slots : data.slots_data;
  const isLoop = data.isLoop !== undefined ? data.isLoop : data.is_loop;
  const fallbackAction = data.fallbackAction !== undefined ? data.fallbackAction : data.fallback_action;
  const status = data.status;
  const coverUrl = data.coverUrl !== undefined ? data.coverUrl : data.cover_url;

  let startIso = existing.start_time;
  let endIso = existing.end_time;
  let totalDur = existing.duration;
  let slotsJson = existing.slots_data;

  let preparedSlots = existing.slots;
  let needRecalc = false;

  if (startTime) {
    const sMs = new Date(startTime).getTime();
    if (!isNaN(sMs)) {
      startIso = new Date(sMs).toISOString();
      needRecalc = true;
    }
  }

  if (Array.isArray(slots) && slots.length > 0) {
    preparedSlots = [];
    let orderIndex = 0;
    const baseMs = new Date(startIso).getTime();
    let cursor = baseMs;

    for (const s of slots) {
      const durSec = Math.max(1, Number(s.duration) || 0);
      const durMs = Math.round(durSec * 1000);
      const sStart = new Date(cursor).toISOString();
      const sEnd = new Date(cursor + durMs).toISOString();

      let audioUrl = s.audio_url || s.audioUrl;
      if (!audioUrl && (s.track_id || s.trackId)) {
        const dbTrack = await get('SELECT audio_url FROM radio_tracks WHERE id = ?', [s.track_id || s.trackId]);
        if (dbTrack && dbTrack.audio_url) audioUrl = dbTrack.audio_url;
      }
      if (!audioUrl) audioUrl = '';

      preparedSlots.push({
        slotOrder: orderIndex++,
        trackId: s.track_id || s.trackId || null,
        title: String(s.title || 'Без названия').trim(),
        type: ['track', 'podcast', 'speech'].includes(s.type) ? s.type : 'track',
        audioUrl,
        duration: durSec,
        startTime: sStart,
        endTime: sEnd
      });

      cursor += durMs;
    }

    totalDur = preparedSlots.reduce((sum, s) => sum + s.duration, 0);
    endIso = new Date(cursor).toISOString();
    slotsJson = JSON.stringify(preparedSlots);
    needRecalc = false;
  } else if (needRecalc) {
    const baseMs = new Date(startIso).getTime();
    let cursor = baseMs;
    preparedSlots = preparedSlots.map((s) => {
      const durMs = Math.round((Number(s.duration) || 0) * 1000);
      const sStart = new Date(cursor).toISOString();
      const sEnd = new Date(cursor + durMs).toISOString();
      cursor += durMs;
      return { ...s, startTime: sStart, endTime: sEnd };
    });
    endIso = new Date(cursor).toISOString();
    slotsJson = JSON.stringify(preparedSlots);
  }

  // Проверка наложения при изменении временных рамок
  const overlap = await get(
    `SELECT id, title, start_time, end_time FROM radio_scheduled_broadcasts 
     WHERE station_id = ? AND id != ? AND status != 'cancelled' 
       AND start_time < ? AND end_time > ? LIMIT 1`,
    [existing.station_id, id, endIso, startIso]
  );
  if (overlap) {
    throw new Error(`Пересечение по времени с передачей «${overlap.title}» (${overlap.start_time} — ${overlap.end_time})`);
  }

  const updates = [];
  const params = [];

  if (title !== undefined) {
    updates.push('title = ?');
    params.push(String(title).trim() || existing.title);
  }
  if (description !== undefined) {
    updates.push('description = ?');
    params.push(String(description).trim());
  }
  if (startIso !== existing.start_time) {
    updates.push('start_time = ?');
    params.push(startIso);
  }
  if (endIso !== existing.end_time) {
    updates.push('end_time = ?');
    params.push(endIso);
  }
  if (totalDur !== existing.duration) {
    updates.push('duration = ?');
    params.push(totalDur);
  }
  if (slotsJson !== existing.slots_data) {
    updates.push('slots_data = ?');
    params.push(slotsJson);
  }
  if (isLoop !== undefined) {
    updates.push('is_loop = ?');
    params.push(isLoop ? 1 : 0);
  }
  if (fallbackAction !== undefined && ['return_to_regular', 'silence', 'noise'].includes(fallbackAction)) {
    updates.push('fallback_action = ?');
    params.push(fallbackAction);
  }
  if (status !== undefined && ['planned', 'live', 'finished', 'cancelled'].includes(status)) {
    updates.push('status = ?');
    params.push(status);
  }
  if (coverUrl !== undefined) {
    updates.push('cover_url = ?');
    params.push(coverUrl || null);
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);

  if (updates.length > 1) {
    await run(`UPDATE radio_scheduled_broadcasts SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  return getScheduledBroadcastById(id);
}

async function deleteScheduledBroadcast(id, actingUserId, isRootOrAdmin) {
  const existing = await getScheduledBroadcastById(id);
  if (!existing) return false;

  const station = await getStationById(existing.station_id);
  if (!station) throw new Error('Станция не найдена');

  const isOwner = actingUserId != null && String(station.owner_id) === String(actingUserId);
  if (!isOwner && !isRootOrAdmin) {
    throw new Error('Недостаточно прав для удаления запланированного эфира');
  }

  await run('DELETE FROM radio_scheduled_broadcasts WHERE id = ?', [id]);
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

  sql += ' ORDER BY slot_order ASC, start_time ASC';
  return all(sql, params);
}

/**
 * Сохранение / замена сетки вещания для радиостанции.
 * Рассчитывает слоты последовательно, максимум до 24 часов вперед.
 */
async function setTimelineSlots(stationId, slots = [], customStartTime = null, options = {}) {
  const station = await getStationById(stationId);
  if (!station) throw new Error('Станция не найдена');

  const now = getEffectiveNow();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  // Бесшовное горячее обновление сетки прямого эфира (асинхронное редактирование)
  // Сохраняет текущий воспроизводимый трек в эфире без прерывания звучания!
  if (options.hotUpdate && (station.broadcast_status === 'live' || options.isLive)) {
    const liveState = await getStationLiveState(stationId);
    const activeSlot = liveState && liveState.currentSlot;

    if (activeSlot && activeSlot.id) {
      const activeEndMs = new Date(activeSlot.end_time || activeSlot.endTime).getTime();
      // Если активный слот ещё звучит (до конца осталось больше 1 секунды)
      if (activeEndMs > nowMs + 1000) {
        // 1. Оставляем активный слот и предшествующую историю вещания, удаляем только будущие запланированные слоты
        await run(
          'DELETE FROM radio_timeline_slots WHERE station_id = ? AND slot_order > ?',
          [stationId, activeSlot.slot_order || 0]
        );

        // 2. Определяем, с какого места черновика подставлять треки
        let upcomingDraftSlots = slots;
        const activeTrackId = activeSlot.track_id || activeSlot.trackId;
        const activeTitle = activeSlot.title;
        const activeIdx = slots.findIndex(s =>
          (activeTrackId && (s.track_id == activeTrackId || s.trackId == activeTrackId)) ||
          (activeTitle && s.title === activeTitle)
        );

        if (activeIdx >= 0) {
          upcomingDraftSlots = slots.slice(activeIdx + 1);
        }

        // 3. Выстраиваем новые слоты начиная ровно с момента окончания активного трека
        let cursor = activeEndMs;
        let orderIndex = (activeSlot.slot_order || 0) + 1;
        const maxDurationMs = 24 * 60 * 60 * 1000;
        const endLimit = cursor + maxDurationMs;

        for (const s of upcomingDraftSlots) {
          const durSec = Math.max(1, Number(s.duration) || 0);
          const durMs = durSec * 1000;
          if (cursor >= endLimit) break;

          const actualDurMs = Math.min(durMs, endLimit - cursor);
          const startTimeIso = new Date(cursor).toISOString();
          const endTimeIso = new Date(cursor + actualDurMs).toISOString();

          let audioUrl = s.audio_url || s.audioUrl;
          if (!audioUrl && (s.track_id || s.trackId)) {
            const dbTrack = await get('SELECT audio_url FROM radio_tracks WHERE id = ?', [s.track_id || s.trackId]);
            if (dbTrack && dbTrack.audio_url) audioUrl = dbTrack.audio_url;
          }
          if (!audioUrl) audioUrl = '';

          await run(
            `INSERT INTO radio_timeline_slots (station_id, track_id, slot_order, title, type, audio_url, duration, start_time, end_time)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              stationId,
              s.track_id || s.trackId || null,
              orderIndex++,
              String(s.title || 'Без названия').trim(),
              ['track', 'podcast', 'speech'].includes(s.type) ? s.type : 'track',
              audioUrl,
              actualDurMs / 1000,
              startTimeIso,
              endTimeIso
            ]
          );

          cursor += actualDurMs;
        }

        return getTimelineSlots(stationId);
      }
    }
  }

  const isForceNow = Boolean(options.forceNow || customStartTime === 'now');
  let cursor;
  if (isForceNow) {
    cursor = getEffectiveNow().getTime() - 250;
  } else {
    cursor = customStartTime ? new Date(customStartTime).getTime() : getEffectiveNow().getTime();
    if (isNaN(cursor)) cursor = getEffectiveNow().getTime();
  }
  const initialStartMs = cursor;

  const maxDurationMs = 24 * 60 * 60 * 1000; // 24 часа максимум
  const endLimit = cursor + maxDurationMs;

  const preparedSlots = [];
  let orderIndex = 0;
  for (const s of slots) {
    const durSec = Math.max(1, Number(s.duration) || 0);
    const durMs = durSec * 1000;

    if (cursor >= endLimit) break; // Превышен лимит 24 часа

    const actualDurMs = Math.min(durMs, endLimit - cursor);
    const startTimeIso = new Date(cursor).toISOString();
    const endTimeIso = new Date(cursor + actualDurMs).toISOString();

    let audioUrl = s.audio_url || s.audioUrl;
    // Если audioUrl отсутствует, но есть track_id — подтягиваем оригинальный audio_url из базы треков
    if (!audioUrl && (s.track_id || s.trackId)) {
      const dbTrack = await get('SELECT audio_url FROM radio_tracks WHERE id = ?', [s.track_id || s.trackId]);
      if (dbTrack && dbTrack.audio_url) {
        audioUrl = dbTrack.audio_url;
      }
    }
    // Защита от SQLITE_CONSTRAINT NOT NULL
    if (!audioUrl) {
      audioUrl = '';
    }

    preparedSlots.push({
      stationId,
      trackId: s.track_id || s.trackId || null,
      slotOrder: orderIndex++,
      title: String(s.title || 'Без названия').trim(),
      type: ['track', 'podcast', 'speech'].includes(s.type) ? s.type : 'track',
      audioUrl,
      duration: actualDurMs / 1000,
      startTime: startTimeIso,
      endTime: endTimeIso
    });

    cursor += actualDurMs;
  }

  // Полностью очищаем старые слоты станции перед сохранением новой последовательности
  await run('DELETE FROM radio_timeline_slots WHERE station_id = ?', [stationId]);

  for (const p of preparedSlots) {
    await run(
      `INSERT INTO radio_timeline_slots (station_id, track_id, slot_order, title, type, audio_url, duration, start_time, end_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.stationId, p.trackId, p.slotOrder, p.title, p.type, p.audioUrl, p.duration, p.startTime, p.endTime]
    );
  }

  if (options.status) {
    await run('UPDATE radio_stations SET broadcast_status = ?, broadcast_started_at = ? WHERE id = ?', [
      options.status,
      new Date(initialStartMs).toISOString(),
      stationId
    ]);
  }

  return getTimelineSlots(stationId);
}

/**
 * Запуск вещания радиостанции (мгновенный старт либо отложенный).
 */
async function startStationBroadcast(stationId, { forceNow = true, startTime = null, slots = null } = {}) {
  const station = await getStationById(stationId);
  if (!station) throw new Error('Станция не найдена');

  const now = getEffectiveNow();
  let startMs = forceNow ? now.getTime() - 250 : (startTime ? new Date(startTime).getTime() : now.getTime());
  if (isNaN(startMs)) startMs = now.getTime();

  const isLive = startMs <= now.getTime();
  const status = isLive ? 'live' : 'scheduled';
  const startIso = new Date(startMs).toISOString();

  if (slots && Array.isArray(slots) && slots.length > 0) {
    await setTimelineSlots(stationId, slots, startIso, { forceNow: isLive, status });
  } else {
    const existingSlots = await all(
      'SELECT * FROM radio_timeline_slots WHERE station_id = ? ORDER BY slot_order ASC, start_time ASC',
      [stationId]
    );
    if (existingSlots.length > 0) {
      await setTimelineSlots(stationId, existingSlots, startIso, { forceNow: isLive, status });
    } else {
      await run('UPDATE radio_stations SET broadcast_status = ?, broadcast_started_at = ? WHERE id = ?', [
        status,
        startIso,
        stationId
      ]);
    }
  }

  return getStationLiveState(stationId);
}

/**
 * Остановка эфира радиостанции без удаления слотов сетки.
 */
async function stopStationBroadcast(stationId) {
  const station = await getStationById(stationId);
  if (!station) throw new Error('Станция не найдена');

  await run("UPDATE radio_stations SET broadcast_status = 'offline' WHERE id = ?", [stationId]);
  return { success: true, broadcastStatus: 'offline' };
}

/**
 * Получение текущего состояния прямого эфира станции
 */
async function getStationLiveState(stationId, options = {}) {
  const finishedSlotId = options && (options.finishedSlotId || options.finished_slot_id);
  const station = await getStationById(stationId);
  if (!station) throw new Error('Станция не найдена');

  const now = getEffectiveNow();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  // 1. Приоритет 1: Календарное расписание (radio_scheduled_broadcasts)
  // Проверяем наличие активной запланированной передачи на текущий момент nowIso
  const activeEvent = await get(
    `SELECT * FROM radio_scheduled_broadcasts 
     WHERE station_id = ? AND status != 'cancelled' 
       AND start_time <= ? AND end_time > ? 
     ORDER BY start_time ASC LIMIT 1`,
    [stationId, nowIso, nowIso]
  );

  // Находим ближайший следующий запланированный эфир (для подсказок интерфейса и предзагрузки)
  const nextEvent = await get(
    `SELECT id, title, start_time, end_time, duration, cover_url FROM radio_scheduled_broadcasts 
     WHERE station_id = ? AND status != 'cancelled' AND start_time > ? 
     ORDER BY start_time ASC LIMIT 1`,
    [stationId, nowIso]
  );

  // Автоматически помечаем прошедшие передачи как finished
  run(
    "UPDATE radio_scheduled_broadcasts SET status = 'finished' WHERE station_id = ? AND status IN ('planned', 'live') AND end_time <= ?",
    [stationId, nowIso]
  ).catch(() => {});

  if (activeEvent) {
    let eventSlots = [];
    try { eventSlots = JSON.parse(activeEvent.slots_data || '[]'); } catch (_) {}
    if (eventSlots.length > 0) {
      if (activeEvent.status === 'planned') {
        run("UPDATE radio_scheduled_broadcasts SET status = 'live' WHERE id = ?", [activeEvent.id]).catch(() => {});
      }

      const eventStartMs = new Date(activeEvent.start_time).getTime();
      const eventTotalDurSec = Number(activeEvent.duration) || 0;
      const eventTotalDurMs = Math.round(eventTotalDurSec * 1000);

      let eventCurrentSlot = null;
      let eventOffset = 0;
      let eventRemaining = 0;
      let eventMatchedIdx = -1;

      if (activeEvent.is_loop && eventTotalDurMs > 0) {
        const elapsedMs = Math.max(0, nowMs - eventStartMs);
        const cycleMs = elapsedMs % eventTotalDurMs;
        const cycleElapsedSec = cycleMs / 1000;
        let acc = 0;
        for (let i = 0; i < eventSlots.length; i++) {
          const slotDur = Number(eventSlots[i].duration) || 0;
          if (acc + slotDur > cycleElapsedSec || i === eventSlots.length - 1) {
            eventMatchedIdx = i;
            eventOffset = Math.max(0, cycleElapsedSec - acc);
            eventRemaining = Math.max(0, slotDur - eventOffset);
            break;
          }
          acc += slotDur;
        }
      } else {
        for (let i = 0; i < eventSlots.length; i++) {
          const slot = eventSlots[i];
          const sStartMs = new Date(slot.startTime).getTime();
          const sEndMs = new Date(slot.endTime).getTime();
          if (nowMs >= sStartMs && nowMs < sEndMs) {
            eventMatchedIdx = i;
            eventOffset = Math.max(0, (nowMs - sStartMs) / 1000);
            eventRemaining = Math.max(0, (sEndMs - nowMs) / 1000);
            break;
          }
        }
      }

      if (eventMatchedIdx >= 0) {
        const s = eventSlots[eventMatchedIdx];
        eventCurrentSlot = {
          id: s.trackId ? `ev_${activeEvent.id}_${s.slotOrder}_${s.trackId}` : `ev_${activeEvent.id}_${s.slotOrder}`,
          title: s.title,
          type: s.type,
          audioUrl: s.audioUrl,
          duration: s.duration,
          startTime: s.startTime,
          endTime: s.endTime,
          trackId: s.trackId
        };

        const nextSlots = [];
        for (let i = eventMatchedIdx + 1; i < Math.min(eventSlots.length, eventMatchedIdx + 6); i++) {
          const ns = eventSlots[i];
          nextSlots.push({
            id: ns.trackId ? `ev_${activeEvent.id}_${ns.slotOrder}_${ns.trackId}` : `ev_${activeEvent.id}_${ns.slotOrder}`,
            title: ns.title,
            type: ns.type,
            audioUrl: ns.audioUrl,
            duration: ns.duration,
            startTime: ns.startTime,
            endTime: ns.endTime,
            trackId: ns.trackId
          });
        }

        return {
          station,
          serverTime: nowIso,
          broadcastStatus: 'live',
          isLive: true,
          isVirtualLoop: Boolean(activeEvent.is_loop),
          isEternal: false,
          isScheduledEvent: true,
          scheduledEvent: {
            id: activeEvent.id,
            title: activeEvent.title,
            description: activeEvent.description,
            startTime: activeEvent.start_time,
            endTime: activeEvent.end_time,
            coverUrl: activeEvent.cover_url
          },
          nextScheduledEvent: nextEvent ? {
            id: nextEvent.id,
            title: nextEvent.title,
            startTime: nextEvent.start_time,
            endTime: nextEvent.end_time
          } : null,
          fallback: null,
          currentSlot: eventCurrentSlot,
          offset: Math.round(eventOffset * 10) / 10,
          remaining: Math.round(eventRemaining * 10) / 10,
          nextSlots,
          prevSlots: []
        };
      }
    }
  }

  const status = station.broadcast_status || 'live';
  const isStationEternal = Boolean(station.is_eternal === 1 || station.is_eternal === true);
  if (status === 'offline') {
    return {
      station,
      serverTime: nowIso,
      broadcastStatus: 'offline',
      isLive: false,
      isVirtualLoop: false,
      isEternal: isStationEternal,
      isScheduledEvent: false,
      scheduledEvent: null,
      nextScheduledEvent: nextEvent ? {
        id: nextEvent.id,
        title: nextEvent.title,
        startTime: nextEvent.start_time,
        endTime: nextEvent.end_time
      } : null,
      fallback: 'silence',
      currentSlot: null,
      offset: 0,
      remaining: 0,
      nextSlots: [],
      prevSlots: []
    };
  }

  if (status === 'scheduled') {
    const scheduledMs = station.broadcast_started_at ? new Date(station.broadcast_started_at).getTime() : nowMs;
    if (nowMs < scheduledMs) {
      const upcoming = await all(
        'SELECT * FROM radio_timeline_slots WHERE station_id = ? ORDER BY slot_order ASC LIMIT 10',
        [stationId]
      );
      return {
        station,
        serverTime: nowIso,
        broadcastStatus: 'scheduled',
        scheduledStartTime: station.broadcast_started_at,
        isLive: false,
        isVirtualLoop: false,
        isEternal: isStationEternal,
        isScheduledEvent: false,
        scheduledEvent: null,
        nextScheduledEvent: nextEvent ? {
          id: nextEvent.id,
          title: nextEvent.title,
          startTime: nextEvent.start_time,
          endTime: nextEvent.end_time
        } : null,
        fallback: 'silence',
        currentSlot: null,
        offset: 0,
        remaining: 0,
        nextSlots: upcoming.map(s => ({
          id: s.id,
          title: s.title,
          type: s.type,
          audioUrl: s.audio_url,
          duration: s.duration,
          startTime: s.start_time,
          endTime: s.end_time
        })),
        prevSlots: []
      };
    } else {
      await run("UPDATE radio_stations SET broadcast_status = 'live' WHERE id = ?", [stationId]);
      station.broadcast_status = 'live';
    }
  }

  // Все слоты станции в порядке очереди
  const allSlots = await all(
    'SELECT * FROM radio_timeline_slots WHERE station_id = ? ORDER BY slot_order ASC, start_time ASC',
    [stationId]
  );

  let currentSlot = null;
  let offset = 0;
  let remaining = 0;
  let isVirtualLoop = false;
  let loopNextSlots = [];
  let loopPrevSlots = [];
  let currentCycleStartMs = null;
  let currentCycleEndMs = null;

  if (allSlots.length > 0) {
    let scheduleStartIndex = allSlots.length - 1;
    for (let i = allSlots.length - 1; i > 0; i--) {
      const prevEndMs = new Date(allSlots[i - 1].end_time).getTime();
      const currStartMs = new Date(allSlots[i].start_time).getTime();
      if (currStartMs - prevEndMs <= 5000) {
        scheduleStartIndex = i - 1;
      } else {
        break;
      }
    }
    const activeLoopSlots = allSlots.slice(scheduleStartIndex);

    const totalDurationSec = activeLoopSlots.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
    const totalDurationMs = Math.round(totalDurationSec * 1000);
    const scheduleStartMs = new Date(activeLoopSlots[0].start_time).getTime();

    if ((station.fallback_mode === 'loop' || isStationEternal) && totalDurationSec > 0) {
      if (nowMs < scheduleStartMs) {
        if (scheduleStartMs - nowMs <= 4000) {
          // Защита от микро-рассинхрона (если старт через пару секунд)
          currentCycleStartMs = scheduleStartMs;
          currentCycleEndMs = scheduleStartMs + totalDurationMs;
          currentSlot = {
            ...activeLoopSlots[0],
            start_time: activeLoopSlots[0].start_time,
            end_time: activeLoopSlots[0].end_time
          };
          offset = 0;
          remaining = Number(activeLoopSlots[0].duration) || 0;
          isVirtualLoop = false;
        } else {
          // Запланировано на будущее
          currentSlot = null;
        }
      } else {
        // Мы в активном вещании (цикл 0, 1, 2, ...)
        const elapsedSinceStartMs = Math.max(0, nowMs - scheduleStartMs);
        const cycleIndex = Math.floor(elapsedSinceStartMs / totalDurationMs);
        currentCycleStartMs = scheduleStartMs + (cycleIndex * totalDurationMs);
        currentCycleEndMs = currentCycleStartMs + totalDurationMs;
        const cycleElapsedSec = (nowMs - currentCycleStartMs) / 1000;
        isVirtualLoop = cycleIndex > 0;

        let matchedIndex = -1;

        if (finishedSlotId) {
          const finishedIdx = activeLoopSlots.findIndex(s => String(s.id) === String(finishedSlotId));
          if (finishedIdx >= 0) {
            matchedIndex = (finishedIdx + 1) % activeLoopSlots.length;
            const accBefore = activeLoopSlots.slice(0, matchedIndex).reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
            currentCycleStartMs = nowMs - Math.round(accBefore * 1000);
            currentCycleEndMs = currentCycleStartMs + totalDurationMs;
            if (currentCycleStartMs > scheduleStartMs || matchedIndex === 0) {
              isVirtualLoop = true;
            }
            offset = 0;
            remaining = Number(activeLoopSlots[matchedIndex].duration) || 0;
          }
        }

        if (matchedIndex < 0) {
          let accumulator = 0;
          for (let idx = 0; idx < activeLoopSlots.length; idx++) {
            const slot = activeLoopSlots[idx];
            const slotDur = Number(slot.duration) || 0;
            if (accumulator + slotDur > cycleElapsedSec || idx === activeLoopSlots.length - 1) {
              matchedIndex = idx;
              offset = Math.max(0, cycleElapsedSec - accumulator);
              remaining = Math.max(0, slotDur - offset);
              break;
            }
            accumulator += slotDur;
          }
        }

        if (matchedIndex >= 0) {
          const accBeforeMatched = activeLoopSlots.slice(0, matchedIndex).reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
          const slotStartMs = currentCycleStartMs + Math.round(accBeforeMatched * 1000);
          const slotEndMs = slotStartMs + Math.round((Number(activeLoopSlots[matchedIndex].duration) || 0) * 1000);

          currentSlot = {
            ...activeLoopSlots[matchedIndex],
            start_time: new Date(slotStartMs).toISOString(),
            end_time: new Date(slotEndMs).toISOString()
          };

          // Будущие слоты цикла с URL для бесшовного предзагрузки
          let nextCursorMs = slotEndMs;
          const maxNextSlots = Math.min(10, Math.max(1, activeLoopSlots.length - 1));
          for (let i = 1; i <= maxNextSlots; i++) {
            const ns = activeLoopSlots[(matchedIndex + i) % activeLoopSlots.length];
            const nsDur = Number(ns.duration) || 0;
            const nsStartMs = nextCursorMs;
            const nsEndMs = nextCursorMs + Math.round(nsDur * 1000);
            nextCursorMs = nsEndMs;

            loopNextSlots.push({
              id: ns.id,
              title: ns.title,
              type: ns.type,
              audioUrl: ns.audio_url,
              duration: ns.duration,
              startTime: new Date(nsStartMs).toISOString(),
              endTime: new Date(nsEndMs).toISOString(),
              trackId: ns.track_id
            });
          }

          // Прошедшие слоты цикла
          let prevCursorMs = slotStartMs;
          const maxPrevSlots = Math.min(10, Math.max(1, activeLoopSlots.length - 1));
          for (let i = 1; i <= maxPrevSlots; i++) {
            const pIdx = (matchedIndex - i + activeLoopSlots.length * 100) % activeLoopSlots.length;
            const ps = activeLoopSlots[pIdx];
            const psDur = Number(ps.duration) || 0;
            const psEndMs = prevCursorMs;
            const psStartMs = prevCursorMs - Math.round(psDur * 1000);
            prevCursorMs = psStartMs;

            loopPrevSlots.push({
              id: ps.id,
              title: ps.title,
              type: ps.type,
              audioUrl: ps.audio_url,
              duration: ps.duration,
              startTime: new Date(psStartMs).toISOString(),
              endTime: new Date(psEndMs).toISOString(),
              trackId: ps.track_id
            });
          }
        }
      }
    } else {
      // Режим без зацикливания (линейное расписание)
      if (finishedSlotId) {
        const finishedIdx = allSlots.findIndex(s => String(s.id) === String(finishedSlotId));
        if (finishedIdx >= 0 && finishedIdx < allSlots.length - 1) {
          currentSlot = { ...allSlots[finishedIdx + 1] };
          offset = 0;
          remaining = Number(currentSlot.duration) || 0;
        }
      }

      if (!currentSlot) {
        currentSlot = allSlots.find(s => s.start_time <= nowIso && s.end_time > nowIso) || null;
        if (!currentSlot) {
          const nearUpcoming = allSlots.find(s => s.start_time > nowIso);
          if (nearUpcoming && new Date(nearUpcoming.start_time).getTime() - nowMs <= 4000) {
            currentSlot = { ...nearUpcoming };
            offset = 0;
            remaining = Number(nearUpcoming.duration) || 0;
          }
        }
      }

      if (currentSlot) {
        const sStart = new Date(currentSlot.start_time).getTime();
        offset = Math.max(0, (nowMs - sStart) / 1000);
        remaining = Math.max(0, (Number(currentSlot.duration) || 0) - offset);
      }
    }
  }

  if (!currentCycleStartMs && allSlots.length > 0) {
    currentCycleStartMs = new Date(allSlots[0].start_time).getTime();
    currentCycleEndMs = new Date(allSlots[allSlots.length - 1].end_time).getTime();
  }

  // Ближайшие следующие слоты (до 10 шт.)
  let nextSlots = [];
  if ((station.fallback_mode === 'loop' || isVirtualLoop) && loopNextSlots.length > 0) {
    nextSlots = loopNextSlots;
  } else if (allSlots.length > 0) {
    const curIdx = currentSlot ? allSlots.findIndex(s => s.id === currentSlot.id) : -1;
    if (curIdx >= 0) {
      nextSlots = allSlots.slice(curIdx + 1, curIdx + 11).map(s => ({
        id: s.id,
        title: s.title,
        type: s.type,
        audioUrl: null, // Защита: не отдаем аудиофайл будущих треков до их выхода в эфир
        duration: s.duration,
        startTime: s.start_time,
        endTime: s.end_time,
        trackId: s.track_id
      }));
    } else {
      nextSlots = allSlots.filter(s => s.start_time > nowIso).slice(0, 10).map(s => ({
        id: s.id,
        title: s.title,
        type: s.type,
        audioUrl: null, // Защита: не отдаем аудиофайл будущих треков до их выхода в эфир
        duration: s.duration,
        startTime: s.start_time,
        endTime: s.end_time,
        trackId: s.track_id
      }));
    }
  }

  // Прошедшие слоты (до 10 шт.)
  const prevSlots = await all(
    `SELECT * FROM radio_timeline_slots 
     WHERE station_id = ? AND end_time <= ? 
     ORDER BY start_time DESC LIMIT 10`,
    [stationId, nowIso]
  );

  return {
    station,
    serverTime: nowIso,
    broadcastStatus: station.broadcast_status || 'live',
    isLive: Boolean(currentSlot),
    isVirtualLoop,
    isEternal: isStationEternal,
    isScheduledEvent: false,
    scheduledEvent: null,
    nextScheduledEvent: nextEvent ? {
      id: nextEvent.id,
      title: nextEvent.title,
      startTime: nextEvent.start_time,
      endTime: nextEvent.end_time
    } : null,
    fallback: !currentSlot ? station.fallback_mode : null,
    cycleStartTime: currentCycleStartMs ? new Date(currentCycleStartMs).toISOString() : null,
    cycleEndTime: currentCycleEndMs ? new Date(currentCycleEndMs).toISOString() : null,
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
    nextSlots,
    prevSlots: ((station.fallback_mode === 'loop' || isVirtualLoop) && loopPrevSlots.length > 0) ? loopPrevSlots : prevSlots.map(s => ({
      id: s.id,
      title: s.title,
      type: s.type,
      audioUrl: s.audio_url,
      duration: s.duration,
      startTime: s.start_time,
      endTime: s.end_time,
      trackId: s.track_id
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
  const isOwner = requestingUserId != null && String(pl.user_id) === String(requestingUserId);
  if (!pl.is_public && !isOwner && !isAdmin) {
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
  pl.tracks_count = tracks.length;
  const totalDur = tracks.reduce((acc, t) => acc + (parseFloat(t.duration) || 0), 0);
  pl.totalDuration = totalDur;
  pl.total_duration = totalDur;
  return pl;
}

async function listPlaylists({ userId = null, requestingUserId = null, isAdmin = false, isPublic = null, includeMine = false, search = '', page = 1, limit = 30 } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const offset = (p - 1) * l;

  const conditions = [];
  const params = [];

  const isOwner = userId != null && requestingUserId != null && String(userId) === String(requestingUserId);

  if (userId) {
    conditions.push('p.user_id = ?');
    params.push(userId);
    if (!isOwner && !isAdmin) {
      conditions.push('p.is_public = 1');
    }
  } else if (isPublic !== null) {
    if (isPublic && includeMine && requestingUserId != null) {
      conditions.push('(p.is_public = 1 OR p.user_id = ?)');
      params.push(requestingUserId);
    } else {
      conditions.push('p.is_public = ?');
      params.push(isPublic ? 1 : 0);
    }
  } else if (!isAdmin) {
    if (requestingUserId != null) {
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

  const normalizedPlaylists = playlists.map((pl) => ({
    ...pl,
    tracks_count: pl.trackCount,
    total_duration: pl.totalDuration
  }));

  return { playlists: normalizedPlaylists, total, page: p, limit: l, totalPages: Math.ceil(total / l) || 1 };
}

async function updatePlaylist(id, userId, isAdmin, { title, description, isPublic, coverUrl }) {
  const pl = await get('SELECT * FROM radio_playlists WHERE id = ?', [id]);
  if (!pl) return null;
  const isOwner = userId != null && String(pl.user_id) === String(userId);
  if (!isOwner && !isAdmin) {
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
  const isOwner = userId != null && String(pl.user_id) === String(userId);
  if (!isOwner && !isAdmin) {
    throw new Error('Вы не являетесь владельцем этого плейлиста');
  }
  await run('DELETE FROM radio_playlist_tracks WHERE playlist_id = ?', [id]);
  await run('DELETE FROM radio_playlists WHERE id = ?', [id]);
  return true;
}

async function addTrackToPlaylist(playlistId, trackId, userId, isAdmin) {
  const pl = await get('SELECT * FROM radio_playlists WHERE id = ?', [playlistId]);
  if (!pl) throw new Error('Плейлист не найден');
  const isOwner = userId != null && String(pl.user_id) === String(userId);
  if (!isOwner && !isAdmin) {
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
  const isOwner = userId != null && String(pl.user_id) === String(userId);
  if (!isOwner && !isAdmin) {
    throw new Error('У вас нет прав на редактирование этого плейлиста');
  }
  await run('DELETE FROM radio_playlist_tracks WHERE playlist_id = ? AND track_id = ?', [playlistId, trackId]);
  return { removed: true };
}

// ===== Очистка устаревших слотов сетки (хранение до 32 часов) =====

async function cleanupOldTimelineSlots() {
  const result = await run(
    `DELETE FROM radio_timeline_slots 
     WHERE datetime(end_time) < datetime('now', '-32 hours')
       AND station_id NOT IN (SELECT id FROM radio_stations WHERE is_eternal = 1)`
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
  updateTrackDuration,
  deleteTrack,
  ensureTracksConvertedToMp3,
  probeAudioDuration,
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
  startStationBroadcast,
  stopStationBroadcast,
  getStationLiveState,
  getEffectiveNow,
  cleanupOldTimelineSlots,
  createScheduledBroadcast,
  getScheduledBroadcasts,
  getScheduledBroadcastById,
  updateScheduledBroadcast,
  deleteScheduledBroadcast
};
