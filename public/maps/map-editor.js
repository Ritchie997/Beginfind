// map-editor.js — редактор интерактивной карты (ПК), страница /map/:id/edit.
//
// Инструменты:
//   V — выбор зоны;  P — многоугольник по точкам;  L — лассо (от руки);
//   E — правка точек выбранной зоны.
// Новая форма создаёт зону; с Shift — добавляется к выбранной зоне, с Alt —
// вырезается из неё (операции над контурами — библиотека polygon-clipping).
// Пробел (зажать) — двигать карту во время рисования. Ctrl+Z / Ctrl+Y —
// отмена/повтор, Ctrl+S — сохранить, Delete — удалить выбранную зону.
//
// Состояние редактора — полная копия карты (зоны с ролями, как хранит
// сервер). Каждое изменение пишется в черновик localStorage: закрыли вкладку
// или ушли на другую страницу — при следующем открытии редактор предложит
// восстановить несохранённое.

(function () {
  'use strict';

  const MC = () => window.MapCore;
  const esc = (s) => window.MapCore.escapeHtml(s);
  const POLYGON_CLIPPING_SRC = 'https://cdn.jsdelivr.net/npm/polygon-clipping@0.15.7/dist/polygon-clipping.umd.min.js';
  const DRAFT_PREFIX = 'beginfind.mapDraft.';
  const HISTORY_LIMIT = 80;
  const MAX_HANDLES = 700;

  const TOOLS = [
    { id: 'select', key: 'v', icon: 'fa-arrow-pointer', label: 'Выбор', hint: 'Клик по зоне — выбрать. Двойной клик — править её точки.' },
    { id: 'polygon', key: 'p', icon: 'fa-draw-polygon', label: 'Многоугольник', hint: 'Клик — точка. Двойной клик, Enter или клик по первой точке — готово. Backspace — убрать точку, Esc — отмена. Shift — добавить к выбранной, Alt — вырезать.' },
    { id: 'lasso', key: 'l', icon: 'fa-signature', label: 'Лассо', hint: 'Зажмите кнопку мыши и обведите область. Shift — добавить к выбранной зоне, Alt — вырезать из неё. Пробел — двигать карту.' },
    { id: 'vertex', key: 'e', icon: 'fa-bezier-curve', label: 'Правка точек', hint: 'Тяните точку. Промежуточная точка между двумя — добавить новую. Правый клик по точке — удалить.' },
    { id: 'marker', key: 'm', icon: 'fa-location-dot', label: 'Метка', hint: 'Клик — поставить метку. Метки перетаскиваются мышью; тип, описание и статья — в свойствах справа.' }
  ];

  // ===== Утилиты =====

  function genId(prefix) {
    return prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  const RU_TO_LAT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  // Зеркало src/services/slugify.js — slug статьи по введённому названию.
  function slugify(text) {
    return String(text || '').split('').map((ch) => {
      const lower = ch.toLowerCase();
      return Object.prototype.hasOwnProperty.call(RU_TO_LAT, lower) ? RU_TO_LAT[lower] : ch;
    }).join('').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 80) || 'article';
  }

  // Результат polygon-clipping: кольца замкнуты (последняя точка = первая) —
  // храним без замыкающей, как сервер; вырожденные кольца выкидываем.
  function cleanMulti(multi) {
    const out = [];
    (multi || []).forEach((poly) => {
      const rings = [];
      poly.forEach((ring, i) => {
        const r = ring.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
        if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
        if (r.length >= 3) rings.push(r);
        else if (i === 0) rings.length = 0;
      });
      if (rings.length) out.push(rings);
    });
    return out;
  }

  function pointCount(multi) {
    return (multi || []).reduce((n, poly) => n + poly.reduce((m, r) => m + r.length, 0), 0);
  }

  // ===== Редактор =====

  class MapEditor {
    constructor(root, data) {
      this.root = root;
      this.mapId = data.id;
      this.serverId = data.serverId;
      this.canDelete = !!data.can_delete;
      this.chunkSize = data.chunkSize;
      this.maxSourceBytes = data.maxSourceBytes;
      this.zoneTypes = data.zoneTypes || [];
      this.types = MC().typeMap(this.zoneTypes);
      this.baseUpdatedAt = data.updated_at;
      this.size = data.size;
      this.basemaps = data.basemaps || [];
      this.markerTypes = data.markerTypes || [];
      this.mtypes = MC().typeMap(this.markerTypes);
      this.doc = { title: data.title, roles: data.roles || [], zones: data.zones || [], markers: data.markers || [] };
      this.selectedMarkerId = null;
      this.markerLayers = new Map();
      this.selectedId = null;
      this.tool = 'select';
      this.undoStack = [];
      this.redoStack = [];
      this.dirty = false;
      this.mods = { shift: false, alt: false, space: false };
      this.draw = null; // состояние рисования (polygon/lasso)
      this.handles = [];
      this.articles = []; // [{slug,title}] — для поля "Статья"
      this.roleOptions = [];
      this.zoneLayers = new Map();
      this.sidebarTab = 'zones';

      this.buildLayout();
      this.bindGlobal();
      this.initMap();
      this.renderAll();
      this.loadLookups();
      this.offerDraftRestore();
      this.startBasemapPolling();
    }

    // ----- Разметка -----

    buildLayout() {
      this.root.innerHTML = `
        <div class="map-fs map-editor">
          <div class="map-fs-topbar">
            <button type="button" class="map-fs-btn" data-act="back" title="Закрыть редактор"><i class="fas fa-arrow-left"></i></button>
            <input type="text" class="me-title-input" maxlength="120" value="${esc(this.doc.title)}" title="Название карты">
            <span class="me-status" data-el="status"></span>
            <div class="map-fs-actions">
              <select class="map-fs-select" data-el="basemap-select" title="Подложка" hidden></select>
              <button type="button" class="map-fs-btn" data-act="undo" title="Отменить (Ctrl+Z)"><i class="fas fa-rotate-left"></i></button>
              <button type="button" class="map-fs-btn" data-act="redo" title="Повторить (Ctrl+Y)"><i class="fas fa-rotate-right"></i></button>
              <button type="button" class="map-fs-btn" data-act="preview" title="Открыть просмотр"><i class="fas fa-eye"></i><span class="map-fs-btn-label"> Просмотр</span></button>
              <button type="button" class="map-fs-btn map-fs-btn-primary" data-act="save" title="Сохранить (Ctrl+S)"><i class="fas fa-floppy-disk"></i><span class="map-fs-btn-label"> Сохранить</span></button>
            </div>
          </div>
          <div class="me-body">
            <div class="me-tools">
              ${TOOLS.map((t) => `<button type="button" class="me-tool" data-tool="${t.id}" title="${esc(t.label)} (${t.key.toUpperCase()})"><i class="fas ${t.icon}"></i></button>`).join('')}
            </div>
            <div class="me-canvas-wrap">
              <div class="me-canvas"></div>
              <div class="me-hint" data-el="hint"></div>
              <div class="me-overlay" data-el="overlay" hidden></div>
            </div>
            <aside class="me-side">
              <div class="me-side-tabs">
                <button type="button" class="me-side-tab active" data-side-tab="zones"><i class="fas fa-layer-group"></i> Зоны</button>
                <button type="button" class="me-side-tab" data-side-tab="map"><i class="fas fa-map"></i> Карта</button>
                <button type="button" class="me-side-tab" data-side-tab="world" title="Типы зон — общие для всех карт этого мира"><i class="fas fa-earth-europe"></i> Мир</button>
              </div>
              <div class="me-side-body" data-side-body="zones">
                <div class="me-tree" data-el="tree"></div>
                <div class="me-props" data-el="props"></div>
              </div>
              <div class="me-side-body" data-side-body="map" hidden>
                <div data-el="map-settings"></div>
              </div>
              <div class="me-side-body" data-side-body="world" hidden>
                <div data-el="world"></div>
              </div>
            </aside>
          </div>
        </div>`;
      this.el = (name) => this.root.querySelector(`[data-el="${name}"]`);
      this.canvasEl = this.root.querySelector('.me-canvas');
      this.wrapEl = this.root.querySelector('.me-canvas-wrap');

      this.root.addEventListener('click', (e) => this.onRootClick(e));
      this.root.querySelector('.me-title-input').addEventListener('focus', () => this.pushHistory());
      this.root.querySelector('.me-title-input').addEventListener('input', (e) => { this.doc.title = e.target.value; this.markDirty(); });
      this.el('basemap-select').addEventListener('change', (e) => this.setBasemap(e.target.value));
    }

    onRootClick(e) {
      const tool = e.target.closest('[data-tool]');
      if (tool) { this.setTool(tool.dataset.tool); return; }
      const tab = e.target.closest('[data-side-tab]');
      if (tab) { this.setSideTab(tab.dataset.sideTab); return; }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      switch (btn.dataset.act) {
        case 'back': this.close(); break;
        case 'undo': this.undo(); break;
        case 'redo': this.redo(); break;
        case 'save': this.save(); break;
        case 'preview': this.preview(); break;
      }
    }

    setSideTab(tab) {
      this.sidebarTab = tab;
      this.root.querySelectorAll('[data-side-tab]').forEach((b) => b.classList.toggle('active', b.dataset.sideTab === tab));
      this.root.querySelectorAll('[data-side-body]').forEach((b) => { b.hidden = b.dataset.sideBody !== tab; });
      if (tab === 'map') this.renderMapSettings();
      // Типы мира монтируем один раз — несохранённые правки типов не
      // теряются при переключении вкладок.
      if (tab === 'world' && !this._worldMounted && this.serverId) {
        this._worldMounted = true;
        window.MapsUI.mountWorldEditor(this.el('world'), this.serverId, {
          onSaved: (world) => this.applyZoneTypes(world),
          onChange: (world) => this.previewWorld(world)
        });
      }
    }

    // Типы мира сохранены — сразу перерисовываем зоны новыми цветами/стилями.
    // Живой предпросмотр несохранённых правок мира: цвет ползунком меняется
    // десятки раз в секунду — перерисовываем не чаще раза за кадр и без
    // панели свойств (она в другой вкладке и пересоздаёт поля ролей).
    previewWorld(world) {
      this._pendingWorld = world;
      if (this._worldFrame) return;
      this._worldFrame = requestAnimationFrame(() => {
        this._worldFrame = null;
        if (this.map && this._pendingWorld) this.applyZoneTypes(this._pendingWorld, { live: true });
      });
    }

    applyZoneTypes(world, { live = false } = {}) {
      const w = Array.isArray(world) ? { zoneTypes: world } : (world || {});
      this.zoneTypes = w.zoneTypes || this.zoneTypes;
      this.types = MC().typeMap(this.zoneTypes);
      if (w.markerTypes) { this.markerTypes = w.markerTypes; this.mtypes = MC().typeMap(this.markerTypes); }
      this.renderZoneLayers();
      this.renderMarkerLayers();
      this.renderTree();
      if (!live) this.renderProps();
    }

    // ----- Карта (Leaflet) -----

    initMap() {
      const size = this.size || { w: 4096, h: 4096 };
      const maxZoom = Math.max(0, Math.ceil(Math.log2(Math.max(size.w, size.h) / MC().TILE_SIZE)));
      this.map = L.map(this.canvasEl, {
        crs: L.CRS.Simple,
        minZoom: -maxZoom - 3,
        // Шаг — целый, как в просмотре (без мутных промежуточных масштабов);
        // приближение глубже, чем в просмотре (до 8×) — чтобы точно ставить точки.
        maxZoom: 3,
        zoomSnap: 1,
        zoomDelta: 1,
        wheelPxPerZoomLevel: 100,
        attributionControl: false,
        doubleClickZoom: false,
        boxZoom: false
      });
      this.map.zoomControl.setPosition('bottomright');
      this.zonesPane = this.map.createPane('zonesPane');
      this.zonesPane.style.zIndex = 450;
      this.renderer = L.svg({ padding: 0.5, pane: 'zonesPane' });
      this.drawLayer = L.layerGroup().addTo(this.map);
      this.handleLayer = L.layerGroup().addTo(this.map);
      this.markerLayer = L.layerGroup().addTo(this.map); // в редакторе без группировки — править надо каждую

      this.applySize();

      this.map.on('click', (e) => this.onMapClick(e));
      this.map.on('dblclick', (e) => this.onMapDblClick(e));
      this.map.on('mousemove', (e) => this.onMapMouseMove(e));
      this.map.on('mousedown', (e) => this.onMapMouseDown(e));
      this.map.on('moveend zoomend', () => { if (this.tool === 'vertex') this.renderHandles(); });
      this._resizeObserver = new ResizeObserver(() => this.map.invalidateSize());
      this._resizeObserver.observe(this.wrapEl);
    }

    // Система координат карты задаётся первой подложкой. Пока её нет —
    // рисовать не на чем (зоны съехали бы после загрузки).
    applySize() {
      const overlay = this.el('overlay');
      if (this.boundsRect) { this.boundsRect.remove(); this.boundsRect = null; }
      // Диапазон отдаления — под текущий размер карты (он мог смениться:
      // удалили единственную подложку и загрузили другую, другого размера).
      const size = this.size || { w: 4096, h: 4096 };
      const maxZoom = Math.max(0, Math.ceil(Math.log2(Math.max(size.w, size.h) / MC().TILE_SIZE)));
      this.map.setMinZoom(-maxZoom - 3);
      if (!this.size) {
        this.map.setMaxBounds(null);
        overlay.hidden = false;
        overlay.innerHTML = '<div><i class="fas fa-image"></i><p>Загрузите подложку — изображение карты. От её размера зависит система координат зон.</p><button type="button" class="btn btn-primary btn-sm" data-overlay-act="upload">Загрузить подложку</button></div>';
        overlay.querySelector('[data-overlay-act="upload"]').onclick = () => { this.setSideTab('map'); this.root.querySelector('[data-el="bm-file"]')?.click(); };
        this.map.setView([0, 0], 0);
        return;
      }
      overlay.hidden = true;
      const bounds = MC().imageBounds(this.size);
      this.boundsRect = L.rectangle(bounds, { color: '#72767d', weight: 1, dashArray: '4 4', fill: false, interactive: false }).addTo(this.map);
      this.map.setMaxBounds(bounds.pad(0.6));
      if (!this._fitted) { this.map.fitBounds(bounds, { animate: false }); this._fitted = true; }
      this.refreshBasemapSelect();
    }

    // Размер карты сменился на сервере (первая подложка готова, либо
    // подложку заменили на другую, другого размера) — перестраиваем границы,
    // тайлы и вид; иначе новая подложка показывалась бы в старых границах.
    setSize(size) {
      this.size = size;
      this._fitted = false;
      if (this.tileLayer) { this.tileLayer.remove(); this.tileLayer = null; }
      this.currentBasemapId = null;
      this.applySize();
    }

    readyBasemaps() {
      return this.basemaps.filter((b) => b.status === 'ready' && b.url);
    }

    refreshBasemapSelect() {
      const select = this.el('basemap-select');
      const ready = this.readyBasemaps();
      select.hidden = ready.length < 2;
      select.innerHTML = ready.map((b) => `<option value="${esc(b.id)}">${esc(b.title)}</option>`).join('');
      if (!ready.some((b) => b.id === this.currentBasemapId)) this.setBasemap(ready[0] ? ready[0].id : null);
      else select.value = this.currentBasemapId;
    }

    setBasemap(id) {
      if (this.tileLayer) { this.tileLayer.remove(); this.tileLayer = null; }
      this.currentBasemapId = id;
      const bm = this.basemaps.find((b) => b.id === id);
      if (bm && this.size) {
        this.tileLayer = MC().makeTileLayer(bm, this.size).addTo(this.map);
        this.tileLayer.bringToBack();
      }
      const select = this.el('basemap-select');
      if (id) select.value = id;
    }

    // ----- Зоны на карте -----

    zoneById(id) { return this.doc.zones.find((z) => z.id === id) || null; }
    zonePoly(z) { return (z && z.shapes && z.shapes[0] && z.shapes[0].polygon) || []; }

    descendants(id) {
      const out = new Set();
      const walk = (pid) => this.doc.zones.forEach((z) => { if (z.parentId === pid && !out.has(z.id)) { out.add(z.id); walk(z.id); } });
      walk(id);
      return out;
    }

    renderZoneLayers() {
      this.zoneLayers.forEach((l) => l.remove());
      this.zoneLayers.clear();
      const depths = MC().zoneDepths(this.doc.zones);
      const ordered = this.doc.zones
        .filter((z) => this.zonePoly(z).length)
        .map((z) => ({ z, d: depths.get(z.id) || 0, a: MC().polygonArea(this.zonePoly(z)) }))
        .sort((p, q) => (p.d - q.d) || (q.a - p.a))
        .map((p) => p.z);
      ordered.forEach((zone) => {
        const layer = L.polygon(MC().polygonToLatLngs(this.zonePoly(zone)), { ...this.zoneStyle(zone), renderer: this.renderer, className: 'map-zone' });
        layer.on('click', (e) => {
          if (this.tool !== 'select' && this.tool !== 'vertex') return;
          L.DomEvent.stopPropagation(e);
          this.select(zone.id);
        });
        layer.on('dblclick', (e) => {
          L.DomEvent.stopPropagation(e);
          this.select(zone.id);
          this.setTool('vertex');
        });
        layer.bindTooltip(esc(zone.title || 'Без названия'), { sticky: true, direction: 'top', className: 'map-zone-tooltip', offset: [0, -8] });
        layer.addTo(this.map);
        this.zoneLayers.set(zone.id, layer);
      });
    }

    zoneStyle(zone) {
      const type = this.types.get(zone.typeId);
      const selected = zone.id === this.selectedId;
      const s = selected ? MC().hoverStyle(type, zone.style) : MC().baseStyle(type, zone.style);
      return selected ? { ...s, weight: s.weight + 1, dashArray: '6 4' } : s;
    }

    refreshZoneLayer(zone) {
      const layer = this.zoneLayers.get(zone.id);
      if (!layer) return;
      layer.setLatLngs(MC().polygonToLatLngs(this.zonePoly(zone)));
      layer.setStyle(this.zoneStyle(zone));
    }

    // ----- Выбор и инструменты -----

    select(id, { fly = false } = {}) {
      if (this.selectedMarkerId) {
        const mid = this.selectedMarkerId;
        this.selectedMarkerId = null;
        this.refreshMarkerIcon(mid);
      }
      const prev = this.selectedId;
      this.selectedId = id && this.zoneById(id) ? id : null;
      [prev, this.selectedId].forEach((zid) => { const z = zid && this.zoneById(zid); if (z) this.refreshZoneLayer(z); });
      if (fly && this.selectedId) {
        const bbox = MC().polygonBBox(this.zonePoly(this.zoneById(this.selectedId)));
        if (bbox) this.map.flyToBounds(MC().bboxToLatLngBounds(bbox), { padding: [60, 60], maxZoom: 1, duration: 0.5 });
      }
      if (this.tool === 'vertex') this.renderHandles();
      this.renderTree();
      this.renderProps();
    }

    setTool(tool) {
      if (!TOOLS.some((t) => t.id === tool)) return;
      this.cancelDrawing();
      this.tool = tool;
      this.root.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
      const drawing = tool === 'polygon' || tool === 'lasso';
      this.wrapEl.classList.toggle('me-drawing', drawing);
      this.wrapEl.classList.toggle('me-tool-lasso', tool === 'lasso');
      if (drawing && !this.mods.space) this.map.dragging.disable(); else this.map.dragging.enable();
      if (tool === 'vertex' && !this.selectedId) this.toast('Сначала выберите зону — её точки появятся для правки');
      this.renderHandles();
      this.updateHint();
    }

    updateHint() {
      const t = TOOLS.find((x) => x.id === this.tool);
      let text = t ? t.hint : '';
      if (this.draw && this.draw.kind === 'polygon') text = `Точек: ${this.draw.points.length}. ${text}`;
      this.el('hint').textContent = text;
    }

    // ----- Рисование -----

    clickPoint(e) { return MC().fromLatLng(e.latlng); }

    onMapClick(e) {
      if (this.tool === 'polygon' && this.size) {
        if (this.mods.space) return;
        const pt = this.clickPoint(e);
        if (!this.draw) this.draw = { kind: 'polygon', points: [] };
        const pts = this.draw.points;
        // Клик рядом с первой точкой — замкнуть.
        if (pts.length >= 3) {
          const first = this.map.latLngToContainerPoint(MC().toLatLng(pts[0]));
          if (first.distanceTo(e.containerPoint) < 10) { this.finishPolygon(); return; }
        }
        pts.push(pt);
        this.renderDraft(e.latlng);
        this.updateHint();
        return;
      }
      if (this.tool === 'marker' && this.size) {
        this.addMarker(this.clampToImage(this.clickPoint(e)));
        return;
      }
      if (this.tool === 'select' || this.tool === 'vertex') this.select(null);
    }

    // ----- Метки -----

    markerById(id) { return (this.doc.markers || []).find((m) => m.id === id) || null; }
    markerType(m) { return this.mtypes.get(m.typeId) || MC().FALLBACK_MARKER_TYPE; }

    markerIcon(m) {
      const t = this.markerType(m);
      const selected = m.id === this.selectedMarkerId;
      return L.divIcon({
        className: 'map-marker-anchor',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        html: `<span class="map-marker${selected ? ' is-selected' : ''}" style="--marker-color:${esc(t.color)}"><i class="fas fa-${esc(t.icon)}"></i></span>`
      });
    }

    // Самая глубокая зона, в которой стоит точка: метка скрытой зоны
    // скрывается у читателя вместе с ней.
    zoneForPoint(pt) {
      const depths = MC().zoneDepths(this.doc.zones);
      let best = null;
      this.doc.zones.forEach((z) => {
        if (!MC().pointInMulti(pt, this.zonePoly(z))) return;
        const d = depths.get(z.id) || 0;
        if (!best || d > best.d) best = { z, d };
      });
      return best ? best.z.id : null;
    }

    renderMarkerLayers() {
      if (!this.markerLayer) return;
      this.markerLayer.clearLayers();
      this.markerLayers.clear();
      (this.doc.markers || []).forEach((m) => {
        const marker = L.marker(MC().toLatLng(m.pos), { icon: this.markerIcon(m), draggable: true, keyboard: false, riseOnHover: true });
        marker.on('click', (e) => { L.DomEvent.stopPropagation(e); this.selectMarker(m.id); });
        marker.on('dragstart', () => { this.pushHistory(); this.selectMarker(m.id); });
        marker.on('dragend', () => {
          const pos = this.clampToImage(MC().fromLatLng(marker.getLatLng()));
          m.pos = [Math.round(pos[0] * 10) / 10, Math.round(pos[1] * 10) / 10];
          m.zoneId = this.zoneForPoint(m.pos);
          marker.setLatLng(MC().toLatLng(m.pos));
          this.markDirty();
          this.renderProps();
        });
        marker.bindTooltip(esc(m.title || this.markerType(m).name), { direction: 'top', offset: [0, -16], className: 'map-zone-tooltip' });
        marker.addTo(this.markerLayer);
        this.markerLayers.set(m.id, marker);
      });
    }

    refreshMarkerIcon(id) {
      const m = this.markerById(id);
      const layer = this.markerLayers.get(id);
      if (m && layer) layer.setIcon(this.markerIcon(m));
    }

    addMarker(pos) {
      this.pushHistory();
      const type = this.markerTypes[0] || null;
      const n = (this.doc.markers || []).filter((m) => m.typeId === (type && type.id)).length + 1;
      const marker = {
        id: genId('k'),
        typeId: type ? type.id : null,
        zoneId: this.zoneForPoint(pos),
        title: `${type ? type.name : 'Метка'} ${n}`,
        text: '',
        article: null,
        roles: [],
        lockedMode: 'lock',
        pos: [Math.round(pos[0] * 10) / 10, Math.round(pos[1] * 10) / 10]
      };
      this.doc.markers = [...(this.doc.markers || []), marker];
      this.renderMarkerLayers();
      this.selectMarker(marker.id);
      this.markDirty();
      const titleInput = this.root.querySelector('[data-mprop="title"]');
      if (titleInput) { titleInput.focus(); titleInput.select(); }
    }

    selectMarker(id, { fly = false } = {}) {
      if (this.selectedId) {
        const zid = this.selectedId;
        this.selectedId = null;
        const z = this.zoneById(zid);
        if (z) this.refreshZoneLayer(z);
        this.renderHandles();
      }
      const prev = this.selectedMarkerId;
      this.selectedMarkerId = id && this.markerById(id) ? id : null;
      if (prev) this.refreshMarkerIcon(prev);
      if (this.selectedMarkerId) this.refreshMarkerIcon(this.selectedMarkerId);
      if (fly && this.selectedMarkerId) this.map.flyTo(MC().toLatLng(this.markerById(this.selectedMarkerId).pos), Math.max(this.map.getZoom(), 0), { duration: 0.5 });
      this.renderTree();
      this.renderProps();
    }

    deleteMarker(id) {
      const m = this.markerById(id);
      if (!m || !confirm(`Удалить метку «${m.title || 'без названия'}»?`)) return;
      this.pushHistory();
      this.doc.markers = this.doc.markers.filter((x) => x.id !== id);
      this.selectedMarkerId = null;
      this.renderMarkerLayers();
      this.renderTree();
      this.renderProps();
      this.markDirty();
    }

    onMapDblClick() {
      if (this.tool === 'polygon' && this.draw) {
        // dblclick приходит после двух click — последняя точка задублирована.
        const pts = this.draw.points;
        if (pts.length > 1) {
          const a = pts[pts.length - 1]; const b = pts[pts.length - 2];
          if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6 || this.map.latLngToContainerPoint(MC().toLatLng(a)).distanceTo(this.map.latLngToContainerPoint(MC().toLatLng(b))) < 4) pts.pop();
        }
        this.finishPolygon();
      }
    }

    onMapMouseMove(e) {
      if (this.draw && this.draw.kind === 'polygon') this.renderDraft(e.latlng);
    }

    renderDraft(cursorLatLng) {
      this.drawLayer.clearLayers();
      if (!this.draw) return;
      const lls = this.draw.points.map(MC().toLatLng);
      if (this.draw.kind === 'polygon') {
        const line = cursorLatLng ? [...lls, cursorLatLng] : lls;
        if (line.length > 1) L.polyline(line, { color: '#ffffff', weight: 2, dashArray: '5 5', interactive: false }).addTo(this.drawLayer);
        lls.forEach((ll, i) => L.circleMarker(ll, { radius: i === 0 ? 6 : 4, color: '#ffffff', weight: 2, fillColor: i === 0 ? '#faa81a' : '#5865f2', fillOpacity: 1, interactive: false }).addTo(this.drawLayer));
      } else if (this.draw.kind === 'lasso' && lls.length > 1) {
        L.polyline(lls, { color: '#ffffff', weight: 2, interactive: false }).addTo(this.drawLayer);
      }
    }

    onMapMouseDown(e) {
      if (this.tool !== 'lasso' || !this.size || this.mods.space) return;
      const oe = e.originalEvent;
      if (oe.button !== 0) return;
      oe.preventDefault();
      this.draw = { kind: 'lasso', points: [this.clickPoint(e)], lastCp: e.containerPoint };
      const onMove = (ev) => {
        if (!this.draw || this.draw.kind !== 'lasso') return;
        const cp = this.map.mouseEventToContainerPoint(ev);
        if (cp.distanceTo(this.draw.lastCp) < 3) return;
        this.draw.lastCp = cp;
        this.draw.points.push(MC().fromLatLng(this.map.containerPointToLatLng(cp)));
        this.renderDraft();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        this.finishLasso();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    cancelDrawing() {
      this.draw = null;
      if (this.drawLayer) this.drawLayer.clearLayers();
      this.updateHint && this.el && this.updateHint();
    }

    finishPolygon() {
      const pts = this.draw ? this.draw.points : [];
      this.cancelDrawing();
      if (pts.length < 3) { this.toast('Нужно хотя бы три точки'); return; }
      this.applyNewShape([[pts]]);
    }

    // Лассо упрощаем в экранных пикселях (~1.5 px при текущем масштабе):
    // тысячи точек от движения мыши превращаются в разумный контур.
    finishLasso() {
      const pts = this.draw ? this.draw.points : [];
      this.cancelDrawing();
      if (pts.length < 3) return;
      const layerPts = pts.map((p) => this.map.latLngToLayerPoint(MC().toLatLng(p)));
      const simplified = L.LineUtil.simplify(layerPts, 1.5).map((lp) => MC().fromLatLng(this.map.layerPointToLatLng(lp)));
      if (simplified.length < 3) { this.toast('Слишком маленькая область'); return; }
      this.applyNewShape([[simplified]]);
    }

    clip() { return window.polygonClipping; }

    // Новая форма: Shift — добавить к выбранной зоне, Alt — вырезать из неё,
    // иначе — новая зона (родитель и тип подбираются по месту рисования).
    // Рисовать за краем картинки можно, но в зону попадает только часть
    // внутри неё — граница зоны прилипает к краю карты.
    clipToImage(multi) {
      const clip = this.clip();
      if (!this.size || !clip) return multi;
      const { w, h } = this.size;
      const inside = (p) => p[0] >= 0 && p[1] >= 0 && p[0] <= w && p[1] <= h;
      if (multi.every((poly) => poly.every((ring) => ring.every(inside)))) return multi;
      try {
        return cleanMulti(clip.intersection(multi, [[[0, 0], [w, 0], [w, h], [0, h]]]));
      } catch (e) {
        return multi;
      }
    }

    clampToImage(p) {
      if (!this.size) return p;
      return [Math.min(this.size.w, Math.max(0, p[0])), Math.min(this.size.h, Math.max(0, p[1]))];
    }

    applyNewShape(multi) {
      multi = this.clipToImage(multi);
      if (!multi.length) { this.toast('Область целиком за краем карты'); return; }
      const clip = this.clip();
      const selected = this.zoneById(this.selectedId);
      if ((this.mods.shift || this.mods.alt) && selected) {
        if (!clip) { this.toast('Библиотека операций с контурами не загрузилась'); return; }
        let result;
        try {
          result = this.mods.shift ? clip.union(this.zonePoly(selected), multi) : clip.difference(this.zonePoly(selected), multi);
        } catch (err) { this.toast(`Не удалось совместить контуры: ${err.message}`); return; }
        result = cleanMulti(result);
        if (!result.length) { this.toast('От зоны ничего не осталось — отменено'); return; }
        this.pushHistory();
        selected.shapes = [{ from: null, polygon: result }];
        this.afterZonesChanged({ keepLayers: false });
        return;
      }

      const parent = this.findParentFor(multi);
      const type = this.pickType(parent);
      let polygon = multi;
      if (parent && type && type.clipToParent && clip) {
        try {
          const inter = cleanMulti(clip.intersection(this.zonePoly(parent), multi));
          if (inter.length) polygon = inter;
        } catch (err) { /* оставим как нарисовано */ }
      } else {
        polygon = cleanMulti(clip ? clip.union(multi) : multi); // самопересечения лассо → корректный контур
        if (!polygon.length) polygon = multi;
      }

      this.pushHistory();
      const sameType = this.doc.zones.filter((z) => z.typeId === (type && type.id)).length + 1;
      const zone = {
        id: genId('z'),
        parentId: parent ? parent.id : null,
        typeId: type ? type.id : null,
        title: `${type ? type.name : 'Зона'} ${sameType}`,
        article: null,
        roles: [],
        lockedMode: 'lock',
        shapes: [{ from: null, polygon }]
      };
      this.doc.zones.push(zone);
      this.selectedId = zone.id;
      this.afterZonesChanged({ keepLayers: false });
      const titleInput = this.root.querySelector('[data-prop="title"]');
      if (titleInput) { titleInput.focus(); titleInput.select(); }
    }

    // Родитель — самая глубокая зона, внутри которой лежит большая часть
    // точек новой формы.
    findParentFor(multi) {
      const pts = (multi[0] && multi[0][0]) || [];
      if (!pts.length) return null;
      const depths = MC().zoneDepths(this.doc.zones);
      let best = null;
      this.doc.zones.forEach((z) => {
        const poly = this.zonePoly(z);
        const inside = pts.filter((p) => MC().pointInMulti(p, poly)).length;
        if (inside / pts.length < 0.6) return;
        const d = depths.get(z.id) || 0;
        const a = MC().polygonArea(poly);
        if (!best || d > best.d || (d === best.d && a < best.a)) best = { z, d, a };
      });
      return best ? best.z : null;
    }

    pickType(parent) {
      if (parent) {
        const allowed = this.zoneTypes.find((t) => t.parents.includes(parent.typeId));
        if (allowed) return allowed;
      }
      return this.zoneTypes.find((t) => t.topLevel) || this.zoneTypes[0] || null;
    }

    // ----- Правка точек -----

    renderHandles() {
      if (!this.handleLayer) return;
      this.handleLayer.clearLayers();
      this.handles = [];
      const zone = this.tool === 'vertex' && this.zoneById(this.selectedId);
      if (!zone) return;
      const poly = this.zonePoly(zone);
      const view = this.map.getBounds().pad(0.1);
      const items = [];
      poly.forEach((rings, pi) => rings.forEach((ring, ri) => ring.forEach((pt, i) => {
        const ll = MC().toLatLng(pt);
        if (view.contains(ll)) items.push({ pi, ri, i, ll, mid: false });
        const next = ring[(i + 1) % ring.length];
        const mid = MC().toLatLng([(pt[0] + next[0]) / 2, (pt[1] + next[1]) / 2]);
        if (view.contains(mid)) items.push({ pi, ri, i, ll: mid, mid: true });
      })));
      if (items.filter((h) => !h.mid).length > MAX_HANDLES) {
        this.el('hint').textContent = `Слишком много точек на экране (${items.length}) — приблизьте карту, чтобы править их.`;
        return;
      }
      this.updateHint();
      items.forEach((h) => {
        const marker = L.marker(h.ll, {
          draggable: true,
          icon: L.divIcon({ className: h.mid ? 'me-handle me-handle-mid' : 'me-handle', iconSize: h.mid ? [9, 9] : [12, 12] }),
          keyboard: false
        }).addTo(this.handleLayer);
        marker.on('dragstart', () => this.onHandleDragStart(zone, h));
        marker.on('drag', (e) => this.onHandleDrag(zone, h, e.target.getLatLng()));
        marker.on('dragend', () => { this.snapHandle(marker, zone, h); this.onHandleDragEnd(); });
        if (!h.mid) marker.on('contextmenu', (e) => { L.DomEvent.preventDefault(e.originalEvent); this.deleteVertex(zone, h); });
      });
    }

    onHandleDragStart(zone, h) {
      this.pushHistory();
      if (h.mid) {
        // Промежуточная точка становится настоящей: вставляем после i.
        const ring = this.zonePoly(zone)[h.pi][h.ri];
        ring.splice(h.i + 1, 0, this.clampToImage(MC().fromLatLng(h.ll)));
        h.i += 1;
        h.mid = false;
      }
    }

    onHandleDrag(zone, h, ll) {
      const ring = this.zonePoly(zone)[h.pi][h.ri];
      const p = this.clampToImage(MC().fromLatLng(ll));
      ring[h.i] = [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
      this.refreshZoneLayer(zone);
    }

    // Отпущенная за краем точка визуально возвращается на край.
    snapHandle(marker, zone, h) {
      const ring = this.zonePoly(zone)[h.pi][h.ri];
      if (ring[h.i]) marker.setLatLng(MC().toLatLng(ring[h.i]));
    }

    onHandleDragEnd() {
      this.markDirty();
      this.renderHandles();
      this.renderProps();
    }

    deleteVertex(zone, h) {
      const poly = this.zonePoly(zone);
      const ring = poly[h.pi][h.ri];
      this.pushHistory();
      if (ring.length > 3) ring.splice(h.i, 1);
      else if (h.ri > 0) poly[h.pi].splice(h.ri, 1); // дыра из трёх точек — убираем дыру
      else if (poly.length > 1) poly.splice(h.pi, 1); // отдельный кусок зоны — убираем кусок
      else { this.undoStack.pop(); this.toast('У зоны должно остаться хотя бы три точки'); return; }
      this.refreshZoneLayer(zone);
      this.markDirty();
      this.renderHandles();
      this.renderProps();
    }

    // ----- Дерево зон -----

    renderTree() {
      const tree = this.el('tree');
      const zones = this.doc.zones;
      const ids = new Set(zones.map((z) => z.id));
      const children = new Map();
      zones.forEach((z) => {
        const key = z.parentId && ids.has(z.parentId) ? z.parentId : '';
        if (!children.has(key)) children.set(key, []);
        children.get(key).push(z);
      });
      const rows = [];
      const walk = (key, depth) => (children.get(key) || [])
        .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ru'))
        .forEach((z) => {
          const t = this.types.get(z.typeId) || MC().FALLBACK_TYPE;
          rows.push(`<div class="me-tree-item${z.id === this.selectedId ? ' active' : ''}" draggable="true" data-zone-id="${esc(z.id)}" style="padding-left:${8 + depth * 16}px">
            <span class="map-fs-zone-dot" style="background:${esc(t.color)}"></span>
            <span class="me-tree-name">${esc(z.title || 'Без названия')}</span>
            <span class="me-tree-type">${esc(t.name)}</span>
            ${z.roles && z.roles.length ? '<i class="fas fa-lock me-tree-flag" title="Доступ ограничен ролями"></i>' : ''}
            ${z.article ? '<i class="fas fa-book me-tree-flag" title="Привязана статья"></i>' : ''}
          </div>`);
          walk(z.id, depth + 1);
        });
      walk('', 0);
      const markers = (this.doc.markers || []).slice().sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ru'));
      const markerRows = markers.map((m) => {
        const t = this.markerType(m);
        return `<div class="me-tree-item${m.id === this.selectedMarkerId ? ' active' : ''}" data-marker-id="${esc(m.id)}">
          <i class="fas fa-${esc(t.icon)} map-fs-marker-icon" style="color:${esc(t.color)}"></i>
          <span class="me-tree-name">${esc(m.title || t.name)}</span>
          <span class="me-tree-type">${esc(t.name)}</span>
          ${m.roles && m.roles.length ? '<i class="fas fa-lock me-tree-flag" title="Доступ ограничен ролями"></i>' : ''}
          ${m.article ? '<i class="fas fa-book me-tree-flag" title="Привязана статья"></i>' : ''}
        </div>`;
      });
      tree.innerHTML = `
        <div class="me-tree-head">Зоны (${zones.length})</div>
        <div class="me-tree-list">${rows.join('') || '<div class="me-tree-empty">Нарисуйте первую зону инструментом «Лассо» или «Многоугольник»</div>'}</div>
        <div class="me-tree-root-drop" data-root-drop>Перетащите сюда — сделать зоной верхнего уровня</div>
        <div class="me-tree-head">Метки (${markers.length})</div>
        <div class="me-tree-list me-tree-list-markers">${markerRows.join('') || '<div class="me-tree-empty">Инструмент «Метка» (M) — клик по карте ставит метку</div>'}</div>`;
      this.bindTreeEvents(tree);
    }

    bindTreeEvents(tree) {
      tree.onclick = (e) => {
        const mItem = e.target.closest('[data-marker-id]');
        if (mItem) { this.selectMarker(mItem.dataset.markerId, { fly: true }); return; }
        const item = e.target.closest('[data-zone-id]');
        if (item) this.select(item.dataset.zoneId, { fly: true });
      };
      tree.ondragstart = (e) => {
        const item = e.target.closest('[data-zone-id]');
        if (!item) return;
        this._dragZoneId = item.dataset.zoneId;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.dataset.zoneId);
        tree.classList.add('me-tree-dragging');
      };
      tree.ondragend = () => { tree.classList.remove('me-tree-dragging'); tree.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target')); };
      tree.ondragover = (e) => {
        const target = e.target.closest('[data-zone-id], [data-root-drop]');
        if (!target || !this._dragZoneId) return;
        const targetId = target.dataset.zoneId;
        if (targetId && (targetId === this._dragZoneId || this.descendants(this._dragZoneId).has(targetId))) return;
        e.preventDefault();
        tree.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
        target.classList.add('drop-target');
      };
      tree.ondrop = (e) => {
        const target = e.target.closest('[data-zone-id], [data-root-drop]');
        const dragId = this._dragZoneId;
        this._dragZoneId = null;
        if (!target || !dragId) return;
        e.preventDefault();
        this.reparent(dragId, target.dataset.zoneId || null);
      };
    }

    // Смена родителя. Если тип зоны обрезается по родителю — обрезаем по
    // новому; если пересечения нет — оставляем форму и предупреждаем.
    reparent(zoneId, parentId) {
      const zone = this.zoneById(zoneId);
      if (!zone || zone.parentId === parentId) return;
      if (parentId && (parentId === zoneId || this.descendants(zoneId).has(parentId))) return;
      this.pushHistory();
      zone.parentId = parentId;
      const parent = this.zoneById(parentId);
      const type = this.types.get(zone.typeId);
      if (parent && type && !type.parents.includes(parent.typeId)) {
        this.toast(`Тип «${type.name}» обычно не лежит внутри «${(this.types.get(parent.typeId) || {}).name || 'этой зоны'}» — проверьте тип зоны`);
      }
      if (parent && type && type.clipToParent) this.clipToParent(zone, { silent: true, history: false });
      this.afterZonesChanged({ keepLayers: false });
    }

    clipToParent(zone, { silent = false, history = true } = {}) {
      const parent = this.zoneById(zone.parentId);
      const clip = this.clip();
      if (!parent || !clip) { if (!silent) this.toast('У зоны нет родителя'); return false; }
      let inter;
      try { inter = cleanMulti(clip.intersection(this.zonePoly(parent), this.zonePoly(zone))); } catch (e) { inter = []; }
      if (!inter.length) { this.toast('Зона целиком вне родителя — форма оставлена как есть'); return false; }
      if (history) this.pushHistory();
      zone.shapes = [{ from: null, polygon: inter }];
      if (history) this.afterZonesChanged({ keepLayers: false });
      return true;
    }

    // ----- Свойства выбранной зоны -----

    renderProps() {
      const box = this.el('props');
      const marker = this.markerById(this.selectedMarkerId);
      if (marker) { this.renderMarkerProps(box, marker); return; }
      const zone = this.zoneById(this.selectedId);
      if (!zone) {
        box.innerHTML = '<div class="me-props-empty">Выберите зону или метку на карте или в списке</div>';
        this.propsRolesField = null;
        return;
      }
      const all = this.doc.zones;
      const banned = this.descendants(zone.id);
      banned.add(zone.id);
      const depths = MC().zoneDepths(all);
      const parentOptions = all
        .filter((z) => !banned.has(z.id))
        .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ru'))
        .map((z) => `<option value="${esc(z.id)}"${z.id === zone.parentId ? ' selected' : ''}>${'— '.repeat(depths.get(z.id) || 0)}${esc(z.title || 'Без названия')}</option>`)
        .join('');
      const typeOptions = this.zoneTypes.map((t) => `<option value="${esc(t.id)}"${t.id === zone.typeId ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
      const articleTitle = zone.article ? (this.articles.find((a) => a.slug === zone.article)?.title || zone.article) : '';

      box.innerHTML = `
        <div class="me-props-head">Свойства зоны</div>
        <label class="me-field"><span>Название</span><input type="text" class="form-input" data-prop="title" value="${esc(zone.title)}" maxlength="120"></label>
        <label class="me-field"><span>Тип</span><select class="form-select" data-prop="typeId">${typeOptions || '<option value="">—</option>'}</select></label>
        <label class="me-field"><span>Внутри зоны</span><select class="form-select" data-prop="parentId"><option value="">— верхний уровень —</option>${parentOptions}</select></label>
        <label class="me-field"><span>Статья</span>
          <input type="text" class="form-input" data-prop="article" list="me-articles-list" value="${esc(articleTitle)}" placeholder="Название статьи…">
          <small class="me-field-note" data-el="article-note">${this.articleNote(zone)}</small>
        </label>
        <div class="me-field"><span>Кому видна зона</span>
          <div class="chip-field" data-el="zone-roles">
            <div class="chip-field-box"><div class="chip-field-chips"></div><input type="text" class="chip-field-input" placeholder="Пусто — видна всем, кто видит карту"></div>
            <div class="chip-field-dropdown" hidden></div><input type="hidden" class="chip-field-hidden">
          </div>
        </div>
        <label class="me-field"><span>Если статья читателю закрыта</span>
          <select class="form-select" data-prop="lockedMode">
            <option value="lock"${zone.lockedMode !== 'hide' ? ' selected' : ''}>Показать зону с замком</option>
            <option value="hide"${zone.lockedMode === 'hide' ? ' selected' : ''}>Скрыть зону</option>
          </select>
        </label>
        ${this.renderZoneStyleSection(zone)}
        <div class="me-props-info">Точек в контуре: ${pointCount(this.zonePoly(zone))}</div>
        <div class="me-props-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-prop-act="vertex"><i class="fas fa-bezier-curve"></i> Править точки</button>
          <button type="button" class="btn btn-secondary btn-sm" data-prop-act="clip" ${zone.parentId ? '' : 'disabled'}><i class="fas fa-crop-simple"></i> Обрезать по родителю</button>
          <button type="button" class="btn btn-danger btn-sm" data-prop-act="delete"><i class="fas fa-trash"></i> Удалить</button>
        </div>`;

      box.querySelectorAll('[data-prop]').forEach((input) => {
        input.addEventListener('focus', () => { this._propHistoryPushed = false; });
        const handler = () => this.onPropChange(zone, input);
        input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', handler);
      });
      box.querySelector('[data-prop="article"]').addEventListener('change', () => this.renderTree());
      this.bindZoneStyleSection(box, zone);
      box.querySelector('[data-prop-act="vertex"]').onclick = () => this.setTool('vertex');
      box.querySelector('[data-prop-act="clip"]').onclick = () => this.clipToParent(zone);
      box.querySelector('[data-prop-act="delete"]').onclick = () => this.deleteZone(zone.id);

      if (window.ChipField) {
        this.propsRolesField = new window.ChipField(box.querySelector('[data-el="zone-roles"]'), {
          freeText: false,
          options: this.roleOptions,
          emptyText: 'Нет ролей',
          onChange: (values) => {
            this.pushHistory();
            zone.roles = values.map(decodeRoleRef).filter(Boolean);
            this.markDirty();
            this.renderTree();
          }
        });
        this.propsRolesField.setValues((zone.roles || []).map(encodeRoleRef));
      }
    }

    // Свой стиль зоны поверх стиля её типа (см. effectiveType в map-core.js).
    renderZoneStyleSection(zone) {
      const type = this.types.get(zone.typeId) || MC().FALLBACK_TYPE;
      const st = MC().effectiveType(type, zone.style);
      const on = !!zone.style;
      const effects = { fill: 'Заливка ярче', outline: 'Толще граница', glow: 'Свечение', pulse: 'Пульсация' };
      return `
        <label class="checkbox-field me-style-toggle"><input type="checkbox" data-style-toggle ${on ? 'checked' : ''}> Свой стиль (поверх типа «${esc(type.name)}»)</label>
        <div class="me-style" ${on ? '' : 'hidden'}>
          <label>Цвет <input type="color" data-style="color" value="${esc(st.color)}"></label>
          <label>Заливка <input type="range" min="0" max="1" step="0.05" data-style="fillOpacity" value="${st.fillOpacity}"></label>
          <label>Граница <input type="number" min="0" max="10" step="0.5" data-style="weight" value="${st.weight}"></label>
          <label class="checkbox-field"><input type="checkbox" data-style="dashed" ${st.dashed ? 'checked' : ''}> Пунктир</label>
          <label>При наведении <select data-style="hoverEffect">${Object.entries(effects).map(([v, l]) => `<option value="${v}"${st.hoverEffect === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>`;
    }

    bindZoneStyleSection(box, zone) {
      const toggle = box.querySelector('[data-style-toggle]');
      const panel = box.querySelector('.me-style');
      toggle.addEventListener('change', () => {
        this.pushHistory();
        if (toggle.checked) {
          const t = this.types.get(zone.typeId) || MC().FALLBACK_TYPE;
          zone.style = { color: t.color, fillOpacity: t.fillOpacity, weight: t.weight, dashed: !!t.dashed, hoverEffect: t.hoverEffect };
        } else {
          zone.style = null;
        }
        this.refreshZoneLayer(zone);
        this.markDirty();
        this.renderProps();
      });
      panel.querySelectorAll('[data-style]').forEach((input) => {
        input.addEventListener('focus', () => { this._propHistoryPushed = false; });
        input.addEventListener(input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input', () => {
          if (!this._propHistoryPushed) { this.pushHistory(); this._propHistoryPushed = true; }
          const f = input.dataset.style;
          zone.style = zone.style || {};
          if (input.type === 'checkbox') zone.style[f] = input.checked;
          else if (input.type === 'range' || input.type === 'number') zone.style[f] = Number(input.value);
          else zone.style[f] = input.value;
          this.refreshZoneLayer(zone);
          this.markDirty();
        });
      });
    }

    // ----- Свойства выбранной метки -----

    renderMarkerProps(box, m) {
      const typeOptions = this.markerTypes.map((t) => `<option value="${esc(t.id)}"${t.id === m.typeId ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
      const articleTitle = m.article ? (this.articles.find((a) => a.slug === m.article)?.title || m.article) : '';
      const zone = this.zoneById(m.zoneId);
      box.innerHTML = `
        <div class="me-props-head">Свойства метки</div>
        <label class="me-field"><span>Название</span><input type="text" class="form-input" data-mprop="title" value="${esc(m.title)}" maxlength="120"></label>
        <label class="me-field"><span>Тип</span><select class="form-select" data-mprop="typeId">${typeOptions || '<option value="">—</option>'}</select></label>
        <label class="me-field"><span>Описание (всплывает по клику)</span><textarea class="form-input me-textarea" data-mprop="text" maxlength="2000" rows="4" placeholder="Короткое пояснение к месту…">${esc(m.text || '')}</textarea></label>
        <label class="me-field"><span>Статья</span>
          <input type="text" class="form-input" data-mprop="article" list="me-articles-list" value="${esc(articleTitle)}" placeholder="Название статьи…">
          <small class="me-field-note" data-el="article-note">${this.articleNote(m, 'метка')}</small>
        </label>
        <div class="me-field"><span>Кому видна метка</span>
          <div class="chip-field" data-el="marker-roles">
            <div class="chip-field-box"><div class="chip-field-chips"></div><input type="text" class="chip-field-input" placeholder="Пусто — видна всем, кто видит карту"></div>
            <div class="chip-field-dropdown" hidden></div><input type="hidden" class="chip-field-hidden">
          </div>
        </div>
        <label class="me-field"><span>Если статья читателю закрыта</span>
          <select class="form-select" data-mprop="lockedMode">
            <option value="lock"${m.lockedMode !== 'hide' ? ' selected' : ''}>Показать метку с замком</option>
            <option value="hide"${m.lockedMode === 'hide' ? ' selected' : ''}>Скрыть метку</option>
          </select>
        </label>
        <div class="me-props-info">${zone ? `Стоит в зоне «${esc(zone.title || 'без названия')}» — скрыта вместе с ней` : 'Стоит вне зон'}</div>
        <div class="me-props-actions">
          <button type="button" class="btn btn-danger btn-sm" data-mprop-act="delete"><i class="fas fa-trash"></i> Удалить метку</button>
        </div>`;

      box.querySelectorAll('[data-mprop]').forEach((input) => {
        input.addEventListener('focus', () => { this._propHistoryPushed = false; });
        input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => this.onMarkerPropChange(m, input));
      });
      box.querySelector('[data-mprop="article"]').addEventListener('change', () => this.renderTree());
      box.querySelector('[data-mprop-act="delete"]').onclick = () => this.deleteMarker(m.id);

      if (window.ChipField) {
        this.propsRolesField = new window.ChipField(box.querySelector('[data-el="marker-roles"]'), {
          freeText: false,
          options: this.roleOptions,
          emptyText: 'Нет ролей',
          onChange: (values) => {
            this.pushHistory();
            m.roles = values.map(decodeRoleRef).filter(Boolean);
            this.markDirty();
            this.renderTree();
          }
        });
        this.propsRolesField.setValues((m.roles || []).map(encodeRoleRef));
      }
    }

    onMarkerPropChange(m, input) {
      if (!this._propHistoryPushed) { this.pushHistory(); this._propHistoryPushed = true; }
      const f = input.dataset.mprop;
      const v = input.value;
      if (f === 'title') {
        m.title = v;
        const el = this.el('tree').querySelector(`[data-marker-id="${CSS.escape(m.id)}"] .me-tree-name`);
        if (el) el.textContent = v || this.markerType(m).name;
        this.markerLayers.get(m.id)?.setTooltipContent(esc(v || this.markerType(m).name));
      } else if (f === 'typeId') { m.typeId = v || null; this.refreshMarkerIcon(m.id); this.renderTree(); }
      else if (f === 'text') m.text = v;
      else if (f === 'lockedMode') m.lockedMode = v === 'hide' ? 'hide' : 'lock';
      else if (f === 'article') {
        const text = v.trim();
        const byTitle = this.articles.find((a) => a.title.toLowerCase() === text.toLowerCase());
        const bySlug = this.articles.find((a) => a.slug === text);
        m.article = !text ? null : (byTitle ? byTitle.slug : bySlug ? bySlug.slug : slugify(text));
        const note = this.el('article-note');
        if (note) note.innerHTML = this.articleNote(m, 'метка');
      }
      this.markDirty();
    }

    articleNote(zone, noun = 'зона') {
      if (!zone.article) return noun === 'метка' ? 'Без статьи метка показывает только описание' : 'Без статьи зона только подсвечивается';
      const found = this.articles.find((a) => a.slug === zone.article);
      return found ? `✓ Статья «${esc(found.title)}»` : 'Такой статьи нет — читателю предложат её создать';
    }

    onPropChange(zone, input) {
      if (!this._propHistoryPushed) { this.pushHistory(); this._propHistoryPushed = true; }
      const f = input.dataset.prop;
      const v = input.value;
      if (f === 'title') { zone.title = v; this.updateTreeItemTitle(zone); }
      else if (f === 'typeId') { zone.typeId = v || null; this.refreshZoneLayer(zone); this.renderTree(); }
      else if (f === 'parentId') { this.undoStack.pop(); this.reparent(zone.id, v || null); return; }
      else if (f === 'lockedMode') zone.lockedMode = v === 'hide' ? 'hide' : 'lock';
      else if (f === 'article') {
        const text = v.trim();
        const byTitle = this.articles.find((a) => a.title.toLowerCase() === text.toLowerCase());
        const bySlug = this.articles.find((a) => a.slug === text);
        zone.article = !text ? null : (byTitle ? byTitle.slug : bySlug ? bySlug.slug : slugify(text));
        const note = this.el('article-note');
        if (note) note.innerHTML = this.articleNote(zone);
      }
      this.markDirty();
    }

    updateTreeItemTitle(zone) {
      const el = this.el('tree').querySelector(`[data-zone-id="${CSS.escape(zone.id)}"] .me-tree-name`);
      if (el) el.textContent = zone.title || 'Без названия';
      const layer = this.zoneLayers.get(zone.id);
      if (layer) layer.setTooltipContent(esc(zone.title || 'Без названия'));
    }

    deleteZone(id) {
      const zone = this.zoneById(id);
      if (!zone) return;
      const kids = this.doc.zones.filter((z) => z.parentId === id);
      const msg = kids.length
        ? `Удалить зону «${zone.title}»? Вложенные зоны (${kids.length}) останутся и перейдут на уровень выше.`
        : `Удалить зону «${zone.title}»?`;
      if (!confirm(msg)) return;
      this.pushHistory();
      kids.forEach((k) => { k.parentId = zone.parentId; });
      (this.doc.markers || []).forEach((m) => { if (m.zoneId === id) m.zoneId = zone.parentId; });
      this.doc.zones = this.doc.zones.filter((z) => z.id !== id);
      this.selectedId = null;
      this.afterZonesChanged({ keepLayers: false });
    }

    // ----- Настройки карты: доступ, подложки, удаление -----

    renderMapSettings() {
      const box = this.el('map-settings');
      box.innerHTML = `
        <div class="me-props-head">Доступ к карте</div>
        <div class="chip-field" data-el="map-roles">
          <div class="chip-field-box"><div class="chip-field-chips"></div><input type="text" class="chip-field-input" placeholder="Пусто — карта видна всем"></div>
          <div class="chip-field-dropdown" hidden></div><input type="hidden" class="chip-field-hidden">
        </div>
        <p class="me-field-note">Роли мира (сервера) и общие роли платформы. Владелец и доверенный админ видят всё.</p>

        <div class="me-props-head">Подложки</div>
        <p class="me-field-note">Все подложки одной карты должны быть одного размера${this.size ? ` — ${this.size.w}×${this.size.h}` : ''}. Большие файлы загружаются частями, затем сервер нарезает их на тайлы — это может занять несколько минут.</p>
        <div class="me-basemaps" data-el="basemaps"></div>
        <label class="btn btn-secondary btn-sm me-upload-btn"><i class="fas fa-upload"></i> Загрузить подложку
          <input type="file" data-el="bm-file" accept=".jpg,.jpeg,.png,.webp,.tif,.tiff" hidden>
        </label>
        <div class="me-upload" data-el="upload" hidden></div>

        ${this.canDelete ? `<div class="server-danger-zone"><h4>Опасная зона</h4><p>Удаление карты сотрёт её зоны и подложки. Статьи останутся.</p><button type="button" class="btn btn-danger btn-sm" data-el="delete-map"><i class="fas fa-trash"></i> Удалить карту</button></div>` : ''}`;

      if (window.ChipField) {
        this.mapRolesField = new window.ChipField(box.querySelector('[data-el="map-roles"]'), {
          freeText: false,
          options: this.roleOptions,
          emptyText: 'Нет ролей',
          onChange: (values) => { this.pushHistory(); this.doc.roles = values.map(decodeRoleRef).filter(Boolean); this.markDirty(); }
        });
        this.mapRolesField.setValues((this.doc.roles || []).map(encodeRoleRef));
      }
      this.renderBasemapList();
      box.querySelector('[data-el="bm-file"]').addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (file) this.uploadBasemap(file);
      });
      box.querySelector('[data-el="delete-map"]')?.addEventListener('click', () => this.deleteMap());
    }

    renderBasemapList() {
      const list = this.el('basemaps');
      if (!list) return;
      if (!this.basemaps.length) { list.innerHTML = '<div class="me-props-empty">Подложек пока нет</div>'; return; }
      const statusText = (b) => {
        if (b.status === 'ready') return `<span class="me-bm-ok">готова · ${b.width}×${b.height}</span>`;
        if (b.status === 'processing') return '<span class="me-bm-wait"><i class="fas fa-spinner fa-spin"></i> нарезается на тайлы…</span>';
        if (b.status === 'queued') return `<span class="me-bm-wait"><i class="fas fa-clock"></i> в очереди${b.queuePosition ? ` (№${b.queuePosition})` : ''}</span>`;
        if (b.status === 'uploading') return '<span class="me-bm-wait">загрузка не завершена</span>';
        return `<span class="me-bm-err"><i class="fas fa-triangle-exclamation"></i> ${esc(b.error || 'ошибка')}</span>`;
      };
      list.innerHTML = this.basemaps.map((b, i) => `
        <div class="me-bm" data-bm-id="${esc(b.id)}">
          <input type="text" class="form-input" data-bm-field="title" value="${esc(b.title)}" maxlength="80">
          <div class="me-bm-row">
            ${statusText(b)}
            <span class="me-bm-btns">
              ${b.status === 'error' ? '<button type="button" class="map-icon-btn" data-bm-act="retile" title="Нарезать заново"><i class="fas fa-rotate"></i></button>' : ''}
              <button type="button" class="map-icon-btn" data-bm-act="up" title="Выше" ${i === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
              <button type="button" class="map-icon-btn is-danger" data-bm-act="delete" title="Удалить подложку"><i class="fas fa-trash"></i></button>
            </span>
          </div>
        </div>`).join('');
      list.oninput = (e) => {
        const row = e.target.closest('[data-bm-id]');
        const bm = row && this.basemaps.find((b) => b.id === row.dataset.bmId);
        if (bm && e.target.dataset.bmField === 'title') { bm.title = e.target.value; this.markDirty(); this.refreshBasemapSelect(); }
      };
      list.onclick = async (e) => {
        const btn = e.target.closest('[data-bm-act]');
        const row = btn && btn.closest('[data-bm-id]');
        if (!row) return;
        const id = row.dataset.bmId;
        const i = this.basemaps.findIndex((b) => b.id === id);
        if (btn.dataset.bmAct === 'up' && i > 0) {
          [this.basemaps[i - 1], this.basemaps[i]] = [this.basemaps[i], this.basemaps[i - 1]];
          this.markDirty();
          this.renderBasemapList();
          this.refreshBasemapSelect();
        } else if (btn.dataset.bmAct === 'delete') {
          if (!confirm('Удалить подложку? Файл и тайлы будут стёрты с сервера.')) return;
          const res = await window.MapsUI.api(`/api/maps/${this.mapId}/basemaps/${id}`, 'DELETE');
          if (!res.success) { this.toast(window.MapsUI.apiError(res)); return; }
          this.basemaps = this.basemaps.filter((b) => b.id !== id);
          this.renderBasemapList();
          this.refreshBasemapSelect();
          this.pollBasemapsSoon(); // сервер мог сбросить размер карты — подхватываем
        } else if (btn.dataset.bmAct === 'retile') {
          const res = await window.MapsUI.api(`/api/maps/${this.mapId}/basemaps/${id}/retile`, 'POST', {});
          if (!res.success) { this.toast(window.MapsUI.apiError(res)); return; }
          this.pollBasemapsSoon();
        }
      };
    }

    // Загрузка по частям: заявка → части по chunkSize → завершение.
    // Обрыв связи на части — до трёх повторов этой же части.
    async uploadBasemap(file) {
      if (file.size > this.maxSourceBytes) { this.toast(`Файл больше ${Math.round(this.maxSourceBytes / 1024 / 1024)} МБ`); return; }
      const box = this.el('upload');
      box.hidden = false;
      const setProgress = (done, text) => {
        box.innerHTML = `<div class="me-upload-name">${esc(file.name)}</div>
          <div class="me-progress"><div class="me-progress-bar" style="width:${Math.round(done * 100)}%"></div></div>
          <div class="me-upload-text">${esc(text)}</div>`;
      };
      setProgress(0, 'Подготовка…');
      const init = await window.MapsUI.api(`/api/maps/${this.mapId}/basemaps`, 'POST', { filename: file.name, size: file.size });
      if (!init.success) { setProgress(0, `Ошибка: ${window.MapsUI.apiError(init)}`); return; }
      const { basemapId, chunkSize } = init.data;
      this._uploading = true;
      try {
        let offset = 0;
        while (offset < file.size) {
          const chunk = file.slice(offset, offset + chunkSize);
          let attempt = 0;
          let received = null;
          while (received === null) {
            try {
              const resp = await fetch(`/api/maps/${this.mapId}/basemaps/${basemapId}/chunk?offset=${offset}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${window.authManager.getToken()}` },
                body: chunk
              });
              const data = await resp.json().catch(() => ({}));
              if (resp.ok) received = data.received;
              else if (resp.status === 409 && Number.isFinite(data.received)) received = data.received; // сервер знает, сколько уже есть
              else throw new Error(data.error || `HTTP ${resp.status}`);
            } catch (err) {
              if (++attempt >= 3) throw err;
              await new Promise((r) => setTimeout(r, 1500 * attempt));
            }
          }
          offset = received;
          const mb = (n) => (n / 1024 / 1024).toFixed(1);
          setProgress(offset / file.size, `Загружено ${mb(offset)} из ${mb(file.size)} МБ`);
        }
        const done = await window.MapsUI.api(`/api/maps/${this.mapId}/basemaps/${basemapId}/complete`, 'POST', {});
        if (!done.success) throw new Error(window.MapsUI.apiError(done));
        setProgress(1, 'Загружено. Сервер нарезает подложку на тайлы — статус виден в списке выше.');
        setTimeout(() => { box.hidden = true; }, 6000);
      } catch (err) {
        setProgress(0, `Ошибка загрузки: ${err.message}`);
      } finally {
        this._uploading = false;
        this.pollBasemapsSoon();
      }
    }

    // Статусы подложек (очередь → нарезка → готово) опрашиваем, пока есть
    // незавершённые. Зоны из ответа НЕ берём — там серверная версия, а у
    // редактора могут быть несохранённые правки.
    startBasemapPolling() {
      this._pollTimer = setInterval(() => {
        if (this.basemaps.some((b) => b.status === 'queued' || b.status === 'processing') || this._pollSoon) this.pollBasemaps();
      }, 4000);
    }
    pollBasemapsSoon() { this._pollSoon = true; this.pollBasemaps(); }

    async pollBasemaps() {
      this._pollSoon = false;
      const res = await window.MapsUI.api(`/api/maps/${this.mapId}?mode=edit`);
      if (!res.success || !this.map) return;
      const fresh = res.data;
      const titles = new Map(this.basemaps.map((b) => [b.id, b.title]));
      const order = this.basemaps.map((b) => b.id);
      this.basemaps = fresh.basemaps
        .map((b) => ({ ...b, title: titles.get(b.id) ?? b.title }))
        .sort((a, b) => (order.indexOf(a.id) + 1 || 999) - (order.indexOf(b.id) + 1 || 999));
      const sizeChanged = (fresh.size || null) === null
        ? !!this.size
        : !this.size || fresh.size.w !== this.size.w || fresh.size.h !== this.size.h;
      if (sizeChanged) this.setSize(fresh.size || null);
      else this.refreshBasemapSelect();
      this.renderBasemapList();
    }

    async deleteMap() {
      if (!confirm(`Удалить карту «${this.doc.title}» целиком? Это нельзя отменить.`)) return;
      const res = await window.MapsUI.api(`/api/maps/${this.mapId}`, 'DELETE');
      if (!res.success) { this.toast(window.MapsUI.apiError(res)); return; }
      this.dirty = false;
      this.clearDraft();
      window.showMessage?.('Карта удалена', 'success');
      window.spaRouter?.navigateTo('/servers');
    }

    // ----- Справочники: статьи и роли -----

    async loadLookups() {
      try {
        const idx = await window.apiClient.makeAuthenticatedRequest('/api/articles-index');
        const list = (idx.success && idx.data && idx.data.accessible) || [];
        this.articles = list.map((a) => ({ slug: a.slug, title: a.title || a.slug }));
        let dl = document.getElementById('me-articles-list');
        if (!dl) { dl = document.createElement('datalist'); dl.id = 'me-articles-list'; this.root.appendChild(dl); }
        dl.innerHTML = this.articles.map((a) => `<option value="${esc(a.title)}"></option>`).join('');
      } catch (e) { /* поле статьи останется без подсказок */ }

      const options = [];
      try {
        const adm = await window.apiClient.makeAuthenticatedRequest('/api/admin-roles');
        if (adm.success && Array.isArray(adm.data && adm.data.roles)) adm.data.roles.forEach((r) => options.push({ value: `system:${r.id}`, label: `🌐 ${r.name}` }));
      } catch (e) { /* без общих ролей */ }
      if (this.serverId) {
        try {
          const srv = await window.apiClient.makeAuthenticatedRequest(`/api/servers/${this.serverId}/roles`);
          if (srv.success && Array.isArray(srv.data)) srv.data.forEach((r) => options.push({ value: `server:${r.id}`, label: `🏠 ${r.name}` }));
        } catch (e) { /* без ролей мира */ }
      }
      this.roleOptions = options;
      this.propsRolesField?.setOptions(options);
      this.mapRolesField?.setOptions(options);
      this.renderProps();
    }

    // ----- История, черновик, сохранение -----

    snapshot() {
      return JSON.stringify({ title: this.doc.title, roles: this.doc.roles, zones: this.doc.zones, markers: this.doc.markers });
    }

    pushHistory() {
      this.undoStack.push(this.snapshot());
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.updateUndoButtons();
    }

    restore(snap) {
      const s = JSON.parse(snap);
      this.doc = { title: s.title, roles: s.roles, zones: s.zones, markers: s.markers || [] };
      if (!this.markerById(this.selectedMarkerId)) this.selectedMarkerId = null;
      this.root.querySelector('.me-title-input').value = this.doc.title;
      if (!this.zoneById(this.selectedId)) this.selectedId = null;
      this.afterZonesChanged({ keepLayers: false });
      if (this.sidebarTab === 'map') this.renderMapSettings();
    }

    undo() {
      if (!this.undoStack.length) return;
      this.cancelDrawing();
      this.redoStack.push(this.snapshot());
      this.restore(this.undoStack.pop());
      this.updateUndoButtons();
    }

    redo() {
      if (!this.redoStack.length) return;
      this.cancelDrawing();
      this.undoStack.push(this.snapshot());
      this.restore(this.redoStack.pop());
      this.updateUndoButtons();
    }

    updateUndoButtons() {
      this.root.querySelector('[data-act="undo"]').disabled = !this.undoStack.length;
      this.root.querySelector('[data-act="redo"]').disabled = !this.redoStack.length;
    }

    afterZonesChanged() {
      this.renderZoneLayers();
      this.renderMarkerLayers();
      this.renderHandles();
      this.renderTree();
      this.renderProps();
      this.markDirty();
    }

    markDirty() {
      this.dirty = true;
      this.setStatus('Есть несохранённые изменения', 'dirty');
      clearTimeout(this._draftTimer);
      this._draftTimer = setTimeout(() => this.writeDraft(), 800);
    }

    setStatus(text, kind) {
      const el = this.el('status');
      el.textContent = text;
      el.dataset.kind = kind || '';
    }

    draftKey() { return DRAFT_PREFIX + this.mapId; }

    writeDraft() {
      if (!this.dirty) return;
      try {
        localStorage.setItem(this.draftKey(), JSON.stringify({
          baseUpdatedAt: this.baseUpdatedAt,
          savedAt: Date.now(),
          title: this.doc.title,
          roles: this.doc.roles,
          zones: this.doc.zones,
          markers: this.doc.markers,
          basemaps: this.basemaps.map((b) => ({ id: b.id, title: b.title }))
        }));
      } catch (e) { /* переполнен localStorage — черновик не сохранится, но сохранение на сервер работает */ }
    }

    clearDraft() {
      try { localStorage.removeItem(this.draftKey()); } catch (e) { /* нет доступа — ничего страшного */ }
    }

    offerDraftRestore() {
      let draft = null;
      try { draft = JSON.parse(localStorage.getItem(this.draftKey()) || 'null'); } catch (e) { draft = null; }
      if (!draft || !Array.isArray(draft.zones)) return;
      const when = new Date(draft.savedAt).toLocaleString('ru-RU');
      const stale = draft.baseUpdatedAt !== this.baseUpdatedAt;
      const msg = stale
        ? `Есть несохранённый черновик этой карты от ${when}, но с тех пор карту сохранили заново (возможно, кто-то другой). Восстановить черновик? Более новые изменения при сохранении будут перезаписаны.`
        : `Есть несохранённый черновик этой карты от ${when}. Восстановить его?`;
      if (!confirm(msg)) { this.clearDraft(); return; }
      this.pushHistory();
      this.doc = { title: draft.title, roles: draft.roles || [], zones: draft.zones, markers: draft.markers || this.doc.markers || [] };
      this.root.querySelector('.me-title-input').value = this.doc.title;
      const titles = new Map((draft.basemaps || []).map((b) => [b.id, b.title]));
      this.basemaps.forEach((b) => { if (titles.has(b.id)) b.title = titles.get(b.id); });
      if (stale) this._forceNextSave = true;
      this.afterZonesChanged();
    }

    async save({ force = false } = {}) {
      if (this._saving) return;
      this._saving = true;
      this.setStatus('Сохранение…', 'saving');
      const body = {
        title: this.doc.title,
        roles: this.doc.roles,
        zones: this.doc.zones,
        markers: this.doc.markers,
        basemaps: this.basemaps.map((b) => ({ id: b.id, title: b.title })),
        baseUpdatedAt: this.baseUpdatedAt,
        force: force || !!this._forceNextSave
      };
      const res = await window.MapsUI.api(`/api/maps/${this.mapId}`, 'PUT', body);
      this._saving = false;
      if (res.status === 409 || (res.data && res.data.updated_at && !res.success && res.status === 409)) {
        this.setStatus('Конфликт версий', 'error');
        if (confirm('Эту карту уже сохранил кто-то другой после того, как вы открыли редактор. Перезаписать его изменения вашими?')) return this.save({ force: true });
        return;
      }
      if (!res.success) {
        this.setStatus('Не сохранено', 'error');
        window.showMessage?.(`Не удалось сохранить карту: ${window.MapsUI.apiError(res)}`, 'error');
        return;
      }
      this.baseUpdatedAt = res.data.updated_at;
      this._forceNextSave = false;
      this.dirty = false;
      clearTimeout(this._draftTimer);
      this.clearDraft();
      this.setStatus(`Сохранено в ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`, 'saved');
    }

    async preview() {
      if (this.dirty && confirm('Сохранить изменения перед просмотром?')) await this.save();
      window.MapsUI.openMapPage(this.mapId, { zoneId: this.selectedId });
    }

    close() {
      if (this.dirty && !confirm('Есть несохранённые изменения. Они останутся в черновике и будут предложены при следующем открытии редактора. Закрыть?')) return;
      window.MapsUI.goBack();
    }

    // ----- Клавиатура и прочее -----

    bindGlobal() {
      this._onKeyDown = (e) => this.onKeyDown(e);
      this._onKeyUp = (e) => this.onKeyUp(e);
      this._onBlur = () => { this.mods = { shift: false, alt: false, space: false }; this.setTool(this.tool); };
      this._onBeforeUnload = (e) => { if (this.dirty) { this.writeDraft(); e.preventDefault(); e.returnValue = ''; } };
      document.addEventListener('keydown', this._onKeyDown);
      document.addEventListener('keyup', this._onKeyUp);
      window.addEventListener('blur', this._onBlur);
      window.addEventListener('beforeunload', this._onBeforeUnload);
    }

    isTyping() {
      const a = document.activeElement;
      return !!(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)));
    }

    onKeyDown(e) {
      this.mods.shift = e.shiftKey;
      this.mods.alt = e.altKey;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 's') { e.preventDefault(); this.save(); return; }
      if (this.isTyping()) return;
      if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); return; }
      if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); return; }
      if (e.altKey) e.preventDefault(); // Alt в браузере уводит фокус в меню
      if (mod) return;
      if (e.key === ' ') {
        e.preventDefault();
        if (!this.mods.space) { this.mods.space = true; this.map.dragging.enable(); this.wrapEl.classList.add('me-panning'); }
        return;
      }
      if (e.key === 'Escape') { if (this.draw) this.cancelDrawing(); else this.select(null); return; }
      if (e.key === 'Enter' && this.draw && this.draw.kind === 'polygon') { this.finishPolygon(); return; }
      if (e.key === 'Backspace' && this.draw && this.draw.kind === 'polygon') { e.preventDefault(); this.draw.points.pop(); this.renderDraft(); this.updateHint(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedMarkerId) { e.preventDefault(); this.deleteMarker(this.selectedMarkerId); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedId) { e.preventDefault(); this.deleteZone(this.selectedId); return; }
      const tool = TOOLS.find((t) => t.key === key);
      if (tool) this.setTool(tool.id);
    }

    onKeyUp(e) {
      this.mods.shift = e.shiftKey;
      this.mods.alt = e.altKey;
      if (e.key === ' ' && this.mods.space) {
        this.mods.space = false;
        this.wrapEl.classList.remove('me-panning');
        if (this.tool === 'polygon' || this.tool === 'lasso') this.map.dragging.disable();
      }
    }

    toast(text) {
      window.showMessage?.(text, 'warning');
    }

    renderAll() {
      this.setTool('select');
      this.renderZoneLayers();
      this.renderMarkerLayers();
      this.renderTree();
      this.renderProps();
      this.updateUndoButtons();
      this.setStatus('Все изменения сохранены', 'saved');
    }

    destroy() {
      if (this.dirty) this.writeDraft();
      clearInterval(this._pollTimer);
      clearTimeout(this._draftTimer);
      document.removeEventListener('keydown', this._onKeyDown);
      document.removeEventListener('keyup', this._onKeyUp);
      window.removeEventListener('blur', this._onBlur);
      window.removeEventListener('beforeunload', this._onBeforeUnload);
      if (this._resizeObserver) this._resizeObserver.disconnect();
      if (this.map) this.map.remove();
      this.map = null;
    }
  }

  function decodeRoleRef(value) {
    const m = /^(system|server):(\d+)$/.exec(String(value || ''));
    return m ? { scope: m[1], id: parseInt(m[2], 10) } : null;
  }
  function encodeRoleRef(ref) { return `${ref.scope}:${ref.id}`; }

  // ===== Маршрут /map/:id/edit =====

  async function loadMapEditor(router) {
    window.MapsUI.cleanupPage();
    const mapId = router.mapRouteId;
    const appContent = document.getElementById('app-content');
    if (!appContent) return;
    appContent.innerHTML = '<div class="map-fs"><div class="map-fs-empty"><i class="fas fa-spinner fa-spin"></i><div>Открываем редактор карты…</div></div></div>';
    document.body.classList.add('map-fs-open');

    const res = await window.MapsUI.api(`/api/maps/${encodeURIComponent(mapId)}?mode=edit`);
    if (!res.success) {
      appContent.innerHTML = `<div class="map-fs"><div class="map-fs-topbar"><button type="button" class="map-fs-btn" onclick="MapsUI.goBack()"><i class="fas fa-arrow-left"></i></button><div class="map-fs-title"><span class="map-fs-name">Редактор недоступен</span></div></div><div class="map-fs-empty"><i class="fas fa-lock"></i><div>${esc(window.MapsUI.apiError(res))}</div></div></div>`;
      return;
    }
    try {
      await window.MapCore.loadScript(POLYGON_CLIPPING_SRC, 'polygonClipping');
    } catch (e) {
      window.showMessage?.('Не удалась загрузка библиотеки контуров — объединение и обрезка зон будут недоступны', 'warning');
    }
    const pageTitle = document.getElementById('page-title');
    if (pageTitle) pageTitle.textContent = `Редактор: ${res.data.title}`;
    document.title = `${res.data.title} — редактор карты`;
    const editor = new MapEditor(appContent, res.data);
    window.MapsUI.setCurrent(editor);
  }

  window.MapEditor = { loadMapEditor };
})();
