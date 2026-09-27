// maps-store.js — интерактивные карты: content/maps/<id>.json.
//
// Карта — отдельная сущность (не блок статьи): её показывают блоки `map` в
// любом числе статей и полноэкранная страница /map/:id.
//
// Система координат — пиксели исходного изображения подложки: x вправо, y
// вниз, size = {w, h} первой загруженной подложки. Все подложки карты обязаны
// иметь этот же размер (иначе зоны съедут), см. map-tiler.js.
//
// Форма зоны — MultiPolygon в формате библиотеки polygon-clipping:
//   [ polygon, ... ], polygon = [ ring, ... ] (первое кольцо — внешний
//   контур, остальные — дыры), ring = [ [x, y], ... ].
// Храним списком версий shapes: [{ from, polygon }] — задел под таймлайн
// (этап 3); пока версия одна и from = null.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MAPS_DIR, MAP_SOURCES_DIR, MAP_TILES_DIR } = require('../config/paths');
const { normalizeLayerRoles } = require('./article-layers');

const MAX_ZONES = 5000;
const MAX_SHAPE_VERSIONS = 100;
const MAX_EVENTS = 2000;
const TIME_LIMIT = 1e9;
const MAX_MARKERS = 5000;
const HOVER_EFFECTS = ['outline', 'fill', 'glow', 'pulse'];
const MAX_POINTS_TOTAL = 400000; // защита от случайно гигантских контуров (лассо без упрощения)
const MAX_BASEMAPS = 20;
const LOCKED_MODES = ['lock', 'hide'];
const BASEMAP_STATUSES = ['uploading', 'queued', 'processing', 'ready', 'error'];

function genId(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function str(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function validId(v) {
  return typeof v === 'string' && /^[a-z0-9_-]{1,40}$/i.test(v);
}

// ===== Время (этап 3) =====
// Время — одно целое число, «абсолютный год» мира (см. календарь в
// worlds-store.js). null — без границы: «с начала времён» / «навсегда».
// Интервал существования — [from, to): в году to объекта уже нет.

function timeOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(-TIME_LIMIT, Math.min(TIME_LIMIT, Math.round(n)));
}

function normalizeInterval(raw) {
  const from = timeOrNull(raw && raw.from);
  let to = timeOrNull(raw && raw.to);
  if (from !== null && to !== null && to <= from) to = null;
  return { from, to };
}

// Настройки шкалы карты: начальная и конечная дата (шкала идёт ровно между
// ними; null — диапазон по данным карты), момент при открытии и фон по
// периодам — [{ from, to, basemapId }]: в этот период показывается этот фон.
function normalizeTimeline(raw, basemapIds) {
  const t = isPlainObject(raw) ? raw : {};
  const start = timeOrNull(t.start);
  let end = timeOrNull(t.end);
  if (start !== null && end !== null && end <= start) end = null;
  const periods = (Array.isArray(t.periods) ? t.periods : []).slice(0, 100).map((p) => {
    if (!isPlainObject(p) || !validId(p.basemapId) || (basemapIds && !basemapIds.has(p.basemapId))) return null;
    return { id: validId(p.id) ? p.id : genId('p'), basemapId: p.basemapId, ...normalizeInterval(p) };
  }).filter(Boolean);
  return { initial: timeOrNull(t.initial), start, end, periods };
}

// ===== Геометрия =====

function round1(n) {
  return Math.round(n * 10) / 10;
}

function normalizeRing(raw, budget) {
  if (!Array.isArray(raw)) return null;
  const ring = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]); const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const pt = [round1(x), round1(y)];
    const prev = ring[ring.length - 1];
    if (prev && prev[0] === pt[0] && prev[1] === pt[1]) continue; // дубль подряд
    ring.push(pt);
  }
  // Замыкающую точку (как в GeoJSON) не храним — Leaflet замыкает сам.
  if (ring.length > 1) {
    const a = ring[0]; const b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) ring.pop();
  }
  if (ring.length < 3) return null;
  budget.left -= ring.length;
  if (budget.strict && budget.left < 0) throw new Error(`Слишком много точек в контурах карты (больше ${MAX_POINTS_TOTAL}) — упростите границы`);
  return ring;
}

function normalizeMultiPolygon(raw, budget) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const poly of raw) {
    if (!Array.isArray(poly)) continue;
    const rings = [];
    for (const r of poly) {
      const ring = normalizeRing(r, budget);
      if (ring) rings.push(ring);
      else if (!rings.length) break; // нет внешнего контура — весь многоугольник пропускаем
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

// ===== Зоны =====

// Свой стиль отдельной зоны поверх стиля её типа: только заданные поля,
// остальное берётся из типа. null — зона целиком в стиле типа.
function normalizeStyle(raw) {
  if (!isPlainObject(raw)) return null;
  const out = {};
  if (typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color)) out.color = raw.color.toLowerCase();
  const fo = Number(raw.fillOpacity);
  if (raw.fillOpacity != null && Number.isFinite(fo)) out.fillOpacity = Math.min(1, Math.max(0, fo));
  const w = Number(raw.weight);
  if (raw.weight != null && Number.isFinite(w)) out.weight = Math.min(10, Math.max(0, w));
  if (typeof raw.dashed === 'boolean') out.dashed = raw.dashed;
  if (HOVER_EFFECTS.includes(raw.hoverEffect)) out.hoverEffect = raw.hoverEffect;
  return Object.keys(out).length ? out : null;
}

function normalizeZone(raw, budget) {
  if (!isPlainObject(raw)) return null;
  // Версии границы: [{ from, polygon }] по возрастанию from; первая — с
  // начала времён (from = null). Одинаковые from — остаётся последняя.
  const byFrom = new Map();
  (Array.isArray(raw.shapes) ? raw.shapes : []).slice(0, MAX_SHAPE_VERSIONS).forEach((s) => {
    if (!isPlainObject(s)) return;
    const polygon = normalizeMultiPolygon(s.polygon, budget);
    if (polygon.length) byFrom.set(timeOrNull(s.from), polygon);
  });
  const shapes = [...byFrom.entries()]
    .sort((a, b) => (a[0] === null ? -Infinity : a[0]) - (b[0] === null ? -Infinity : b[0]))
    .map(([from, polygon]) => ({ from, polygon }));
  if (!shapes.length) return null;
  shapes[0].from = null;
  const interval = normalizeInterval(raw);
  return {
    id: validId(raw.id) ? raw.id : genId('z'),
    parentId: validId(raw.parentId) ? raw.parentId : null,
    typeId: validId(raw.typeId) ? raw.typeId : null,
    title: str(raw.title, 120),
    article: str(raw.article, 120) || null,
    roles: normalizeLayerRoles(raw.roles),
    lockedMode: LOCKED_MODES.includes(raw.lockedMode) ? raw.lockedMode : 'lock',
    style: normalizeStyle(raw.style),
    from: interval.from,
    to: interval.to,
    shapes
  };
}

// ===== Метки =====
// Точка на карте с названием и описанием; по желанию ведёт в статью.
// zoneId — зона, в которой стоит метка (редактор проставляет сам): метка
// скрытой от читателя зоны скрывается вместе с ней.

function normalizeMarker(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.pos)) return null;
  const x = Number(raw.pos[0]); const y = Number(raw.pos[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    id: validId(raw.id) ? raw.id : genId('k'),
    typeId: validId(raw.typeId) ? raw.typeId : null,
    zoneId: validId(raw.zoneId) ? raw.zoneId : null,
    title: str(raw.title, 120),
    text: typeof raw.text === 'string' ? raw.text.slice(0, 2000) : '',
    article: str(raw.article, 120) || null,
    roles: normalizeLayerRoles(raw.roles),
    lockedMode: LOCKED_MODES.includes(raw.lockedMode) ? raw.lockedMode : 'lock',
    ...normalizeInterval(raw),
    pos: [round1(x), round1(y)]
  };
}

// ===== События таймлайна =====
// Моментальное (to = null) или длительное [from, to). Связано с зонами и
// метками (подсвечиваются при выборе события) и, по желанию, со статьёй.

function normalizeEvent(raw, zoneIds, markerIds) {
  if (!isPlainObject(raw)) return null;
  const from = timeOrNull(raw.from);
  if (from === null) return null;
  let to = timeOrNull(raw.to);
  if (to !== null && to <= from) to = null;
  const ids = (list, allowed) => [...new Set((Array.isArray(list) ? list : []).filter((id) => allowed.has(id)))];
  return {
    id: validId(raw.id) ? raw.id : genId('e'),
    from,
    to,
    title: str(raw.title, 120) || 'Событие',
    text: typeof raw.text === 'string' ? raw.text.slice(0, 4000) : '',
    article: str(raw.article, 120) || null,
    zoneIds: ids(raw.zoneIds, zoneIds),
    markerIds: ids(raw.markerIds, markerIds)
  };
}

function normalizeEvents(raw, zones, markers) {
  const zoneIds = new Set(zones.map((z) => z.id));
  const markerIds = new Set(markers.map((m) => m.id));
  const seen = new Set();
  return (Array.isArray(raw) ? raw : [])
    .slice(0, MAX_EVENTS)
    .map((e) => normalizeEvent(e, zoneIds, markerIds))
    .filter((e) => e && !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => a.from - b.from);
}

function normalizeMarkers(raw, zones) {
  const zoneIds = new Set((zones || []).map((z) => z.id));
  const seen = new Set();
  return (Array.isArray(raw) ? raw : [])
    .slice(0, MAX_MARKERS)
    .map(normalizeMarker)
    .filter((m) => m && !seen.has(m.id) && seen.add(m.id))
    .map((m) => (m.zoneId && !zoneIds.has(m.zoneId) ? { ...m, zoneId: null } : m));
}

// strict — проверять лимит точек (при сохранении из редактора). При чтении
// уже сохранённой карты не проверяем: иначе карта, записанная до снижения
// лимита, просто перестала бы открываться.
function normalizeZones(raw, { strict = false } = {}) {
  const budget = { left: MAX_POINTS_TOTAL, strict };
  const zones = (Array.isArray(raw) ? raw : []).slice(0, MAX_ZONES).map((z) => normalizeZone(z, budget)).filter(Boolean);

  // Уникальные id; родитель — только существующая зона; без циклов.
  const seen = new Set();
  const unique = zones.filter((z) => (seen.has(z.id) ? false : (seen.add(z.id), true)));
  const byId = new Map(unique.map((z) => [z.id, z]));
  unique.forEach((z) => { if (z.parentId && (!byId.has(z.parentId) || z.parentId === z.id)) z.parentId = null; });
  unique.forEach((z) => {
    const visited = new Set([z.id]);
    let p = z.parentId;
    while (p) {
      if (visited.has(p)) { z.parentId = null; break; }
      visited.add(p);
      p = byId.get(p)?.parentId || null;
    }
  });
  return unique;
}

// ===== Подложки =====

function normalizeBasemap(raw) {
  if (!isPlainObject(raw) || !validId(raw.id)) return null;
  return {
    id: raw.id,
    title: str(raw.title, 80) || 'Фон',
    status: BASEMAP_STATUSES.includes(raw.status) ? raw.status : 'error',
    error: raw.status === 'error' ? str(raw.error, 300) || 'Ошибка обработки' : null,
    ext: /^\.[a-z0-9]{2,5}$/.test(raw.ext || '') ? raw.ext : null,
    declaredSize: Number.isFinite(Number(raw.declaredSize)) ? Number(raw.declaredSize) : null,
    width: Number.isInteger(raw.width) ? raw.width : null,
    height: Number.isInteger(raw.height) ? raw.height : null,
    maxZoom: Number.isInteger(raw.maxZoom) ? raw.maxZoom : null,
    tilesVersion: Number.isInteger(raw.tilesVersion) ? raw.tilesVersion : 0,
    // Подложка по времени: показывается сама, когда таймлайн в её интервале.
    ...normalizeInterval(raw),
    created_at: str(raw.created_at, 40) || new Date().toISOString()
  };
}

// ===== Карта целиком =====

function normalizeMap(raw) {
  const data = isPlainObject(raw) ? raw : {};
  const size = isPlainObject(data.size) && Number.isInteger(data.size.w) && Number.isInteger(data.size.h) && data.size.w > 0 && data.size.h > 0
    ? { w: data.size.w, h: data.size.h }
    : null;
  const map = {
    id: data.id,
    title: str(data.title, 120) || 'Без названия',
    serverId: parseInt(data.serverId, 10) || null,
    author_id: parseInt(data.author_id, 10) || null,
    co_author_ids: Array.isArray(data.co_author_ids) ? data.co_author_ids.map((n) => parseInt(n, 10)).filter((n) => n > 0) : [],
    roles: normalizeLayerRoles(data.roles),
    size,
    basemaps: (Array.isArray(data.basemaps) ? data.basemaps : []).map(normalizeBasemap).filter(Boolean).slice(0, MAX_BASEMAPS),
    zones: normalizeZones(data.zones),
    markers: null, // ниже — после зон (проверка zoneId)
    events: null, // ниже — после зон и меток (проверка связей)
    // Начальный момент таймлайна при открытии карты (null — самый ранний).
    timeline: null, // ниже — после фонов (проверка basemapId)
    created_at: str(data.created_at, 40) || new Date().toISOString(),
    updated_at: str(data.updated_at, 40) || new Date().toISOString()
  };
  map.markers = normalizeMarkers(data.markers, map.zones);
  map.events = normalizeEvents(data.events, map.zones, map.markers);
  map.timeline = normalizeTimeline(data.timeline, new Set(map.basemaps.map((b) => b.id)));
  return map;
}

function mapFile(id) {
  if (!validId(id)) throw new Error('Некорректный id карты');
  return path.join(MAPS_DIR, `${id}.json`);
}

function getMap(id) {
  if (!validId(id)) return null;
  const file = mapFile(id);
  if (!fs.existsSync(file)) return null;
  try {
    return normalizeMap({ ...JSON.parse(fs.readFileSync(file, 'utf8')), id });
  } catch (e) {
    console.error(`[maps] Не удалось прочитать ${file}:`, e.message);
    return null;
  }
}

function listMaps() {
  if (!fs.existsSync(MAPS_DIR)) return [];
  return fs.readdirSync(MAPS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => getMap(f.slice(0, -5)))
    .filter(Boolean);
}

// Запись через временный файл — чтобы обрыв посреди записи не оставил
// полкарты (файл может быть большим из-за контуров).
function writeMap(map, { touch = true } = {}) {
  const normalized = normalizeMap(map);
  if (touch) normalized.updated_at = new Date().toISOString();
  fs.mkdirSync(MAPS_DIR, { recursive: true });
  const file = mapFile(normalized.id);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(normalized), 'utf8');
  fs.renameSync(tmp, file);
  return normalized;
}

function createMap({ title, serverId, authorId }) {
  return writeMap({ id: genId('m'), title, serverId, author_id: authorId, basemaps: [], zones: [] });
}

// Изменение одной карты "прочитал — поменял — записал" без гонок между
// параллельными запросами (обработчик тайлов и сохранение из редактора
// могут писать почти одновременно).
const locks = new Map();
function updateMap(id, mutate, opts) {
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.then(() => {
    const map = getMap(id);
    if (!map) throw new Error('Карта не найдена');
    const result = mutate(map);
    return writeMap(result || map, opts);
  });
  locks.set(id, run.catch(() => {}));
  return run;
}

function deleteMap(id) {
  const file = mapFile(id);
  try { fs.unlinkSync(file); } catch (e) { /* уже нет */ }
  fs.rmSync(path.join(MAP_SOURCES_DIR, id), { recursive: true, force: true });
  fs.rmSync(path.join(MAP_TILES_DIR, id), { recursive: true, force: true });
}

// ===== Файлы подложек =====

function sourceDir(mapId) {
  return path.join(MAP_SOURCES_DIR, mapId);
}
function sourcePath(mapId, basemap) {
  return path.join(sourceDir(mapId), `${basemap.id}${basemap.ext || ''}`);
}
function partPath(mapId, basemapId) {
  return path.join(sourceDir(mapId), `${basemapId}.part`);
}
function tilesDir(mapId, basemapId) {
  return path.join(MAP_TILES_DIR, mapId, basemapId);
}
function tilesUrl(mapId, basemap) {
  // ?v= — тайлы перенарезанной подложки лежат по тем же путям, кэш браузера
  // иначе показывал бы старые.
  return `/uploads/maps/${mapId}/${basemap.id}/{z}/{y}/{x}.webp?v=${basemap.tilesVersion || 0}`;
}

function removeBasemapFiles(mapId, basemap) {
  for (const p of [sourcePath(mapId, basemap), partPath(mapId, basemap.id)]) {
    try { fs.unlinkSync(p); } catch (e) { /* нет файла */ }
  }
  fs.rmSync(tilesDir(mapId, basemap.id), { recursive: true, force: true });
}

module.exports = {
  MAX_ZONES,
  genId,
  validId,
  normalizeMap,
  normalizeZones,
  normalizeMarkers,
  timeOrNull,
  getMap,
  listMaps,
  createMap,
  updateMap,
  writeMap,
  deleteMap,
  sourceDir,
  sourcePath,
  partPath,
  tilesDir,
  tilesUrl,
  removeBasemapFiles
};
