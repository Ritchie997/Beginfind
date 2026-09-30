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
// Тайлы — WebP без потерь: карта не пережимается, мелкие подписи и линии
// остаются как в исходнике (ценой размера тайлов и времени нарезки).
//
// Нарезка идёт во временную папку и подменяет готовую только при успехе —
// перенарезка (например, после восстановления из бэкапа) не оставляет карту
// без тайлов на время работы.
//
// Замена картинки фона (kind 'replace'): новый файл того же разрешения
// нарезается так же во временную папку и подменяет старый фон только при
// успехе. Координаты зон и меток — пиксели исходника, поэтому при том же
// размере они остаются на своих местах.

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

const queue = []; // [{ mapId, basemapId, kind: 'tiles' | 'preview' | 'replace' }]
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

// Размер картинки с учётом EXIF-поворота и проверкой предела.
async function readSize(src) {
  const meta = await getSharp()(src, { limitInputPixels: false }).metadata();
  const w = meta.autoOrient ? meta.autoOrient.width : meta.width;
  const h = meta.autoOrient ? meta.autoOrient.height : meta.height;
  if (!w || !h) throw new Error('Не удалось прочитать размер изображения');
  if (w * h > MAX_PIXELS) throw new Error(`Изображение слишком большое (${w}×${h}); максимум — ${MAX_PIXELS.toLocaleString('ru-RU')} пикселей`);
  return { w, h };
}

// Картинка → тайлы и миниатюра в workDir.
async function tileInto(src, workDir) {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(workDir), { recursive: true });
  await getSharp()(src, { limitInputPixels: false })
    .rotate() // учесть EXIF-ориентацию (фото с телефона)
    .ensureAlpha() // поля за краем картинки — прозрачные, а не белые
    .webp({ lossless: true, effort: 2 }) // без сжатия с потерями
    .tile({ size: TILE_SIZE, layout: 'google', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toFile(workDir);
  await makePreview(src, path.join(workDir, PREVIEW_FILE));
}

// Готовая папка тайлов ← workDir (старая удаляется только после подмены).
function swapTiles(workDir, finalDir) {
  const oldDir = `${finalDir}.old`;
  fs.rmSync(oldDir, { recursive: true, force: true });
  if (fs.existsSync(finalDir)) fs.renameSync(finalDir, oldDir);
  fs.renameSync(workDir, finalDir);
  fs.rmSync(oldDir, { recursive: true, force: true });
}

function maxZoomFor(w, h) {
  return Math.max(0, Math.ceil(Math.log2(Math.max(w, h) / TILE_SIZE)));
}

// Фон другого размера → картинка размера карты: аффинное преобразование
// (sharp.affine), затем часть, попавшая в прямоугольник карты, кладётся на
// прозрачный холст size. Пиксель результата affine = преобразованная точка
// минус левый верхний угол рамки преобразованного изображения, поэтому
// смещение на холсте — этот угол плюс сдвиг (e, f) матрицы.
async function warpToMap(src, srcSize, M, size, dest) {
  const S = getSharp();
  const T = (x, y) => [M.a * x + M.b * y, M.c * x + M.d * y];
  const corners = [T(0, 0), T(srcSize.w, 0), T(0, srcSize.h), T(srcSize.w, srcSize.h)];
  const minX = Math.min(...corners.map((p) => p[0]));
  const minY = Math.min(...corners.map((p) => p[1]));
  const bw = Math.max(...corners.map((p) => p[0])) - minX;
  const bh = Math.max(...corners.map((p) => p[1])) - minY;
  if (bw * bh > MAX_PIXELS) throw new Error('После выравнивания фон получается слишком большим — проверьте опорные точки');

  const warpedFile = `${dest}.warp.png`;
  const cropFile = `${dest}.crop.png`;
  try {
    const info = await S(src, { limitInputPixels: false })
      .rotate()
      .ensureAlpha()
      .affine([M.a, M.b, M.c, M.d], { background: { r: 0, g: 0, b: 0, alpha: 0 }, interpolator: S.interpolators.bicubic })
      .png({ compressionLevel: 1 })
      .toFile(warpedFile);
    const left = Math.round(minX + M.e);
    const top = Math.round(minY + M.f);
    const x0 = Math.max(0, left);
    const y0 = Math.max(0, top);
    const x1 = Math.min(size.w, left + info.width);
    const y1 = Math.min(size.h, top + info.height);
    if (x1 <= x0 || y1 <= y0) throw new Error('После выравнивания фон оказывается целиком за пределами карты — проверьте опорные точки');
    await S(warpedFile, { limitInputPixels: false })
      .extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 })
      .png({ compressionLevel: 1 })
      .toFile(cropFile);
    await S({ create: { width: size.w, height: size.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }, limitInputPixels: false })
      .composite([{ input: cropFile, left: x0, top: y0, limitInputPixels: false }])
      .png({ compressionLevel: 1 })
      .toFile(dest);
  } finally {
    for (const f of [warpedFile, cropFile]) { try { fs.unlinkSync(f); } catch (e) { /* нет */ } }
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

  try {
    const { w, h } = await readSize(src);

    // Все подложки карты — в одной системе координат (размер первой). Фон
    // другого размера выравнивается по трём опорным точкам: пока точек нет,
    // режем его как есть (их ставят в окне выравнивания редактора) и ждём;
    // с точками — сначала приводим картинку к размеру карты, потом режем.
    const fresh = store.getMap(mapId);
    const size = fresh && fresh.size;
    if (size && (size.w !== w || size.h !== h)) {
      const cur = fresh.basemaps.find((b) => b.id === basemapId);
      if (!cur || !cur.align) {
        await tileInto(src, workDir);
        swapTiles(workDir, finalDir);
        await store.updateMap(mapId, (m) => {
          const bm = m.basemaps.find((b) => b.id === basemapId);
          if (bm) Object.assign(bm, { status: 'align', error: null, width: w, height: h, srcWidth: w, srcHeight: h, maxZoom: maxZoomFor(w, h), tilesVersion: (bm.tilesVersion || 0) + 1 });
          return m;
        }, { touch: false });
        console.log(`[maps] Фон ${mapId}/${basemapId} ${w}×${h} ≠ карта ${size.w}×${size.h}: ждёт выравнивания`);
        return;
      }
      const M = store.affineFromPoints(cur.align.points);
      if (!M) throw new Error('Опорные точки фона лежат на одной прямой — поставьте их треугольником');
      const aligned = store.alignedPath(mapId, basemapId);
      await warpToMap(src, { w, h }, M, size, aligned);
      await tileInto(aligned, workDir);
      swapTiles(workDir, finalDir);
      await store.updateMap(mapId, (m) => {
        const bm = m.basemaps.find((b) => b.id === basemapId);
        if (bm) Object.assign(bm, { status: 'ready', error: null, width: size.w, height: size.h, srcWidth: w, srcHeight: h, maxZoom: maxZoomFor(size.w, size.h), tilesVersion: (bm.tilesVersion || 0) + 1 });
        return m;
      }, { touch: false });
      console.log(`[maps] Фон ${mapId}/${basemapId} выровнен: ${w}×${h} → ${size.w}×${size.h}`);
      return;
    }

    await tileInto(src, workDir);
    swapTiles(workDir, finalDir);

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

function setReplace(mapId, basemapId, patch) {
  return store.updateMap(mapId, (map) => {
    const bm = map.basemaps.find((b) => b.id === basemapId);
    if (bm && bm.replace) bm.replace = { ...bm.replace, ...patch };
    return map;
  }, { touch: false });
}

async function processReplaceJob({ mapId, basemapId }) {
  const map = store.getMap(mapId);
  const basemap = map && map.basemaps.find((b) => b.id === basemapId);
  if (!basemap || !basemap.replace || !basemap.replace.ext) return; // отменили или удалили
  const src = store.replaceSourcePath(mapId, basemap);
  if (!fs.existsSync(src)) {
    await setReplace(mapId, basemapId, { status: 'error', error: 'Файл замены не найден' });
    return;
  }
  await setReplace(mapId, basemapId, { status: 'processing', error: null });
  const finalDir = store.tilesDir(mapId, basemapId);
  const workDir = `${finalDir}.work`;
  try {
    const { w, h } = await readSize(src);
    // У выровненного фона сравниваем с размером его исходной картинки и
    // приводим замену к размеру карты теми же опорными точками.
    const need = basemap.srcWidth && basemap.srcHeight ? { w: basemap.srcWidth, h: basemap.srcHeight }
      : basemap.width && basemap.height ? { w: basemap.width, h: basemap.height } : map.size;
    if (need && (need.w !== w || need.h !== h)) {
      throw new Error(`Разрешение ${w}×${h} не совпадает с фоном ${need.w}×${need.h} — заменить можно только картинкой того же размера`);
    }
    const warp = basemap.align && map.size && (map.size.w !== w || map.size.h !== h) ? store.affineFromPoints(basemap.align.points) : null;
    const alignedTmp = `${store.alignedPath(mapId, basemapId)}.replace.png`;
    if (warp) {
      await warpToMap(src, { w, h }, warp, map.size, alignedTmp);
      await tileInto(alignedTmp, workDir);
    } else {
      await tileInto(src, workDir);
    }

    // Замену могли отменить или фон удалить, пока шла нарезка.
    const fresh = store.getMap(mapId);
    const cur = fresh && fresh.basemaps.find((b) => b.id === basemapId);
    if (!cur || !cur.replace) {
      fs.rmSync(workDir, { recursive: true, force: true });
      return;
    }

    swapTiles(workDir, finalDir);
    // Исходник: новый файл встаёт на место старого (расширение могло смениться).
    const { ext: newExt, declaredSize } = basemap.replace;
    try { fs.unlinkSync(store.sourcePath(mapId, cur)); } catch (e) { /* нет — не страшно */ }
    fs.renameSync(src, store.sourcePath(mapId, { ...cur, ext: newExt }));
    if (warp) fs.renameSync(alignedTmp, store.alignedPath(mapId, basemapId));
    const out = warp ? map.size : { w, h }; // размер нарезанного — у выровненного это размер карты
    await store.updateMap(mapId, (m) => {
      const bm = m.basemaps.find((b) => b.id === basemapId);
      if (bm) {
        Object.assign(bm, {
          status: 'ready', error: null, ext: newExt, declaredSize,
          width: out.w, height: out.h, maxZoom: maxZoomFor(out.w, out.h), tilesVersion: (bm.tilesVersion || 0) + 1, replace: null,
          ...(warp ? { srcWidth: w, srcHeight: h } : {})
        });
      }
      return m;
    }, { touch: false });
    console.log(`[maps] Фон ${mapId}/${basemapId} заменён: ${w}×${h}`);
  } catch (err) {
    fs.rmSync(workDir, { recursive: true, force: true });
    try { fs.unlinkSync(src); } catch (e) { /* уже нет */ }
    try { fs.unlinkSync(`${store.alignedPath(mapId, basemapId)}.replace.png`); } catch (e) { /* нет */ }
    console.error(`[maps] Ошибка замены фона ${mapId}/${basemapId}:`, err.message);
    await setReplace(mapId, basemapId, { status: 'error', error: err.message }).catch(() => {});
  }
}

async function runNext() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  try {
    if (job.kind === 'preview') await processPreviewJob(job);
    else if (job.kind === 'replace') await processReplaceJob(job);
    else await processJob(job);
  } finally {
    running = false;
    setImmediate(runNext);
  }
}

// Номер в очереди (1 — обрабатывается сейчас или следующая) — для статуса в UI.
function queuePosition(mapId, basemapId, kind = 'tiles') {
  const i = queue.findIndex((j) => j.mapId === mapId && j.basemapId === basemapId && j.kind === kind);
  return i === -1 ? null : i + 1;
}

// При старте и после восстановления из бэкапа: всё, что не дорезалось
// (сервер перезапустили посреди работы), и готовые подложки без тайлов
// (в бэкап тайлы не кладутся — только исходники) — снова в очередь.
function rescan() {
  let count = 0;
  for (const map of store.listMaps()) {
    for (const bm of map.basemaps) {
      if (bm.replace && (bm.replace.status === 'queued' || bm.replace.status === 'processing')) enqueue(map.id, bm.id, 'replace');
      const src = store.sourcePath(map.id, bm);
      if (!bm.ext || !fs.existsSync(src)) continue;
      const tilesMissing = !fs.existsSync(path.join(store.tilesDir(map.id, bm.id), '0'));
      if (bm.status === 'queued' || bm.status === 'processing' || ((bm.status === 'ready' || bm.status === 'align') && tilesMissing)) {
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

module.exports = { enqueue, rescan, queuePosition, hasPreview, warpToMap, TILE_SIZE, PREVIEW_FILE };
