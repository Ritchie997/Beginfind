// worlds-store.js — настройки «мира» для интерактивных карт. Мир = сервер
// (у статей уже есть привязка к серверу, роли доступа — роли сервера), поэтому
// отдельной сущности нет: файл content/worlds/<serverId>.json.
//
// Здесь справочники типов зон и меток и календарь мира (calendar.months —
// свои месяцы, см. public/maps/map-calendar.js).
//
// Тип зоны задаёт правила вложенности (какие типы могут быть родителем,
// можно ли быть на верхнем уровне), стиль по умолчанию и то, обрезается ли
// зона этого типа по границе родителя. Глубина иерархии не ограничена —
// её определяет сам набор типов.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WORLDS_DIR } = require('../config/paths');
const MapCalendar = require('../../public/maps/map-calendar');

const MAX_TYPES = 50;
const HOVER_EFFECTS = ['outline', 'fill', 'glow', 'pulse'];

// Иконки меток — только из этого списка (Font Awesome 6 Free, solid):
// произвольная строка в классе иконки открывала бы дорогу мусору в разметке.
const MARKER_ICONS = [
  'location-dot', 'star', 'crown', 'chess-rook', 'shield-halved', 'place-of-worship', 'landmark',
  'city', 'house', 'campground', 'dungeon', 'tree', 'mountain', 'water', 'anchor', 'ship',
  'skull', 'bolt', 'fire', 'gem', 'book', 'flag', 'horse', 'circle-info'
];

// «Видно с приближения»: 0 — всегда, 1 — с приближения ×2 от вида всей
// карты, 2 — ×4 и т.д. Считается от вида всей карты, поэтому одинаково
// работает на картах любого размера.
function minZoomRel(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? Math.min(8, Math.max(0, n)) : 0;
}

function genId() {
  return 't' + crypto.randomBytes(5).toString('hex');
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function str(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function hexColor(v, fallback) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback;
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Шаблон по умолчанию — «Страна → Регион → Город → Район». Отдаётся, пока
// админ мира ничего не сохранил; id фиксированные, чтобы карты, нарисованные
// до первого сохранения настроек мира, не теряли свои типы.
function defaultZoneTypes() {
  return [
    { id: 'country', name: 'Страна', topLevel: true, parents: [], color: '#5865f2', fillOpacity: 0.12, weight: 3, dashed: false, hoverEffect: 'fill', clipToParent: false, minZoomRel: 0 },
    { id: 'region', name: 'Регион', topLevel: true, parents: ['country'], color: '#3ba55d', fillOpacity: 0.1, weight: 2, dashed: true, hoverEffect: 'fill', clipToParent: true, minZoomRel: 1 },
    { id: 'city', name: 'Город', topLevel: true, parents: ['region', 'country'], color: '#faa81a', fillOpacity: 0.25, weight: 2, dashed: false, hoverEffect: 'glow', clipToParent: true, minZoomRel: 2 },
    { id: 'district', name: 'Район', topLevel: false, parents: ['city'], color: '#eb459e', fillOpacity: 0.2, weight: 1, dashed: false, hoverEffect: 'outline', clipToParent: true, minZoomRel: 3 }
  ];
}

function defaultMarkerTypes() {
  return [
    { id: 'city', name: 'Город', icon: 'city', color: '#5865f2', minZoomRel: 0 },
    { id: 'capital', name: 'Столица', icon: 'crown', color: '#faa81a', minZoomRel: 0, noCluster: true },
    { id: 'note', name: 'Пояснение', icon: 'circle-info', color: '#3ba55d', minZoomRel: 1 }
  ];
}

function normalizeMarkerType(raw) {
  if (!isPlainObject(raw)) return null;
  const name = str(raw.name, 60);
  if (!name) return null;
  return {
    id: /^[a-z0-9_-]{1,40}$/i.test(raw.id || '') ? raw.id : genId(),
    name,
    icon: MARKER_ICONS.includes(raw.icon) ? raw.icon : 'location-dot',
    color: hexColor(raw.color, '#5865f2'),
    minZoomRel: minZoomRel(raw.minZoomRel),
    // Важные (столицы и т.п.) не прячутся в группу меток на отдалении.
    noCluster: !!raw.noCluster
  };
}

function normalizeZoneType(raw) {
  if (!isPlainObject(raw)) return null;
  const name = str(raw.name, 60);
  if (!name) return null;
  return {
    id: /^[a-z0-9_-]{1,40}$/i.test(raw.id || '') ? raw.id : genId(),
    name,
    topLevel: raw.topLevel !== false,
    parents: Array.isArray(raw.parents) ? raw.parents.filter((p) => typeof p === 'string').slice(0, MAX_TYPES) : [],
    color: hexColor(raw.color, '#5865f2'),
    fillOpacity: clampNum(raw.fillOpacity, 0, 1, 0.15),
    weight: clampNum(raw.weight, 0, 10, 2),
    dashed: !!raw.dashed,
    hoverEffect: HOVER_EFFECTS.includes(raw.hoverEffect) ? raw.hoverEffect : 'fill',
    clipToParent: raw.clipToParent !== false,
    minZoomRel: minZoomRel(raw.minZoomRel)
  };
}

// ===== Календарь мира =====
// Время карт — целое число дней. months — свои месяцы мира [{ name, days }]
// (null — обычный григорианский календарь), см. public/maps/map-calendar.js.
// eras/format — эпохи из первой версии этапа 3: в интерфейсе не
// используются, но хранятся как были.

function defaultCalendar() {
  return {
    eras: [
      { id: 'before', name: 'До Основания', short: 'до О.', start: null, direction: 'backward' },
      { id: 'founding', name: 'Эпоха Основания', short: 'Э.О.', start: 0, direction: 'forward' }
    ],
    format: '{year} {short}'
  };
}

function normalizeMonths(raw) {
  if (!Array.isArray(raw)) return null;
  const months = raw.slice(0, MapCalendar.MAX_MONTHS).map((m) => {
    if (!isPlainObject(m)) return null;
    const name = str(m.name, 40);
    const days = Math.round(Number(m.days));
    if (!name || !Number.isFinite(days)) return null;
    return { name, days: Math.min(MapCalendar.MAX_MONTH_DAYS, Math.max(1, days)) };
  }).filter(Boolean);
  return months.length ? months : null;
}

function normalizeCalendar(raw) {
  return { ...normalizeEras(raw), months: normalizeMonths(isPlainObject(raw) ? raw.months : null) };
}

function normalizeEras(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.eras)) return defaultCalendar();
  const seen = new Set();
  let eras = raw.eras.slice(0, 50).map((e) => {
    if (!isPlainObject(e)) return null;
    const name = str(e.name, 60);
    if (!name) return null;
    const start = e.start === null || e.start === '' || e.start === undefined ? null : Math.round(Number(e.start));
    return {
      id: /^[a-z0-9_-]{1,40}$/i.test(e.id || '') ? e.id : genId(),
      name,
      short: str(e.short, 20),
      start: Number.isFinite(start) ? Math.max(-1e9, Math.min(1e9, start)) : null,
      direction: e.direction === 'backward' ? 'backward' : 'forward'
    };
  }).filter((e) => e && !seen.has(e.id) && seen.add(e.id));
  // Только одна эра может идти «с начала времён» (start = null) — первая.
  eras.sort((a, b) => (a.start === null ? -Infinity : a.start) - (b.start === null ? -Infinity : b.start));
  eras = eras.filter((e, i) => e.start !== null || i === 0);
  if (!eras.length) return defaultCalendar();
  return { eras, format: str(raw.format, 60) || '{year} {short}' };
}

function normalizeWorld(raw) {
  const data = isPlainObject(raw) ? raw : {};
  let zoneTypes = Array.isArray(data.zoneTypes)
    ? data.zoneTypes.map(normalizeZoneType).filter(Boolean).slice(0, MAX_TYPES)
    : defaultZoneTypes();

  // id уникальны; ссылки parents — только на существующие типы.
  const seen = new Set();
  zoneTypes = zoneTypes.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  zoneTypes.forEach((t) => { t.parents = t.parents.filter((p) => seen.has(p) && p !== t.id); });
  if (!zoneTypes.length) zoneTypes = defaultZoneTypes();

  // Мир, сохранённый до появления меток, получает типы меток по умолчанию.
  let markerTypes = Array.isArray(data.markerTypes)
    ? data.markerTypes.map(normalizeMarkerType).filter(Boolean).slice(0, MAX_TYPES)
    : defaultMarkerTypes();
  const seenMarker = new Set();
  markerTypes = markerTypes.filter((t) => (seenMarker.has(t.id) ? false : (seenMarker.add(t.id), true)));
  if (!markerTypes.length) markerTypes = defaultMarkerTypes();

  return {
    zoneTypes,
    markerTypes,
    calendar: normalizeCalendar(data.calendar)
  };
}

function worldFile(serverId) {
  const id = parseInt(serverId, 10);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Некорректный id сервера');
  return path.join(WORLDS_DIR, `${id}.json`);
}

function getWorld(serverId) {
  const file = worldFile(serverId);
  if (!fs.existsSync(file)) return { ...normalizeWorld(null), isDefault: true };
  try {
    return { ...normalizeWorld(JSON.parse(fs.readFileSync(file, 'utf8'))), isDefault: false };
  } catch (e) {
    console.error(`[worlds] Не удалось прочитать ${file}:`, e.message);
    return { ...normalizeWorld(null), isDefault: true };
  }
}

// Типы зон и меток. Календарь здесь не меняется (даже если пришёл): его
// смена пересчитывает даты всех карт мира — только через setCalendar.
function saveWorld(serverId, raw) {
  const file = worldFile(serverId);
  const world = normalizeWorld({ ...(isPlainObject(raw) ? raw : {}), calendar: getWorld(serverId).calendar });
  fs.mkdirSync(WORLDS_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...world, updated_at: new Date().toISOString() }, null, 2), 'utf8');
  return { ...world, isDefault: false };
}

// Новый календарь мира; возвращает { world, before } — календарь до смены
// (для пересчёта дат карт).
function setCalendar(serverId, rawCalendar) {
  const current = getWorld(serverId);
  const before = current.calendar;
  const file = worldFile(serverId);
  const { isDefault, ...data } = current;
  const world = normalizeWorld({ ...data, calendar: { ...before, months: isPlainObject(rawCalendar) ? rawCalendar.months : null } });
  fs.mkdirSync(WORLDS_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...world, updated_at: new Date().toISOString() }, null, 2), 'utf8');
  return { world: { ...world, isDefault: false }, before };
}

function deleteWorld(serverId) {
  try { fs.unlinkSync(worldFile(serverId)); } catch (e) { /* нет файла — нечего удалять */ }
}

module.exports = { getWorld, saveWorld, setCalendar, deleteWorld, defaultZoneTypes, defaultMarkerTypes, defaultCalendar, HOVER_EFFECTS, MARKER_ICONS };
