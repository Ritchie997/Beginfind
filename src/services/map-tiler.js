// map-tiler.js — фоновая нарезка подложек карт на тайлы (sharp).
//
// Сервер слабый, поэтому: одна подложка за раз, libvips в один поток, кэш
// sharp выключен (картинки огромные и одноразовые). Гигантские исходники
// (20000×20000 и больше) обрабатываются libvips потоково, без загрузки
// целиком в память; встроенный предел sharp (~268 млн пикселей) снят,
// вместо него свой MAX_PIXELS.
//
// Раскладка тайлов — "google": {z}/{y}/{x}.webp, изображение прижато к
// левому верхнему углу квадрата 256·2^maxZoom, лишнее — прозрачное. На
// клиенте Leaflet в CRS.Simple с zoomOffset = maxZoom: при зуме 0 один
// пиксель карты = один пиксель исходника (см. public/maps/map-core.js).
//
// Нарезка идёт во временную папку и подменяет готовую только при успехе —
// перенарезка (например, после восстановления из бэкапа) не оставляет карту
// без тайлов на время работы.

const fs = require('fs');
const path = require('path');
const store = require('./maps-store');

const TILE_SIZE = 256;
const MAX_PIXELS = 40000 * 40000;

let sharp = null;
function getSharp() {
  if (!sharp) {
    sharp = require('sharp');
    sharp.concurrency(1);
    sharp.cache(false);
  }
  return sharp;
}

const queue = []; // [{ mapId, basemapId, kind: 'tiles' | 'preview' }]
let running = false;

const PREVIEW_FILE = 'preview.webp';
const PREVIEW_MAX = 640;

function isQueued(mapId, basemapId, kind = 'tiles') {
  return queue.some((j) => j.mapId === mapId && j.basemapId === basemapId && j.kind === kind);
}

function enqueue(mapId, basemapId, kind = 'tiles') {
  if (!isQueued(mapId, basemapId, kind)) queue.push({ mapId, basemapId, kind });
  setImmediate(runNext);
}

// Миниатюра для карточек карт (вкладка сервера «Карты») — вся картинка
// целиком, без прозрачных полей тайлов.
function makePreview(src, destFile) {
  return getSharp()(src, { limitInputPixels: false })
    .rotate()
    .resize({ width: PREVIEW_MAX, height: PREVIEW_MAX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(destFile);
}

function previewPath(mapId, basemapId) {
  return path.join(store.tilesDir(mapId, basemapId), PREVIEW_FILE);
}

// Только миниатюра (для подложек, нарезанных до её появления).
async function processPreviewJob({ mapId, basemapId }) {
  const map = store.getMap(mapId);
  const basemap = map && map.basemaps.find((b) => b.id === basemapId);
  if (!basemap || basemap.status !== 'ready') return;
  const src = store.sourcePath(mapId, basemap);
  if (!fs.existsSync(src) || !fs.existsSync(store.tilesDir(mapId, basemapId))) return;
  try {
    await makePreview(src, previewPath(mapId, basemapId));
  } catch (err) {
    console.error(`[maps] Не удалось сделать миниатюру ${mapId}/${basemapId}:`, err.message);
  }
}

function setBasemap(mapId, basemapId, patch) {
  return store.updateMap(mapId, (map) => {
    const bm = map.basemaps.find((b) => b.id === basemapId);
    if (bm) Object.assign(bm, patch);
    return map;
  }, { touch: false });
}

async function processJob({ mapId, basemapId }) {
  const map = store.getMap(mapId);
  const basemap = map && map.basemaps.find((b) => b.id === basemapId);
  if (!basemap) return; // карту/подложку удалили, пока стояла в очереди

  const src = store.sourcePath(mapId, basemap);
  if (!fs.existsSync(src)) {
    await setBasemap(mapId, basemapId, { status: 'error', error: 'Исходный файл фона не найден' });
    return;
  }

  await setBasemap(mapId, basemapId, { status: 'processing', error: null });
  const finalDir = store.tilesDir(mapId, basemapId);
  const workDir = `${finalDir}.work`;
  const oldDir = `${finalDir}.old`;

  try {
    const s = getSharp();
    const meta = await s(src, { limitInputPixels: false }).metadata();
    const w = meta.autoOrient ? meta.autoOrient.width : meta.width;
    const h = meta.autoOrient ? meta.autoOrient.height : meta.height;
    if (!w || !h) throw new Error('Не удалось прочитать размер изображения');
    if (w * h > MAX_PIXELS) throw new Error(`Изображение слишком большое (${w}×${h}); максимум — ${MAX_PIXELS.toLocaleString('ru-RU')} пикселей`);

    // Все подложки карты — в одной системе координат (размер первой).
    const fresh = store.getMap(mapId);
    if (fresh && fresh.size && (fresh.size.w !== w || fresh.size.h !== h)) {
      throw new Error(`Размер ${w}×${h} не совпадает с размером карты ${fresh.size.w}×${fresh.size.h} — все фоны одной карты должны быть одинакового размера`);
    }

    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(workDir), { recursive: true });

    await s(src, { limitInputPixels: false })
      .rotate() // учесть EXIF-ориентацию (фото с телефона)
      .ensureAlpha() // поля за краем картинки — прозрачные, а не белые
      .webp({ quality: 82, effort: 3 })
      .tile({ size: TILE_SIZE, layout: 'google', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toFile(workDir);
    await makePreview(src, path.join(workDir, PREVIEW_FILE));

    fs.rmSync(oldDir, { recursive: true, force: true });
    if (fs.existsSync(finalDir)) fs.renameSync(finalDir, oldDir);
    fs.renameSync(workDir, finalDir);
    fs.rmSync(oldDir, { recursive: true, force: true });

    const maxZoom = Math.max(0, Math.ceil(Math.log2(Math.max(w, h) / TILE_SIZE)));
    await store.updateMap(mapId, (m) => {
      const bm = m.basemaps.find((b) => b.id === basemapId);
      if (bm) Object.assign(bm, { status: 'ready', error: null, width: w, height: h, maxZoom, tilesVersion: (bm.tilesVersion || 0) + 1 });
      if (!m.size) m.size = { w, h };
      return m;
    }, { touch: false });
    console.log(`[maps] Подложка ${mapId}/${basemapId} нарезана: ${w}×${h}, уровней ${maxZoom + 1}`);
  } catch (err) {
    fs.rmSync(workDir, { recursive: true, force: true });
    console.error(`[maps] Ошибка нарезки ${mapId}/${basemapId}:`, err.message);
    await setBasemap(mapId, basemapId, { status: 'error', error: err.message }).catch(() => {});
  }
}

async function runNext() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  try {
    if (job.kind === 'preview') await processPreviewJob(job);
    else await processJob(job);
  } finally {
    running = false;
    setImmediate(runNext);
  }
}

// Номер в очереди (1 — обрабатывается сейчас или следующая) — для статуса в UI.
function queuePosition(mapId, basemapId) {
  const i = queue.findIndex((j) => j.mapId === mapId && j.basemapId === basemapId && j.kind !== 'preview');
  return i === -1 ? null : i + 1;
}

// При старте и после восстановления из бэкапа: всё, что не дорезалось
// (сервер перезапустили посреди работы), и готовые подложки без тайлов
// (в бэкап тайлы не кладутся — только исходники) — снова в очередь.
function rescan() {
  let count = 0;
  for (const map of store.listMaps()) {
    for (const bm of map.basemaps) {
      const src = store.sourcePath(map.id, bm);
      if (!bm.ext || !fs.existsSync(src)) continue;
      const tilesMissing = !fs.existsSync(path.join(store.tilesDir(map.id, bm.id), '0'));
      if (bm.status === 'queued' || bm.status === 'processing' || (bm.status === 'ready' && tilesMissing)) {
        enqueue(map.id, bm.id);
        count++;
      } else if (bm.status === 'ready' && !fs.existsSync(previewPath(map.id, bm.id))) {
        enqueue(map.id, bm.id, 'preview');
      }
    }
  }
  if (count) console.log(`[maps] В очередь нарезки поставлено подложек: ${count}`);
  return count;
}

function hasPreview(mapId, basemapId) {
  return fs.existsSync(previewPath(mapId, basemapId));
}

module.exports = { enqueue, rescan, queuePosition, hasPreview, TILE_SIZE, PREVIEW_FILE };
