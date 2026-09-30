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
  // Недорисованный многоугольник — отдельно от черновика карты: пишется на
  // каждую точку, переживает перезагрузку страницы и закрытие вкладки.
  const DRAWING_PREFIX = 'beginfind.mapDrawing.';
  const HISTORY_LIMIT = 80;
  const MAX_HANDLES = 700;

  const TOOLS = [
    { id: 'select', key: 'v', icon: 'fa-arrow-pointer', label: 'Выбор', hint: 'Клик по зоне — выбрать. Двойной клик — править её точки.' },
    { id: 'polygon', key: 'p', icon: 'fa-draw-polygon', label: 'Многоугольник', hint: 'Клик — точка. Двойной клик, Enter или клик по первой точке — готово. Backspace — убрать точку, Esc — отмена. Shift — добавить к выбранной, Alt — вырезать. Точки прилипают к границам других зон (зелёный кружок); две точки подряд на границе одной зоны — контур пройдёт вдоль неё, Ctrl при клике — в обход с другой стороны.' },
    { id: 'lasso', key: 'l', icon: 'fa-signature', label: 'Лассо', hint: 'Зажмите кнопку мыши и обведите область. Shift — добавить к выбранной зоне, Alt — вырезать из неё. Пробел — двигать карту.' },
    { id: 'brush', key: 'b', icon: 'fa-paintbrush', label: 'Кисть', hint: 'Зажмите кнопку мыши и ведите — мазок заданной ширины. Выбрана зона — мазок добавляется к ней, Alt — вырезается из неё; не выбрана — мазок становится новой зоной. [ и ] — размер кисти. Пробел — двигать карту.' },
    { id: 'vertex', key: 'e', icon: 'fa-bezier-curve', label: 'Правка точек', hint: 'Тяните точку — у границы другой зоны она прилипнет к ней. Промежуточная точка между двумя — добавить новую. Правый клик по точке — удалить.' },
    { id: 'marker', key: 'm', icon: 'fa-location-dot', label: 'Метка', hint: 'Клик — поставить метку. Метки перетаскиваются мышью; тип, описание и статья — в свойствах справа.' }
  ];

  // ===== Утилиты =====

  function genId(prefix) {
    return prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  const RU_TO_LAT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  // Зеркало src/services/slugify.js — slug статьи по введённому названию.
  // Размер картинки по заголовку файла (без чтения на сервер); null — браузер
  // не умеет этот формат (tiff) или не успел: тогда проверит сервер.
  function readImageSize(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      const done = (v) => { clearTimeout(timer); URL.revokeObjectURL(url); img.onload = img.onerror = null; resolve(v); };
      const timer = setTimeout(() => done(null), 8000);
      img.onload = () => done(img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null);
      img.onerror = () => done(null);
      img.src = url;
    });
  }

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

  // Прилипание к границам: радиус в экранных пикселях.
  const SNAP_PX = 10;
  const NEIGHBOR_CUT_KEY = 'beginfind.mapNeighborCut';
  const FOG_PREVIEW_KEY = 'beginfind.mapFogPreview';
  // Кисть: диаметр в экранных пикселях, число сторон круга на концах мазка.
  const BRUSH_KEY = 'beginfind.mapBrushPx';
  const BRUSH_MIN = 4;
  const BRUSH_MAX = 200;
  const BRUSH_SIDES = 12;

  // Позиция на кольце — число s: целое — вершина s, дробное — точка на
  // ребре floor(s) → floor(s)+1. Вершины строго между sA и sB при обходе
  // кольца вперёд (по возрастанию индексов, с переходом через конец).
  function ringVertsForward(n, sA, sB) {
    let span = sB - sA;
    if (span <= 0) span += n;
    const out = [];
    const start = Math.floor(sA) + 1;
    for (let step = 0; step < n; step++) {
      const idx = (start + step) % n;
      let off = idx - sA;
      if (off <= 0) off += n;
      if (off >= span - 1e-9) break;
      out.push(idx);
    }
    return out;
  }

  function pathLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return len;
  }

  // Участок границы между двумя точками кольца: вершины, через которые
  // пройдёт контур от a до b (сами a и b не входят). По умолчанию — более
  // короткий путь, longWay — обход с другой стороны.
  function ringTrace(ring, a, b, longWay) {
    const n = ring.length;
    if (n < 3 || Math.abs(a.s - b.s) < 1e-9) return [];
    const fwd = ringVertsForward(n, a.s, b.s).map((i) => ring[i]);
    const back = ringVertsForward(n, b.s, a.s).reverse().map((i) => ring[i]);
    const lf = pathLength([a.pt, ...fwd, b.pt]);
    const lb = pathLength([a.pt, ...back, b.pt]);
    const shortIsFwd = lf <= lb;
    const useFwd = longWay ? !shortIsFwd : shortIsFwd;
    return (useFwd ? fwd : back).map((p) => [p[0], p[1]]);
  }

  // Аффинное преобразование по трём парам [xФона, yФона, xКарты, yКарты] —
  // зеркало affineFromPoints в src/services/maps-store.js. null — точки
  // фона на одной прямой.
  function affineFromPoints(points) {
    const [[x1, y1, u1, v1], [x2, y2, u2, v2], [x3, y3, u3, v3]] = points;
    const det = x1 * (y2 - y3) - y1 * (x2 - x3) + (x2 * y3 - x3 * y2);
    if (Math.abs(det) < 1e-6) return null;
    const solve = (r1, r2, r3) => [
      (r1 * (y2 - y3) - y1 * (r2 - r3) + (r2 * y3 - r3 * y2)) / det,
      (x1 * (r2 - r3) - r1 * (x2 - x3) + (x2 * r3 - x3 * r2)) / det,
      (x1 * (y2 * r3 - y3 * r2) - y1 * (x2 * r3 - x3 * r2) + r1 * (x2 * y3 - x3 * y2)) / det
    ];
    const [a, b, e] = solve(u1, u2, u3);
    const [c, d, f] = solve(v1, v2, v3);
    return { a, b, c, d, e, f };
  }
  const affineApply = (M, p) => [M.a * p[0] + M.b * p[1] + M.e, M.c * p[0] + M.d * p[1] + M.f];
  function affineInvert(M) {
    const det = M.a * M.d - M.b * M.c;
    if (Math.abs(det) < 1e-12) return null;
    const a = M.d / det; const b = -M.b / det; const c = -M.c / det; const d = M.a / det;
    return { a, b, c, d, e: -(a * M.e + b * M.f), f: -(c * M.e + d * M.f) };
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
      this.doc = { title: data.title, roles: data.roles || [], zones: data.zones || [], markers: data.markers || [], markerGroups: data.markerGroups || [], events: data.events || [], timeline: data.timeline || { initial: null } };
      this.hiddenGroupsEd = new Set(); // группы, скрытые на карте редактора («глазик»)
      this.newMarkerGroupId = null; // в какую группу пойдут новые метки
      this.calendar = data.calendar || null;
      this.selectedEventId = null;
      // Текущий момент редактора: начальный момент карты, иначе самый ранний
      // момент в данных, иначе 0.
      const hasTime = MC().mapHasTime({ ...this.doc, basemaps: data.basemaps || [] });
      this.time = this.doc.timeline.initial !== null && this.doc.timeline.initial !== undefined
        ? this.doc.timeline.initial
        : (hasTime ? MC().timeRange({ ...this.doc, basemaps: data.basemaps || [] }).min : 0);
      this.selectedMarkerId = null;
      this.markerLayers = new Map();
      this.selectedId = null;
      this.tool = 'select';
      this.undoStack = [];
      this.redoStack = [];
      this.dirty = false;
      this.mods = { shift: false, alt: false, space: false };
      this.draw = null; // состояние рисования (polygon/lasso)
      // Многоугольник, отложенный сменой инструмента: вернулись к «Многоугольнику» — рисуем дальше.
      this.pausedPoly = null;
      // Контур, только что отменённый (Esc) или замкнутый в зону: Ctrl+Z возвращает его в рисование.
      this._recoverDraw = null;
      this.handles = [];
      this.articles = []; // [{slug,title}] — для поля "Статья"
      this.roleOptions = [];
      this.zoneLayers = new Map();
      this.sidebarTab = 'zones';

      this.buildLayout();
      let cut = true;
      try { cut = localStorage.getItem(NEIGHBOR_CUT_KEY) !== '0'; } catch (e) { /* нет доступа */ }
      this.setNeighborCut(cut);
      let fogPreview = false;
      try { fogPreview = localStorage.getItem(FOG_PREVIEW_KEY) === '1'; } catch (e) { /* нет доступа */ }
      this.setFogPreview(fogPreview);
      this.bindCalendarSection();
      this.bindGlobal();
      this.initMap();
      this.renderAll();
      this.loadLookups();
      this.el('world-details').addEventListener('toggle', () => { if (this.el('world-details').open) this.mountWorld(); });
      this.offerDraftRestore();
      this.restoreDrawing();
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
              <select class="map-fs-select" data-el="basemap-select" title="Фон карты" hidden></select>
              <button type="button" class="map-fs-btn" data-act="undo" title="Отменить (Ctrl+Z)"><i class="fas fa-rotate-left"></i></button>
              <button type="button" class="map-fs-btn" data-act="redo" title="Повторить (Ctrl+Y)"><i class="fas fa-rotate-right"></i></button>
              <button type="button" class="map-fs-btn" data-act="preview" title="Открыть просмотр"><i class="fas fa-eye"></i><span class="map-fs-btn-label"> Просмотр</span></button>
              <button type="button" class="map-fs-btn map-fs-btn-primary" data-act="save" title="Сохранить (Ctrl+S)"><i class="fas fa-floppy-disk"></i><span class="map-fs-btn-label"> Сохранить</span></button>
            </div>
          </div>
          <div class="me-body">
            <div class="me-tools">
              ${TOOLS.map((t) => `<button type="button" class="me-tool" data-tool="${t.id}" title="${esc(t.label)} (${t.key.toUpperCase()})"><i class="fas ${t.icon}"></i></button>`).join('')}
              <span class="me-tools-sep"></span>
              <button type="button" class="me-tool me-tool-toggle" data-act="toggle-neighbors" title=""><i class="fas fa-object-ungroup"></i></button>
              <button type="button" class="me-tool me-tool-toggle" data-act="toggle-fog" title=""><i class="fas fa-cloud"></i></button>
            </div>
            <div class="me-canvas-wrap">
              <div class="me-canvas"></div>
              <div class="me-hint" data-el="hint"></div>
              <div class="me-marker-palette" data-el="marker-palette" hidden></div>
              <div class="me-overlay" data-el="overlay" hidden></div>
              <div class="map-timeline me-timeline" data-el="timeline"></div>
            </div>
            <aside class="me-side">
              <div class="me-side-tabs">
                <button type="button" class="me-side-tab active" data-side-tab="zones"><i class="fas fa-layer-group"></i> Зоны</button>
                <button type="button" class="me-side-tab" data-side-tab="map"><i class="fas fa-map"></i> Карта</button>
                <button type="button" class="me-side-tab" data-side-tab="time" title="Таймлайн: события, начальный момент, копирование состояния"><i class="fas fa-hourglass-half"></i> Время</button>
              </div>
              <div class="me-side-body" data-side-body="zones">
                <div class="me-tree" data-el="tree"></div>
                <div class="me-props" data-el="props"></div>
                <details class="me-world-details" data-el="world-details">
                  <summary><i class="fas fa-earth-europe"></i> Типы зон и меток мира</summary>
                  <div data-el="world"></div>
                </details>
              </div>
              <div class="me-side-body" data-side-body="map" hidden>
                <div data-el="map-settings"></div>
              </div>
              <div class="me-side-body" data-side-body="time" hidden>
                <details class="me-props-details me-calendar" data-el="calendar-details">
                  <summary><i class="fas fa-calendar-days"></i> Календарь мира: <span data-el="calendar-kind"></span></summary>
                  <div data-el="calendar-editor"></div>
                </details>
                <div data-el="time-panel"></div>
              </div>
            </aside>
          </div>
        </div>`;
      this.el = (name) => this.root.querySelector(`[data-el="${name}"]`);
      this.canvasEl = this.root.querySelector('.me-canvas');
      this.wrapEl = this.root.querySelector('.me-canvas-wrap');

      // root — общий #app-content, он переживает редактор: обработчик
      // снимается в destroy(), иначе после перехода к другой карте кнопки
      // («Просмотр», «Сохранить»…) срабатывали бы и у прежнего редактора.
      this._onRootClick = (e) => this.onRootClick(e);
      this.root.addEventListener('click', this._onRootClick);
      MC().makePanelResizable(this.root.querySelector('.me-side'), 'beginfind_map_editor_side_w', { def: 340, min: 260 });
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
        case 'toggle-neighbors': this.setNeighborCut(!this.neighborCut); break;
        case 'toggle-fog': this.setFogPreview(!this.fogPreview); break;
      }
    }

    // «Не заходить на соседей»: новая форма (и то, что добавляется к
    // выбранной зоне) обрезается по зонам того же уровня — соседние зоны не
    // накладываются друг на друга. Запоминается в браузере.
    setNeighborCut(on) {
      this.neighborCut = !!on;
      try { localStorage.setItem(NEIGHBOR_CUT_KEY, this.neighborCut ? '1' : '0'); } catch (e) { /* нет доступа */ }
      const btn = this.root.querySelector('[data-act="toggle-neighbors"]');
      if (btn) {
        btn.classList.toggle('active', this.neighborCut);
        btn.title = this.neighborCut
          ? 'Не заходить на соседние зоны: ВКЛ — новая зона обрезается по зонам того же уровня (N)'
          : 'Не заходить на соседние зоны: ВЫКЛ — зоны могут накладываться (N)';
      }
    }

    // Вычесть из формы зоны того же уровня (те же parentId), существующие
    // сейчас; excludeId — сама зона, к которой добавляем. null — вычитать
    // нечего или выключено; [] — от формы ничего не осталось.
    cutByNeighbors(multi, parentId, excludeId) {
      const clip = this.clip();
      if (!this.neighborCut || !clip) return null;
      const bb = MC().polygonBBox(multi);
      const others = this.doc.zones.filter((z) => z.id !== excludeId && (z.parentId || null) === (parentId || null) && this.existsNow(z))
        .map((z) => this.zonePoly(z))
        .filter((p) => {
          if (!p.length || !bb) return false;
          const ob = MC().polygonBBox(p);
          return ob && ob.minX < bb.maxX && ob.maxX > bb.minX && ob.minY < bb.maxY && ob.maxY > bb.minY;
        });
      if (!others.length) return null;
      try {
        return cleanMulti(clip.difference(multi, ...others));
      } catch (e) {
        return null; // не вышло — оставим как нарисовано
      }
    }

    setSideTab(tab) {
      this.sidebarTab = tab;
      this.root.querySelectorAll('[data-side-tab]').forEach((b) => b.classList.toggle('active', b.dataset.sideTab === tab));
      this.root.querySelectorAll('[data-side-body]').forEach((b) => { b.hidden = b.dataset.sideBody !== tab; });
      if (tab === 'map') this.renderMapSettings();
      if (tab === 'time') this.renderTimePanel();
    }

    // Типы мира — во вкладке «Зоны», рядом со свойствами: цвет, иконку и
    // видимость типа меняют там же, где выбрана зона или метка. Монтируются
    // один раз — несохранённые правки типов не теряются.
    mountWorld() {
      if (this._worldMounted || !this.serverId) return this._worldReady;
      this._worldMounted = true;
      this._worldReady = window.MapsUI.mountWorldEditor(this.el('world'), this.serverId, {
        onSaved: (world) => this.applyZoneTypes(world),
        // Правка типа — сразу на карте и «есть несохранённые изменения»:
        // мир сохраняет обычное «Сохранить» (см. save).
        onChange: (world) => { this.previewWorld(world); this.markDirty(); }
      }).then((ctl) => { this._worldCtl = ctl; return ctl; });
      return this._worldReady;
    }

    // ⚙ у типа в свойствах: раскрыть «Типы мира» и показать нужный тип.
    async openTypeSettings(kind, typeId) {
      const details = this.el('world-details');
      details.open = true;
      const ctl = await this.mountWorld();
      const row = ctl && ctl.openType(kind, typeId);
      if (!row) return;
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.remove('is-flash');
      void row.offsetWidth;
      row.classList.add('is-flash');
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
      if (w.calendar) { this.calendar = w.calendar; this.renderTimelineBar(); if (this.sidebarTab === 'time') this.renderTimePanel(); }
      this.renderZoneLayers();
      this.renderMarkerLayers();
      this.renderMarkerPalette();
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
        // приближение глубже, чем в просмотре — чтобы точно ставить точки.
        maxZoom: MC().MAX_EDITOR_ZOOM,
        zoomSnap: 1,
        zoomDelta: 1,
        wheelPxPerZoomLevel: 100,
        attributionControl: false,
        doubleClickZoom: false,
        boxZoom: false
      });
      this.map.zoomControl.setPosition('bottomright');
      MC().bindPixelZoom(this.map, this.canvasEl);
      this.zonesPane = this.map.createPane('zonesPane');
      this.zonesPane.style.zIndex = 450;
      this.renderer = L.svg({ padding: 0.5, pane: 'zonesPane' });
      // Предпросмотр тумана войны: поверх зон, но под метками и точками
      // правки (markerPane = 600) — править под туманом всё ещё можно.
      this.fogPane = this.map.createPane('meFogPane');
      this.fogPane.style.zIndex = 590;
      this.fogPane.style.pointerEvents = 'none';
      this.fogRenderer = L.svg({ padding: 0.5, pane: 'meFogPane' });
      this.fogLayer = L.layerGroup().addTo(this.map);
      this.drawLayer = L.layerGroup().addTo(this.map);
      this.pausedLayer = L.layerGroup().addTo(this.map); // отложенный многоугольник (бледно)
      this.handleLayer = L.layerGroup().addTo(this.map);
      this.markerLayer = L.layerGroup().addTo(this.map); // в редакторе без группировки — править надо каждую

      this.applySize();

      this.map.on('click', (e) => this.onMapClick(e));
      this.map.on('dblclick', (e) => this.onMapDblClick(e));
      this.map.on('mousemove', (e) => this.onMapMouseMove(e));
      this.map.on('mousedown', (e) => this.onMapMouseDown(e));
      this.map.on('mouseout', () => { if (!this.draw || this.draw.kind !== 'brush') this.hideBrushCursor(); });
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
        overlay.innerHTML = '<div><i class="fas fa-image"></i><p>Загрузите фон — изображение карты. От её размера зависит система координат зон.</p><button type="button" class="btn btn-primary btn-sm" data-overlay-act="upload">Загрузить фон</button></div>';
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

    setBasemap(id, { auto = false } = {}) {
      if (!auto) this._manualBasemapId = id; // выбор в списке — фон вне периодов
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
    // Форма зоны в текущий момент редактора (версия границы, действующая сейчас).
    zonePoly(z) {
      if (!z || !z.shapes || !z.shapes.length) return [];
      const sh = z.shapes[MC().shapeIndexAt(z, this.time)];
      return (sh && sh.polygon) || [];
    }

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
        layer.bindTooltip(esc(zone.title || 'Без названия') + (this.existsNow(zone) ? '' : ' · сейчас не существует'), { sticky: true, direction: 'top', className: 'map-zone-tooltip', offset: [0, -8] });
        layer.addTo(this.map);
        const el = layer.getElement && layer.getElement();
        if (el) el.classList.toggle('me-zone-absent', !this.existsNow(zone));
        this.zoneLayers.set(zone.id, layer);
      });
      this.highlightEventZones && this.highlightEventZones();
      this.renderFogPreview();
    }

    // ----- Предпросмотр тумана войны -----
    // Зоны с туманом — так, как их видит читатель без ролей зоны: сплошная
    // «облачная» заливка поверх фона (см. renderFog в map-core.js).

    setFogPreview(on) {
      this.fogPreview = !!on;
      try { localStorage.setItem(FOG_PREVIEW_KEY, this.fogPreview ? '1' : '0'); } catch (e) { /* нет доступа */ }
      this.root.querySelectorAll('[data-act="toggle-fog"]').forEach((btn) => {
        btn.classList.toggle('active', this.fogPreview);
        if (btn.classList.contains('me-tool')) {
          btn.title = this.fogPreview
            ? 'Предпросмотр тумана: ВКЛ — зоны с туманом закрыты, как у читателя без их ролей (F)'
            : 'Предпросмотр тумана: ВЫКЛ (F)';
        }
      });
      this.renderFogPreview();
    }

    renderFogPreview() {
      if (!this.fogLayer) return;
      this.fogLayer.clearLayers();
      if (!this.fogPreview) return;
      this.doc.zones.forEach((z) => {
        if (!z.fog || !this.existsNow(z)) return;
        const poly = this.zonePoly(z);
        if (!poly.length) return;
        L.polygon(MC().polygonToLatLngs(poly), {
          renderer: this.fogRenderer,
          interactive: false,
          className: 'map-fog',
          color: '#3a3c42',
          weight: 1,
          opacity: 0.9,
          fillColor: '#1b1c20',
          fillOpacity: 0.97
        }).addTo(this.fogLayer);
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
      const el = layer.getElement && layer.getElement();
      if (el) el.classList.toggle('me-zone-absent', !this.existsNow(zone));
      if (zone.fog && this.fogPreview) this.renderFogPreview(); // туман следует за правкой точек
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
      // Недорисованный многоугольник при смене инструмента не выбрасываем —
      // откладываем (виден бледным) до возвращения к «Многоугольнику».
      const poly = this.draw && this.draw.kind === 'polygon';
      if (poly && tool !== 'polygon') {
        if (this.draw.points.length) this.pausedPoly = this.draw;
        this.draw = null;
        this.drawLayer.clearLayers();
      } else if (!poly) {
        this.cancelDrawing();
      }
      if (tool === 'polygon' && this.pausedPoly) {
        this.draw = this.pausedPoly;
        this.pausedPoly = null;
      }
      this.renderPaused();
      this.tool = tool;
      this.root.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
      const drawing = tool === 'polygon' || tool === 'lasso' || tool === 'brush';
      if (tool !== 'brush') this.hideBrushCursor();
      this.wrapEl.classList.toggle('me-drawing', drawing);
      this.wrapEl.classList.toggle('me-tool-lasso', tool === 'lasso');
      if (drawing && !this.mods.space) this.map.dragging.disable(); else this.map.dragging.enable();
      if (tool === 'vertex' && !this.selectedId) this.toast('Сначала выберите зону — её точки появятся для правки');
      this.renderHandles();
      this.renderMarkerPalette();
      if (this.draw && this.draw.kind === 'polygon') this.renderDraft();
      this.updateHint();
      this.updateUndoButtons();
    }

    // Палитра типов для инструмента «Метка»: какой тип получит следующая
    // поставленная метка (запоминается, пока открыт редактор).
    renderMarkerPalette() {
      const el = this.el('marker-palette');
      if (!el) return;
      el.hidden = this.tool !== 'marker';
      if (el.hidden) return;
      if (!this.markerTypes.some((t) => t.id === this.newMarkerTypeId)) this.newMarkerTypeId = this.markerTypes[0] ? this.markerTypes[0].id : null;
      el.innerHTML = `<div class="me-palette-head">Ставить метку:</div>` + (this.markerTypes.length
        ? this.markerTypes.map((t) => `<button type="button" class="me-palette-item${t.id === this.newMarkerTypeId ? ' active' : ''}" data-new-type="${esc(t.id)}">
            <span class="map-marker" style="--marker-color:${esc(t.color)}"><i class="fas fa-${esc(t.icon)}"></i></span>${esc(t.name)}
          </button>`).join('')
        : '<div class="me-palette-empty">Нет типов меток</div>')
        + (this.doc.markerGroups.length ? `<div class="me-palette-head">В группу:</div>
          <select class="me-palette-group">${['<option value="">Без группы</option>', ...this.doc.markerGroups.map((g) => `<option value="${esc(g.id)}"${g.id === this.newMarkerGroupId ? ' selected' : ''}>${esc(g.name)}</option>`)].join('')}</select>` : '');
      const groupSel = el.querySelector('.me-palette-group');
      if (groupSel) groupSel.onchange = () => { this.newMarkerGroupId = groupSel.value || null; };
      el.onclick = (e) => {
        const b = e.target.closest('[data-new-type]');
        if (!b) return;
        this.newMarkerTypeId = b.dataset.newType;
        this.renderMarkerPalette();
      };
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
    }

    updateHint() {
      const t = TOOLS.find((x) => x.id === this.tool);
      let text = t ? t.hint : '';
      if (this.draw && this.draw.kind === 'polygon') text = `Точек: ${this.draw.points.length}. ${text} Ctrl+Z — убрать последнюю точку.`;
      else if (this.pausedPoly) text = `Недорисованный контур (${this.pausedPoly.points.length} точек) ждёт — вернитесь к «Многоугольнику» (P), чтобы продолжить. ${text}`;
      this.el('hint').textContent = text;
    }

    // ----- Рисование -----

    clickPoint(e) { return MC().fromLatLng(e.latlng); }

    // ----- Прилипание к границам других зон -----
    //
    // Точка многоугольника (и перетаскиваемая точка зоны), поставленная в
    // пределах SNAP_PX от вершины или ребра существующей зоны, ложится ровно
    // на её границу — у соседних зон получается общая граница без щелей и
    // наложений. Вершина в приоритете перед ребром.
    // @returns {{zoneId, pi, ri, s, pt}|null} s — позиция на кольце (см. ringTrace)
    findSnap(pt, { excludeZoneId = null } = {}) {
      if (!this.map) return null;
      const tol = SNAP_PX / Math.pow(2, this.map.getZoom());
      let vBest = null;
      let eBest = null;
      this.doc.zones.forEach((z) => {
        if (z.id === excludeZoneId || !this.existsNow(z)) return;
        this.zonePoly(z).forEach((rings, pi) => rings.forEach((ring, ri) => {
          const n = ring.length;
          for (let i = 0; i < n; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % n];
            // Быстрый отсев ребра целиком за пределами допуска.
            if (pt[0] < Math.min(a[0], b[0]) - tol || pt[0] > Math.max(a[0], b[0]) + tol
              || pt[1] < Math.min(a[1], b[1]) - tol || pt[1] > Math.max(a[1], b[1]) + tol) continue;
            const dv = Math.hypot(pt[0] - a[0], pt[1] - a[1]);
            if (dv <= tol && (!vBest || dv < vBest.d)) vBest = { d: dv, zoneId: z.id, pi, ri, s: i, pt: [a[0], a[1]] };
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const len2 = dx * dx + dy * dy;
            if (!len2) continue;
            const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / len2));
            const q = [a[0] + t * dx, a[1] + t * dy];
            const de = Math.hypot(pt[0] - q[0], pt[1] - q[1]);
            if (de <= tol && (!eBest || de < eBest.d)) {
              eBest = { d: de, zoneId: z.id, pi, ri, s: t >= 1 ? (i + 1) % n : i + t, pt: [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10] };
            }
          }
        }));
      });
      return vBest || eBest;
    }

    snapRing(snap) {
      const z = snap && this.zoneById(snap.zoneId);
      const poly = z && this.zonePoly(z);
      return (poly && poly[snap.pi] && poly[snap.pi][snap.ri]) || null;
    }

    // Обход вдоль границы: предыдущая точка контура и новая лежат на одном
    // кольце одной зоны — вернуть вершины границы между ними.
    traceBetween(prevSnap, snap, longWay) {
      if (!prevSnap || !snap) return [];
      if (prevSnap.zoneId !== snap.zoneId || prevSnap.pi !== snap.pi || prevSnap.ri !== snap.ri) return [];
      const ring = this.snapRing(snap);
      return ring ? ringTrace(ring, prevSnap, snap, longWay) : [];
    }

    onMapClick(e) {
      if (this.tool === 'polygon' && this.size) {
        if (this.mods.space) return;
        let pt = this.clickPoint(e);
        if (!this.draw) this.draw = { kind: 'polygon', points: [], redo: [] };
        const pts = this.draw.points;
        // Клик рядом с первой точкой — замкнуть.
        if (pts.length >= 3) {
          const first = this.map.latLngToContainerPoint(MC().toLatLng(pts[0]));
          if (first.distanceTo(e.containerPoint) < 10) { this.finishPolygon(); return; }
        }
        const snap = this.findSnap(pt);
        if (snap) pt = [snap.pt[0], snap.pt[1]];
        // Две точки подряд на границе одной зоны — контур идёт вдоль неё
        // (Ctrl — в обход с другой стороны). Вставленные точки — одна группа
        // с кликнутой: Backspace/Ctrl+Z убирают их вместе.
        const last = pts[pts.length - 1];
        const traced = last && last.snap ? this.traceBetween(last.snap, snap, e.originalEvent && e.originalEvent.ctrlKey) : [];
        if (traced.length) {
          const group = genId('t');
          traced.forEach((p) => { p.trace = group; pts.push(p); });
          pt.traceEnd = group;
        }
        if (snap) pt.snap = snap;
        pts.push(pt);
        this.draw.redo = [];
        this.renderDraft(e.latlng, e.originalEvent && e.originalEvent.ctrlKey);
        this.drawingChanged();
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
        html: `<span class="map-marker${selected ? ' is-selected' : ''}${this.existsNow(m) ? '' : ' is-absent'}" style="--marker-color:${esc(t.color)}"><i class="fas fa-${esc(t.icon)}"></i></span>`
      });
    }

    // Самая глубокая зона, в которой стоит точка: метка скрытой зоны
    // скрывается у читателя вместе с ней.
    zoneForPoint(pt) {
      const depths = MC().zoneDepths(this.doc.zones);
      let best = null;
      this.doc.zones.forEach((z) => {
        if (!this.existsNow(z) || !MC().pointInMulti(pt, this.zonePoly(z))) return;
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
        if (m.groupId && this.hiddenGroupsEd.has(m.groupId) && m.id !== this.selectedMarkerId) return; // группа скрыта «глазиком»
        const marker = L.marker(MC().toLatLng(m.pos), { icon: this.markerIcon(m), draggable: true, keyboard: false, riseOnHover: true });
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          this.selectMarker(m.id);
          this.openMarkerPopup(m.id);
        });
        // Во время перетаскивания иконку НЕ меняем (выделение = setIcon) —
        // иначе элемент, за который тянут, пропадает и перетаскивание
        // обрывается. Выделяем уже после того, как метку отпустили.
        marker.on('dragstart', () => { this.pushHistory(); marker.closePopup(); marker.closeTooltip(); });
        marker.on('dragend', () => {
          const pos = this.clampToImage(MC().fromLatLng(marker.getLatLng()));
          m.pos = [Math.round(pos[0] * 10) / 10, Math.round(pos[1] * 10) / 10];
          m.zoneId = this.zoneForPoint(m.pos);
          marker.setLatLng(MC().toLatLng(m.pos));
          this.markDirty();
          this.selectMarker(m.id);
        });
        marker.bindTooltip(esc(m.title || this.markerType(m).name), { direction: 'top', offset: [0, -16], className: 'map-zone-tooltip' });
        marker.addTo(this.markerLayer);
        this.markerLayers.set(m.id, marker);
      });
      this.applyMarkerSearchOpacity();
    }

    // Поиск в списке: название, описание или имя группы метки.
    markerMatches(m, q) {
      const norm = (v) => String(v || '').toLowerCase().replace(/ё/g, 'е');
      const g = m.groupId && (this.doc.markerGroups || []).find((x) => x.id === m.groupId);
      return norm(m.title).includes(q) || norm(m.text).includes(q) || (!!g && norm(g.name).includes(q));
    }

    // Пока в поиске что-то набрано, не совпавшие метки на карте редактора
    // полупрозрачные.
    applyMarkerSearchOpacity() {
      const q = String(this._treeQuery || '').toLowerCase().replace(/ё/g, 'е').trim();
      this.markerLayers.forEach((layer, id) => {
        const m = this.markerById(id);
        layer.setOpacity(!q || !m || this.markerMatches(m, q) ? 1 : 0.25);
      });
    }

    refreshMarkerIcon(id) {
      const m = this.markerById(id);
      const layer = this.markerLayers.get(id);
      if (m && layer) layer.setIcon(this.markerIcon(m));
    }

    addMarker(pos) {
      this.pushHistory();
      const type = this.markerTypes.find((t) => t.id === this.newMarkerTypeId) || this.markerTypes[0] || null;
      const n = (this.doc.markers || []).filter((m) => m.typeId === (type && type.id)).length + 1;
      const marker = {
        id: genId('k'),
        typeId: type ? type.id : null,
        zoneId: this.zoneForPoint(pos),
        groupId: this.doc.markerGroups.some((g) => g.id === this.newMarkerGroupId) ? this.newMarkerGroupId : null,
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

    // Мини-панель у выбранной метки: удалить прямо на карте, без боковой панели.
    openMarkerPopup(id) {
      const m = this.markerById(id);
      const layer = this.markerLayers.get(id);
      if (!m || !layer) return;
      const html = `<div class="me-marker-popup-body">
          <span class="me-marker-popup-title">${esc(m.title || this.markerType(m).name)}</span>
          <button type="button" class="map-icon-btn is-danger" data-pop="delete" title="Удалить метку (Backspace)"><i class="fas fa-trash"></i></button>
        </div>`;
      layer.unbindPopup();
      layer.bindPopup(html, { className: 'me-marker-popup', closeButton: false, offset: [0, -12], autoPan: false }).openPopup();
      const el = layer.getPopup().getElement();
      if (!el) return;
      L.DomEvent.disableClickPropagation(el);
      el.querySelector('[data-pop="delete"]').onclick = () => { layer.closePopup(); this.deleteMarker(id); };
    }

    // Подтверждение удаления — модальное окно приложения (confirm-dialog.js),
    // запасной вариант — системный confirm.
    async askDelete(message, title = 'Удалить?', confirmLabel = 'Удалить') {
      if (window.confirmDialog) return window.confirmDialog.open({ title, message, confirmLabel, danger: confirmLabel === 'Удалить' });
      return confirm(message);
    }

    async deleteMarker(id) {
      const m = this.markerById(id);
      if (!m || !(await this.askDelete(`Метка «${m.title || 'без названия'}» будет удалена с карты.`, 'Удалить метку?'))) return;
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
      if (this.tool === 'brush') { if (!this.mods.space) this.showBrushCursor(e.latlng); else this.hideBrushCursor(); return; }
      if (this.tool === 'polygon' && !this.mods.space) this.renderDraft(e.latlng, e.originalEvent && e.originalEvent.ctrlKey);
    }

    // cursorLatLng — где сейчас мышь: к ней тянется пунктир от последней
    // точки; если курсор прилипает к границе зоны — там кружок-подсказка, а
    // если выйдет обход вдоль границы — пунктир показывает его путь.
    renderDraft(cursorLatLng, longWay) {
      this.drawLayer.clearLayers();
      let cursor = cursorLatLng;
      let cursorSnap = null;
      if (cursor && this.tool === 'polygon') {
        cursorSnap = this.findSnap(MC().fromLatLng(cursor));
        if (cursorSnap) {
          cursor = MC().toLatLng(cursorSnap.pt);
          L.circleMarker(cursor, { radius: 7, color: '#3ba55d', weight: 2, fill: false, interactive: false }).addTo(this.drawLayer);
        }
      }
      if (!this.draw) return;
      const lls = this.draw.points.map(MC().toLatLng);
      if (this.draw.kind === 'polygon') {
        const last = this.draw.points[this.draw.points.length - 1];
        const traced = cursorSnap && last && last.snap ? this.traceBetween(last.snap, cursorSnap, longWay) : [];
        if (traced.length) L.polyline([MC().toLatLng(last), ...traced.map(MC().toLatLng), cursor], { color: '#3ba55d', weight: 4, opacity: 0.9, interactive: false }).addTo(this.drawLayer);
        const line = cursor ? [...lls, ...traced.map(MC().toLatLng), cursor] : lls;
        if (line.length > 1) L.polyline(line, { color: '#ffffff', weight: 2, dashArray: '5 5', interactive: false }).addTo(this.drawLayer);
        lls.forEach((ll, i) => L.circleMarker(ll, { radius: i === 0 ? 6 : 4, color: '#ffffff', weight: 2, fillColor: i === 0 ? '#faa81a' : '#5865f2', fillOpacity: 1, interactive: false }).addTo(this.drawLayer));
      } else if (this.draw.kind === 'lasso' && lls.length > 1) {
        L.polyline(lls, { color: '#ffffff', weight: 2, interactive: false }).addTo(this.drawLayer);
      }
    }

    // ----- Кисть -----
    //
    // Мазок — ломаная в экранных пикселях; при отпускании каждая пара
    // соседних точек становится «капсулой» (прямоугольник + круги на концах)
    // шириной brushPx, капсулы склеиваются в один контур (polygon-clipping).

    brushSize() {
      if (!this.brushPx) {
        let v = NaN;
        try { v = parseInt(localStorage.getItem(BRUSH_KEY), 10); } catch (e) { /* нет доступа */ }
        this.brushPx = Number.isFinite(v) ? Math.max(BRUSH_MIN, Math.min(BRUSH_MAX, v)) : 24;
      }
      return this.brushPx;
    }

    setBrushSize(px) {
      this.brushPx = Math.max(BRUSH_MIN, Math.min(BRUSH_MAX, Math.round(px)));
      try { localStorage.setItem(BRUSH_KEY, String(this.brushPx)); } catch (e) { /* нет доступа */ }
      if (this._brushCursor) this._brushCursor.setRadius(this.brushPx / 2);
      this.el('hint').textContent = `Размер кисти: ${this.brushPx} px на экране. ${TOOLS.find((t) => t.id === 'brush').hint}`;
    }

    showBrushCursor(latlng) {
      if (!this._brushCursor) {
        this._brushCursor = L.circleMarker(latlng, { radius: this.brushSize() / 2, color: '#ffffff', weight: 1.5, dashArray: '3 3', fill: false, interactive: false });
      }
      this._brushCursor.setLatLng(latlng);
      if (!this.map.hasLayer(this._brushCursor)) this._brushCursor.addTo(this.map);
    }

    hideBrushCursor() {
      if (this._brushCursor && this.map && this.map.hasLayer(this._brushCursor)) this._brushCursor.remove();
    }

    startBrush(e) {
      const cp = e.containerPoint;
      this.draw = { kind: 'brush', cps: [cp], alt: !!(e.originalEvent && e.originalEvent.altKey) };
      const renderStroke = () => {
        this.drawLayer.clearLayers();
        const lls = this.draw.cps.map((p) => this.map.containerPointToLatLng(p));
        const style = { color: this.draw.alt ? '#ed4245' : '#3ba55d', opacity: 0.45, weight: this.brushSize(), lineCap: 'round', lineJoin: 'round', interactive: false };
        if (lls.length > 1) L.polyline(lls, style).addTo(this.drawLayer);
        else L.circleMarker(lls[0], { radius: this.brushSize() / 2, stroke: false, fillColor: style.color, fillOpacity: 0.45, interactive: false }).addTo(this.drawLayer);
      };
      renderStroke();
      const onMove = (ev) => {
        if (!this.draw || this.draw.kind !== 'brush') return;
        const p = this.map.mouseEventToContainerPoint(ev);
        this.showBrushCursor(this.map.containerPointToLatLng(p));
        if (p.distanceTo(this.draw.cps[this.draw.cps.length - 1]) < 2) return;
        this.draw.cps.push(p);
        renderStroke();
      };
      const onUp = () => {
        this._lassoUp = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        this.finishBrush();
      };
      this._lassoUp = onUp;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    finishBrush() {
      const d = this.draw;
      this.cancelDrawing();
      if (!d || d.kind !== 'brush' || !d.cps.length) return;
      const clip = this.clip();
      if (!clip) { this.toast('Библиотека операций с контурами не загрузилась'); return; }
      const rPx = this.brushSize() / 2;
      // Упрощаем в экранных пикселях: дрожь руки меньше четверти кисти не нужна.
      const cps = d.cps.length > 2 ? L.LineUtil.simplify(d.cps, Math.max(1, rPx / 4)) : d.cps;
      const pts = cps.map((p) => MC().fromLatLng(this.map.containerPointToLatLng(p)));
      const r = rPx / Math.pow(2, this.map.getZoom()); // радиус в пикселях карты
      const circle = (c) => {
        const ring = [];
        for (let i = 0; i < BRUSH_SIDES; i++) {
          const a = (i / BRUSH_SIDES) * Math.PI * 2;
          ring.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
        }
        return [ring];
      };
      const parts = pts.map(circle);
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1];
        const [bx, by] = pts[i];
        const len = Math.hypot(bx - ax, by - ay);
        if (!len) continue;
        const nx = (-(by - ay) / len) * r;
        const ny = ((bx - ax) / len) * r;
        parts.push([[[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]]);
      }
      let shape;
      try {
        shape = cleanMulti(clip.union(...parts));
      } catch (err) {
        this.toast(`Не удалось собрать мазок: ${err.message}`);
        return;
      }
      if (!shape.length) return;
      const selected = this.zoneById(this.selectedId);
      this.applyNewShape(shape, selected ? (d.alt ? 'cut' : 'add') : 'new');
    }

    onMapMouseDown(e) {
      if (this.tool === 'brush' && this.size && !this.mods.space) {
        const oe = e.originalEvent;
        if (oe.button !== 0) return;
        oe.preventDefault();
        this.startBrush(e);
        return;
      }
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
        this._lassoUp = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        this.finishLasso();
      };
      this._lassoUp = onUp; // для finishStuckDrag: отпустили кнопку вне окна
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    cancelDrawing() {
      this.draw = null;
      if (this.drawLayer) this.drawLayer.clearLayers();
      this.updateHint && this.el && this.updateHint();
    }

    // Esc: контур убирается, но Ctrl+Z сразу после этого возвращает его.
    abandonDrawing() {
      const poly = this.draw && this.draw.kind === 'polygon' ? this.draw : null;
      if (poly && poly.points.length) {
        this._recoverDraw = { kind: 'cancel', points: poly.points.slice() };
        this.toast(`Контур отменён (точек: ${poly.points.length}) — Ctrl+Z вернёт его`);
      }
      this.cancelDrawing();
      this.drawingChanged();
    }

    // Замкнуть контур в зону. Если не вышло (мало точек, контур за краем,
    // не совместился с выбранной зоной) — точки остаются, рисование
    // продолжается. Ctrl+Z после замыкания убирает зону и возвращает контур.
    finishPolygon() {
      const pts = this.draw ? this.draw.points.slice() : [];
      if (pts.length < 3) { this.toast('Нужно хотя бы три точки'); return; }
      if (!this.applyNewShape([[pts]])) return;
      this.cancelDrawing();
      this._recoverDraw = { kind: 'finish', points: pts };
      this.drawingChanged();
    }

    // Продолжить рисование многоугольника с этими точками.
    resumeDrawing(points) {
      this.pausedPoly = null;
      this.draw = { kind: 'polygon', points: points.slice(), redo: [] };
      this.setTool('polygon');
      this.drawingChanged();
    }

    popDrawPoint() {
      const pts = this.draw.points;
      const p = pts.pop();
      if (p && p.traceEnd) {
        // Точка, к которой контур шёл вдоль границы, — убираем вместе с
        // вставленными точками обхода (в redo — одной группой).
        const group = [p];
        while (pts.length && pts[pts.length - 1].trace === p.traceEnd) group.unshift(pts.pop());
        this.draw.redo.push({ group });
      } else if (p) this.draw.redo.push(p);
      if (!this.draw.points.length) {
        // Убрали все точки — контура больше нет, но Ctrl+Y вернёт их.
        this.draw = { kind: 'polygon', points: [], redo: this.draw.redo };
      }
      this.renderDraft();
      this.drawingChanged();
    }

    // Отрисовка отложенного контура, подсказка, кнопки отмены/повтора и
    // сохранение контура в localStorage — после любого его изменения.
    drawingChanged() {
      this.renderPaused();
      this.updateHint();
      this.updateUndoButtons();
      this.saveDrawing();
    }

    renderPaused() {
      if (!this.pausedLayer) return;
      this.pausedLayer.clearLayers();
      if (!this.pausedPoly || !this.pausedPoly.points.length) return;
      const lls = this.pausedPoly.points.map(MC().toLatLng);
      if (lls.length > 1) L.polyline(lls, { color: '#ffffff', weight: 2, opacity: 0.55, dashArray: '2 6', interactive: false }).addTo(this.pausedLayer);
      L.circleMarker(lls[0], { radius: 5, color: '#ffffff', weight: 2, fillColor: '#faa81a', fillOpacity: 0.7, opacity: 0.7, interactive: false }).addTo(this.pausedLayer);
    }

    drawingKey() { return DRAWING_PREFIX + this.mapId; }

    currentPolyDraw() {
      if (this.draw && this.draw.kind === 'polygon' && this.draw.points.length) return this.draw;
      if (this.pausedPoly && this.pausedPoly.points.length) return this.pausedPoly;
      return null;
    }

    saveDrawing() {
      const d = this.currentPolyDraw();
      try {
        if (d) localStorage.setItem(this.drawingKey(), JSON.stringify({ points: d.points, savedAt: Date.now() }));
        else localStorage.removeItem(this.drawingKey());
      } catch (e) { /* localStorage недоступен/переполнен — контур живёт только в памяти */ }
    }

    // При открытии редактора — вернуть контур, недорисованный в прошлый раз
    // (перезагрузка страницы, закрытая вкладка, вылет из сессии).
    restoreDrawing() {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(this.drawingKey()) || 'null'); } catch (e) { saved = null; }
      const pts = saved && Array.isArray(saved.points)
        ? saved.points.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
        : [];
      if (!pts.length || !this.size) return; // без подложки рисовать нельзя — контур подождёт
      this.resumeDrawing(pts);
      this.toast(`Восстановлен недорисованный контур (точек: ${pts.length}). Продолжайте ставить точки или нажмите Esc, чтобы отменить.`);
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

    // true — форма применена; false — нет (причина уже показана тостом).
    // mode: 'add' — добавить к выбранной зоне, 'cut' — вырезать из неё,
    // 'new' — новая зона; не задан — по модификаторам (Shift / Alt).
    applyNewShape(multi, mode) {
      multi = this.clipToImage(multi);
      if (!multi.length) { this.toast('Область целиком за краем карты'); return false; }
      const clip = this.clip();
      const selected = this.zoneById(this.selectedId);
      const op = mode || (this.mods.shift ? 'add' : this.mods.alt ? 'cut' : 'new');
      if ((op === 'add' || op === 'cut') && selected) {
        if (!clip) { this.toast('Библиотека операций с контурами не загрузилась'); return false; }
        if (op === 'add') {
          const cut = this.cutByNeighbors(multi, selected.parentId, selected.id);
          if (cut && !cut.length) { this.toast('Эта область целиком занята соседними зонами (выключить: кнопка «Не заходить на соседей», N)'); return false; }
          if (cut) multi = cut;
        }
        let result;
        try {
          result = op === 'add' ? clip.union(this.zonePoly(selected), multi) : clip.difference(this.zonePoly(selected), multi);
        } catch (err) { this.toast(`Не удалось совместить контуры: ${err.message}`); return false; }
        result = cleanMulti(result);
        if (!result.length) { this.toast('От зоны ничего не осталось — отменено'); return false; }
        this.pushHistory();
        this.setZonePoly(selected, result);
        this.afterZonesChanged({ keepLayers: false });
        return true;
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
      const cut = this.cutByNeighbors(polygon, parent ? parent.id : null, null);
      if (cut && !cut.length) { this.toast('Эта область целиком занята соседними зонами (выключить: кнопка «Не заходить на соседей», N)'); return false; }
      if (cut) polygon = cut;

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
      return true;
    }

    // Родитель — самая глубокая зона, внутри которой лежит большая часть
    // точек новой формы.
    findParentFor(multi) {
      const pts = (multi[0] && multi[0][0]) || [];
      if (!pts.length) return null;
      const depths = MC().zoneDepths(this.doc.zones);
      let best = null;
      this.doc.zones.forEach((z) => {
        if (!this.existsNow(z)) return;
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
      let p = this.clampToImage(MC().fromLatLng(ll));
      // Прилипание к границе другой зоны (см. findSnap).
      const snap = this.findSnap(p, { excludeZoneId: zone.id });
      if (snap) p = snap.pt;
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

    // Список зон и меток: поиск, сворачиваемые разделы и ветки дерева —
    // при большом числе зон до нужной иначе не долистаться.
    renderTree() {
      const tree = this.el('tree');
      this._treeOpen = this._treeOpen || { zones: true, markers: true };
      this._collapsed = this._collapsed || new Set();
      if (!tree.querySelector('.me-tree-search')) {
        tree.innerHTML = '<input type="search" class="me-tree-search form-input" placeholder="Найти зону или метку…" autocomplete="off"><div data-el="tree-body"></div>';
        const search = tree.querySelector('.me-tree-search');
        search.addEventListener('input', () => { this._treeQuery = search.value; this.renderTree(); this.applyMarkerSearchOpacity(); });
        this.bindTreeEvents(tree);
      }
      const body = tree.querySelector('[data-el="tree-body"]');
      const norm = (v) => String(v || '').toLowerCase().replace(/ё/g, 'е');
      const q = norm(this._treeQuery).trim();

      // Выбранная зона всегда видна: разворачиваем её предков.
      if (this.selectedId) {
        let p = this.zoneById(this.selectedId)?.parentId;
        let guard = 0;
        while (p && guard++ < 64) { this._collapsed.delete(p); p = this.zoneById(p)?.parentId; }
      }

      const zones = this.doc.zones;
      const ids = new Set(zones.map((z) => z.id));
      const children = new Map();
      zones.forEach((z) => {
        const key = z.parentId && ids.has(z.parentId) ? z.parentId : '';
        if (!children.has(key)) children.set(key, []);
        children.get(key).push(z);
      });
      const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '', 'ru');
      const zoneRow = (z, depth, hasKids) => {
        const t = this.types.get(z.typeId) || MC().FALLBACK_TYPE;
        const caret = hasKids
          ? `<button type="button" class="me-tree-caret" data-toggle-zone="${esc(z.id)}" title="${this._collapsed.has(z.id) ? 'Развернуть' : 'Свернуть'}"><i class="fas fa-caret-${this._collapsed.has(z.id) ? 'right' : 'down'}"></i></button>`
          : '<span class="me-tree-caret-space"></span>';
        return `<div class="me-tree-item${z.id === this.selectedId ? ' active' : ''}${this.existsNow(z) ? '' : ' is-absent'}" draggable="true" data-zone-id="${esc(z.id)}" style="padding-left:${4 + depth * 14}px">
          ${caret}
          <span class="map-fs-zone-dot" style="background:${esc(t.color)}"></span>
          <span class="me-tree-name">${esc(z.title || 'Без названия')}</span>${z.fog ? '<i class="fas fa-cloud me-tree-fog" title="Туман войны"></i>' : ''}
          <span class="me-tree-type">${esc(t.name)}</span>
          ${z.roles && z.roles.length ? '<i class="fas fa-lock me-tree-flag" title="Доступ ограничен ролями"></i>' : ''}
          ${z.article ? '<i class="fas fa-book me-tree-flag" title="Привязана статья"></i>' : ''}
        </div>`;
      };
      const rows = [];
      if (q) {
        zones.filter((z) => norm(z.title).includes(q)).sort(byTitle).forEach((z) => rows.push(zoneRow(z, 0, false)));
      } else {
        const walk = (key, depth) => (children.get(key) || []).sort(byTitle).forEach((z) => {
          const kids = (children.get(z.id) || []).length > 0;
          rows.push(zoneRow(z, depth, kids));
          if (kids && !this._collapsed.has(z.id)) walk(z.id, depth + 1);
        });
        walk('', 0);
      }

      const markers = (this.doc.markers || []).filter((m) => !q || this.markerMatches(m, q)).sort(byTitle);
      const groups = this.doc.markerGroups || [];
      const groupIds = new Set(groups.map((g) => g.id));
      const canDrag = !q && groups.length > 0; // перетаскивание метки в другую группу
      const markerRow = (m) => {
        const t = this.markerType(m);
        return `<div class="me-tree-item${m.id === this.selectedMarkerId ? ' active' : ''}${this.existsNow(m) ? '' : ' is-absent'}" data-marker-id="${esc(m.id)}"${canDrag ? ` draggable="true" data-in-group="${esc(groupIds.has(m.groupId) ? m.groupId : '')}"` : ''}>
          <i class="fas fa-${esc(t.icon)} map-fs-marker-icon" style="color:${esc(t.color)}"></i>
          <span class="me-tree-name">${esc(m.title || t.name)}</span>
          <span class="me-tree-type">${esc(t.name)}</span>
          ${m.roles && m.roles.length ? '<i class="fas fa-lock me-tree-flag" title="Доступ ограничен ролями"></i>' : ''}
          ${m.article ? '<i class="fas fa-book me-tree-flag" title="Привязана статья"></i>' : ''}
        </div>`;
      };
      // Метки по группам: заголовок группы — «глазик» (видимость на карте
      // редактора), название (правится прямо тут), «скрыта у читателя по
      // умолчанию», удалить. При поиске — плоский список. Метку можно
      // перетащить на заголовок группы (или на метку в ней) — перенести туда.
      let markerRows;
      if (q || !groups.length) {
        markerRows = markers.map(markerRow);
      } else {
        markerRows = [];
        groups.forEach((g) => {
          const list = markers.filter((m) => m.groupId === g.id);
          const hidden = this.hiddenGroupsEd.has(g.id);
          markerRows.push(`<div class="me-group-head${hidden ? ' is-hidden' : ''}" data-group-id="${esc(g.id)}" data-group-drop="${esc(g.id)}">
            <button type="button" class="me-tree-caret" data-group-eye="${esc(g.id)}" title="${hidden ? 'Показать на карте редактора' : 'Скрыть на карте редактора'}"><i class="fas fa-eye${hidden ? '-slash' : ''}"></i></button>
            <input type="text" class="me-group-name" data-group-name="${esc(g.id)}" value="${esc(g.name)}" maxlength="60" title="Название группы">
            <span class="me-tree-type">${list.length}</span>
            <button type="button" class="me-tree-caret${g.ownCluster ? ' is-on' : ''}" data-group-cluster="${esc(g.id)}" title="${g.ownCluster ? 'Свои кружки: на отдалении метки группы собираются только между собой. Нажмите, чтобы смешивать с остальными' : 'На отдалении метки группы смешиваются с остальными в общие кружки. Нажмите, чтобы собирать их отдельно'}"><i class="fas fa-object-group"></i></button>
            <button type="button" class="me-tree-caret${g.hiddenByDefault ? ' is-on' : ''}" data-group-default="${esc(g.id)}" title="${g.hiddenByDefault ? 'У читателя скрыта по умолчанию — нажмите, чтобы показывать сразу' : 'У читателя видна сразу — нажмите, чтобы скрыть по умолчанию'}"><i class="fas fa-user-${g.hiddenByDefault ? 'slash' : 'check'}"></i></button>
            <button type="button" class="me-tree-caret is-danger" data-group-del="${esc(g.id)}" title="Удалить группу (метки останутся без группы)"><i class="fas fa-trash"></i></button>
          </div>`);
          list.forEach((m) => markerRows.push(markerRow(m)));
        });
        // «Без группы» — всегда, даже пустая: на неё перетаскивают, чтобы убрать метку из группы.
        const loose = markers.filter((m) => !groupIds.has(m.groupId));
        markerRows.push('<div class="me-group-head me-group-loose" data-group-drop=""><span class="me-tree-caret-space"></span><span class="me-tree-name">Без группы</span><span class="me-tree-type">' + loose.length + '</span></div>');
        loose.forEach((m) => markerRows.push(markerRow(m)));
      }
      const zoneCount = q ? `${rows.length} из ${zones.length}` : zones.length;
      const markerCount = q ? `${markers.length} из ${(this.doc.markers || []).length}` : markers.length;
      body.innerHTML = `
        <details class="me-tree-section" data-section="zones" ${this._treeOpen.zones || q ? 'open' : ''}>
          <summary>Зоны (${zoneCount})${!q && zones.some((z) => (children.get(z.id) || []).length) ? '<span class="me-tree-bulk"><button type="button" data-tree-bulk="collapse" title="Свернуть все ветки"><i class="fas fa-compress"></i></button><button type="button" data-tree-bulk="expand" title="Развернуть все ветки"><i class="fas fa-expand"></i></button></span>' : ''}</summary>
          <div class="me-tree-list">${rows.join('') || `<div class="me-tree-empty">${q ? 'Ничего не найдено' : 'Нарисуйте первую зону инструментом «Лассо» или «Многоугольник»'}</div>`}</div>
          <div class="me-tree-root-drop" data-root-drop>Перетащите сюда — сделать зоной верхнего уровня</div>
        </details>
        <details class="me-tree-section" data-section="markers" ${this._treeOpen.markers || q ? 'open' : ''}>
          <summary>Метки (${markerCount})<span class="me-tree-bulk"><button type="button" data-group-add title="Новая группа меток"><i class="fas fa-folder-plus"></i></button></span></summary>
          <div class="me-tree-list me-tree-list-markers">${markerRows.join('') || `<div class="me-tree-empty">${q ? 'Ничего не найдено' : 'Инструмент «Метка» (M) — клик по карте ставит метку'}</div>`}</div>
        </details>`;
      body.querySelectorAll('details[data-section]').forEach((d) => {
        d.addEventListener('toggle', () => { if (!q) this._treeOpen[d.dataset.section] = d.open; });
      });
      // Прокрутить список к выбранному.
      const active = body.querySelector('.me-tree-item.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }

    bindTreeEvents(tree) {
      tree.addEventListener('change', (e) => {
        const nameIn = e.target.closest('[data-group-name]');
        if (!nameIn) return;
        const g = this.doc.markerGroups.find((x) => x.id === nameIn.dataset.groupName);
        if (!g || !nameIn.value.trim()) { nameIn.value = g ? g.name : ''; return; }
        this.pushHistory();
        g.name = nameIn.value.trim().slice(0, 60);
        this.markDirty();
        this.renderMarkerPalette();
      });
      tree.onclick = (e) => {
        if (this.onGroupClick(e)) return;
        const caret = e.target.closest('[data-toggle-zone]');
        if (caret) {
          const id = caret.dataset.toggleZone;
          if (this._collapsed.has(id)) this._collapsed.delete(id); else this._collapsed.add(id);
          this.renderTree();
          return;
        }
        const bulk = e.target.closest('[data-tree-bulk]');
        if (bulk) {
          e.preventDefault();
          if (bulk.dataset.treeBulk === 'expand') this._collapsed.clear();
          else this.doc.zones.forEach((z) => { if (this.doc.zones.some((c) => c.parentId === z.id)) this._collapsed.add(z.id); });
          this.renderTree();
          return;
        }
        const mItem = e.target.closest('[data-marker-id]');
        if (mItem) { this.selectMarker(mItem.dataset.markerId, { fly: true }); return; }
        const item = e.target.closest('[data-zone-id]');
        if (item) this.select(item.dataset.zoneId, { fly: true });
      };
      tree.ondragstart = (e) => {
        const mItem = e.target.closest('[data-marker-id][draggable]');
        if (mItem) {
          this._dragMarkerId = mItem.dataset.markerId;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', mItem.dataset.markerId);
          tree.classList.add('me-tree-dragging-marker');
          return;
        }
        const item = e.target.closest('[data-zone-id]');
        if (!item) return;
        this._dragZoneId = item.dataset.zoneId;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.dataset.zoneId);
        tree.classList.add('me-tree-dragging');
      };
      tree.ondragend = () => {
        this._dragMarkerId = null;
        tree.classList.remove('me-tree-dragging', 'me-tree-dragging-marker');
        tree.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
      };
      // Группа, в которую упадёт метка: заголовок группы или любая метка в ней.
      const dropGroupHead = (e) => {
        const t = e.target.closest('[data-group-drop], [data-in-group]');
        if (!t) return null;
        const gid = t.dataset.groupDrop !== undefined ? t.dataset.groupDrop : t.dataset.inGroup;
        return tree.querySelector(`[data-group-drop="${CSS.escape(gid)}"]`);
      };
      tree.ondragover = (e) => {
        if (this._dragMarkerId) {
          const head = dropGroupHead(e);
          tree.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
          const m = (this.doc.markers || []).find((x) => x.id === this._dragMarkerId);
          if (!head || !m || head.dataset.groupDrop === (m.groupId || '')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          head.classList.add('drop-target');
          return;
        }
        const target = e.target.closest('[data-zone-id], [data-root-drop]');
        if (!target || !this._dragZoneId) return;
        const targetId = target.dataset.zoneId;
        if (targetId && (targetId === this._dragZoneId || this.descendants(this._dragZoneId).has(targetId))) return;
        e.preventDefault();
        tree.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
        target.classList.add('drop-target');
      };
      tree.ondrop = (e) => {
        if (this._dragMarkerId) {
          const head = dropGroupHead(e);
          const id = this._dragMarkerId;
          this._dragMarkerId = null;
          if (!head) return;
          e.preventDefault();
          this.moveMarkerToGroup(id, head.dataset.groupDrop || null);
          return;
        }
        const target = e.target.closest('[data-zone-id], [data-root-drop]');
        const dragId = this._dragZoneId;
        this._dragZoneId = null;
        if (!target || !dragId) return;
        e.preventDefault();
        this.reparent(dragId, target.dataset.zoneId || null);
      };
    }

    moveMarkerToGroup(markerId, groupId) {
      const m = (this.doc.markers || []).find((x) => x.id === markerId);
      if (!m || (m.groupId || null) === groupId) return;
      this.pushHistory();
      m.groupId = groupId;
      this.markDirty();
      this.renderMarkerLayers(); // группа могла быть скрыта «глазиком»
      this.renderTree();
      if (m.id === this.selectedMarkerId) this.renderProps();
      const g = groupId && this.doc.markerGroups.find((x) => x.id === groupId);
      this.toast(g ? `Метка перенесена в «${g.name}»` : 'Метка убрана из группы');
    }

    // Кнопки групп меток в списке. true — клик обработан.
    onGroupClick(e) {
      const add = e.target.closest('[data-group-add]');
      if (add) {
        e.preventDefault();
        this.pushHistory();
        const g = { id: genId('g'), name: `Группа ${this.doc.markerGroups.length + 1}`, hiddenByDefault: false, ownCluster: true };
        this.doc.markerGroups = [...this.doc.markerGroups, g];
        this._treeOpen.markers = true;
        this.markDirty();
        this.renderTree();
        this.renderMarkerPalette();
        const input = this.el('tree').querySelector(`[data-group-name="${CSS.escape(g.id)}"]`);
        if (input) { input.focus(); input.select(); }
        return true;
      }
      const eye = e.target.closest('[data-group-eye]');
      if (eye) {
        const id = eye.dataset.groupEye;
        if (this.hiddenGroupsEd.has(id)) this.hiddenGroupsEd.delete(id); else this.hiddenGroupsEd.add(id);
        this.renderMarkerLayers();
        this.renderTree();
        return true;
      }
      const clusterBtn = e.target.closest('[data-group-cluster]');
      if (clusterBtn) {
        const g = this.doc.markerGroups.find((x) => x.id === clusterBtn.dataset.groupCluster);
        if (!g) return true;
        this.pushHistory();
        g.ownCluster = !g.ownCluster;
        this.markDirty();
        this.renderTree();
        this.toast(g.ownCluster ? `«${g.name}»: на карте метки группы будут собираться в свои кружки` : `«${g.name}»: метки группы снова в общих кружках`);
        return true;
      }
      const dflt = e.target.closest('[data-group-default]');
      if (dflt) {
        const g = this.doc.markerGroups.find((x) => x.id === dflt.dataset.groupDefault);
        if (!g) return true;
        this.pushHistory();
        g.hiddenByDefault = !g.hiddenByDefault;
        this.markDirty();
        this.renderTree();
        return true;
      }
      const del = e.target.closest('[data-group-del]');
      if (del) {
        const g = this.doc.markerGroups.find((x) => x.id === del.dataset.groupDel);
        if (!g) return true;
        (async () => {
          if (!(await this.askDelete(`Группа «${g.name}» будет удалена. Её метки останутся на карте, но без группы.`, 'Удалить группу?'))) return;
          this.pushHistory();
          this.doc.markerGroups = this.doc.markerGroups.filter((x) => x.id !== g.id);
          (this.doc.markers || []).forEach((m) => { if (m.groupId === g.id) m.groupId = null; });
          this.hiddenGroupsEd.delete(g.id);
          if (this.newMarkerGroupId === g.id) this.newMarkerGroupId = null;
          this.markDirty();
          this.renderMarkerLayers();
          this.renderTree();
          this.renderProps();
          this.renderMarkerPalette();
        })();
        return true;
      }
      return !!e.target.closest('[data-group-name]'); // клик в поле названия — не выбор
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
      this.setZonePoly(zone, inter);
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
        <div class="me-field"><span>Тип</span><div class="me-type-row"><select class="form-select" data-prop="typeId">${typeOptions || '<option value="">—</option>'}</select><button type="button" class="map-icon-btn" data-type-settings="zone" title="Настроить этот тип: цвет, эффект, видимость"><i class="fas fa-gear"></i></button></div></div>
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
        <label class="me-check" title="Работает, когда выше заданы роли: остальным читателям область закрыта туманом вместе с фоном, а вложенные зоны и метки в ней скрыты">
          <input type="checkbox" data-prop="fog"${zone.fog ? ' checked' : ''}> Туман войны: без этих ролей область закрыта туманом
        </label>
        <button type="button" class="btn btn-secondary btn-sm me-fog-preview-btn${this.fogPreview ? ' active' : ''}" data-act="toggle-fog" ${zone.fog ? '' : 'hidden'}><i class="fas fa-cloud"></i> Предпросмотр тумана</button>
        <label class="me-field"><span>Если статья читателю закрыта</span>
          <select class="form-select" data-prop="lockedMode">
            <option value="lock"${zone.lockedMode !== 'hide' ? ' selected' : ''}>Показать зону с замком</option>
            <option value="hide"${zone.lockedMode === 'hide' ? ' selected' : ''}>Скрыть зону</option>
          </select>
        </label>
        ${this.renderItemTimeSection(zone, true)}
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
      box.querySelector('[data-type-settings="zone"]').onclick = () => this.openTypeSettings('zone', zone.typeId);
      this.bindItemTimeSection(box, zone, true);
      this.bindSections(box);
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
        <details class="me-props-details" data-sec="style" ${this.secOpen('style', false) ? 'open' : ''}>
        <summary>Оформление${on ? ' <span class="me-sec-badge">свой стиль</span>' : ''}</summary>
        <label class="checkbox-field me-style-toggle"><input type="checkbox" data-style-toggle ${on ? 'checked' : ''}> Свой стиль (поверх типа «${esc(type.name)}»)</label>
        <div class="me-style" ${on ? '' : 'hidden'}>
          <label>Цвет <input type="color" data-style="color" value="${esc(st.color)}"></label>
          <label>Заливка <input type="range" min="0" max="1" step="0.05" data-style="fillOpacity" value="${st.fillOpacity}"></label>
          <label>Граница <input type="number" min="0" max="10" step="0.5" data-style="weight" value="${st.weight}"></label>
          <label class="checkbox-field"><input type="checkbox" data-style="dashed" ${st.dashed ? 'checked' : ''}> Пунктир</label>
          <label>При наведении <select data-style="hoverEffect">${Object.entries(effects).map(([v, l]) => `<option value="${v}"${st.hoverEffect === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        </details>`;
    }

    // Состояние сворачиваемых блоков свойств (Время, Оформление, Видимость)
    // запоминается, пока открыт редактор.
    secOpen(key, dflt) {
      this._secOpen = this._secOpen || {};
      return key in this._secOpen ? this._secOpen[key] : dflt;
    }

    bindSections(box) {
      box.querySelectorAll('details[data-sec]').forEach((d) => {
        d.addEventListener('toggle', () => { this._secOpen = this._secOpen || {}; this._secOpen[d.dataset.sec] = d.open; });
      });
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

    // ----- Важность метки: видимость и группировка поверх типа -----

    renderMarkerVisibilitySection(m) {
      const t = this.markerType(m);
      const levels = ['Всегда', 'С приближения ×2', '×4', '×8', '×16', '×32', '×64'];
      const typeLevel = levels[t.minZoomRel || 0] || 'Всегда';
      const own = m.minZoomRel !== null && m.minZoomRel !== undefined;
      const clusterOwn = m.noCluster !== null && m.noCluster !== undefined;
      return `
        <details class="me-props-details" data-sec="visibility" ${this.secOpen('visibility', own || clusterOwn) ? 'open' : ''}>
        <summary>Важность и видимость${own || clusterOwn ? ' <span class="me-sec-badge">своя</span>' : ''}</summary>
        <label class="me-field"><span>Видно</span>
          <select class="form-select" data-mvis="minZoomRel">
            <option value=""${own ? '' : ' selected'}>Как у типа — ${esc(typeLevel)}</option>
            ${levels.map((l, i) => `<option value="${i}"${own && m.minZoomRel === i ? ' selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label class="me-field"><span>На отдалении</span>
          <select class="form-select" data-mvis="noCluster">
            <option value=""${clusterOwn ? '' : ' selected'}>Как у типа — ${t.noCluster ? 'не прятать в группу' : 'можно группировать'}</option>
            <option value="yes"${clusterOwn && m.noCluster ? ' selected' : ''}>Не прятать в группу (важная)</option>
            <option value="no"${clusterOwn && !m.noCluster ? ' selected' : ''}>Можно группировать с соседними</option>
          </select>
        </label>
        </details>`;
    }

    bindMarkerVisibilitySection(box, m) {
      box.querySelectorAll('[data-mvis]').forEach((sel) => {
        sel.addEventListener('change', () => {
          this.pushHistory();
          if (sel.dataset.mvis === 'minZoomRel') m.minZoomRel = sel.value === '' ? null : Number(sel.value);
          else m.noCluster = sel.value === '' ? null : sel.value === 'yes';
          this.markDirty();
          this.renderProps();
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
        ${this.doc.markerGroups.length ? `<label class="me-field"><span>Группа</span><select class="form-select" data-mprop="groupId"><option value="">Без группы</option>${this.doc.markerGroups.map((g) => `<option value="${esc(g.id)}"${g.id === m.groupId ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>` : ''}
        <div class="me-field"><span>Тип</span><div class="me-type-row"><select class="form-select" data-mprop="typeId">${typeOptions || '<option value="">—</option>'}</select><button type="button" class="map-icon-btn" data-type-settings="marker" title="Настроить этот тип: иконка, цвет, видимость"><i class="fas fa-gear"></i></button></div></div>
        <details class="me-props-details" data-sec="m-content" ${this.secOpen('m-content', !!(m.text || m.article)) ? 'open' : ''}>
          <summary>Описание и статья${m.text || m.article ? ` <span class="me-sec-badge">${[m.text ? 'описание' : '', m.article ? 'статья' : ''].filter(Boolean).join(' · ')}</span>` : ''}</summary>
          <label class="me-field"><span>Описание (всплывает по клику)</span><textarea class="form-input me-textarea" data-mprop="text" maxlength="2000" rows="4" placeholder="Короткое пояснение к месту…">${esc(m.text || '')}</textarea></label>
          <label class="me-field"><span>Статья</span>
            <input type="text" class="form-input" data-mprop="article" list="me-articles-list" value="${esc(articleTitle)}" placeholder="Название статьи…">
            <small class="me-field-note" data-el="article-note">${this.articleNote(m, 'метка')}</small>
          </label>
        </details>
        <details class="me-props-details" data-sec="m-access" ${this.secOpen('m-access', !!(m.roles && m.roles.length)) ? 'open' : ''}>
          <summary>Доступ${m.roles && m.roles.length ? ` <span class="me-sec-badge">ролей: ${m.roles.length}</span>` : ''}</summary>
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
        </details>
        ${this.renderMarkerVisibilitySection(m)}
        ${this.renderItemTimeSection(m, false)}
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
      this.bindItemTimeSection(box, m, false);
      this.bindMarkerVisibilitySection(box, m);
      this.bindSections(box);
      box.querySelector('[data-type-settings="marker"]').onclick = () => this.openTypeSettings('marker', m.typeId);

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
      else if (f === 'groupId') { m.groupId = v || null; this.renderTree(); }
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
      else if (f === 'fog') {
        if (zone.fog === input.checked) { this.undoStack.pop(); this._propHistoryPushed = false; return; } // input+change от одного клика
        zone.fog = input.checked;
        const previewBtn = this.root.querySelector('.me-fog-preview-btn');
        if (previewBtn) previewBtn.hidden = !zone.fog;
        this.renderFogPreview();
        this.renderTree();
        if (zone.fog && !(zone.roles || []).length) this.toast('Туман войны включён, но у зоны нет ролей — задайте в «Кому видна зона», кто уже исследовал эту область');
      }
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

    async deleteZone(id) {
      const zone = this.zoneById(id);
      if (!zone) return;
      const kids = this.doc.zones.filter((z) => z.parentId === id);
      const msg = kids.length
        ? `Зона «${zone.title || 'без названия'}» будет удалена. Вложенные зоны (${kids.length}) останутся и перейдут на уровень выше.`
        : `Зона «${zone.title || 'без названия'}» будет удалена со всеми версиями границы.`;
      if (!(await this.askDelete(msg, 'Удалить зону?'))) return;
      this.pushHistory();
      kids.forEach((k) => { k.parentId = zone.parentId; });
      (this.doc.markers || []).forEach((m) => { if (m.zoneId === id) m.zoneId = zone.parentId; });
      this.doc.zones = this.doc.zones.filter((z) => z.id !== id);
      this.selectedId = null;
      this.afterZonesChanged({ keepLayers: false });
    }

    // ===== Время (этап 3) =====
    // Редактор показывает карту в текущий момент this.time: версии границ,
    // действующие в этот момент, правятся инструментами как обычно; зоны и
    // метки, которых в этот момент нет, видны бледными (их можно выбрать и
    // поправить им интервал).

    cal() { return this.calendar || MC().DEFAULT_CALENDAR; }
    fmt(t) { return MC().formatTime(this.cal(), t); }
    fmtIn(t) { return MC().formatTimeInput(this.cal(), t); }

    shapeIndex(z) { return MC().shapeIndexAt(z, this.time); }

    setZonePoly(z, polygon) {
      if (!z.shapes || !z.shapes.length) z.shapes = [{ from: null, polygon }];
      else z.shapes[this.shapeIndex(z)].polygon = polygon;
    }

    existsNow(o) { return MC().existsAt(o, this.time); }

    // Диапазон шкалы редактора: даты карты + запас, и всегда включает
    // текущий момент (его можно задать любой датой в поле).
    editorRange() {
      const tl = this.doc.timeline || {};
      if (tl.start != null && tl.end != null && tl.end > tl.start) {
        return { min: Math.min(tl.start, this.time), max: Math.max(tl.end, this.time) };
      }
      const r = MC().timeRange({ ...this.doc, basemaps: this.basemaps });
      const pad = Math.max(365, Math.round((r.max - r.min) * 0.1));
      return { min: Math.min(r.min - pad, this.time - 30), max: Math.max(r.max + pad, this.time + 30) };
    }

    // Фон по периодам и в редакторе: дата попала в период — показываем его фон
    // (вне периодов — фон, выбранный в списке сверху).
    applyPeriodBasemap() {
      const periods = (this.doc.timeline && this.doc.timeline.periods) || [];
      const p = periods.find((x) => MC().existsAt(x, this.time));
      const target = p && this.basemaps.find((b) => b.id === p.basemapId && b.status === 'ready');
      const id = target ? target.id : (this._manualBasemapId || null);
      if (id && id !== this.currentBasemapId) this.setBasemap(id, { auto: true });
    }

    setTime(t) {
      t = Math.round(Number(t));
      if (!Number.isFinite(t) || t === this.time) return;
      this.time = t;
      this.applyPeriodBasemap();
      this.renderZoneLayers();
      this.renderMarkerLayers();
      this.renderHandles();
      this.highlightEventZones();
      this.renderTimelineBar();
      this.renderTree();
      this.renderProps();
      if (this.sidebarTab === 'time') this.renderTimePanel();
    }

    // --- Поле даты: «дд.мм.гг» (пусто = без границы) ---

    timeInputHtml(key, value, { allowEmpty = true, emptyLabel = 'без границы' } = {}) {
      const v = value === null || value === undefined ? '' : this.fmtIn(value);
      // Свой календарь позволяет вводить месяц названием — тогда не только цифры.
      const numeric = window.MapCalendar.customMonths(this.cal()) ? '' : ' inputmode="numeric"';
      return `<span class="me-time" data-time-key="${esc(key)}">
        <input type="text" class="me-time-year"${numeric} value="${esc(v)}" placeholder="${esc(allowEmpty ? emptyLabel : 'дд.мм.гг')}" title="${esc(window.MapCalendar.inputHint(this.cal()))}">
        ${allowEmpty ? '<button type="button" class="map-icon-btn me-time-clear" title="Очистить"><i class="fas fa-xmark"></i></button>' : ''}
      </span>`;
    }

    // undefined — ввели что-то неразборчивое (поле подсвечивается, значение не меняем).
    readTimeInput(el) {
      const input = el.querySelector('.me-time-year');
      const s = input.value.trim();
      input.classList.remove('is-invalid');
      if (s === '') return null;
      const t = MC().parseTime(s, this.cal());
      if (t === null) { input.classList.add('is-invalid'); return undefined; }
      input.value = this.fmtIn(t);
      return t;
    }

    // onChange(key, value) — по смене даты и по «очистить».
    bindTimeInputs(root, onChange) {
      root.querySelectorAll('.me-time').forEach((el) => {
        const fire = () => {
          const v = this.readTimeInput(el);
          if (v === undefined) { this.toast(window.MapCalendar.inputHint(this.cal())); return; }
          onChange(el.dataset.timeKey, v, el);
        };
        el.querySelector('.me-time-year').addEventListener('change', fire);
        el.querySelector('.me-time-clear')?.addEventListener('click', () => { el.querySelector('.me-time-year').value = ''; fire(); });
      });
    }

    // --- Шкала внизу редактора ---

    renderTimelineBar() {
      const bar = this.el('timeline');
      if (!bar) return;
      const { min, max } = this.editorRange();
      const span = Math.max(1, max - min);
      // Событие вне заданных начальной/конечной даты — прижато к краю шкалы.
      const pct = (t) => Math.max(0, Math.min(100, ((t - min) / span) * 100));
      const events = (this.doc.events || []).slice().sort((a, b) => a.from - b.from);
      const laneEnds = [];
      const items = events.map((e) => {
        const sel = e.id === this.selectedEventId ? ' is-selected' : '';
        if (e.to === null || e.to === undefined) return `<button type="button" class="map-tl-event map-tl-point${sel}" data-event-id="${esc(e.id)}" style="left:${pct(e.from).toFixed(3)}%" title="${esc(`${this.fmt(e.from)} — ${e.title}`)}"></button>`;
        let lane = laneEnds.findIndex((end) => end <= e.from);
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(e.to); } else laneEnds[lane] = e.to;
        return `<button type="button" class="map-tl-event map-tl-bar${sel}" data-event-id="${esc(e.id)}" style="left:${pct(e.from).toFixed(3)}%;width:${Math.max(0.6, pct(e.to) - pct(e.from)).toFixed(3)}%;--lane:${Math.min(lane, 2)}" title="${esc(`${MC().formatRange(this.cal(), e.from, e.to)} — ${e.title}`)}"></button>`;
      }).join('');
      bar.innerHTML = `
        <div class="map-tl-head">
          <button type="button" class="map-tl-btn" data-tl="prev" title="Предыдущее событие"><i class="fas fa-backward-step"></i></button>
          <span class="map-tl-date">${esc(this.fmt(this.time))}</span>
          <button type="button" class="map-tl-btn" data-tl="next" title="Следующее событие"><i class="fas fa-forward-step"></i></button>
          <button type="button" class="map-tl-btn" data-tl="add-event" title="Добавить событие на текущую дату"><i class="fas fa-plus"></i> Событие</button>
        </div>
        <div class="map-tl-scroll"><div class="map-tl-track">
          <div class="map-tl-events">${items}</div>
          <input type="range" class="map-tl-range" min="${min}" max="${max}" step="1" value="${this.time}" aria-label="Момент времени">
        </div></div>`;
      const range = bar.querySelector('.map-tl-range');
      let frame = null;
      range.addEventListener('input', () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          this.time = Number(range.value);
          bar.querySelector('.map-tl-date').textContent = this.fmt(this.time);
          this.applyPeriodBasemap();
          this.renderZoneLayers();
          this.renderMarkerLayers();
          this.renderHandles();
          this.highlightEventZones();
        });
      });
      // Отпустили ползунок — перерисовываем панели (дерево, свойства).
      range.addEventListener('change', () => { const t = Number(range.value); this.time = NaN; this.setTime(t); });
      bar.onclick = (e) => {
        const ev = e.target.closest('[data-event-id]');
        if (ev) { this.selectEvent(ev.dataset.eventId); return; }
        const btn = e.target.closest('[data-tl]');
        if (!btn) return;
        if (btn.dataset.tl === 'add-event') { this.addEvent(); return; }
        const froms = events.map((x) => x.from);
        const target = btn.dataset.tl === 'prev' ? [...froms].reverse().find((f) => f < this.time) : froms.find((f) => f > this.time);
        if (target !== undefined) this.setTime(target);
      };
    }

    // --- Вкладка «Время» ---

    renderTimePanel() {
      const box = this.el('time-panel');
      if (!box) return;
      const events = (this.doc.events || []).slice().sort((a, b) => a.from - b.from);
      const tl = this.doc.timeline || (this.doc.timeline = { initial: null, start: null, end: null, periods: [] });
      box.innerHTML = `
        <div class="me-props-head">Текущая дата</div>
        <div class="me-time-now">${esc(this.fmt(this.time))}</div>
        <div class="me-field">${this.timeInputHtml('now', this.time, { allowEmpty: false })}</div>
        <p class="me-field-note">Редактор показывает карту на эту дату: правка границы меняет версию, действующую сейчас.</p>

        <div class="me-props-head">Шкала времени</div>
        <div class="me-time-pair">
          <div class="me-field"><span>Начальная дата</span>${this.timeInputHtml('tl-start', tl.start, { emptyLabel: 'по данным' })}</div>
          <div class="me-field"><span>Конечная дата</span>${this.timeInputHtml('tl-end', tl.end, { emptyLabel: 'по данным' })}</div>
        </div>
        <div class="me-field"><span>Карта открывается на дате</span>${this.timeInputHtml('initial', tl.initial, { emptyLabel: 'начальной' })}</div>
        <button type="button" class="btn btn-secondary btn-sm" data-time-act="initial-now"><i class="fas fa-location-crosshairs"></i> Текущая дата</button>

        <div class="world-head" style="margin-top:14px">
          <span class="me-props-head">Фон по периодам</span>
          <button type="button" class="btn btn-secondary btn-sm" data-time-act="add-period" ${this.readyBasemaps().length ? '' : 'disabled title="Сначала загрузите фон во вкладке «Карта»"'}><i class="fas fa-plus"></i> Период</button>
        </div>
        <p class="me-field-note">В этот период на карте показывается этот фон. Вне периодов читатель видит первый фон из списка во вкладке «Карта».</p>
        <div class="me-periods">${(tl.periods || []).map((pr, i) => `
          <div class="me-period" data-period-index="${i}">
            ${this.timeInputHtml(`p-from:${i}`, pr.from, { emptyLabel: 'с начала' })}
            <span>—</span>
            ${this.timeInputHtml(`p-to:${i}`, pr.to, { emptyLabel: 'до конца' })}
            <select class="me-period-bm" data-period-bm="${i}">${this.basemaps.map((b) => `<option value="${esc(b.id)}"${b.id === pr.basemapId ? ' selected' : ''}>${esc(b.title)}</option>`).join('')}</select>
            <button type="button" class="map-icon-btn is-danger" data-period-del="${i}" title="Удалить период"><i class="fas fa-trash"></i></button>
          </div>`).join('') || '<div class="me-tree-empty">Периодов нет — фон не меняется со временем</div>'}</div>

        <div class="world-head" style="margin-top:14px">
          <span class="me-props-head">События (${events.length})</span>
          <button type="button" class="btn btn-secondary btn-sm" data-time-act="add-event"><i class="fas fa-plus"></i> Событие</button>
        </div>
        <div class="me-tree-list me-events">${events.map((e) => `
          <div class="me-tree-item${e.id === this.selectedEventId ? ' active' : ''}" data-event-id="${esc(e.id)}">
            <span class="me-event-date">${esc(MC().formatRange(this.cal(), e.from, e.to))}</span>
            <span class="me-tree-name">${esc(e.title)}</span>
          </div>`).join('') || '<div class="me-tree-empty">Событий пока нет</div>'}</div>
        <div data-el="event-form"></div>

        <div class="me-props-head" style="margin-top:14px">Копирование состояния</div>
        <p class="me-field-note">Перенести границы зон и то, какие зоны и метки существуют, с одной даты на другую.</p>
        <button type="button" class="btn btn-secondary btn-sm" data-time-act="copy-state"><i class="fas fa-clone"></i> Копировать состояние…</button>`;

      this.bindTimeInputs(box, (key, value) => {
        if (key === 'now') { if (value !== null) this.setTime(value); return; }
        const [kind, idx] = key.split(':');
        this.pushHistory();
        if (kind === 'initial') tl.initial = value;
        else if (kind === 'tl-start') tl.start = value;
        else if (kind === 'tl-end') tl.end = value;
        else if (kind === 'p-from' || kind === 'p-to') {
          const pr = tl.periods[Number(idx)];
          if (pr) pr[kind === 'p-from' ? 'from' : 'to'] = value;
          if (pr && pr.from != null && pr.to != null && pr.to <= pr.from) { pr.to = null; this.toast('Конец периода раньше начала — граница «до» снята'); }
        }
        if (tl.start != null && tl.end != null && tl.end <= tl.start) { tl.end = null; this.toast('Конечная дата раньше начальной — она снята'); }
        this.markDirty();
        this.renderTimelineBar();
        this.renderTimePanel();
      });
      box.querySelector('[data-time-act="initial-now"]').onclick = () => {
        this.pushHistory();
        tl.initial = this.time;
        this.markDirty();
        this.renderTimePanel();
      };
      box.querySelector('[data-time-act="add-period"]').onclick = () => {
        const bm = this.readyBasemaps()[0];
        if (!bm) return;
        this.pushHistory();
        tl.periods = [...(tl.periods || []), { id: genId('p'), from: this.time, to: null, basemapId: bm.id }];
        this.markDirty();
        this.renderTimePanel();
      };
      box.querySelectorAll('[data-period-bm]').forEach((sel) => {
        sel.onchange = () => { this.pushHistory(); tl.periods[Number(sel.dataset.periodBm)].basemapId = sel.value; this.markDirty(); this.applyPeriodBasemap(); };
      });
      // Периоды могли поменяться — фон на текущей дате тоже.
      this.applyPeriodBasemap();
      box.querySelectorAll('[data-period-del]').forEach((btn) => {
        btn.onclick = () => { this.pushHistory(); tl.periods.splice(Number(btn.dataset.periodDel), 1); this.markDirty(); this.renderTimePanel(); };
      });
      box.querySelector('[data-time-act="add-event"]').onclick = () => this.addEvent();
      box.querySelector('[data-time-act="copy-state"]').onclick = () => this.openCopyStateDialog();
      box.querySelector('.me-events').onclick = (e) => {
        const item = e.target.closest('[data-event-id]');
        if (item) this.selectEvent(item.dataset.eventId);
      };
      this.renderEventForm();
    }

    // --- Календарь мира (общий для всех карт мира) ---
    // Смена календаря пересчитывает даты всех карт мира на сервере, в том
    // числе этой: поэтому сначала сохраняем правки, а после смены
    // перезагружаем редактор с пересчитанными датами.

    bindCalendarSection() {
      const months = window.MapCalendar.customMonths(this.cal());
      this.el('calendar-kind').textContent = months ? `свой, ${months.length} мес.` : 'обычный';
      const details = this.el('calendar-details');
      const mount = () => {
        if (!details.open || details._mounted || !this.serverId) return;
        details._mounted = true;
        window.MapsUI.mountCalendarEditor(details.querySelector('[data-el="calendar-editor"]'), this.serverId, {
          beforeSave: async () => {
            if (!this.dirty) return true;
            await this.save();
            if (this.dirty) { window.showMessage?.('Сначала сохраните карту — календарь не изменён', 'error'); return false; }
            return true;
          },
          onSaved: () => { this.dirty = false; window.MapEditor.loadMapEditor(window.spaRouter); }
        });
      };
      details.addEventListener('toggle', mount);
    }

    // --- События ---

    eventById(id) { return (this.doc.events || []).find((e) => e.id === id) || null; }

    addEvent() {
      this.pushHistory();
      const ev = { id: genId('e'), from: this.time, to: null, title: 'Новое событие', text: '', article: null, zoneIds: this.selectedId ? [this.selectedId] : [], markerIds: this.selectedMarkerId ? [this.selectedMarkerId] : [] };
      this.doc.events = [...(this.doc.events || []), ev];
      this.markDirty();
      this.setSideTab('time');
      this.selectEvent(ev.id);
      const title = this.root.querySelector('[data-eprop="title"]');
      if (title) { title.focus(); title.select(); }
    }

    selectEvent(id) {
      // Повторное нажатие на выбранное событие — свернуть (снять выбор).
      if (id && id === this.selectedEventId) {
        this.selectedEventId = null;
        this.highlightEventZones();
        this.renderTimelineBar();
        this.renderTimePanel();
        return;
      }
      this.selectedEventId = this.eventById(id) ? id : null;
      if (this.sidebarTab !== 'time') this.setSideTab('time');
      const ev = this.eventById(this.selectedEventId);
      if (ev && ev.from !== this.time) this.setTime(ev.from);
      else { this.highlightEventZones(); this.renderTimelineBar(); this.renderTimePanel(); }
    }

    // Зоны выбранного события — обведены на карте.
    highlightEventZones() {
      const ev = this.eventById(this.selectedEventId);
      const ids = new Set(ev ? ev.zoneIds : []);
      this.zoneLayers.forEach((layer, id) => {
        const el = layer.getElement && layer.getElement();
        if (el) el.classList.toggle('map-zone-event', ids.has(id));
      });
    }

    renderEventForm() {
      const box = this.el('event-form');
      if (!box) return;
      const ev = this.eventById(this.selectedEventId);
      if (!ev) { box.innerHTML = ''; return; }
      const articleTitle = ev.article ? (this.articles.find((a) => a.slug === ev.article)?.title || ev.article) : '';
      box.innerHTML = `
        <div class="me-event-form">
          <label class="me-field"><span>Название события</span><input type="text" class="form-input" data-eprop="title" value="${esc(ev.title)}" maxlength="120"></label>
          <div class="me-field"><span>Начало</span>${this.timeInputHtml('from', ev.from, { allowEmpty: false })}</div>
          <div class="me-field"><span>Конец (пусто — моментальное)</span>${this.timeInputHtml('to', ev.to, { emptyLabel: 'моментальное' })}</div>
          <label class="me-field"><span>Описание</span><textarea class="form-input me-textarea" data-eprop="text" rows="4" maxlength="4000">${esc(ev.text || '')}</textarea></label>
          <label class="me-field"><span>Статья</span><input type="text" class="form-input" data-eprop="article" list="me-articles-list" value="${esc(articleTitle)}" placeholder="Название статьи…"></label>
          <div class="me-field"><span>Связанные зоны</span>
            <div class="chip-field" data-el="event-zones"><div class="chip-field-box"><div class="chip-field-chips"></div><input type="text" class="chip-field-input" placeholder="Выберите зоны…"></div><div class="chip-field-dropdown" hidden></div><input type="hidden" class="chip-field-hidden"></div>
          </div>
          <div class="me-field"><span>Связанные метки</span>
            <div class="chip-field" data-el="event-markers"><div class="chip-field-box"><div class="chip-field-chips"></div><input type="text" class="chip-field-input" placeholder="Выберите метки…"></div><div class="chip-field-dropdown" hidden></div><input type="hidden" class="chip-field-hidden"></div>
          </div>
          <div class="me-props-actions"><button type="button" class="btn btn-danger btn-sm" data-eprop-act="delete"><i class="fas fa-trash"></i> Удалить событие</button></div>
        </div>`;
      box.querySelectorAll('[data-eprop]').forEach((input) => {
        input.addEventListener('focus', () => { this._propHistoryPushed = false; });
        input.addEventListener('input', () => {
          if (!this._propHistoryPushed) { this.pushHistory(); this._propHistoryPushed = true; }
          const f = input.dataset.eprop;
          if (f === 'title') ev.title = input.value;
          else if (f === 'text') ev.text = input.value;
          else if (f === 'article') {
            const text = input.value.trim();
            const byTitle = this.articles.find((a) => a.title.toLowerCase() === text.toLowerCase());
            ev.article = !text ? null : (byTitle ? byTitle.slug : slugify(text));
          }
          this.markDirty();
        });
      });
      box.querySelector('[data-eprop="title"]').addEventListener('change', () => { this.renderTimelineBar(); this.renderTimePanel(); });
      this.bindTimeInputs(box, (key, value) => {
        this.pushHistory();
        if (key === 'from' && value !== null) ev.from = value;
        if (key === 'to') ev.to = value;
        if (ev.to !== null && ev.to <= ev.from) { ev.to = null; this.toast('Конец события раньше начала — событие стало моментальным'); }
        this.markDirty();
        this.renderTimelineBar();
        this.renderTimePanel();
      });
      box.querySelector('[data-eprop-act="delete"]').onclick = () => this.deleteEvent(ev.id);
      this.renderEventChips(box, ev);
    }

    async deleteEvent(id) {
      const ev = this.eventById(id);
      if (!ev || !(await this.askDelete(`Событие «${ev.title}» будет удалено со шкалы.`, 'Удалить событие?'))) return;
      {
        this.pushHistory();
        this.doc.events = this.doc.events.filter((x) => x.id !== ev.id);
        this.selectedEventId = null;
        this.markDirty();
        this.highlightEventZones();
        this.renderTimelineBar();
        this.renderTimePanel();
      }
    }

    renderEventChips(box, ev) {
      if (window.ChipField) {
        const zf = new window.ChipField(box.querySelector('[data-el="event-zones"]'), {
          freeText: false,
          options: this.doc.zones.map((z) => ({ value: z.id, label: z.title || 'Без названия' })),
          emptyText: 'Нет зон',
          onChange: (values) => { this.pushHistory(); ev.zoneIds = values; this.markDirty(); this.highlightEventZones(); }
        });
        zf.setValues(ev.zoneIds || []);
        const mf = new window.ChipField(box.querySelector('[data-el="event-markers"]'), {
          freeText: false,
          options: (this.doc.markers || []).map((m) => ({ value: m.id, label: m.title || 'Метка' })),
          emptyText: 'Нет меток',
          onChange: (values) => { this.pushHistory(); ev.markerIds = values; this.markDirty(); }
        });
        mf.setValues(ev.markerIds || []);
      }
    }

    // --- Время в свойствах зоны/метки ---

    renderItemTimeSection(item, isZone) {
      let versions = '';
      if (isZone) {
        const active = this.shapeIndex(item);
        versions = `
          <div class="me-field"><span>Версии границы</span>
            <div class="me-versions">${(item.shapes || []).map((sh, i) => `
              <div class="me-version${i === active ? ' active' : ''}">
                <span>${sh.from === null || sh.from === undefined ? 'С начала времён' : `С ${esc(this.fmt(sh.from))}`}${i === active ? ' <em>· сейчас правится</em>' : ''}</span>
                <span class="me-bm-btns">
                  <button type="button" class="map-icon-btn" data-ver-go="${i}" title="Перейти к этой дате"><i class="fas fa-location-arrow"></i></button>
                  ${i > 0 ? `<button type="button" class="map-icon-btn is-danger" data-ver-del="${i}" title="Удалить версию"><i class="fas fa-trash"></i></button>` : ''}
                </span>
              </div>`).join('')}</div>
            <button type="button" class="btn btn-secondary btn-sm" data-ver-new><i class="fas fa-code-branch"></i> Новая версия границы с ${esc(this.fmt(this.time))}</button>
          </div>`;
      }
      const bounded = item.from != null || item.to != null || (isZone && (item.shapes || []).length > 1);
      return `
        <details class="me-props-details" data-sec="time" ${this.secOpen('time', bounded) || !this.existsNow(item) ? 'open' : ''}>
        <summary>Время${bounded ? ` <span class="me-sec-badge">${esc(MC().formatRange(this.cal(), item.from, item.to) || 'версии границы')}</span>` : ''}${this.existsNow(item) ? '' : ' <span class="me-absent-badge">сейчас не существует</span>'}</summary>
        <div class="me-field"><span>Существует с</span>${this.timeInputHtml('from', item.from, { emptyLabel: 'начала времён' })}</div>
        <div class="me-field"><span>по (в этот день уже нет)</span>${this.timeInputHtml('to', item.to, { emptyLabel: 'конца времён' })}</div>
        <div class="me-time-quick">
          <button type="button" class="map-icon-btn me-quick" data-time-quick="from">с текущего</button>
          <button type="button" class="map-icon-btn me-quick" data-time-quick="to">до текущего</button>
        </div>
        ${versions}
        </details>`;
    }

    bindItemTimeSection(box, item, isZone) {
      const apply = () => {
        if (item.from !== null && item.to !== null && item.to <= item.from) { item.to = null; this.toast('Конец раньше начала — граница «по» снята'); }
        this.markDirty();
        if (isZone) { this.refreshZoneLayer(item); this.renderTree(); } else this.refreshMarkerIcon(item.id);
        this.renderProps();
      };
      this.bindTimeInputs(box, (key, value) => {
        if (key !== 'from' && key !== 'to') return;
        this.pushHistory();
        item[key] = value;
        apply();
      });
      box.querySelectorAll('[data-time-quick]').forEach((b) => {
        b.onclick = () => { this.pushHistory(); item[b.dataset.timeQuick] = this.time; apply(); };
      });
      if (!isZone) return;
      box.querySelector('[data-ver-new]')?.addEventListener('click', () => {
        if ((item.shapes || []).some((sh) => sh.from === this.time)) { this.toast('Версия с этого момента уже есть'); return; }
        this.pushHistory();
        const copy = JSON.parse(JSON.stringify(this.zonePoly(item)));
        item.shapes.push({ from: this.time, polygon: copy });
        item.shapes.sort((a, b) => (a.from === null ? -Infinity : a.from) - (b.from === null ? -Infinity : b.from));
        this.markDirty();
        this.renderProps();
        this.toast(`Новая версия границы с ${this.fmt(this.time)} — правки теперь относятся к ней`);
      });
      box.querySelectorAll('[data-ver-go]').forEach((b) => {
        b.onclick = () => {
          const i = Number(b.dataset.verGo);
          const sh = item.shapes[i];
          const t = sh.from !== null && sh.from !== undefined ? sh.from : (item.shapes[1] ? item.shapes[1].from - 1 : this.time);
          this.setTime(t);
        };
      });
      box.querySelectorAll('[data-ver-del]').forEach((b) => {
        b.onclick = async () => {
          const i = Number(b.dataset.verDel);
          if (!(await this.askDelete(`Версия границы с ${this.fmt(item.shapes[i].from)} будет удалена.`, 'Удалить версию границы?'))) return;
          this.pushHistory();
          item.shapes.splice(i, 1);
          this.refreshZoneLayer(item);
          this.markDirty();
          this.renderProps();
        };
      });
    }

    // --- Копирование состояния из момента A в момент B ---

    openCopyStateDialog() {
      const zone = this.zoneById(this.selectedId);
      const overlay = document.createElement('div');
      overlay.className = 'me-modal';
      overlay.innerHTML = `
        <div class="me-modal-box">
          <div class="me-props-head">Копировать состояние карты</div>
          <div class="me-field"><span>С даты</span>${this.timeInputHtml('a', this.time, { allowEmpty: false })}</div>
          <div class="me-field"><span>На дату</span>${this.timeInputHtml('b', this.time + 1, { allowEmpty: false })}</div>
          <div class="me-field"><span>Что копировать</span>
            <label class="checkbox-field"><input type="radio" name="me-copy-scope" value="all" ${zone ? '' : 'checked'}> Все зоны и метки</label>
            <label class="checkbox-field"><input type="radio" name="me-copy-scope" value="zone" ${zone ? 'checked' : 'disabled'}> Только ${zone ? `зона «${esc(zone.title || 'без названия')}» и вложенные в неё` : 'выбранная зона (сначала выберите зону)'}</label>
          </div>
          <div class="me-copy-preview" data-el="copy-preview"></div>
          <div class="me-props-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-copy-act="cancel">Отмена</button>
            <button type="button" class="btn btn-primary btn-sm" data-copy-act="apply" disabled>Применить</button>
          </div>
        </div>`;
      this.root.querySelector('.map-editor').appendChild(overlay);
      const read = () => {
        const [a, b] = ['a', 'b'].map((k) => this.readTimeInput(overlay.querySelector(`[data-time-key="${k}"]`)));
        const scope = overlay.querySelector('input[name="me-copy-scope"]:checked').value;
        return { a, b, scope };
      };
      const refresh = () => {
        const plan = this.planCopyState(read());
        overlay.querySelector('[data-el="copy-preview"]').innerHTML = plan.html;
        overlay.querySelector('[data-copy-act="apply"]').disabled = !plan.changes.length;
        overlay._plan = plan;
      };
      this.bindTimeInputs(overlay, refresh);
      overlay.querySelectorAll('input[name="me-copy-scope"]').forEach((r) => r.addEventListener('change', refresh));
      overlay.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-copy-act]');
        if (e.target === overlay || (btn && btn.dataset.copyAct === 'cancel')) { overlay.remove(); return; }
        if (btn && btn.dataset.copyAct === 'apply' && overlay._plan) {
          this.pushHistory();
          overlay._plan.changes.forEach((fn) => fn());
          overlay.remove();
          this.afterZonesChanged();
          this.renderTimelineBar();
          this.toast(`Состояние скопировано: изменений — ${overlay._plan.changes.length}`);
        }
      });
      refresh();
    }

    // План копирования: что изменится (для сводки) и сами изменения.
    // Границы: форма зоны в момент A становится версией с момента B.
    // Существование: зона/метка, которая есть в A, но нет в B, — продлевается,
    // чтобы существовать и в B. Лишнее в B не удаляется — только перечисляется.
    planCopyState({ a, b, scope }) {
      const lines = [];
      const skipped = [];
      const changes = [];
      if (a == null || b == null || a === b) return { html: '<p class="me-field-note">Выберите две разные даты.</p>', changes };
      let zones = this.doc.zones;
      let markers = this.doc.markers || [];
      if (scope === 'zone' && this.selectedId) {
        const ids = this.descendants(this.selectedId);
        ids.add(this.selectedId);
        zones = zones.filter((z) => ids.has(z.id));
        markers = markers.filter((m) => m.zoneId && ids.has(m.zoneId));
      }
      const at = (o, t) => MC().existsAt(o, t);
      const shapeAt = (z, t) => z.shapes[MC().shapeIndexAt(z, t)];
      zones.forEach((z) => {
        const name = `«${esc(z.title || 'без названия')}»`;
        if (at(z, a) && !at(z, b)) {
          lines.push(`Зона ${name} будет существовать и в ${esc(this.fmt(b))}`);
          changes.push(() => { if (z.from !== null && b < z.from) z.from = b; else if (z.to !== null && b >= z.to) z.to = null; });
        } else if (!at(z, a) && at(z, b)) {
          skipped.push(`зона ${name}`);
          return;
        }
        if (!at(z, a)) return;
        const src = shapeAt(z, a);
        const dst = shapeAt(z, b);
        if (src === dst || JSON.stringify(src.polygon) === JSON.stringify(dst.polygon)) return;
        lines.push(`Зона ${name}: граница из ${esc(this.fmt(a))} станет версией с ${esc(this.fmt(b))}`);
        changes.push(() => {
          const poly = JSON.parse(JSON.stringify(src.polygon));
          const same = z.shapes.find((sh) => sh.from === b);
          if (same) same.polygon = poly;
          else {
            z.shapes.push({ from: b, polygon: poly });
            z.shapes.sort((x, y) => (x.from === null ? -Infinity : x.from) - (y.from === null ? -Infinity : y.from));
          }
        });
      });
      markers.forEach((m) => {
        const name = `«${esc(m.title || 'без названия')}»`;
        if (at(m, a) && !at(m, b)) {
          lines.push(`Метка ${name} будет существовать и в ${esc(this.fmt(b))}`);
          changes.push(() => { if (m.from !== null && b < m.from) m.from = b; else if (m.to !== null && b >= m.to) m.to = null; });
        } else if (!at(m, a) && at(m, b)) skipped.push(`метка ${name}`);
      });
      const html = `
        ${lines.length ? `<div class="me-copy-list">${lines.map((l) => `<div>• ${l}</div>`).join('')}</div>` : '<p class="me-field-note">На этих датах карта уже одинаковая — копировать нечего.</p>'}
        ${skipped.length ? `<p class="me-field-note">Не затронуто (есть в ${esc(this.fmt(b))}, но нет в ${esc(this.fmt(a))}): ${skipped.join(', ')}.</p>` : ''}`;
      return { html, changes };
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

        <div class="me-props-head">Фоны карты</div>
        <p class="me-field-note">Фоны одной карты — в одной системе координат${this.size ? ` (${this.size.w}×${this.size.h})` : ''}. Фон другого размера после нарезки попросит выровнять его по трём опорным точкам (кнопка <i class="fas fa-crosshairs"></i>). Большие файлы загружаются частями, затем сервер нарезает их на тайлы без сжатия — это может занять несколько минут. Кнопка <i class="fas fa-file-import"></i> у фона заменяет картинку новой того же разрешения: зоны и метки остаются на местах, а старый фон работает, пока новый не готов.</p>
        <div class="me-basemaps" data-el="basemaps"></div>
        <label class="btn btn-secondary btn-sm me-upload-btn"><i class="fas fa-upload"></i> Загрузить фон
          <input type="file" data-el="bm-file" accept=".jpg,.jpeg,.png,.webp,.tif,.tiff" hidden>
        </label>
        <input type="file" data-el="bm-replace-file" accept=".jpg,.jpeg,.png,.webp,.tif,.tiff" hidden>
        <div class="me-upload" data-el="upload" hidden></div>

        ${this.canDelete ? `<div class="server-danger-zone"><h4>Опасная зона</h4><p>Удаление карты сотрёт её зоны и фоны. Статьи останутся.</p><button type="button" class="btn btn-danger btn-sm" data-el="delete-map"><i class="fas fa-trash"></i> Удалить карту</button></div>` : ''}`;

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
      box.querySelector('[data-el="bm-replace-file"]').addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        const id = this._replaceTargetId;
        e.target.value = '';
        this._replaceTargetId = null;
        if (file && id) this.replaceBasemap(id, file);
      });
      box.querySelector('[data-el="delete-map"]')?.addEventListener('click', () => this.deleteMap());
    }

    renderBasemapList() {
      const list = this.el('basemaps');
      if (!list) return;
      if (!this.basemaps.length) { list.innerHTML = '<div class="me-props-empty">Подложек пока нет</div>'; return; }
      const statusText = (b) => {
        if (b.status === 'ready') return `<span class="me-bm-ok">готов · ${b.width}×${b.height}</span>`;
        if (b.status === 'processing') return '<span class="me-bm-wait"><i class="fas fa-spinner fa-spin"></i> нарезается на тайлы…</span>';
        if (b.status === 'queued') return `<span class="me-bm-wait"><i class="fas fa-clock"></i> в очереди${b.queuePosition ? ` (№${b.queuePosition})` : ''}</span>`;
        if (b.status === 'uploading') return '<span class="me-bm-wait">загрузка не завершена</span>';
        if (b.status === 'align') return `<span class="me-bm-wait"><i class="fas fa-crosshairs"></i> ${b.width}×${b.height} — другой размер, нужно выровнять</span>`;
        return `<span class="me-bm-err"><i class="fas fa-triangle-exclamation"></i> ${esc(b.error || 'ошибка')}</span>`;
      };
      // Идущая замена картинки — отдельной строкой под статусом фона.
      const replaceRow = (b) => {
        const r = b.replace;
        if (!r) return '';
        const cancel = (title) => `<button type="button" class="map-icon-btn" data-bm-act="replace-cancel" title="${title}"><i class="fas fa-xmark"></i></button>`;
        let text;
        if (r.status === 'processing') text = '<span class="me-bm-wait"><i class="fas fa-spinner fa-spin"></i> замена нарезается…</span>';
        else if (r.status === 'queued') text = `<span class="me-bm-wait"><i class="fas fa-clock"></i> замена в очереди${b.replaceQueuePosition ? ` (№${b.replaceQueuePosition})` : ''}</span>${cancel('Отменить замену')}`;
        else if (r.status === 'uploading') text = `<span class="me-bm-wait"><i class="fas fa-upload"></i> замена загружается${this._replacingId === b.id ? '…' : ' (не завершена)'}</span>${this._replacingId === b.id ? '' : cancel('Отменить замену')}`;
        else text = `<span class="me-bm-err"><i class="fas fa-triangle-exclamation"></i> замена не удалась: ${esc(r.error || 'ошибка')}. Фон не изменён.</span>${cancel('Скрыть')}`;
        return `<div class="me-bm-row me-bm-replace">${text}</div>`;
      };
      const canReplace = (b) => b.status === 'ready' && (!b.replace || b.replace.status === 'error') && !this._replacingId;
      list.innerHTML = this.basemaps.map((b, i) => `
        <div class="me-bm" data-bm-id="${esc(b.id)}">
          <input type="text" class="form-input" data-bm-field="title" value="${esc(b.title)}" maxlength="80">
          <div class="me-bm-row">
            ${statusText(b)}
            <span class="me-bm-btns">
              ${b.status === 'error' ? '<button type="button" class="map-icon-btn" data-bm-act="retile" title="Нарезать заново"><i class="fas fa-rotate"></i></button>' : ''}
              ${b.status === 'align' || (b.status === 'ready' && b.align) ? `<button type="button" class="map-icon-btn${b.status === 'align' ? ' is-accent' : ''}" data-bm-act="align" title="${b.status === 'align' ? 'Выровнять по трём опорным точкам' : 'Выровнять заново'}"><i class="fas fa-crosshairs"></i></button>` : ''}
              ${canReplace(b) ? `<button type="button" class="map-icon-btn" data-bm-act="replace" title="Заменить картинку (то же разрешение ${b.width}×${b.height}; зоны и метки останутся)"><i class="fas fa-file-import"></i></button>` : ''}
              <button type="button" class="map-icon-btn" data-bm-act="up" title="Выше" ${i === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
              <button type="button" class="map-icon-btn is-danger" data-bm-act="delete" title="Удалить фон"><i class="fas fa-trash"></i></button>
            </span>
          </div>
          ${replaceRow(b)}
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
          if (!(await this.askDelete('Файл фона и его тайлы будут стёрты с сервера.', 'Удалить фон?'))) return;
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
        } else if (btn.dataset.bmAct === 'align') {
          this.openAlignDialog(id);
        } else if (btn.dataset.bmAct === 'replace') {
          this._replaceTargetId = id;
          this.el('bm-replace-file').click();
        } else if (btn.dataset.bmAct === 'replace-cancel') {
          const res = await window.MapsUI.api(`/api/maps/${this.mapId}/basemaps/${id}/replace`, 'DELETE');
          if (!res.success) { this.toast(window.MapsUI.apiError(res)); return; }
          this.pollBasemapsSoon();
        }
      };
    }

    // ----- Выравнивание фона другого размера по трём опорным точкам -----
    //
    // Слева — новый фон (его собственные тайлы), справа — карта (другой
    // готовый фон и контуры зон). Пара = клик на фоне + клик в то же место
    // карты; точки можно перетаскивать. Сервер по трём парам приводит
    // картинку к системе координат карты и перенарезает (POST .../align).
    // «Выровнять заново»: слева уже выровненный фон (координаты карты), и
    // точки переводятся обратно в пиксели исходника прежней матрицей.
    openAlignDialog(id) {
      const bm = this.basemaps.find((b) => b.id === id);
      if (!bm || !bm.url || !this.size) { this.toast('Фон ещё не нарезан — дождитесь окончания'); return; }
      const oldM = bm.status === 'ready' && bm.align ? affineFromPoints(bm.align.points) : null;
      const oldInv = oldM && affineInvert(oldM);
      const leftSize = oldM ? this.size : { w: bm.srcWidth || bm.width, h: bm.srcHeight || bm.height };
      const ref = this.basemaps.find((b) => b.status === 'ready' && b.url && b.id !== id) || (oldM ? bm : null);

      const overlay = document.createElement('div');
      overlay.className = 'me-align';
      overlay.innerHTML = `
        <div class="me-align-box">
          <div class="me-align-head">
            <b>Выравнивание фона «${esc(bm.title)}»</b>
            <span>Кликните приметное место на новом фоне, затем то же место на карте — это одна пара. Нужны три пары, лучше далеко друг от друга (треугольником). Точки можно перетаскивать.</span>
          </div>
          <div class="me-align-panes">
            <div class="me-align-pane"><div class="me-align-cap">Новый фон · ${leftSize.w}×${leftSize.h}</div><div class="me-align-map" data-side="s"></div></div>
            <div class="me-align-pane"><div class="me-align-cap">Карта · ${this.size.w}×${this.size.h}${ref ? '' : ' (готового фона нет — видны только контуры зон)'}</div><div class="me-align-map" data-side="m"></div></div>
          </div>
          <div class="me-align-foot">
            <span class="me-align-status" data-el="align-status"></span>
            <button type="button" class="btn btn-secondary btn-sm" data-align="reset"><i class="fas fa-rotate-left"></i> Сбросить</button>
            <button type="button" class="btn btn-secondary btn-sm" data-align="cancel">Отмена</button>
            <button type="button" class="btn btn-primary btn-sm" data-align="apply"><i class="fas fa-crosshairs"></i> Выровнять</button>
          </div>
        </div>`;
      this.root.appendChild(overlay);
      this._alignOpen = true;

      const makeMap = (el, basemap, size) => {
        const m = L.map(el, { crs: L.CRS.Simple, minZoom: -((basemap && basemap.maxZoom) || 4) - 2, maxZoom: MC().MAX_EDITOR_ZOOM, zoomSnap: 1, attributionControl: false, doubleClickZoom: false });
        if (basemap) MC().makeTileLayer(basemap, size).addTo(m);
        m.fitBounds(MC().imageBounds(size));
        return m;
      };
      const maps = {
        s: makeMap(overlay.querySelector('[data-side="s"]'), bm, leftSize),
        m: makeMap(overlay.querySelector('[data-side="m"]'), ref, this.size)
      };
      this.doc.zones.filter((z) => this.existsNow(z)).forEach((z) => {
        L.polygon(MC().polygonToLatLngs(this.zonePoly(z)), { color: '#ffffff', weight: 1, opacity: 0.8, fill: false, interactive: false }).addTo(maps.m);
      });

      // pairs: [{ s: [x,y] | null, m: [x,y] | null }] — s в координатах
      // левой панели (исходник или, при «заново», уже выровненный фон).
      let pairs = oldM ? bm.align.points.map((p) => ({ s: affineApply(oldM, [p[0], p[1]]), m: [p[2], p[3]] })) : [];
      const pins = { s: [], m: [] };
      const statusEl = overlay.querySelector('[data-el="align-status"]');
      const applyBtn = overlay.querySelector('[data-align="apply"]');
      const complete = () => pairs.filter((p) => p.s && p.m);

      const render = () => {
        ['s', 'm'].forEach((side) => {
          pins[side].forEach((mk) => mk.remove());
          pins[side] = [];
          pairs.forEach((p, i) => {
            if (!p[side]) return;
            const mk = L.marker(MC().toLatLng(p[side]), {
              draggable: true,
              keyboard: false,
              icon: L.divIcon({ className: 'me-align-pin-anchor', iconSize: [24, 24], iconAnchor: [12, 12], html: `<span class="me-align-pin">${i + 1}</span>` })
            }).addTo(maps[side]);
            mk.on('dragend', () => { p[side] = MC().fromLatLng(mk.getLatLng()); render(); });
            pins[side].push(mk);
          });
        });
        const n = complete().length;
        const waiting = pairs.find((p) => !p.s || !p.m);
        statusEl.textContent = `Пар: ${n} из 3` + (waiting ? (waiting.s ? ` · теперь то же место на карте (справа) для точки ${pairs.indexOf(waiting) + 1}` : ` · теперь точку ${pairs.indexOf(waiting) + 1} на новом фоне (слева)`) : n < 3 ? ' · кликните приметное место на новом фоне' : ' · можно выравнивать');
        applyBtn.disabled = n !== 3;
      };
      const setPoint = (side, pt) => {
        let p = pairs.find((x) => !x[side]);
        if (!p) {
          if (pairs.length >= 3) { this.toast('Уже три пары — перетащите точки или нажмите «Сбросить»'); return; }
          p = { s: null, m: null };
          pairs.push(p);
        }
        p[side] = pt;
        render();
      };
      maps.s.on('click', (e) => setPoint('s', MC().fromLatLng(e.latlng)));
      maps.m.on('click', (e) => setPoint('m', MC().fromLatLng(e.latlng)));
      render();

      const close = () => {
        this._alignOpen = false;
        maps.s.remove();
        maps.m.remove();
        overlay.remove();
      };
      this._closeAlign = close;
      overlay.querySelector('[data-align="cancel"]').onclick = close;
      overlay.querySelector('[data-align="reset"]').onclick = () => { pairs = []; render(); };
      applyBtn.onclick = async () => {
        const done = complete();
        if (done.length !== 3) return;
        const points = done.map((p) => {
          const src = oldInv ? affineApply(oldInv, p.s) : p.s;
          return [src[0], src[1], p.m[0], p.m[1]];
        });
        if (!affineFromPoints(points)) { this.toast('Точки на новом фоне лежат на одной прямой — поставьте их треугольником'); return; }
        applyBtn.disabled = true;
        const res = await window.MapsUI.api(`/api/maps/${this.mapId}/basemaps/${id}/align`, 'POST', { points });
        if (!res.success) { applyBtn.disabled = false; this.toast(window.MapsUI.apiError(res)); return; }
        close();
        window.showMessage?.('Фон выравнивается и перенарезается — это может занять несколько минут', 'info');
        this.pollBasemapsSoon();
      };
    }

    // Замена картинки фона: та же загрузка частями, но в «тень» к фону.
    // Разрешение проверяем заранее (если браузер умеет прочитать картинку),
    // окончательно — на сервере перед подменой.
    async replaceBasemap(id, file) {
      const bm = this.basemaps.find((b) => b.id === id);
      if (!bm) return;
      const dims = await readImageSize(file);
      // У выровненного фона сравниваем с его исходной картинкой, а не с картой.
      const need = bm.srcWidth && bm.srcHeight ? { w: bm.srcWidth, h: bm.srcHeight } : { w: bm.width, h: bm.height };
      if (dims && (dims.w !== need.w || dims.h !== need.h)) {
        this.toast(`Разрешение ${dims.w}×${dims.h} не совпадает с фоном ${need.w}×${need.h} — заменить можно только картинкой того же размера`);
        return;
      }
      if (!(await this.askDelete(`Картинка фона «${bm.title}» будет заменена файлом «${file.name}». Зоны и метки останутся на местах; старый фон работает, пока новый не нарезан.`, 'Заменить фон?', 'Заменить'))) return;
      this._replacingId = id;
      this.renderBasemapList();
      try {
        await this.uploadBasemap(file, { replaceId: id });
      } finally {
        this._replacingId = null;
        this.renderBasemapList();
      }
    }

    // Загрузка по частям: заявка → части по chunkSize → завершение.
    // Обрыв связи на части — до трёх повторов этой же части.
    // replaceId — не новый фон, а замена картинки существующего.
    async uploadBasemap(file, { replaceId = null } = {}) {
      if (file.size > this.maxSourceBytes) { this.toast(`Файл больше ${Math.round(this.maxSourceBytes / 1024 / 1024)} МБ`); return; }
      const box = this.el('upload');
      box.hidden = false;
      const setProgress = (done, text) => {
        box.innerHTML = `<div class="me-upload-name">${replaceId ? 'Замена фона: ' : ''}${esc(file.name)}</div>
          <div class="me-progress"><div class="me-progress-bar" style="width:${Math.round(done * 100)}%"></div></div>
          <div class="me-upload-text">${esc(text)}</div>`;
      };
      setProgress(0, 'Подготовка…');
      const initUrl = replaceId ? `/api/maps/${this.mapId}/basemaps/${replaceId}/replace` : `/api/maps/${this.mapId}/basemaps`;
      const init = await window.MapsUI.api(initUrl, 'POST', { filename: file.name, size: file.size });
      if (!init.success) { setProgress(0, `Ошибка: ${window.MapsUI.apiError(init)}`); return; }
      const { chunkSize } = init.data;
      const base = replaceId ? `/api/maps/${this.mapId}/basemaps/${replaceId}/replace` : `/api/maps/${this.mapId}/basemaps/${init.data.basemapId}`;
      this._uploading = true;
      try {
        let offset = 0;
        while (offset < file.size) {
          const chunk = file.slice(offset, offset + chunkSize);
          let attempt = 0;
          let received = null;
          while (received === null) {
            try {
              const resp = await fetch(`${base}/chunk?offset=${offset}`, {
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
        const done = await window.MapsUI.api(`${base}/complete`, 'POST', {});
        if (!done.success) throw new Error(window.MapsUI.apiError(done));
        setProgress(1, replaceId
          ? 'Загружено. Сервер нарезает новую картинку — фон сменится, когда она будет готова (статус в списке выше).'
          : 'Загружено. Сервер нарезает фон на тайлы — статус виден в списке выше.');
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
        const busy = (s) => s === 'queued' || s === 'processing';
        if (this.basemaps.some((b) => busy(b.status) || (b.replace && busy(b.replace.status))) || this._pollSoon) this.pollBasemaps();
      }, 4000);
    }
    pollBasemapsSoon() { this._pollSoon = true; this.pollBasemaps(); }

    async pollBasemaps() {
      this._pollSoon = false;
      const res = await window.MapsUI.api(`/api/maps/${this.mapId}?mode=edit`);
      if (!res.success || !this.map) return;
      const fresh = res.data;
      const local = new Map(this.basemaps.map((b) => [b.id, b]));
      const order = this.basemaps.map((b) => b.id);
      const shownUrl = local.has(this.currentBasemapId) ? local.get(this.currentBasemapId).url : null;
      this.basemaps = fresh.basemaps
        .map((b) => (local.has(b.id) ? { ...b, title: local.get(b.id).title, from: local.get(b.id).from, to: local.get(b.id).to } : b))
        .sort((a, b) => (order.indexOf(a.id) + 1 || 999) - (order.indexOf(b.id) + 1 || 999));
      const sizeChanged = (fresh.size || null) === null
        ? !!this.size
        : !this.size || fresh.size.w !== this.size.w || fresh.size.h !== this.size.h;
      if (sizeChanged) this.setSize(fresh.size || null);
      else this.refreshBasemapSelect();
      // Показанный фон заменили (новые тайлы, новый ?v=) — перезагружаем слой.
      const cur = this.basemaps.find((b) => b.id === this.currentBasemapId);
      if (!sizeChanged && cur && shownUrl && cur.url !== shownUrl) {
        this.setBasemap(cur.id, { auto: true });
        this.toast(`Фон «${cur.title}» заменён`);
      }
      this.renderBasemapList();
    }

    async deleteMap() {
      if (!(await this.askDelete(`Карта «${this.doc.title}» будет удалена целиком — зоны, метки, события и фоны. Это нельзя отменить.`, 'Удалить карту?'))) return;
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
      return JSON.stringify({ title: this.doc.title, roles: this.doc.roles, zones: this.doc.zones, markers: this.doc.markers, markerGroups: this.doc.markerGroups, events: this.doc.events, timeline: this.doc.timeline });
    }

    pushHistory() {
      this._recoverDraw = null;
      this.undoStack.push(this.snapshot());
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.updateUndoButtons();
    }

    restore(snap) {
      const s = JSON.parse(snap);
      this.doc = { title: s.title, roles: s.roles, zones: s.zones, markers: s.markers || [], markerGroups: s.markerGroups || [], events: s.events || [], timeline: s.timeline || { initial: null } };
      if (!this.eventById(this.selectedEventId)) this.selectedEventId = null;
      if (!this.markerById(this.selectedMarkerId)) this.selectedMarkerId = null;
      this.root.querySelector('.me-title-input').value = this.doc.title;
      if (!this.zoneById(this.selectedId)) this.selectedId = null;
      this.afterZonesChanged({ keepLayers: false });
      if (this.sidebarTab === 'map') this.renderMapSettings();
    }

    // Во время рисования многоугольника Ctrl+Z/Ctrl+Y убирают и возвращают
    // точки, а не весь контур. Сразу после Esc Ctrl+Z возвращает контур;
    // сразу после замыкания — убирает новую зону и тоже возвращает контур.
    undo() {
      if (this.draw && this.draw.kind === 'polygon') { this.popDrawPoint(); return; }
      const rec = this._recoverDraw;
      this._recoverDraw = null;
      if (rec && rec.kind === 'cancel') { this.resumeDrawing(rec.points); return; }
      if (!this.undoStack.length) return;
      this.cancelDrawing();
      this.redoStack.push(this.snapshot());
      this.restore(this.undoStack.pop());
      if (rec && rec.kind === 'finish') this.resumeDrawing(rec.points);
      this.updateUndoButtons();
    }

    redo() {
      if (this.draw && this.draw.kind === 'polygon') {
        const p = this.draw.redo.pop();
        if (!p) return;
        if (p.group) this.draw.points.push(...p.group);
        else this.draw.points.push(p);
        this.renderDraft();
        this.drawingChanged();
        return;
      }
      if (!this.redoStack.length) return;
      this.cancelDrawing();
      this.undoStack.push(this.snapshot());
      this.restore(this.redoStack.pop());
      this.updateUndoButtons();
    }

    updateUndoButtons() {
      const drawing = this.draw && this.draw.kind === 'polygon';
      this.root.querySelector('[data-act="undo"]').disabled = drawing
        ? !this.draw.points.length
        : !this.undoStack.length && !this._recoverDraw;
      this.root.querySelector('[data-act="redo"]').disabled = drawing ? !this.draw.redo.length : !this.redoStack.length;
    }

    afterZonesChanged() {
      this.renderZoneLayers();
      this.renderMarkerLayers();
      this.renderTimelineBar();
      if (this.sidebarTab === 'time') this.renderTimePanel();
      this.renderHandles();
      this.renderTree();
      this.renderProps();
      this.markDirty();
    }

    markDirty() {
      this.dirty = true;
      // Счётчик правок: save() по нему понимает, что пока шёл запрос, карту
      // успели поменять, и не объявляет эти правки сохранёнными.
      this._editSeq = (this._editSeq || 0) + 1;
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
          timeUnit: 'day', // черновики до перехода на даты хранили годы — такие не предлагаем
          // Календарь мира на момент черновика: сменят — даты черновика
          // пересчитаются так же, как сервер пересчитал карту.
          calendarMonths: window.MapCalendar.customMonths(this.cal()),
          title: this.doc.title,
          roles: this.doc.roles,
          zones: this.doc.zones,
          markers: this.doc.markers,
          markerGroups: this.doc.markerGroups,
          events: this.doc.events,
          timeline: this.doc.timeline,
          basemaps: this.basemaps.map((b) => ({ id: b.id, title: b.title, from: b.from ?? null, to: b.to ?? null }))
        }));
      } catch (e) { /* переполнен localStorage — черновик не сохранится, но сохранение на сервер работает */ }
    }

    clearDraft() {
      try { localStorage.removeItem(this.draftKey()); } catch (e) { /* нет доступа — ничего страшного */ }
    }

    async offerDraftRestore() {
      let draft = null;
      try { draft = JSON.parse(localStorage.getItem(this.draftKey()) || 'null'); } catch (e) { draft = null; }
      if (!draft || !Array.isArray(draft.zones)) return;
      if (draft.timeUnit !== 'day') { this.clearDraft(); return; }
      const when = new Date(draft.savedAt).toLocaleString('ru-RU');
      const stale = draft.baseUpdatedAt !== this.baseUpdatedAt;
      const msg = stale
        ? `Есть несохранённый черновик этой карты от ${when}, но с тех пор карту сохранили заново (возможно, кто-то другой). Если восстановить, более новые изменения при сохранении будут перезаписаны.`
        : `Есть несохранённый черновик этой карты от ${when}.`;
      const choice = await this.choose('Черновик карты', msg, [
        { label: 'Отбросить', value: 'drop', variant: 'secondary' },
        { label: 'Восстановить', value: 'restore', variant: 'primary' }
      ]);
      if (!this.map) return; // редактор уже закрыли, пока окно было открыто
      // Отмена (Esc/крестик) — черновик не трогаем: спросим при следующем открытии.
      if (choice === 'drop') { this.clearDraft(); return; }
      if (choice !== 'restore') return;
      this.pushHistory();
      this.doc = { title: draft.title, roles: draft.roles || [], zones: draft.zones, markers: draft.markers || this.doc.markers || [], events: draft.events || this.doc.events || [], timeline: draft.timeline || this.doc.timeline, markerGroups: draft.markerGroups || this.doc.markerGroups || [] };
      const CAL = window.MapCalendar;
      const draftCal = { months: draft.calendarMonths || null };
      if (CAL.signature(draftCal) !== CAL.signature(this.cal())) {
        CAL.mapTimes(this.doc, (t) => CAL.convert(t, draftCal, this.cal()));
        this.toast('Календарь мира сменился после черновика — даты черновика пересчитаны');
      }
      this.root.querySelector('.me-title-input').value = this.doc.title;
      const titles = new Map((draft.basemaps || []).map((b) => [b.id, b.title]));
      this.basemaps.forEach((b) => { if (titles.has(b.id)) b.title = titles.get(b.id); });
      if (stale) this._forceNextSave = true;
      this.afterZonesChanged();
    }

    // Сохранение, пока идёт прошлое, не теряется: оно ставится в очередь и
    // выполнится сразу после (правки, сделанные во время запроса, тоже уйдут).
    async save(opts = {}) {
      if (this._saving) { this._saveQueued = true; return this._savePromise; }
      this._saving = true;
      this._savePromise = (async () => {
        try {
          await this.saveOnce(opts);
        } catch (e) {
          this.setStatus('Не сохранено', 'error');
          window.showMessage?.(`Не удалось сохранить карту: ${e.message}`, 'error');
        } finally {
          this._saving = false;
        }
        if (this._saveQueued) {
          this._saveQueued = false;
          if (this.dirty) await this.save();
        }
      })();
      return this._savePromise;
    }

    async saveOnce({ force = false } = {}) {
      this.setStatus('Сохранение…', 'saving');
      // Правки типов мира — тем же «Сохранить».
      if (this._worldCtl && this._worldCtl.isDirty()) {
        const ok = await this._worldCtl.save();
        if (!ok) { this.setStatus('Не сохранено', 'error'); return; }
      }
      const seq = this._editSeq || 0;
      const body = {
        title: this.doc.title,
        roles: this.doc.roles,
        zones: this.doc.zones,
        markers: this.doc.markers,
        markerGroups: this.doc.markerGroups,
        events: this.doc.events,
        timeline: this.doc.timeline,
        basemaps: this.basemaps.map((b) => ({ id: b.id, title: b.title, from: b.from ?? null, to: b.to ?? null })),
        baseUpdatedAt: this.baseUpdatedAt,
        force: force || !!this._forceNextSave
      };
      const res = await window.MapsUI.api(`/api/maps/${this.mapId}`, 'PUT', body);
      if (res.status === 409) {
        this.setStatus('Конфликт версий', 'error');
        const choice = await this.choose('Карту уже изменили', 'Эту карту уже сохранил кто-то другой после того, как вы открыли редактор. Перезаписать его изменения вашими?', [
          { label: 'Перезаписать', value: 'force', variant: 'danger' }
        ]);
        if (choice === 'force') return this.saveOnce({ force: true });
        return;
      }
      if (!res.success || !res.data || !res.data.updated_at) {
        this.setStatus('Не сохранено', 'error');
        window.showMessage?.(`Не удалось сохранить карту: ${window.MapsUI.apiError(res)}`, 'error');
        return;
      }
      this.baseUpdatedAt = res.data.updated_at;
      this._forceNextSave = false;

      // Сверка с сервером: он перечитал карту с диска и сообщил, что там
      // лежит. Если чего-то меньше, чем отправили, — правки не считаем
      // сохранёнными, черновик остаётся.
      const lost = this.verifySaved(body, res.data.saved);
      if (lost) {
        this.writeDraft();
        this.setStatus('Сохранено не полностью', 'error');
        window.showMessage?.(`Сервер сохранил карту не полностью: ${lost}. Правки остались в редакторе и в черновике — не закрывайте его и сообщите об ошибке.`, 'error');
        return;
      }

      // Пока шёл запрос, карту поменяли — эти правки ещё не на сервере.
      if ((this._editSeq || 0) !== seq) {
        this.writeDraft(); // черновик — уже от новой версии сервера
        this.setStatus('Есть несохранённые изменения', 'dirty');
        return;
      }
      this.dirty = false;
      clearTimeout(this._draftTimer);
      this.clearDraft();
      this.setStatus(`Сохранено в ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`, 'saved');
    }

    // Что из отправленного сервер не записал (текстом) или null — всё на месте.
    verifySaved(body, saved) {
      if (!saved) return 'сервер не подтвердил запись';
      const parts = [
        ['zones', 'зон'], ['markers', 'меток'], ['events', 'событий'], ['markerGroups', 'групп меток']
      ].filter(([key]) => (saved[key] ?? 0) < (body[key] || []).length)
        .map(([key, label]) => `${label} ${saved[key] ?? 0} из ${body[key].length}`);
      return parts.length ? parts.join(', ') : null;
    }

    // Выбор в окне приложения (не браузерный confirm). Без confirm-dialog.js
    // — запасной системный confirm: true → первый вариант.
    async choose(title, message, buttons) {
      if (window.confirmDialog && window.confirmDialog.choose) return window.confirmDialog.choose({ title, message, buttons });
      return confirm(message) ? buttons[0].value : null;
    }

    // Несохранённые правки перед уходом из редактора: 'save' — сохранить,
    // 'discard' — отбросить (черновик тоже, чтобы потом о нём не спрашивали),
    // null — остаться. Правок нет — сразу 'clean'.
    async askLeave(actionLabel) {
      if (!this.dirty) return 'clean';
      const choice = await this.choose('Несохранённые изменения', 'На карте есть несохранённые изменения. Сохранить их?', [
        { label: 'Не сохранять', value: 'discard', variant: 'secondary' },
        { label: `Сохранить и ${actionLabel}`, value: 'save', variant: 'primary' }
      ]);
      if (choice === 'save') {
        await this.save();
        if (this.dirty) return null; // сохранить не вышло — остаёмся, ошибка уже показана
      } else if (choice === 'discard') {
        this.dirty = false;
        clearTimeout(this._draftTimer);
        this.clearDraft();
      }
      return choice;
    }

    async preview() {
      if (!(await this.askLeave('открыть просмотр'))) return;
      window.MapsUI.openMapPage(this.mapId, { zoneId: this.selectedId });
    }

    async close() {
      if (!(await this.askLeave('выйти'))) return;
      window.MapsUI.goBack();
    }

    // ----- Клавиатура и прочее -----

    bindGlobal() {
      this._onKeyDown = (e) => this.onKeyDown(e);
      this._onKeyUp = (e) => this.onKeyUp(e);
      // Ушли в другую вкладку/окно: отпускание клавиш-модификаторов туда не
      // придёт — сбрасываем их. Рисуемую зону НЕ трогаем (раньше здесь был
      // setTool → cancelDrawing, и недорисованный многоугольник пропадал от
      // любого расфокуса, даже от окна confirm()).
      this._onBlur = () => {
        this.releaseModifiers();
        this.finishStuckDrag();
      };
      // Кнопку мыши отпустили за пределами страницы — mouseup не пришёл, и
      // метка/точка зоны «прилипла» бы к курсору. Первое же движение без
      // зажатой кнопки завершает перетаскивание как обычное отпускание.
      this._onMouseMoveCapture = (e) => { if (e.buttons === 0) this.finishStuckDrag(); };
      // Закрытие вкладки/перезагрузка: системное окно браузера «Покинуть
      // сайт?» не показываем — правки и недорисованный контур и так пишутся
      // в черновик, и при следующем открытии редактор предложит их вернуть.
      this._onBeforeUnload = () => {
        this.saveDrawing();
        if (this.dirty) this.writeDraft();
      };
      document.addEventListener('keydown', this._onKeyDown);
      document.addEventListener('keyup', this._onKeyUp);
      document.addEventListener('mousemove', this._onMouseMoveCapture, true);
      window.addEventListener('blur', this._onBlur);
      window.addEventListener('beforeunload', this._onBeforeUnload);
    }

    releaseModifiers() {
      const hadSpace = this.mods.space;
      this.mods = { shift: false, alt: false, space: false };
      if (hadSpace) {
        this.wrapEl.classList.remove('me-panning');
        if (this.tool === 'polygon' || this.tool === 'lasso' || this.tool === 'brush') this.map.dragging.disable();
      }
    }

    // Незавершённое перетаскивание Leaflet (метка, точка зоны, сдвиг карты)
    // завершаем штатно: finishDrag шлёт dragend, и правка сохраняется так же,
    // как при обычном отпускании кнопки. Лассо — так же, как отпускание.
    finishStuckDrag() {
      const drag = L.Draggable && L.Draggable._dragging;
      if (drag && typeof drag.finishDrag === 'function') drag.finishDrag(true);
      if (this._lassoUp) this._lassoUp();
    }

    isTyping() {
      const a = document.activeElement;
      return !!(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)));
    }

    onKeyDown(e) {
      // Открыто окно выравнивания фона — горячие клавиши редактора молчат.
      if (this._alignOpen) {
        if (e.key === 'Escape' && this._closeAlign) this._closeAlign();
        return;
      }
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
      if (e.key === 'Escape') { if (this.draw) this.abandonDrawing(); else this.select(null); return; }
      if (e.key === 'Enter' && this.draw && this.draw.kind === 'polygon') { this.finishPolygon(); return; }
      if (e.key === 'Backspace' && this.draw && this.draw.kind === 'polygon') { e.preventDefault(); this.popDrawPoint(); return; }
      // Backspace/Delete — модальное окно удаления выбранного: метки, зоны
      // или (во вкладке «Время») события.
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (document.querySelector('#confirmDialogModal:not([hidden])')) return; // окно уже открыто
        if (this.selectedMarkerId) { e.preventDefault(); this.deleteMarker(this.selectedMarkerId); return; }
        if (this.selectedId) { e.preventDefault(); this.deleteZone(this.selectedId); return; }
        if (this.selectedEventId && this.sidebarTab === 'time') { e.preventDefault(); this.deleteEvent(this.selectedEventId); return; }
      }
      if (this.tool === 'brush' && (e.key === '[' || e.key === ']' || e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault();
        const up = e.key === ']' || e.code === 'BracketRight';
        this.setBrushSize(this.brushSize() * (up ? 1.25 : 0.8));
        return;
      }
      if (key === 'f') { this.setFogPreview(!this.fogPreview); return; }
      if (key === 'n') { this.setNeighborCut(!this.neighborCut); this.toast(this.neighborCut ? 'Новые зоны не заходят на соседние' : 'Зоны могут накладываться на соседние'); return; }
      const tool = TOOLS.find((t) => t.key === key);
      if (tool) this.setTool(tool.id);
    }

    onKeyUp(e) {
      this.mods.shift = e.shiftKey;
      this.mods.alt = e.altKey;
      if (e.key === ' ' && this.mods.space) {
        this.mods.space = false;
        this.wrapEl.classList.remove('me-panning');
        if (this.tool === 'polygon' || this.tool === 'lasso' || this.tool === 'brush') this.map.dragging.disable();
      }
    }

    toast(text) {
      window.showMessage?.(text, 'warning');
    }

    renderAll() {
      this.setTool('select');
      this.renderZoneLayers();
      this.renderMarkerLayers();
      this.renderTimelineBar();
      this.renderTree();
      this.renderProps();
      this.updateUndoButtons();
      this.setStatus('Все изменения сохранены', 'saved');
    }

    destroy() {
      if (this.dirty) this.writeDraft();
      this.saveDrawing();
      clearInterval(this._pollTimer);
      clearTimeout(this._draftTimer);
      if (this._alignOpen && this._closeAlign) this._closeAlign();
      this.root.removeEventListener('click', this._onRootClick);
      document.removeEventListener('keydown', this._onKeyDown);
      document.removeEventListener('keyup', this._onKeyUp);
      window.removeEventListener('blur', this._onBlur);
      document.removeEventListener('mousemove', this._onMouseMoveCapture, true);
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
    const generation = window.MapsUI.pageGeneration();
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
    // Пока грузились данные, пользователь мог уйти на другую страницу или
    // другую карту — тогда этот (опоздавший) редактор не создаём.
    if (window.MapsUI.pageGeneration() !== generation) return;
    const pageTitle = document.getElementById('page-title');
    if (pageTitle) pageTitle.textContent = `Редактор: ${res.data.title}`;
    document.title = `${res.data.title} — редактор карты`;
    const editor = new MapEditor(appContent, res.data);
    window.MapsUI.setCurrent(editor);
  }

  window.MapEditor = { loadMapEditor };
})();
