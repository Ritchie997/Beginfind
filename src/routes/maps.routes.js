// maps.routes.js — интерактивные карты (этап 1): миры (типы зон), карты,
// подложки с загрузкой по частям и нарезкой на тайлы.

const express = require('express');
const fs = require('fs');
const path = require('path');
const auth = require('../middleware/auth');
const store = require('../services/maps-store');
const worlds = require('../services/worlds-store');
const tiler = require('../services/map-tiler');
const access = require('../services/map-access');

const router = express.Router();

// Загрузка подложек: исходники бывают на сотни МБ, поэтому по частям.
const CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1536 * 1024 * 1024; // 1.5 ГБ
const SOURCE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff']);

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function loadMapOr404(req, res) {
  const map = store.getMap(req.params.id);
  if (!map) { res.status(404).json({ error: 'Карта не найдена' }); return null; }
  return map;
}

// Полная версия карты для редактора (все зоны, роли, статусы подложек).
function editorPayload(map, world) {
  return {
    ...map,
    basemaps: map.basemaps.map((b) => ({
      ...b,
      url: b.status === 'ready' ? store.tilesUrl(map.id, b) : null,
      queuePosition: tiler.queuePosition(map.id, b.id)
    })),
    zoneTypes: world.zoneTypes,
    markerTypes: world.markerTypes,
    chunkSize: CHUNK_SIZE,
    maxSourceBytes: MAX_SOURCE_BYTES
  };
}

// ===== Мир (настройки сервера для карт) =====

router.get('/servers/:id/world', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const serverId = toInt(req.params.id);
    if (!serverId) return res.status(400).json({ error: 'Некорректный id сервера' });
    const world = worlds.getWorld(serverId);
    const canEdit = access.bypasses(req.user) || await access.isServerAdmin(req.user, serverId);
    res.json({ ...world, can_edit: canEdit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/servers/:id/world', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const serverId = toInt(req.params.id);
    if (!serverId) return res.status(400).json({ error: 'Некорректный id сервера' });
    if (!(access.bypasses(req.user) || await access.isServerAdmin(req.user, serverId))) {
      return res.status(403).json({ error: 'Настройки мира может менять только администратор сервера' });
    }
    res.json({ ...worlds.saveWorld(serverId, req.body), can_edit: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== Карты =====

// Список карт, доступных пользователю (опционально — одного мира).
router.get('/maps', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const serverFilter = toInt(req.query.serverId);
    const maps = store.listMaps().filter((m) => !serverFilter || m.serverId === serverFilter);
    const result = [];
    for (const map of maps) {
      if (!(await access.canViewMap(req.user, map))) continue;
      const ready = map.basemaps.find((b) => b.status === 'ready');
      result.push({
        id: map.id,
        title: map.title,
        serverId: map.serverId,
        serverName: await access.getServerName(map.serverId),
        zoneCount: map.zones.length,
        basemapCount: map.basemaps.length,
        preview: ready && tiler.hasPreview(map.id, ready.id)
          ? `/uploads/maps/${map.id}/${ready.id}/${tiler.PREVIEW_FILE}?v=${ready.tilesVersion || 0}`
          : null,
        // Запасной вариант, пока миниатюры нет: тайл нулевого уровня, где вся
        // картинка занимает долю fw×fh в левом верхнем углу (остальное —
        // прозрачные поля) — клиент показывает только эту долю.
        previewTile: ready && ready.width && ready.height && Number.isInteger(ready.maxZoom)
          ? {
            url: store.tilesUrl(map.id, ready).replace('{z}/{y}/{x}', '0/0/0'),
            fw: ready.width / (tiler.TILE_SIZE * 2 ** ready.maxZoom),
            fh: ready.height / (tiler.TILE_SIZE * 2 ** ready.maxZoom),
            aspect: ready.width / ready.height
          }
          : null,
        updated_at: map.updated_at,
        can_edit: await access.canEditMap(req.user, map)
      });
    }
    result.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/maps', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const serverId = toInt(req.body.serverId);
    if (!serverId) return res.status(400).json({ error: 'Выберите мир (сервер) для карты' });
    if (!(await access.getServerName(serverId))) return res.status(404).json({ error: 'Сервер не найден' });
    if (!(await access.canCreateMapOn(req.user, serverId))) {
      return res.status(403).json({ error: 'Создавать карты этого мира могут только участники сервера' });
    }
    const map = store.createMap({ title: req.body.title, serverId, authorId: req.user.id });
    res.status(201).json({ id: map.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ?mode=edit — полная версия для редактора (только тем, кто может править).
router.get('/maps/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const map = await loadMapOr404(req, res);
    if (!map) return;
    if (!(await access.canViewMap(req.user, map))) {
      return res.status(403).json({ error: 'Доступ к этой карте ограничен' });
    }
    const canEdit = await access.canEditMap(req.user, map);
    const world = worlds.getWorld(map.serverId);

    if (req.query.mode === 'edit') {
      if (!canEdit) return res.status(403).json({ error: 'Править эту карту вам нельзя' });
      return res.json({ ...editorPayload(map, world), serverName: await access.getServerName(map.serverId), can_edit: true, can_delete: await access.canDeleteMap(req.user, map) });
    }

    const visible = await access.buildViewerMap(req.user, map);
    res.json({
      id: map.id,
      title: map.title,
      serverId: map.serverId,
      serverName: await access.getServerName(map.serverId),
      size: map.size,
      basemaps: access.publicBasemaps(map),
      zones: visible.zones,
      markers: visible.markers,
      zoneTypes: world.zoneTypes,
      markerTypes: world.markerTypes,
      updated_at: map.updated_at,
      can_edit: canEdit
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Сохранение из редактора. baseUpdatedAt — версия, от которой редактор
// начинал: если карту за это время сохранил кто-то другой, отвечаем 409, а
// не молча затираем его правки (force: true — осознанная перезапись).
router.put('/maps/:id', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const map = await loadMapOr404(req, res);
    if (!map) return;
    if (!(await access.canEditMap(req.user, map))) return res.status(403).json({ error: 'Править эту карту вам нельзя' });

    const body = req.body || {};
    if (!body.force && body.baseUpdatedAt && body.baseUpdatedAt !== map.updated_at) {
      return res.status(409).json({ error: 'Карту уже изменил кто-то другой', updated_at: map.updated_at });
    }
    const zones = body.zones !== undefined ? store.normalizeZones(body.zones, { strict: true }) : null;
    const markers = Array.isArray(body.markers) ? body.markers : null;

    const saved = await store.updateMap(map.id, (m) => {
      if (typeof body.title === 'string') m.title = body.title;
      if (Array.isArray(body.roles)) m.roles = body.roles;
      if (zones) m.zones = zones;
      if (markers) m.markers = markers; // нормализуются при записи (writeMap → normalizeMap)
      // Подложки: только порядок и названия существующих — статусы/файлы
      // ведёт сервер.
      if (Array.isArray(body.basemaps)) {
        const byId = new Map(m.basemaps.map((b) => [b.id, b]));
        const ordered = [];
        body.basemaps.forEach((raw) => {
          const bm = raw && byId.get(raw.id);
          if (!bm) return;
          if (typeof raw.title === 'string' && raw.title.trim()) bm.title = raw.title.trim().slice(0, 80);
          ordered.push(bm);
          byId.delete(raw.id);
        });
        m.basemaps = [...ordered, ...byId.values()];
      }
      return m;
    });
    res.json({ updated_at: saved.updated_at });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/maps/:id', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const map = await loadMapOr404(req, res);
    if (!map) return;
    if (!(await access.canDeleteMap(req.user, map))) return res.status(403).json({ error: 'Удалить карту может автор или администратор сервера' });
    store.deleteMap(map.id);
    res.json({ deleted: map.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Подложки: загрузка по частям =====

// 1) Заявка: имя и размер файла → id подложки (status 'uploading').
router.post('/maps/:id/basemaps', auth.authenticateToken, auth.checkApproved, auth.checkNotMuted, async (req, res) => {
  try {
    const map = await loadMapOr404(req, res);
    if (!map) return;
    if (!(await access.canEditMap(req.user, map))) return res.status(403).json({ error: 'Править эту карту вам нельзя' });

    const ext = path.extname(String(req.body.filename || '')).toLowerCase();
    const size = Number(req.body.size);
    if (!SOURCE_EXTENSIONS.has(ext)) return res.status(400).json({ error: 'Подложка — изображение jpg, png, webp или tiff' });
    if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ error: 'Некорректный размер файла' });
    if (size > MAX_SOURCE_BYTES) return res.status(400).json({ error: `Файл больше ${Math.round(MAX_SOURCE_BYTES / 1024 / 1024)} МБ` });

    const basemapId = store.genId('b');
    fs.mkdirSync(store.sourceDir(map.id), { recursive: true });
    fs.writeFileSync(store.partPath(map.id, basemapId), Buffer.alloc(0));
    await store.updateMap(map.id, (m) => {
      m.basemaps.push({
        id: basemapId,
        title: String(req.body.title || '').trim() || path.basename(String(req.body.filename), ext).slice(0, 80) || 'Подложка',
        status: 'uploading',
        ext,
        declaredSize: size,
        created_at: new Date().toISOString()
      });
      return m;
    }, { touch: false });
    res.status(201).json({ basemapId, chunkSize: CHUNK_SIZE });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

async function loadUploadingBasemap(req, res) {
  const map = await loadMapOr404(req, res);
  if (!map) return null;
  if (!(await access.canEditMap(req.user, map))) { res.status(403).json({ error: 'Править эту карту вам нельзя' }); return null; }
  const bm = map.basemaps.find((b) => b.id === req.params.bid);
  if (!bm) { res.status(404).json({ error: 'Подложка не найдена' }); return null; }
  if (bm.status !== 'uploading') { res.status(409).json({ error: 'Эта подложка уже загружена' }); return null; }
  return { map, bm };
}

// 2) Часть файла: тело — сырые байты, ?offset= — позиция. Повтор уже
// записанной части (обрыв связи и повторная отправка) принимается без ошибки.
router.put('/maps/:id/basemaps/:bid/chunk',
  auth.authenticateToken, auth.checkApproved,
  express.raw({ type: 'application/octet-stream', limit: CHUNK_SIZE + 1024 }),
  async (req, res) => {
    try {
      const ctx = await loadUploadingBasemap(req, res);
      if (!ctx) return;
      const offset = Number(req.query.offset);
      const chunk = Buffer.isBuffer(req.body) ? req.body : null;
      if (!chunk || !chunk.length) return res.status(400).json({ error: 'Пустая часть файла' });
      if (!Number.isInteger(offset) || offset < 0) return res.status(400).json({ error: 'Некорректный offset' });

      const part = store.partPath(ctx.map.id, ctx.bm.id);
      const current = fs.existsSync(part) ? fs.statSync(part).size : 0;
      if (offset + chunk.length <= current) return res.json({ received: current }); // уже есть
      if (offset !== current) return res.status(409).json({ error: 'Части пришли не по порядку', received: current });
      if (current + chunk.length > ctx.bm.declaredSize) return res.status(400).json({ error: 'Файл больше заявленного размера' });

      fs.appendFileSync(part, chunk);
      res.json({ received: current + chunk.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

// 3) Завершение: файл целиком → в очередь нарезки.
router.post('/maps/:id/basemaps/:bid/complete', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const ctx = await loadUploadingBasemap(req, res);
    if (!ctx) return;
    const part = store.partPath(ctx.map.id, ctx.bm.id);
    const size = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (size !== ctx.bm.declaredSize) return res.status(400).json({ error: `Файл загружен не полностью (${size} из ${ctx.bm.declaredSize} байт)` });

    fs.renameSync(part, store.sourcePath(ctx.map.id, ctx.bm));
    await store.updateMap(ctx.map.id, (m) => {
      const bm = m.basemaps.find((b) => b.id === ctx.bm.id);
      if (bm) bm.status = 'queued';
      return m;
    }, { touch: false });
    tiler.enqueue(ctx.map.id, ctx.bm.id);
    res.json({ status: 'queued', queuePosition: tiler.queuePosition(ctx.map.id, ctx.bm.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Перенарезать (после ошибки) — исходник уже на сервере.
router.post('/maps/:id/basemaps/:bid/retile', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const map = await loadMapOr404(req, res);
    if (!map) return;
    if (!(await access.canEditMap(req.user, map))) return res.status(403).json({ error: 'Править эту карту вам нельзя' });
    const bm = map.basemaps.find((b) => b.id === req.params.bid);
    if (!bm || !fs.existsSync(store.sourcePath(map.id, bm))) return res.status(404).json({ error: 'Исходник подложки не найден' });
    await store.updateMap(map.id, (m) => {
      const b = m.basemaps.find((x) => x.id === bm.id);
      if (b) Object.assign(b, { status: 'queued', error: null });
      return m;
    }, { touch: false });
    tiler.enqueue(map.id, bm.id);
    res.json({ status: 'queued' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/maps/:id/basemaps/:bid', auth.authenticateToken, auth.checkApproved, async (req, res) => {
  try {
    const map = await loadMapOr404(req, res);
    if (!map) return;
    if (!(await access.canEditMap(req.user, map))) return res.status(403).json({ error: 'Править эту карту вам нельзя' });
    const bm = map.basemaps.find((b) => b.id === req.params.bid);
    if (!bm) return res.status(404).json({ error: 'Подложка не найдена' });
    store.removeBasemapFiles(map.id, bm);
    await store.updateMap(map.id, (m) => {
      m.basemaps = m.basemaps.filter((b) => b.id !== bm.id);
      // Удалили последнюю подложку и зон нет — размер карты можно задать заново.
      if (!m.basemaps.length && !m.zones.length) m.size = null;
      return m;
    }, { touch: false }); // не сбивает baseUpdatedAt открытого редактора
    res.json({ deleted: bm.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
