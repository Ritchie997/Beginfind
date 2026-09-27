// map-core.js — общее ядро интерактивных карт: просмотр на отдельной
// странице (/map/:id), в блоке статьи и основа редактора (map-editor.js).
//
// Координаты карты — пиксели исходника подложки: [x, y], y вниз. Leaflet
// работает в CRS.Simple, где lat растёт вверх, поэтому точка [x, y] = LatLng(-y, x).
// Тайлы нарезаны сервером в раскладке google ({z}/{y}/{x}, см.
// src/services/map-tiler.js): при зуме Leaflet 0 один пиксель экрана = один
// пиксель исходника, отрицательные зумы — отдаление (zoomOffset = maxZoom).
//
// Приоритет кликов у вложенных зон — порядком отрисовки: родитель рисуется
// раньше, дети поверх него. Клик в город попадает в город, клик в регион
// мимо городов — в регион, без специальной логики перехвата.

(function () {
  'use strict';

  const TILE_SIZE = 256;
  const MAX_VIEW_ZOOM = 1; // просмотр: максимум 2× от исходника

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function isTouchUi() {
    return !!(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
  }

  // ===== Координаты =====

  function toLatLng(pt) { return L.latLng(-pt[1], pt[0]); }
  function fromLatLng(ll) { return [ll.lng, -ll.lat]; }

  function polygonToLatLngs(multi) {
    return (multi || []).map((poly) => poly.map((ring) => ring.map((p) => [-p[1], p[0]])));
  }

  function imageBounds(size) {
    return L.latLngBounds([0, 0], [-size.h, size.w]);
  }

  function polygonBBox(multi) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    (multi || []).forEach((poly) => (poly[0] || []).forEach(([x, y]) => {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }));
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  }

  function bboxToLatLngBounds(b) {
    return L.latLngBounds([-b.minY, b.minX], [-b.maxY, b.maxX]);
  }

  // Площадь внешних контуров (для порядка отрисовки соседей одного уровня:
  // крупные раньше, мелкие поверх).
  function polygonArea(multi) {
    let sum = 0;
    (multi || []).forEach((poly) => {
      const ring = poly[0] || [];
      let a = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
      sum += Math.abs(a / 2);
    });
    return sum;
  }

  // Точка внутри MultiPolygon (с учётом дыр) — чётно-нечётное правило.
  function pointInRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
      if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function pointInMulti(pt, multi) {
    return (multi || []).some((poly) => poly.length && pointInRing(pt, poly[0]) && !poly.slice(1).some((hole) => pointInRing(pt, hole)));
  }

  // Точка для подписи зоны: центр масс самого большого куска, а если он
  // вне фигуры (подкова, полумесяц) — середина самого широкого горизонтального
  // отрезка внутри фигуры на нескольких высотах.
  function labelPoint(multi) {
    let best = null;
    (multi || []).forEach((poly) => {
      const a = polygonArea([poly]);
      if (!best || a > best.a) best = { poly, a };
    });
    if (!best) return null;
    const ring = best.poly[0];
    let cx = 0, cy = 0, area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      cx += (ring[j][0] + ring[i][0]) * f;
      cy += (ring[j][1] + ring[i][1]) * f;
      area += f;
    }
    if (area !== 0) {
      const c = [cx / (3 * area), cy / (3 * area)];
      if (pointInMulti(c, [best.poly])) return c;
    }
    const bb = polygonBBox([best.poly]);
    let widest = null;
    [0.5, 0.35, 0.65, 0.2, 0.8].forEach((k) => {
      const y = bb.minY + (bb.maxY - bb.minY) * k;
      const xs = [];
      best.poly.forEach((r) => {
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
          const [x1, y1] = r[j]; const [x2, y2] = r[i];
          if ((y1 > y) !== (y2 > y)) xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
        }
      });
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const w = xs[i + 1] - xs[i];
        if (!widest || w > widest.w) widest = { w, pt: [(xs[i] + xs[i + 1]) / 2, y] };
      }
    });
    return widest ? widest.pt : [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2];
  }

  // ===== Время и календарь (этап 3) =====
  // Время — целое «абсолютный год» мира; календарь (настройка мира)
  // превращает его в подпись. Эра с прямым счётом: год = t − start + 1;
  // с обратным (как «до н. э.»): год = начало следующей эры − t.

  const DEFAULT_CALENDAR = {
    eras: [
      { id: 'before', name: 'До Основания', short: 'до О.', start: null, direction: 'backward' },
      { id: 'founding', name: 'Эпоха Основания', short: 'Э.О.', start: 0, direction: 'forward' }
    ],
    format: '{year} {short}'
  };
  const FLUBBER_SRC = 'https://cdn.jsdelivr.net/npm/flubber@0.4.2/build/flubber.min.js';

  function calendarEras(cal) {
    const eras = cal && Array.isArray(cal.eras) && cal.eras.length ? cal.eras : DEFAULT_CALENDAR.eras;
    return eras.slice().sort((a, b) => (a.start === null ? -Infinity : a.start) - (b.start === null ? -Infinity : b.start));
  }

  function eraIndexFor(eras, t) {
    let idx = 0;
    eras.forEach((e, i) => { if (e.start === null || e.start <= t) idx = i; });
    return idx;
  }

  // t → { era, year } в календаре мира.
  function toEraYear(cal, t) {
    const eras = calendarEras(cal);
    const i = eraIndexFor(eras, t);
    const era = eras[i];
    const next = eras[i + 1] ? eras[i + 1].start : null;
    const year = era.direction === 'backward'
      ? (next !== null ? next : 0) - t
      : t - (era.start !== null ? era.start : 0) + 1;
    return { era, year };
  }

  // { eraId, year } → t (обратное к toEraYear).
  function fromEraYear(cal, eraId, year) {
    const eras = calendarEras(cal);
    const i = Math.max(0, eras.findIndex((e) => e.id === eraId));
    const era = eras[i];
    const next = eras[i + 1] ? eras[i + 1].start : null;
    const y = Math.round(Number(year) || 0);
    return era.direction === 'backward' ? (next !== null ? next : 0) - y : (era.start !== null ? era.start : 0) + y - 1;
  }

  // Даты в интерфейсе — просто год числом: для вымышленных миров эпохи и
  // сокращения («Э.О.», «до О.») оказались непонятнее обычного числа.
  function formatTime(cal, t) {
    if (t === null || t === undefined || !Number.isFinite(t)) return '';
    return String(t);
  }

  function formatRange(cal, from, to) {
    if (from === null || from === undefined) return to === null || to === undefined ? '' : `до ${formatTime(cal, to)}`;
    return to === null || to === undefined ? formatTime(cal, from) : `${formatTime(cal, from)} — ${formatTime(cal, to)}`;
  }

  // Существует ли объект (зона, метка, подложка) в момент t: [from, to).
  function existsAt(obj, t) {
    if (t === null || t === undefined) return true;
    return (obj.from === null || obj.from === undefined || t >= obj.from) && (obj.to === null || obj.to === undefined || t < obj.to);
  }

  // Индекс версии границы зоны, действующей в момент t.
  function shapeIndexAt(zone, t) {
    const shapes = zone.shapes || [];
    let idx = 0;
    shapes.forEach((sh, i) => { if (sh.from === null || sh.from === undefined || (t !== null && t !== undefined && sh.from <= t)) idx = i; });
    return idx;
  }

  // Есть ли у карты вообще что-то во времени — иначе шкалу не показываем.
  function mapHasTime(data) {
    const bounded = (o) => (o.from !== null && o.from !== undefined) || (o.to !== null && o.to !== undefined);
    const tl = data.timeline || {};
    if (tl.start != null || tl.end != null || (tl.periods || []).length) return true;
    return (data.events || []).length > 0
      || (data.zones || []).some((z) => bounded(z) || (z.shapes || []).length > 1)
      || (data.markers || []).some(bounded)
      || (data.basemaps || []).some(bounded);
  }

  // Диапазон шкалы: начальная и конечная дата карты, если заданы; иначе
  // все даты карты + поля по краям.
  function timeRange(data) {
    const tl = data.timeline || {};
    if (tl.start != null && tl.end != null && tl.end > tl.start) return { min: tl.start, max: tl.end };
    const vals = [];
    const push = (v) => { if (v !== null && v !== undefined && Number.isFinite(v)) vals.push(v); };
    (data.zones || []).forEach((z) => { push(z.from); push(z.to); (z.shapes || []).forEach((sh) => push(sh.from)); });
    (data.markers || []).forEach((m) => { push(m.from); push(m.to); });
    (data.events || []).forEach((e) => { push(e.from); push(e.to); });
    (data.basemaps || []).forEach((b) => { push(b.from); push(b.to); });
    if (data.timeline) push(data.timeline.initial);
    if (!vals.length) return { min: tl.start != null ? tl.start : 0, max: tl.end != null ? tl.end : (tl.start != null ? tl.start + 100 : 100) };
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    const pad = Math.max(1, Math.round((max - min) * 0.05));
    return { min: tl.start != null ? tl.start : min - pad, max: tl.end != null ? tl.end : max + pad };
  }

  // ===== Типы зон и стили =====

  function typeMap(zoneTypes) {
    return new Map((zoneTypes || []).map((t) => [t.id, t]));
  }

  const FALLBACK_TYPE = { id: null, name: 'Зона', color: '#5865f2', fillOpacity: 0.15, weight: 2, dashed: false, hoverEffect: 'fill' };

  // Тип зоны + свой стиль зоны поверх него (заданные поля перекрывают тип).
  function effectiveType(type, override) {
    const t = type || FALLBACK_TYPE;
    return override ? { ...t, ...override } : t;
  }

  function baseStyle(type, override) {
    const t = effectiveType(type, override);
    return {
      color: t.color,
      weight: t.weight,
      opacity: 0.9,
      fillColor: t.color,
      fillOpacity: t.fillOpacity,
      dashArray: t.dashed ? '8 6' : null
    };
  }

  function hoverStyle(type, override) {
    const t = effectiveType(type, override);
    const s = baseStyle(t);
    if (t.hoverEffect === 'outline') return { ...s, weight: s.weight + 2, opacity: 1 };
    if (t.hoverEffect === 'glow') return { ...s, weight: s.weight + 1, opacity: 1, fillOpacity: Math.min(1, s.fillOpacity + 0.1) };
    if (t.hoverEffect === 'pulse') return { ...s, weight: s.weight + 1, opacity: 1, fillOpacity: Math.min(1, s.fillOpacity + 0.15) };
    return { ...s, fillOpacity: Math.min(1, s.fillOpacity + 0.25), opacity: 1 };
  }

  const FALLBACK_MARKER_TYPE = { id: null, name: 'Метка', icon: 'location-dot', color: '#5865f2', minZoomRel: 0 };

  function zoneDepths(zones) {
    const byId = new Map(zones.map((z) => [z.id, z]));
    const cache = new Map();
    const depth = (z, guard = 0) => {
      if (cache.has(z.id)) return cache.get(z.id);
      const p = z.parentId && byId.get(z.parentId);
      const d = p && guard < 64 ? depth(p, guard + 1) + 1 : 0;
      cache.set(z.id, d);
      return d;
    };
    zones.forEach((z) => depth(z));
    return cache;
  }

  // ===== Подложки =====

  function makeTileLayer(basemap, size) {
    return L.tileLayer(basemap.url, {
      tileSize: TILE_SIZE,
      zoomOffset: basemap.maxZoom,
      minNativeZoom: -basemap.maxZoom,
      maxNativeZoom: 0,
      minZoom: -basemap.maxZoom - 2,
      maxZoom: 4,
      noWrap: true,
      bounds: imageBounds(size),
      keepBuffer: 1,
      updateWhenIdle: isTouchUi(),
      className: 'map-tiles'
    });
  }

  // ===== Загрузка Leaflet по требованию =====
  // Leaflet подключён в index.html; polygon-clipping нужен только редактору.

  const scriptPromises = new Map();
  function loadScript(src, globalName) {
    if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
    if (!scriptPromises.has(src)) {
      scriptPromises.set(src, new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = () => resolve(globalName ? window[globalName] : true);
        el.onerror = () => { scriptPromises.delete(src); reject(new Error(`Не удалось загрузить ${src}`)); };
        document.head.appendChild(el);
      }));
    }
    return scriptPromises.get(src);
  }

  // ===== MapViewer =====
  //
  // opts:
  //   mode: 'page' | 'embed'
  //   view: { x, y, zoom } — начальный вид (иначе вся карта / focusZoneId)
  //   focusZoneId — зона, к которой приблизить и которую подсветить
  //   basemapId — стартовая подложка
  //   onZoneActivate(zone) — клик (ПК) / кнопка в карточке (телефон)

  class MapViewer {
    constructor(container, mapData, opts = {}) {
      this.container = container;
      // Своя копия зон: текущая форма зоны (polygon) зависит от момента
      // таймлайна, а данные карты кэшируются и общие для нескольких просмотров.
      this.data = { ...mapData, zones: (mapData.zones || []).map((z) => ({ ...z })) };
      this.hasTime = mapHasTime(this.data);
      this.range = timeRange(this.data);
      const initial = [opts.time, this.data.timeline && this.data.timeline.initial].find((v) => v !== null && v !== undefined && Number.isFinite(v));
      this.time = this.hasTime ? (initial !== undefined ? initial : this.range.min) : null;
      this.data.zones.forEach((z) => {
        if (!z.shapes && z.polygon) z.shapes = [{ from: null, polygon: z.polygon }];
        z._shapeIndex = shapeIndexAt(z, this.time);
        z.polygon = z.shapes && z.shapes[z._shapeIndex] ? z.shapes[z._shapeIndex].polygon : [];
      });
      this.selectedEventId = null;
      this._morphs = new Map();
      this.opts = opts;
      this.types = typeMap(mapData.zoneTypes);
      this.markerTypes = typeMap(mapData.markerTypes);
      this.zoneLayers = new Map(); // id -> L.Polygon
      this.markerLayers = new Map(); // id -> { marker, data, shown }
      this.selectedId = null; // выбранная зона
      this.selectedMarkerId = null; // выбранная метка
      this.hoveredId = null;
      this.touch = isTouchUi();
      this.build();
    }

    build() {
      const { data, opts } = this;
      const embed = opts.mode === 'embed';
      this.container.classList.add('map-viewer', embed ? 'map-viewer-embed' : 'map-viewer-page');

      this.mapEl = document.createElement('div');
      this.mapEl.className = 'map-viewer-canvas';
      this.container.appendChild(this.mapEl);

      const size = data.size || { w: 2048, h: 2048 };
      this.size = size;
      const maxZoom = Math.max(0, ...data.basemaps.map((b) => b.maxZoom || 0), Math.ceil(Math.log2(Math.max(size.w, size.h) / TILE_SIZE)));

      this.map = L.map(this.mapEl, {
        crs: L.CRS.Simple,
        minZoom: -maxZoom - 2,
        // Целый шаг масштаба: тайлы есть только для целых уровней, на
        // промежуточных браузер растягивает их и картинка мутнеет.
        // Приближение — не больше 2× от оригинала: дальше только растянутые пиксели.
        maxZoom: MAX_VIEW_ZOOM,
        zoomSnap: 1,
        zoomDelta: 1,
        wheelPxPerZoomLevel: 100,
        attributionControl: false,
        zoomControl: !this.touch,
        // В статье на телефоне один палец листает статью, два — двигают
        // и масштабируют карту (щипок Leaflet сдвигает карту вслед за пальцами).
        dragging: !(embed && this.touch),
        // В статье колесо без Ctrl листает страницу, а не масштабирует карту.
        scrollWheelZoom: !embed,
        tap: false,
        maxBounds: imageBounds(size).pad(0.5),
        maxBoundsViscosity: 0.8
      });
      if (!this.touch && this.map.zoomControl) this.map.zoomControl.setPosition('bottomright');

      if (embed) this.setupEmbedGestures();

      this.basemapLayer = null;
      const initialBasemap = this.basemapForTime(this.time) || data.basemaps.find((b) => b.id === opts.basemapId) || data.basemaps[0] || null;
      if (initialBasemap) this.setBasemap(initialBasemap.id);
      else this.container.classList.add('map-viewer-no-basemap');
      this._chosenBasemap = opts.basemapId || null; // стартовый фон периода — не ручной выбор

      this.zonesPane = this.map.createPane('zonesPane');
      this.zonesPane.style.zIndex = 450;
      this.renderer = L.svg({ padding: 0.4, pane: 'zonesPane' });
      // Подписи зон — отдельный слой поверх зон И меток (markerPane = 600),
      // но под всплывающими подсказками (tooltipPane = 650). Мышь не ловят,
      // поэтому метка под названием по-прежнему кликается.
      this.labelsPane = this.map.createPane('zoneLabelsPane');
      this.labelsPane.style.zIndex = 640;
      this.labelsPane.style.pointerEvents = 'none';
      this.labels = new Map(); // id -> { marker, pt, bbox, depth, text }
      this.labelVisible = new Set();
      this.renderZones();
      this.renderMarkers();
      this.map.on('zoomend moveend', () => { this.updateZoomVisibility(); this.updateLabels(); });
      // Контейнер может быть ещё скрыт (статья Ибрипедии рендерится до
      // показа секции) — тогда начальный вид выставим, когда появится размер,
      // иначе fitBounds посчитал бы масштаб для окна 0×0.
      this._pendingInitialView = true;
      if (this.mapEl.clientWidth > 0 && this.mapEl.clientHeight > 0) this.applyInitialViewOnce();

      this.map.on('click', () => {
        if (this._zoneClickedAt && Date.now() - this._zoneClickedAt <= 50) return;
        this.clearEventHighlight();
        this.selectZone(null);
      });
      this._resizeObserver = new ResizeObserver(() => {
        if (!this.map) return;
        this.map.invalidateSize();
        if (this._pendingInitialView && this.mapEl.clientWidth > 0 && this.mapEl.clientHeight > 0) this.applyInitialViewOnce();
      });
      this._resizeObserver.observe(this.container);

      if (this.hasTime) {
        this.buildTimeline();
        // Плавное перетекание границ — библиотека flubber (не загрузилась —
        // смена формы растворением).
        loadScript(FLUBBER_SRC, 'flubber').catch(() => {});
      }
    }

    applyInitialViewOnce() {
      if (!this._pendingInitialView) return;
      this._pendingInitialView = false;
      this.map.invalidateSize();
      this.setInitialView();
      this.updateZoomVisibility();
      this.updateLabels();
    }

    setupEmbedGestures() {
      const hint = document.createElement('div');
      hint.className = 'map-viewer-hint';
      hint.hidden = true;
      this.container.appendChild(hint);
      let timer = null;
      const show = (text) => {
        hint.textContent = text;
        hint.hidden = false;
        clearTimeout(timer);
        timer = setTimeout(() => { hint.hidden = true; }, 1200);
      };
      if (this.touch) {
        this.mapEl.addEventListener('touchmove', (e) => { if (e.touches.length === 1) show('Двигайте карту двумя пальцами'); }, { passive: true });
      } else {
        this.mapEl.addEventListener('wheel', (e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const delta = e.deltaY < 0 ? 1 : -1;
            this.map.setZoomAround(this.map.mouseEventToContainerPoint(e), this.map.getZoom() + delta);
          } else {
            show('Ctrl + колесо — масштаб карты');
          }
        }, { passive: false });
      }
    }

    setBasemap(id) {
      const bm = this.data.basemaps.find((b) => b.id === id);
      if (!bm) return;
      if (this.basemapLayer) this.map.removeLayer(this.basemapLayer);
      this.basemapLayer = makeTileLayer(bm, this.size).addTo(this.map);
      this.currentBasemapId = id;
      this._chosenBasemap = id; // ручной выбор — фон вне периодов шкалы
    }

    // Порядок отрисовки: глубина по возрастанию, внутри уровня — крупные
    // раньше. Поздний слой в SVG лежит выше и первым ловит мышь/палец.
    orderedZones() {
      const depths = zoneDepths(this.data.zones);
      return this.data.zones
        .filter((z) => z.polygon && z.polygon.length)
        .map((z) => ({ z, d: depths.get(z.id) || 0, a: polygonArea(z.polygon) }))
        .sort((p, q) => (p.d - q.d) || (q.a - p.a))
        .map((p) => p.z);
    }

    renderZones() {
      this.zoneLayers.forEach((layer) => layer.remove());
      this.zoneLayers.clear();
      this.orderedZones().forEach((zone) => {
        const type = this.types.get(zone.typeId);
        const layer = L.polygon(polygonToLatLngs(zone.polygon), { ...baseStyle(type, zone.style), renderer: this.renderer, className: 'map-zone' });
        layer.on('mouseover', () => this.setHover(zone.id));
        layer.on('mouseout', () => { if (this.hoveredId === zone.id) this.setHover(null); });
        layer.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          this._zoneClickedAt = Date.now();
          this.onZoneClick(zone);
        });
        // Двойной клик — сразу в статью (одиночный только открывает карточку).
        layer.on('dblclick', (e) => {
          L.DomEvent.stopPropagation(e);
          if (zone.article && !zone.locked) this.activate(zone);
        });
        // Отдельной подсказки у курсора у зон нет: при наведении проявляется
        // сама подпись зоны (даже у мелкой, см. .is-active в maps.css).
        layer.addTo(this.map);
        this.zoneLayers.set(zone.id, layer);
      });
      this.renderLabels();
    }

    // ----- Подписи зон (в стиле подписей графа: текст с обводкой цвета фона) -----

    renderLabels() {
      this.labels.forEach((l) => l.marker.remove());
      this.labels.clear();
      const depths = zoneDepths(this.data.zones);
      this.data.zones.forEach((zone) => {
        const text = (zone.title || '').trim();
        if (!text || !zone.polygon || !zone.polygon.length) return;
        const pt = labelPoint(zone.polygon);
        if (!pt) return;
        const depth = Math.min(3, depths.get(zone.id) || 0);
        const color = effectiveType(this.types.get(zone.typeId), zone.style).color;
        const marker = L.marker(toLatLng(pt), {
          pane: 'zoneLabelsPane',
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: 'map-zone-label-anchor',
            iconSize: null,
            html: `<span class="map-zone-label map-zone-label-d${depth}" style="--zone-color:${escapeHtml(color)}">${escapeHtml(text)}</span>`
          })
        }).addTo(this.map);
        this.labels.set(zone.id, { marker, pt, bbox: polygonBBox(zone.polygon), depth, text, zone });
      });
      this.updateLabels();
    }

    // Подпись видна, когда зона на экране достаточно крупная, чтобы
    // название в неё помещалось, и не налезает на уже показанную подпись
    // (сначала родители, потом вложенные — крупные названия как ориентиры).
    updateLabels() {
      if (!this.map || !this.map._loaded || !this.labels) return;
      const scale = Math.pow(2, this.map.getZoom());
      const sizes = [15, 13, 12, 11];
      const placed = [];
      this.labelVisible.clear();
      [...this.labels.entries()]
        .sort((a, b) => a[1].depth - b[1].depth)
        .forEach(([id, l]) => {
          const fs = sizes[l.depth] || 11;
          const w = l.text.length * fs * (l.depth === 0 ? 0.72 : 0.58) + 10;
          const h = fs * 1.5;
          const zw = (l.bbox.maxX - l.bbox.minX) * scale;
          const zh = (l.bbox.maxY - l.bbox.minY) * scale;
          let show = zw >= w * 0.9 && zh >= h && this.zoneZoomVisible(l.zone);
          if (show) {
            const c = this.map.latLngToContainerPoint(toLatLng(l.pt));
            const rect = { x1: c.x - w / 2, x2: c.x + w / 2, y1: c.y - h / 2, y2: c.y + h / 2 };
            if (placed.some((r) => rect.x1 < r.x2 && rect.x2 > r.x1 && rect.y1 < r.y2 && rect.y2 > r.y1)) show = false;
            else placed.push(rect);
          }
          const el = l.marker.getElement();
          if (el) el.classList.toggle('is-hidden', !show);
          if (show) this.labelVisible.add(id);
        });
    }

    typeName(zone) {
      const t = this.types.get(zone.typeId);
      return t ? t.name : 'Зона';
    }

    zoneById(id) {
      return this.data.zones.find((z) => z.id === id) || null;
    }

    applyStyle(id) {
      const layer = this.zoneLayers.get(id);
      const zone = this.zoneById(id);
      if (!layer || !zone) return;
      const type = this.types.get(zone.typeId);
      const active = id === this.hoveredId || id === this.selectedId;
      layer.setStyle(active ? hoverStyle(type, zone.style) : baseStyle(type, zone.style));
      const el = layer.getElement && layer.getElement();
      if (el) {
        const t = effectiveType(type, zone.style);
        el.classList.toggle('map-zone-glow', active && t.hoverEffect === 'glow');
        el.classList.toggle('map-zone-pulse', active && t.hoverEffect === 'pulse');
        el.style.setProperty('--zone-color', t.color);
        el.classList.toggle('map-zone-selected', id === this.selectedId);
      }
      const label = this.labels && this.labels.get(id);
      const labelEl = label && label.marker.getElement();
      if (labelEl) labelEl.classList.toggle('is-active', active);
    }

    setHover(id) {
      const prev = this.hoveredId;
      this.hoveredId = id;
      if (prev) this.applyStyle(prev);
      if (id) this.applyStyle(id);
    }

    selectZone(id, { fly = false } = {}) {
      this.clearMarkerSelection();
      if (this.selectedEventId && id !== null) this.clearEventHighlight();
      const prev = this.selectedId;
      this.selectedId = id;
      if (prev) this.applyStyle(prev);
      if (id) this.applyStyle(id);
      if (id && fly) this.flyToZone(id);
      this.updateZoomVisibility();
      this.renderCard();
      if (this.opts.onSelect) this.opts.onSelect(id, 'zone');
    }

    // ----- Видимость по масштабу («Видно с приближения» у типа) -----
    // minZoomRel считается от вида всей карты: 0 — всегда, 1 — с ×2, 2 — с ×4…

    isVisibleAtZoom(rel) {
      if (!rel || this.fullZoom == null || !this.map) return true;
      return this.map.getZoom() >= this.fullZoom + rel;
    }

    zoneZoomVisible(zone) {
      if (!zone) return false;
      if (!existsAt(zone, this.time)) return false; // зоны ещё/уже нет в этот момент
      if (zone.id === this.selectedId) return true;
      const t = this.types.get(zone.typeId);
      return this.isVisibleAtZoom(t ? t.minZoomRel : 0);
    }

    // Скрытая по масштабу зона плавно гаснет и не ловит мышь — клик
    // проходит к родителю.
    updateZoomVisibility() {
      if (!this.map || !this.map._loaded) return;
      this.zoneLayers.forEach((layer, id) => {
        const el = layer.getElement && layer.getElement();
        if (el) el.classList.toggle('map-zone-zoomhidden', !this.zoneZoomVisible(this.zoneById(id)));
      });
      this.updateMarkerVisibility();
    }

    // ----- Метки -----

    markerType(m) {
      return this.markerTypes.get(m.typeId) || FALLBACK_MARKER_TYPE;
    }

    markerIcon(m, selected) {
      const t = this.markerType(m);
      const size = this.touch ? 36 : 28; // на телефоне — крупнее, под палец
      return L.divIcon({
        className: 'map-marker-anchor',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        html: `<span class="map-marker${selected ? ' is-selected' : ''}" style="--marker-color:${escapeHtml(t.color)}"><i class="fas fa-${escapeHtml(t.icon)}"></i></span>`
      });
    }

    // Близкие метки на отдалении группируются (Leaflet.markercluster, если
    // плагин загрузился; иначе — просто слой меток).
    renderMarkers() {
      if (this.markerGroup) this.markerGroup.remove();
      this.markerLayers.clear();
      this.markerGroup = L.markerClusterGroup
        ? L.markerClusterGroup({
          showCoverageOnHover: false,
          maxClusterRadius: 44,
          spiderfyOnMaxZoom: true,
          iconCreateFunction: (cluster) => L.divIcon({
            className: 'map-marker-cluster',
            html: `<span>${cluster.getChildCount()}</span>`,
            iconSize: [38, 38]
          })
        })
        : L.layerGroup();
      this.markerGroup.addTo(this.map);
      (this.data.markers || []).forEach((m) => {
        const marker = L.marker(toLatLng(m.pos), { icon: this.markerIcon(m, false), keyboard: false, riseOnHover: true });
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          this._zoneClickedAt = Date.now();
          this.selectMarker(m.id);
        });
        marker.on('dblclick', (e) => {
          L.DomEvent.stopPropagation(e);
          if (m.article && !m.locked) this.activate(m);
        });
        if (!this.touch) marker.bindTooltip(escapeHtml(m.title || this.markerType(m).name), { direction: 'top', offset: [0, -16], className: 'map-zone-tooltip' });
        this.markerLayers.set(m.id, { marker, data: m, shown: false });
      });
      this.updateMarkerVisibility();
    }

    updateMarkerVisibility() {
      if (!this.markerGroup) return;
      const add = [];
      const remove = [];
      this.markerLayers.forEach((e, id) => {
        const vis = existsAt(e.data, this.time) && (id === this.selectedMarkerId || this.isVisibleAtZoom(this.markerType(e.data).minZoomRel));
        if (vis && !e.shown) { add.push(e.marker); e.shown = true; }
        else if (!vis && e.shown) { remove.push(e.marker); e.shown = false; }
      });
      if (remove.length) {
        if (this.markerGroup.removeLayers) this.markerGroup.removeLayers(remove);
        else remove.forEach((mk) => this.markerGroup.removeLayer(mk));
      }
      if (add.length) {
        if (this.markerGroup.addLayers) this.markerGroup.addLayers(add);
        else add.forEach((mk) => this.markerGroup.addLayer(mk));
      }
    }

    markerById(id) {
      return (this.data.markers || []).find((m) => m.id === id) || null;
    }

    clearMarkerSelection() {
      const mid = this.selectedMarkerId;
      if (!mid) return;
      this.selectedMarkerId = null;
      const e = this.markerLayers.get(mid);
      if (e) e.marker.setIcon(this.markerIcon(e.data, false));
      this.updateMarkerVisibility();
    }

    selectMarker(id, { fly = false } = {}) {
      const prevZone = this.selectedId;
      if (prevZone) { this.selectedId = null; this.applyStyle(prevZone); this.updateZoomVisibility(); }
      this.clearMarkerSelection();
      this.selectedMarkerId = id;
      const e = id && this.markerLayers.get(id);
      if (e) e.marker.setIcon(this.markerIcon(e.data, true));
      this.updateMarkerVisibility();
      if (e && fly) {
        if (this.markerGroup.zoomToShowLayer) this.markerGroup.zoomToShowLayer(e.marker, () => this.map.panTo(e.marker.getLatLng()));
        else this.map.flyTo(e.marker.getLatLng(), Math.max(this.map.getZoom(), (this.fullZoom || 0) + 2), { duration: 0.6 });
      }
      this.renderCard();
      if (this.opts.onSelect) this.opts.onSelect(id, 'marker');
    }

    flyToZone(id) {
      const zone = this.zoneById(id);
      const bbox = zone && polygonBBox(zone.polygon);
      if (bbox) this.map.flyToBounds(bboxToLatLngBounds(bbox), { padding: [40, 40], maxZoom: 1, duration: 0.6 });
    }

    // Клик/тап — подсветка и карточка с названием; в статью — кнопкой в
    // карточке или двойным кликом (раньше клик на ПК сразу уводил в статью,
    // и карточку было не прочитать).
    onZoneClick(zone) {
      this.selectZone(zone.id);
    }

    activate(zone) {
      if (this.opts.onZoneActivate) this.opts.onZoneActivate(zone);
      else openZoneArticle(zone);
    }

    renderCard() {
      if (!this.cardEl) {
        this.cardEl = document.createElement('div');
        this.cardEl.className = 'map-zone-card';
        this.cardEl.hidden = true;
        this.container.appendChild(this.cardEl);
        this.cardEl.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-card-action]');
          if (!btn) return;
          if (btn.dataset.cardAction === 'close') { this.clearEventHighlight(); this.selectZone(null); return; }
          if (btn.dataset.cardAction === 'goto-zone') { this.selectZone(btn.dataset.id, { fly: true }); return; }
          if (btn.dataset.cardAction === 'goto-marker') { this.selectMarker(btn.dataset.id, { fly: true }); return; }
          const item = this.selectedMarkerId ? this.markerById(this.selectedMarkerId)
            : this.selectedEventId ? this.eventById(this.selectedEventId)
              : this.zoneById(this.selectedId);
          if (!item) return;
          if (btn.dataset.cardAction === 'open') this.activate(item);
        });
      }
      if (this.selectedMarkerId) { this.renderMarkerCard(); return; }
      if (this.selectedEventId) { this.renderEventCard(); return; }
      const zone = this.zoneById(this.selectedId);
      if (!zone) { this.cardEl.hidden = true; return; }

      let action = '';
      if (zone.locked) action = '<div class="map-zone-card-note"><i class="fas fa-lock"></i> Статья этой зоны вам недоступна</div>';
      else if (zone.articleMissing) action = `<button type="button" class="btn btn-secondary btn-sm" data-card-action="open"><i class="fas fa-plus"></i> Создать статью «${escapeHtml(zone.title || zone.article)}»</button>`;
      else if (zone.article) action = `<button type="button" class="btn btn-primary btn-sm" data-card-action="open"><i class="fas fa-book-open"></i> Открыть статью</button>${this.touch ? '' : '<span class="map-zone-card-tip">или двойной клик по зоне</span>'}`;
      else action = '<div class="map-zone-card-note">Статья к зоне не привязана</div>';

      this.cardEl.innerHTML = `
        <button type="button" class="map-zone-card-close" data-card-action="close" aria-label="Закрыть"><i class="fas fa-xmark"></i></button>
        <div class="map-zone-card-type" style="--zone-color:${escapeHtml(effectiveType(this.types.get(zone.typeId), zone.style).color)}">${escapeHtml(this.typeName(zone))}</div>
        <div class="map-zone-card-title">${escapeHtml(zone.title || 'Без названия')}</div>
        ${zone.articleTitle && zone.articleTitle !== zone.title ? `<div class="map-zone-card-sub">${escapeHtml(zone.articleTitle)}</div>` : ''}
        ${this.hasTime && (zone.from != null || zone.to != null) ? `<div class="map-zone-card-when"><i class="fas fa-hourglass-half"></i> ${escapeHtml(formatRange(this.data.calendar, zone.from, zone.to))}</div>` : ''}
        <div class="map-zone-card-actions">${action}</div>`;
      this.cardEl.hidden = false;
    }

    cardAction(item, noun) {
      if (item.locked) return `<div class="map-zone-card-note"><i class="fas fa-lock"></i> Статья ${noun === 'события' ? 'этого' : 'этой'} ${noun} вам недоступна</div>`;
      if (item.articleMissing) return `<button type="button" class="btn btn-secondary btn-sm" data-card-action="open"><i class="fas fa-plus"></i> Создать статью «${escapeHtml(item.title || item.article)}»</button>`;
      if (item.article) return `<button type="button" class="btn btn-primary btn-sm" data-card-action="open"><i class="fas fa-book-open"></i> Открыть статью</button>${this.touch || noun === 'события' ? '' : `<span class="map-zone-card-tip">или двойной клик по ${noun === 'метки' ? 'метке' : 'зоне'}</span>`}`;
      return '';
    }

    renderMarkerCard() {
      const m = this.markerById(this.selectedMarkerId);
      if (!m) { this.cardEl.hidden = true; return; }
      const t = this.markerType(m);
      const text = (m.text || '').trim();
      this.cardEl.innerHTML = `
        <button type="button" class="map-zone-card-close" data-card-action="close" aria-label="Закрыть"><i class="fas fa-xmark"></i></button>
        <div class="map-zone-card-type map-zone-card-type-marker" style="--zone-color:${escapeHtml(t.color)}"><i class="fas fa-${escapeHtml(t.icon)}"></i> ${escapeHtml(t.name)}</div>
        <div class="map-zone-card-title">${escapeHtml(m.title || t.name)}</div>
        ${m.articleTitle && m.articleTitle !== m.title ? `<div class="map-zone-card-sub">${escapeHtml(m.articleTitle)}</div>` : ''}
        ${text ? `<div class="map-zone-card-text">${escapeHtml(text).replace(/\n/g, '<br>')}</div>` : ''}
        <div class="map-zone-card-actions">${this.cardAction(m, 'метки')}</div>`;
      this.cardEl.hidden = false;
    }

    // ===== Таймлайн (этап 3) =====

    eventById(id) { return (this.data.events || []).find((e) => e.id === id) || null; }

    // Подложка, привязанная ко времени: первая, в чей интервал попал момент t.
    // Подложки без интервала — обычные, выбираются читателем.
    basemapForTime(t) {
      if (t === null || t === undefined) return null;
      // Фон по периодам (настройка шкалы карты): период, в который попал момент.
      const periods = (this.data.timeline && this.data.timeline.periods) || [];
      if (periods.length) {
        const p = periods.find((x) => existsAt(x, t));
        const bm = p && this.data.basemaps.find((b) => b.id === p.basemapId);
        if (bm) return bm;
        return this._chosenBasemap ? this.data.basemaps.find((b) => b.id === this._chosenBasemap) || null : this.data.basemaps[0] || null;
      }
      const timed = (this.data.basemaps || []).filter((b) => b.from != null || b.to != null);
      if (!timed.length) return null;
      return timed.find((b) => existsAt(b, t)) || (this.data.basemaps || []).find((b) => b.from == null && b.to == null) || null;
    }

    // Смена подложки с плавным растворением старой.
    fadeToBasemap(id) {
      const bm = this.data.basemaps.find((b) => b.id === id);
      if (!bm || id === this.currentBasemapId) return;
      const old = this.basemapLayer;
      const layer = makeTileLayer(bm, this.size).setOpacity(0).addTo(this.map);
      this.basemapLayer = layer;
      this.currentBasemapId = id;
      const start = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - start) / 450);
        layer.setOpacity(k);
        if (k < 1) requestAnimationFrame(step);
        else if (old) this.map.removeLayer(old);
      };
      layer.once('load', () => requestAnimationFrame(step));
      setTimeout(() => { if (old && this.map && this.map.hasLayer(old)) { layer.setOpacity(1); this.map.removeLayer(old); } }, 4000);
      if (this.opts.onBasemapChange) this.opts.onBasemapChange(id);
    }

    // Перейти к моменту t. animate — перетекание границ (при клике по событию,
    // «вперёд/назад»); при перетаскивании ползунка — мгновенно.
    setTime(t, { animate = true } = {}) {
      if (!this.hasTime) return;
      t = Math.round(Math.max(this.range.min, Math.min(this.range.max, t)));
      if (t === this.time) { this.updateTimelineUI(); return; }
      this.time = t;
      let shapeChanged = false;
      this.data.zones.forEach((z) => {
        const idx = shapeIndexAt(z, t);
        if (idx === z._shapeIndex) return;
        const fromPoly = z.polygon;
        z._shapeIndex = idx;
        z.polygon = z.shapes[idx].polygon;
        shapeChanged = true;
        const layer = this.zoneLayers.get(z.id);
        if (!layer) return;
        if (animate && existsAt(z, t)) this.morphZone(z, layer, fromPoly, z.polygon);
        else layer.setLatLngs(polygonToLatLngs(z.polygon));
      });
      if (this.selectedId && !existsAt(this.zoneById(this.selectedId) || {}, t)) this.selectZone(null);
      if (this.selectedMarkerId && !existsAt(this.markerById(this.selectedMarkerId) || {}, t)) this.selectZone(null);
      const bm = this.basemapForTime(t);
      if (bm) this.fadeToBasemap(bm.id);
      this.updateZoomVisibility();
      if (shapeChanged) {
        clearTimeout(this._labelTimer);
        this._labelTimer = setTimeout(() => this.renderLabels(), animate ? 650 : 0);
      } else {
        this.updateLabels();
      }
      this.updateTimelineUI();
      if (this.opts.onTimeChange) this.opts.onTimeChange(t);
    }

    // Перетекание границы: одна замкнутая линия → одна — плавная
    // интерполяция формы (flubber); распад/слияние/дыры — растворение.
    morphZone(zone, layer, fromPoly, toPoly) {
      const prev = this._morphs.get(zone.id);
      if (prev) cancelAnimationFrame(prev);
      const fl = window.flubber;
      const simple = (p) => p && p.length === 1 && p[0].length === 1 && p[0][0].length <= 1500;
      let interp = null;
      if (fl && simple(fromPoly) && simple(toPoly)) {
        const bb = polygonBBox(toPoly);
        const seg = Math.max(2, Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) / 90);
        try { interp = fl.interpolate(fromPoly[0][0], toPoly[0][0], { string: false, maxSegmentLength: seg }); } catch (e) { interp = null; }
      }
      if (interp) {
        const start = performance.now();
        const step = (now) => {
          if (!this.map) return;
          const k = Math.min(1, (now - start) / 600);
          const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          if (k < 1) {
            layer.setLatLngs(polygonToLatLngs([[interp(ease)]]));
            this._morphs.set(zone.id, requestAnimationFrame(step));
          } else {
            layer.setLatLngs(polygonToLatLngs(toPoly));
            this._morphs.delete(zone.id);
          }
        };
        this._morphs.set(zone.id, requestAnimationFrame(step));
        return;
      }
      const el = layer.getElement && layer.getElement();
      if (!el) { layer.setLatLngs(polygonToLatLngs(toPoly)); return; }
      el.style.transition = 'opacity .25s ease';
      el.style.opacity = '0';
      setTimeout(() => {
        if (!this.map) return;
        layer.setLatLngs(polygonToLatLngs(toPoly));
        el.style.opacity = '';
        setTimeout(() => { el.style.transition = ''; }, 300);
      }, 250);
    }

    // Шкала внизу карты: события точками (моментальные) и полосами
    // (длительные), ползунок момента, переходы к предыдущему/следующему событию.
    buildTimeline() {
      const el = document.createElement('div');
      el.className = 'map-timeline';
      this.container.appendChild(el);
      this.timelineEl = el;
      this.container.classList.add('has-timeline');
      const { min, max } = this.range;
      const span = Math.max(1, max - min);
      const pct = (t) => ((t - min) / span) * 100;

      // Длительные события — по дорожкам, чтобы полосы не налезали.
      const events = (this.data.events || []).slice().sort((a, b) => a.from - b.from);
      const laneEnds = [];
      const items = events.map((e) => {
        if (e.to === null || e.to === undefined) return `<button type="button" class="map-tl-event map-tl-point" data-event-id="${escapeHtml(e.id)}" style="left:${pct(e.from).toFixed(3)}%" title="${escapeHtml(`${formatTime(this.data.calendar, e.from)} — ${e.title}`)}"></button>`;
        let lane = laneEnds.findIndex((end) => end <= e.from);
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(e.to); } else laneEnds[lane] = e.to;
        lane = Math.min(lane, 2);
        return `<button type="button" class="map-tl-event map-tl-bar" data-event-id="${escapeHtml(e.id)}" style="left:${pct(e.from).toFixed(3)}%;width:${Math.max(0.6, pct(e.to) - pct(e.from)).toFixed(3)}%;--lane:${lane}" title="${escapeHtml(`${formatRange(this.data.calendar, e.from, e.to)} — ${e.title}`)}"></button>`;
      }).join('');

      // На телефоне при большом числе событий шкала шире экрана и листается.
      const wide = this.touch && events.length > 8 ? `style="width:${events.length * 56}px"` : '';
      el.innerHTML = `
        <div class="map-tl-head">
          <button type="button" class="map-tl-btn" data-tl="prev" title="Предыдущее событие"><i class="fas fa-backward-step"></i></button>
          <span class="map-tl-date"></span>
          <button type="button" class="map-tl-btn" data-tl="next" title="Следующее событие"><i class="fas fa-forward-step"></i></button>
        </div>
        <div class="map-tl-scroll">
          <div class="map-tl-track" ${wide}>
            <div class="map-tl-events">${items}</div>
            <input type="range" class="map-tl-range" min="${min}" max="${max}" step="1" value="${this.time}" aria-label="Момент времени">
          </div>
        </div>`;

      const range = el.querySelector('.map-tl-range');
      let frame = null;
      range.addEventListener('input', () => {
        if (frame) return;
        frame = requestAnimationFrame(() => { frame = null; this.setTime(Number(range.value), { animate: false }); });
      });
      el.addEventListener('click', (e) => {
        const ev = e.target.closest('[data-event-id]');
        if (ev) { this.selectEvent(ev.dataset.eventId); return; }
        const btn = e.target.closest('[data-tl]');
        if (!btn) return;
        const list = events.map((x) => x.from);
        const target = btn.dataset.tl === 'prev'
          ? [...list].reverse().find((f) => f < this.time)
          : list.find((f) => f > this.time);
        if (target !== undefined) {
          const e2 = events.find((x) => x.from === target);
          if (e2) this.selectEvent(e2.id); else this.setTime(target);
        }
      });
      // Колесо над шкалой не должно масштабировать карту.
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
      this.updateTimelineUI();
    }

    updateTimelineUI() {
      if (!this.timelineEl) return;
      const range = this.timelineEl.querySelector('.map-tl-range');
      if (range && Number(range.value) !== this.time) range.value = String(this.time);
      const date = this.timelineEl.querySelector('.map-tl-date');
      if (date) date.textContent = formatTime(this.data.calendar, this.time);
      this.timelineEl.querySelectorAll('[data-event-id]').forEach((b) => {
        const e = this.eventById(b.dataset.eventId);
        b.classList.toggle('is-current', !!e && existsAt({ from: e.from, to: e.to === null ? e.from + 1 : e.to }, this.time));
        b.classList.toggle('is-selected', b.dataset.eventId === this.selectedEventId);
      });
    }

    // Выбор события: переход к его началу, подсветка связанных зон и
    // меток, карточка с описанием.
    selectEvent(id) {
      const e = this.eventById(id);
      if (!e) return;
      // Повторное нажатие на то же событие — свернуть: карточка закрывается,
      // подсветка снимается.
      if (id === this.selectedEventId) {
        this.clearEventHighlight();
        this.renderCard();
        if (this.opts.onSelect) this.opts.onSelect(null, 'event');
        return;
      }
      this.clearEventHighlight();
      this.clearMarkerSelection();
      if (this.selectedId) { const z = this.selectedId; this.selectedId = null; this.applyStyle(z); }
      this.selectedEventId = id;
      this.setTime(e.from);
      e.zoneIds.forEach((zid) => {
        const el = this.zoneLayers.get(zid) && this.zoneLayers.get(zid).getElement();
        if (el) el.classList.add('map-zone-event');
      });
      e.markerIds.forEach((mid) => {
        const entry = this.markerLayers.get(mid);
        const el = entry && entry.marker.getElement && entry.marker.getElement();
        if (el) el.classList.add('map-marker-event');
      });
      // Показать связанные зоны целиком.
      const boxes = e.zoneIds.map((zid) => this.zoneById(zid)).filter(Boolean).map((z) => polygonBBox(z.polygon)).filter(Boolean);
      if (boxes.length) {
        const b = boxes.reduce((acc, x) => ({ minX: Math.min(acc.minX, x.minX), minY: Math.min(acc.minY, x.minY), maxX: Math.max(acc.maxX, x.maxX), maxY: Math.max(acc.maxY, x.maxY) }));
        this.map.flyToBounds(bboxToLatLngBounds(b), { padding: [50, 50], maxZoom: 1, duration: 0.6 });
      }
      this.updateTimelineUI();
      this.renderCard();
      if (this.opts.onSelect) this.opts.onSelect(id, 'event');
    }

    clearEventHighlight() {
      if (!this.selectedEventId) return;
      this.selectedEventId = null;
      this.container.querySelectorAll('.map-zone-event').forEach((el) => el.classList.remove('map-zone-event'));
      this.container.querySelectorAll('.map-marker-event').forEach((el) => el.classList.remove('map-marker-event'));
      this.updateTimelineUI();
    }

    renderEventCard() {
      const e = this.eventById(this.selectedEventId);
      if (!e) { this.cardEl.hidden = true; return; }
      const text = (e.text || '').trim();
      const zones = e.zoneIds.map((id) => this.zoneById(id)).filter(Boolean);
      const markers = e.markerIds.map((id) => this.markerById(id)).filter(Boolean);
      const links = [
        ...zones.map((z) => `<button type="button" class="map-card-chip" data-card-action="goto-zone" data-id="${escapeHtml(z.id)}">${escapeHtml(z.title || 'Зона')}</button>`),
        ...markers.map((m) => `<button type="button" class="map-card-chip" data-card-action="goto-marker" data-id="${escapeHtml(m.id)}"><i class="fas fa-location-dot"></i> ${escapeHtml(m.title || 'Метка')}</button>`)
      ].join('');
      this.cardEl.innerHTML = `
        <button type="button" class="map-zone-card-close" data-card-action="close" aria-label="Закрыть"><i class="fas fa-xmark"></i></button>
        <div class="map-zone-card-type map-zone-card-type-marker" style="--zone-color:var(--blurple)"><i class="fas fa-hourglass-half"></i> ${escapeHtml(formatRange(this.data.calendar, e.from, e.to))}</div>
        <div class="map-zone-card-title">${escapeHtml(e.title)}</div>
        ${text ? `<div class="map-zone-card-text">${escapeHtml(text).replace(/\n/g, '<br>')}</div>` : ''}
        ${links ? `<div class="map-card-chips">${links}</div>` : ''}
        <div class="map-zone-card-actions">${this.cardAction(e, 'события')}</div>`;
      this.cardEl.hidden = false;
    }

    setInitialView() {
      const { opts } = this;
      const full = imageBounds(this.size);
      this.map.fitBounds(full, { animate: false });
      this.fullZoom = this.map.getZoom();
      this.map.setMinZoom(Math.min(this.fullZoom - 1, this.map.getMinZoom()));

      if (opts.view && Number.isFinite(opts.view.x) && Number.isFinite(opts.view.y) && Number.isFinite(opts.view.zoom)) {
        this.map.setView(toLatLng([opts.view.x, opts.view.y]), opts.view.zoom, { animate: false });
      } else if (opts.focusZoneId && this.zoneById(opts.focusZoneId)) {
        const bbox = polygonBBox(this.zoneById(opts.focusZoneId).polygon);
        if (bbox) this.map.fitBounds(bboxToLatLngBounds(bbox), { padding: [30, 30], maxZoom: 1, animate: false });
      }
      if (opts.focusZoneId && this.zoneById(opts.focusZoneId)) {
        this.selectedId = opts.focusZoneId;
        this.applyStyle(opts.focusZoneId);
        if (opts.mode !== 'embed') this.renderCard();
      }
    }

    getView() {
      const c = fromLatLng(this.map.getCenter());
      return { x: Math.round(c[0]), y: Math.round(c[1]), zoom: Math.round(this.map.getZoom() * 4) / 4 };
    }

    destroy() {
      this._morphs.forEach((id) => cancelAnimationFrame(id));
      clearTimeout(this._labelTimer);
      if (this._resizeObserver) this._resizeObserver.disconnect();
      if (this.map) this.map.remove();
      this.map = null;
      this.container.innerHTML = '';
    }
  }

  // Переход по зоне: статья есть — открыть; нет — создать с названием зоны.
  function openZoneArticle(zone) {
    if (zone.locked) return;
    if (zone.article && !zone.articleMissing) {
      window.spaRouter?.openIbripediaArticle(zone.article);
      return;
    }
    if (zone.articleMissing || zone.article) {
      window.ibripediaManager?.createArticleWithTitle(zone.title || zone.article || '');
    }
  }

  // ===== Встраивание в статью (блок `map`, см. blocks-renderer.js) =====

  const embedInstances = new Set();
  const mapCache = new Map(); // mapId -> Promise<data>

  function fetchViewerMap(mapId, { fresh = false } = {}) {
    if (fresh || !mapCache.has(mapId)) {
      const p = window.apiClient.makeAuthenticatedRequest(`/api/maps/${encodeURIComponent(mapId)}`).then((r) => {
        if (!r.success) throw new Error((r.data && r.data.error) || r.error || 'Карта недоступна');
        return r.data;
      });
      mapCache.set(mapId, p);
      p.catch(() => mapCache.delete(mapId));
      setTimeout(() => mapCache.delete(mapId), 60000); // короткий кэш — превью редактора перерисовывается часто
    }
    return mapCache.get(mapId);
  }

  // Карты, чей контейнер ушёл из DOM (перерисовка статьи/превью), — удаляем,
  // иначе Leaflet оставлял бы подписки на window.
  function sweepEmbeds() {
    embedInstances.forEach((v) => {
      if (!document.body.contains(v.container)) { v.destroy(); embedInstances.delete(v); }
    });
  }

  async function mountEmbeds(root) {
    sweepEmbeds();
    if (!window.L) return;
    const els = (root || document).querySelectorAll('.blk-map[data-map-id]:not([data-map-mounted])');
    for (const el of els) {
      el.setAttribute('data-map-mounted', '1');
      const mapId = el.getAttribute('data-map-id');
      let cfg = {};
      try { cfg = JSON.parse(el.getAttribute('data-map-config') || '{}'); } catch (e) { cfg = {}; }
      const canvas = el.querySelector('.blk-map-canvas') || el;
      // В предпросмотре редактора статей переход по зоне увёл бы со
      // страницы редактора — там зоны только подсвечиваются.
      const inEditor = !!el.closest('.editor-panes, .preview-pane');
      try {
        const data = await fetchViewerMap(mapId);
        canvas.innerHTML = '';
        if (!data.basemaps.length) {
          canvas.innerHTML = '<div class="blk-map-error"><i class="fas fa-image"></i> У карты ещё нет фона</div>';
          continue;
        }
        const viewer = new MapViewer(canvas, data, {
          mode: 'embed', view: cfg.view, focusZoneId: cfg.focusZoneId, basemapId: cfg.basemapId, time: cfg.time,
          onZoneActivate: inEditor ? () => window.showMessage?.('В предпросмотре редактора переход по зонам отключён', 'info') : undefined
        });
        embedInstances.add(viewer);
        addEmbedControls(el, viewer, mapId, { inEditor });
      } catch (err) {
        canvas.innerHTML = `<div class="blk-map-error"><i class="fas fa-map"></i> ${escapeHtml(err.message)}</div>`;
      }
    }
  }

  function addEmbedControls(el, viewer, mapId, { inEditor = false } = {}) {
    const bar = document.createElement('div');
    bar.className = 'blk-map-controls';
    const basemaps = viewer.data.basemaps;
    bar.innerHTML = `
      ${basemaps.length > 1 ? `<select class="blk-map-basemap" title="Фон карты">${basemaps.map((b) => `<option value="${escapeHtml(b.id)}"${b.id === viewer.currentBasemapId ? ' selected' : ''}>${escapeHtml(b.title)}</option>`).join('')}</select>` : ''}
      ${inEditor ? '' : '<button type="button" class="blk-map-fullscreen" title="Открыть на весь экран"><i class="fas fa-expand"></i></button>'}`;
    bar.querySelector('.blk-map-basemap')?.addEventListener('change', (e) => viewer.setBasemap(e.target.value));
    bar.querySelector('.blk-map-fullscreen')?.addEventListener('click', () => {
      window.MapsUI?.openMapPage(mapId, { zoneId: viewer.selectedId, view: viewer.getView(), basemapId: viewer.currentBasemapId, time: viewer.time });
    });
    el.appendChild(bar);
  }

  window.MapCore = {
    TILE_SIZE,
    escapeHtml,
    isTouchUi,
    toLatLng,
    fromLatLng,
    polygonToLatLngs,
    imageBounds,
    polygonBBox,
    bboxToLatLngBounds,
    polygonArea,
    pointInMulti,
    labelPoint,
    typeMap,
    baseStyle,
    hoverStyle,
    effectiveType,
    FALLBACK_MARKER_TYPE,
    zoneDepths,
    makeTileLayer,
    loadScript,
    MapViewer,
    openZoneArticle,
    fetchViewerMap,
    mountEmbeds,
    sweepEmbeds,
    FALLBACK_TYPE,
    DEFAULT_CALENDAR,
    calendarEras,
    toEraYear,
    fromEraYear,
    formatTime,
    formatRange,
    existsAt,
    shapeIndexAt,
    mapHasTime,
    timeRange
  };
})();
