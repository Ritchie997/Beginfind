// worlds-store.js — настройки «мира» для интерактивных карт. Мир = сервер
// (у статей уже есть привязка к серверу, роли доступа — роли сервера), поэтому
// отдельной сущности нет: файл content/worlds/<serverId>.json.
//
// Сейчас (этап 1) здесь только справочник типов зон; календарь появится на
// этапе 3 (поле calendar зарезервировано и просто сохраняется как есть).
//
// Тип зоны задаёт правила вложенности (какие типы могут быть родителем,
// можно ли быть на верхнем уровне), стиль по умолчанию и то, обрезается ли
// зона этого типа по границе родителя. Глубина иерархии не ограничена —
// её определяет сам набор типов.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WORLDS_DIR } = require('../config/paths');

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
    { id: 'capital', name: 'Столица', icon: 'crown', color: '#faa81a', minZoomRel: 0 },
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
    minZoomRel: minZoomRel(raw.minZoomRel)
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
// Время карт — целое число «абсолютный год». Календарь превращает его в
// подпись: эпохи (с какого абсолютного года начинается, направление счёта)
// и шаблон подписи. Эра с прямым счётом: год = t − start + 1; с обратным
// (как «до н. э.»): год = начало следующей эры − t.

function defaultCalendar() {
  return {
    eras: [
      { id: 'before', name: 'До Основания', short: 'до О.', start: null, direction: 'backward' },
      { id: 'founding', name: 'Эпоха Основания', short: 'Э.О.', start: 0, direction: 'forward' }
    ],
    format: '{year} {short}'
  };
}

function normalizeCalendar(raw) {
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

function saveWorld(serverId, raw) {
  const file = worldFile(serverId);
  const world = normalizeWorld(raw);
  fs.mkdirSync(WORLDS_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...world, updated_at: new Date().toISOString() }, null, 2), 'utf8');
  return { ...world, isDefault: false };
}

function deleteWorld(serverId) {
  try { fs.unlinkSync(worldFile(serverId)); } catch (e) { /* нет файла — нечего удалять */ }
}

module.exports = { getWorld, saveWorld, deleteWorld, defaultZoneTypes, defaultMarkerTypes, defaultCalendar, HOVER_EFFECTS, MARKER_ICONS };
