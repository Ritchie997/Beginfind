// maps-ui.js — страницы интерактивных карт в SPA:
//   /map/:id       — полноэкранный просмотр (ПК и телефон)
//   /map/:id/edit  — редактор (см. map-editor.js)
// и вкладки рабочей области сервера «Карты» и «Мир».
//
// Страница карты — полноэкранный слой поверх интерфейса (.map-fs) внутри
// #app-content: при переходе на другой раздел роутер заменяет #app-content и
// слой исчезает сам; cleanupPage() дополнительно гасит Leaflet.

(function () {
  'use strict';

  const { escapeHtml } = window.MapCore;

  function api(path, method = 'GET', body) {
    return window.apiClient.makeAuthenticatedRequest(path, method, body);
  }
  function apiError(result) {
    return (result && result.data && result.data.error) || (result && result.error) || 'Неизвестная ошибка';
  }

  let current = null; // { viewer | editor }
  let pendingOpen = null; // параметры openMapPage для следующей загрузки /map/:id

  function cleanupPage() {
    if (current) {
      try { current.destroy(); } catch (e) { /* уже разрушено */ }
      current = null;
    }
    document.body.classList.remove('map-fs-open');
  }

  function openMapPage(mapId, params = {}) {
    pendingOpen = { mapId, ...params };
    window.spaRouter?.navigateTo(`/map/${mapId}`);
  }

  function openMapEditor(mapId) {
    window.spaRouter?.navigateTo(`/map/${mapId}/edit`);
  }

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else window.spaRouter?.navigateTo('/ibripedia');
  }

  // ===== Страница просмотра =====

  async function loadMapPage(router) {
    cleanupPage();
    const mapId = router.mapRouteId;
    const appContent = document.getElementById('app-content');
    if (!appContent) return;
    appContent.innerHTML = `
      <div class="map-fs">
        <div class="map-fs-topbar">
          <button type="button" class="map-fs-btn" data-act="back" title="Назад"><i class="fas fa-arrow-left"></i></button>
          <div class="map-fs-title"><span class="map-fs-name">Загрузка карты…</span><span class="map-fs-world"></span></div>
          <div class="map-fs-actions"></div>
        </div>
        <div class="map-fs-body"><div class="map-fs-viewer"></div><aside class="map-fs-panel" hidden></aside></div>
      </div>`;
    document.body.classList.add('map-fs-open');
    const root = appContent.querySelector('.map-fs');
    root.querySelector('[data-act="back"]').addEventListener('click', goBack);

    const params = pendingOpen && pendingOpen.mapId === mapId ? pendingOpen : {};
    pendingOpen = null;

    let data;
    try {
      data = await window.MapCore.fetchViewerMap(mapId, { fresh: true });
    } catch (err) {
      root.querySelector('.map-fs-name').textContent = 'Карта недоступна';
      root.querySelector('.map-fs-viewer').innerHTML = `<div class="map-fs-empty"><i class="fas fa-map"></i><div>${escapeHtml(err.message)}</div></div>`;
      return;
    }

    root.querySelector('.map-fs-name').textContent = data.title;
    root.querySelector('.map-fs-world').textContent = data.serverName ? `Мир: ${data.serverName}` : '';
    document.title = `${data.title} — карта`;
    const pageTitle = document.getElementById('page-title');
    if (pageTitle) pageTitle.textContent = data.title;

    const actions = root.querySelector('.map-fs-actions');
    actions.innerHTML = `
      <button type="button" class="map-fs-btn" data-act="zones" title="Что показывать и список зон и меток"><i class="fas fa-layer-group"></i><span class="map-fs-btn-label"> Слои</span></button>
      ${data.can_edit ? '<button type="button" class="map-fs-btn" data-act="edit" title="Редактировать карту"><i class="fas fa-pen"></i><span class="map-fs-btn-label"> Редактировать</span></button>' : ''}`;

    if (!data.basemaps.length) {
      root.querySelector('.map-fs-viewer').innerHTML = `<div class="map-fs-empty"><i class="fas fa-image"></i><div>У карты ещё нет фона${data.can_edit ? ' — загрузите её в редакторе' : ''}.</div></div>`;
      bindPageActions(root, null, data);
      return;
    }

    const viewer = new window.MapCore.MapViewer(root.querySelector('.map-fs-viewer'), data, {
      mode: 'page',
      view: params.view,
      focusZoneId: params.zoneId,
      basemapId: params.basemapId,
      time: params.time,
      externalLayers: true, // флажки слоёв — в боковой панели страницы
      onSelect: (id, kind) => highlightInPanel(root, id, kind),
      // Список зон — только то, что существует в текущий момент таймлайна.
      onTimeChange: () => root.querySelector('.map-fs-panel')?._render?.(),
      onGroupsChange: () => root.querySelector('.map-fs-panel')?._render?.(),
    });
    current = viewer;
    bindPageActions(root, viewer, data);
  }

  function bindPageActions(root, viewer, data) {
    root.querySelector('[data-act="edit"]')?.addEventListener('click', () => {
      if (window.MapCore.isTouchUi() && !confirm('Редактор карт сейчас рассчитан на компьютер (мышь и клавиатура). Открыть всё равно?')) return;
      openMapEditor(data.id);
    });
    root.querySelector('[data-act="zones"]')?.addEventListener('click', () => toggleZonePanel(root, viewer, data));
  }

  // Список/поиск зон — запасная навигация: мелкий город на огромной карте
  // пальцем не найти. Дерево по вложенности, при поиске — плоский список.
  function toggleZonePanel(root, viewer, data) {
    const panel = root.querySelector('.map-fs-panel');
    if (!panel.hidden) { panel.hidden = true; return; }
    panel.hidden = false;
    if (panel.dataset.built) { panel.querySelector('input')?.focus(); return; }
    panel.dataset.built = '1';
    panel.innerHTML = `
      <div class="map-fs-panel-head">
        <input type="search" class="map-fs-search" placeholder="Найти зону или метку…" autocomplete="off">
        <button type="button" class="map-fs-btn" data-act="close-panel" title="Закрыть"><i class="fas fa-xmark"></i></button>
      </div>
      <div class="map-fs-panel-scroll">
        <details class="map-fs-layers-box" open>
          <summary>Что показывать</summary>
          <div class="map-fs-layers"></div>
        </details>
        <div class="map-fs-zone-list"></div>
      </div>`;
    if (viewer) viewer.mountLayersInto(panel.querySelector('.map-fs-layers'));
    const list = panel.querySelector('.map-fs-zone-list');
    const input = panel.querySelector('.map-fs-search');
    const types = window.MapCore.typeMap(data.zoneTypes);
    const markerTypes = window.MapCore.typeMap(data.markerTypes);
    const render = () => {
      const q = input.value.trim().toLowerCase().replace(/ё/g, 'е');
      const t = viewer ? viewer.time : null;
      const exists = (o) => window.MapCore.existsAt(o, t);
      const html = renderZoneTree(data.zones.filter(exists), types, q, viewer) + renderMarkerList((data.markers || []).filter(exists), markerTypes, q, data.markerGroups || [], viewer);
      list.innerHTML = html || '<div class="map-fs-zone-empty">Ничего не найдено</div>';
      if (viewer) highlightInPanel(root, viewer.selectedMarkerId || viewer.selectedId, viewer.selectedMarkerId ? 'marker' : 'zone');
    };
    input.addEventListener('input', () => {
      if (viewer) viewer.setSearchQuery(input.value);
      render();
    });
    panel._render = render;
    panel.querySelector('[data-act="close-panel"]').addEventListener('click', () => { panel.hidden = true; });
    // Флажок группы в списке — то же, что в «Слоях».
    list.addEventListener('change', (e) => {
      const cb = e.target.closest('[data-list-group]');
      if (cb && viewer) viewer.setGroupVisible(cb.dataset.listGroup, cb.checked);
    });
    list.addEventListener('click', (e) => {
      if (e.target.closest('[data-list-group]')) return;
      const item = e.target.closest('[data-zone-id], [data-marker-id]');
      if (!item || !viewer) return;
      if (item.dataset.markerId) viewer.selectMarker(item.dataset.markerId, { fly: true });
      else viewer.selectZone(item.dataset.zoneId, { fly: true });
      if (window.MapCore.isTouchUi()) panel.hidden = true;
    });
    render();
    if (!window.MapCore.isTouchUi()) input.focus();
  }

  function renderZoneTree(zones, types, query, viewer = null) {
    if (!zones.length) return query ? '' : '<div class="map-fs-zone-empty">На карте пока нет зон</div>';
    const item = (z, depth) => {
      const t = types.get(z.typeId) || window.MapCore.FALLBACK_TYPE;
      const off = viewer && viewer.isZoneFiltered(z);
      return `<button type="button" class="map-fs-zone${off ? ' is-off' : ''}" data-zone-id="${escapeHtml(z.id)}" style="padding-left:${10 + depth * 16}px">
        <span class="map-fs-zone-dot" style="background:${escapeHtml(t.color)}"></span>
        <span class="map-fs-zone-name">${escapeHtml(z.title || 'Без названия')}</span>
        <span class="map-fs-zone-type">${escapeHtml(t.name)}</span>
        ${z.locked ? '<i class="fas fa-lock map-fs-zone-lock" title="Статья закрыта"></i>' : ''}
      </button>`;
    };
    const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '', 'ru');
    if (query) {
      const found = zones.filter((z) => (z.title || '').toLowerCase().replace(/ё/g, 'е').includes(query)).sort(byTitle);
      return found.map((z) => item(z, 0)).join('');
    }
    const ids = new Set(zones.map((z) => z.id));
    const children = new Map();
    zones.forEach((z) => {
      const key = z.parentId && ids.has(z.parentId) ? z.parentId : '';
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(z);
    });
    const out = [];
    const walk = (key, depth) => (children.get(key) || []).sort(byTitle).forEach((z) => { out.push(item(z, depth)); walk(z.id, depth + 1); });
    walk('', 0);
    return out.join('');
  }

  // Метки — по группам карты: заголовок группы с флажком видимости (как в
  // «Слоях»); метки выключенной группы остаются в списке полупрозрачными.
  function renderMarkerList(markers, types, query, groups = [], viewer = null) {
    const norm = (v) => String(v || '').toLowerCase().replace(/ё/g, 'е');
    const found = markers
      .filter((m) => {
        if (!query) return true;
        const g = m.groupId && groups.find((x) => x.id === m.groupId);
        return norm(m.title).includes(query) || norm(m.text).includes(query) || (!!g && norm(g.name).includes(query));
      })
      .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ru'));
    if (!found.length) return '';
    const hidden = viewer ? viewer.hiddenGroups : new Set();
    const row = (m) => {
      const t = types.get(m.typeId) || window.MapCore.FALLBACK_MARKER_TYPE;
      const off = viewer ? viewer.isMarkerFiltered(m) : (m.groupId && hidden.has(m.groupId));
      return `<button type="button" class="map-fs-zone${off ? ' is-off' : ''}" data-marker-id="${escapeHtml(m.id)}"${off ? ' title="Группа выключена — клик всё равно покажет метку"' : ''}>
        <i class="fas fa-${escapeHtml(t.icon)} map-fs-marker-icon" style="color:${escapeHtml(t.color)}"></i>
        <span class="map-fs-zone-name">${escapeHtml(m.title || t.name)}</span>
        <span class="map-fs-zone-type">${escapeHtml(t.name)}</span>
        ${m.locked ? '<i class="fas fa-lock map-fs-zone-lock" title="Статья закрыта"></i>' : ''}
      </button>`;
    };
    const known = new Set(groups.map((g) => g.id));
    if (!groups.length) return `<div class="map-fs-list-head">Метки</div>` + found.map(row).join('');
    let html = `<div class="map-fs-list-head">Метки</div>`;
    groups.forEach((g) => {
      const list = found.filter((m) => m.groupId === g.id);
      if (!list.length) return;
      const on = !hidden.has(g.id);
      html += `<label class="map-fs-group-head${on ? '' : ' is-off'}"><input type="checkbox" data-list-group="${escapeHtml(g.id)}" ${on ? 'checked' : ''}> <span>${escapeHtml(g.name)}</span> <span class="map-fs-zone-type">${list.length}</span></label>`;
      html += list.map(row).join('');
    });
    const loose = found.filter((m) => !m.groupId || !known.has(m.groupId));
    if (loose.length) html += `<div class="map-fs-group-head map-fs-group-loose"><span>Без группы</span> <span class="map-fs-zone-type">${loose.length}</span></div>` + loose.map(row).join('');
    return html;
  }

  function highlightInPanel(root, id, kind = 'zone') {
    root.querySelectorAll('.map-fs-zone').forEach((el) => {
      const match = kind === 'marker' ? el.dataset.markerId === id : el.dataset.zoneId === id;
      el.classList.toggle('active', !!id && match);
    });
  }

  // ===== Вкладка сервера «Карты» =====

  async function renderServerMapsTab(body, ctx) {
    body.innerHTML = '<p class="maps-tab-loading">Загрузка карт…</p>';
    const result = await api(`/api/maps?serverId=${encodeURIComponent(ctx.server.id)}`);
    if (!body.isConnected || window.spaRouter?.currentServerWorkspaceTab !== 'maps') return;
    if (!result.success) {
      body.innerHTML = `<div class="server-permission-note"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(apiError(result))}</div>`;
      return;
    }
    const maps = result.data || [];
    // Слушатели — на собственном корне вкладки: #server-workspace-body общий
    // для всех вкладок, повешенные на него обработчики копились бы.
    body.innerHTML = '<div class="maps-tab-root"></div>';
    const root = body.firstElementChild;
    root.innerHTML = `
      <div class="server-section-toolbar">
        <h3 class="server-section-title">Карты мира (${maps.length})</h3>
        <button class="btn btn-primary btn-sm" data-act="create-map"><i class="fas fa-plus"></i> Создать карту</button>
      </div>
      <div class="maps-create-form" hidden>
        <input type="text" class="form-input" maxlength="120" placeholder="Название карты, например «Континент Эйра»">
        <button class="btn btn-primary btn-sm" data-act="confirm-create">Создать</button>
        <button class="btn btn-secondary btn-sm" data-act="cancel-create">Отмена</button>
      </div>
      ${maps.length ? `<div class="maps-grid">${maps.map(renderMapCard).join('')}</div>`
        : '<div class="maps-empty"><i class="fas fa-map"></i><div>В этом мире пока нет карт</div></div>'}
      <details class="maps-calendar" data-el="calendar" open>
        <summary><i class="fas fa-calendar-days"></i> Календарь мира</summary>
        <div class="maps-calendar-body"></div>
      </details>`;
    mountCalendarEditor(root.querySelector('[data-el="calendar"] .maps-calendar-body'), ctx.server.id);

    const form = root.querySelector('.maps-create-form');
    const input = form.querySelector('input');
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const id = btn.closest('[data-map-id]')?.dataset.mapId;
      if (act === 'create-map') { form.hidden = false; input.focus(); }
      else if (act === 'cancel-create') { form.hidden = true; }
      else if (act === 'confirm-create') await createMap(ctx.server.id, input.value.trim());
      else if (act === 'open-map') openMapPage(id);
      else if (act === 'edit-map') openMapEditor(id);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') createMap(ctx.server.id, input.value.trim()); });
  }

  function renderMapCard(m) {
    return `
      <article class="maps-card" data-map-id="${escapeHtml(m.id)}">
        <button type="button" class="maps-card-preview" data-act="open-map" title="Открыть карту">${renderPreview(m)}</button>
        <div class="maps-card-body">
          <div class="maps-card-title">${escapeHtml(m.title)}</div>
          <div class="maps-card-meta">Зон: ${m.zoneCount} · подложек: ${m.basemapCount} · ${new Date(m.updated_at).toLocaleDateString('ru-RU')}</div>
          <div class="maps-card-actions">
            <button class="btn btn-secondary btn-sm" data-act="open-map"><i class="fas fa-eye"></i> Открыть</button>
            ${m.can_edit ? '<button class="btn btn-secondary btn-sm" data-act="edit-map"><i class="fas fa-pen"></i> Редактировать</button>' : ''}
          </div>
        </div>
      </article>`;
  }

  // Миниатюра карточки: готовая preview.webp, а пока её нет — тайл нулевого
  // уровня, у которого показываем только долю fw×fh с самой картинкой
  // (остальная часть тайла — прозрачные поля до квадрата).
  function renderPreview(m) {
    if (m.preview) return `<img src="${escapeHtml(m.preview)}" alt="" loading="lazy">`;
    const t = m.previewTile;
    if (t && t.fw > 0 && t.fh > 0) {
      return `<span class="maps-card-preview-crop" style="aspect-ratio:${Number(t.aspect).toFixed(4)};background-image:url('${escapeHtml(t.url)}');background-size:${(100 / t.fw).toFixed(3)}% ${(100 / t.fh).toFixed(3)}%"></span>`;
    }
    return '<i class="fas fa-map"></i>';
  }

  async function createMap(serverId, title) {
    if (!title) { window.showMessage?.('Введите название карты', 'error'); return; }
    const result = await api('/api/maps', 'POST', { title, serverId });
    if (!result.success) { window.showMessage?.(`Не удалось создать карту: ${apiError(result)}`, 'error'); return; }
    openMapEditor(result.data.id);
  }

  // ===== Мир: типы зон и типы меток =====

  const HOVER_LABELS = { fill: 'Заливка ярче', outline: 'Толще граница', glow: 'Свечение', pulse: 'Пульсация' };
  // «Видно с приближения» — от вида всей карты (см. isVisibleAtZoom в map-core.js).
  const MIN_ZOOM_LABELS = ['Всегда', 'С приближения ×2', '×4', '×8', '×16', '×32', '×64'];
  // Тот же список, что MARKER_ICONS в src/services/worlds-store.js.
  const MARKER_ICONS = {
    'location-dot': 'Точка', star: 'Звезда', crown: 'Корона', 'chess-rook': 'Крепость', 'shield-halved': 'Щит',
    'place-of-worship': 'Святилище', landmark: 'Здание', city: 'Город', house: 'Дом', campground: 'Лагерь',
    dungeon: 'Подземелье', tree: 'Лес', mountain: 'Гора', water: 'Вода', anchor: 'Порт', ship: 'Корабль',
    skull: 'Опасность', bolt: 'Событие', fire: 'Огонь', gem: 'Сокровище', book: 'Книга', flag: 'Флаг',
    horse: 'Конь', 'circle-info': 'Пояснение'
  };

  function minZoomSelect(value, dis) {
    return `<select data-field="minZoomRel" ${dis}>${MIN_ZOOM_LABELS.map((l, v) => `<option value="${v}"${Number(value || 0) === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  }

  // Редактор мира (мир = сервер): типы зон и типы меток. Живёт во вкладке
  // «Зоны» редактора карты. Отдельной кнопки сохранения нет — правки мира
  // сохраняет обычное «Сохранить» редактора (см. controller.save ниже).
  // onChange(world) — на каждую правку: редактор сразу перерисовывает карту
  // и помечает, что есть несохранённые изменения.
  //
  // Возвращает controller: { isDirty(), save() → true/false, openType(kind, id) }.
  async function mountWorldEditor(container, serverId, { onSaved, onChange } = {}) {
    container.innerHTML = '<p class="maps-tab-loading">Загрузка настроек мира…</p>';
    const result = await api(`/api/servers/${encodeURIComponent(serverId)}/world`);
    if (!container.isConnected) return null;
    if (!result.success) {
      container.innerHTML = `<div class="server-permission-note"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(apiError(result))}</div>`;
      return null;
    }
    const state = {
      zone: result.data.zoneTypes.map((t) => ({ ...t, parents: [...(t.parents || [])] })),
      marker: (result.data.markerTypes || []).map((t) => ({ ...t })),
      canEdit: !!result.data.can_edit,
      isDefault: !!result.data.isDefault,
      dirty: false,
      openSections: { zone: true, marker: true },
      openRows: new Set() // `${kind}:${id}` — раскрытые типы
    };
    container.innerHTML = '<div class="world-tab-root"></div>';
    const root = container.firstElementChild;

    const section = (kind, title, list, rowFn) => `
      <details class="world-section" data-section="${kind}" ${state.openSections[kind] ? 'open' : ''}>
        <summary>
          <span>${title} (${list.length})</span>
          ${state.canEdit ? `<button type="button" class="btn btn-secondary btn-sm world-add" data-act="add" data-kind="${kind}"><i class="fas fa-plus"></i> Тип</button>` : ''}
        </summary>
        <div class="world-types">${list.map((t, i) => rowFn(t, i, state)).join('') || '<div class="me-tree-empty">Типов нет</div>'}</div>
      </details>`;

    const render = () => {
      root.innerHTML = `
        ${!state.canEdit ? '<div class="server-permission-note"><i class="fas fa-circle-info"></i> Менять типы мира может только администратор сервера.</div>' : ''}
        ${state.isDefault ? '<div class="server-permission-note"><i class="fas fa-circle-info"></i> Сейчас действует шаблон мира — его можно менять.</div>' : ''}
        <p class="world-hint">Общие для всех карт этого мира. Правки видны на карте сразу и сохраняются кнопкой «Сохранить» редактора.</p>
        ${section('zone', 'Типы зон', state.zone, renderZoneTypeRow)}
        ${section('marker', 'Типы меток', state.marker, renderMarkerTypeRow)}`;
    };

    const emitChange = () => {
      if (onChange) onChange({ zoneTypes: state.zone.map((t) => ({ ...t, parents: [...(t.parents || [])] })), markerTypes: state.marker.map((t) => ({ ...t })) });
    };
    const markDirty = () => { state.dirty = true; emitChange(); };
    const rowOf = (el) => {
      const row = el.closest('[data-type-index]');
      if (!row) return null;
      const list = state[row.dataset.kind];
      return { row, list, index: Number(row.dataset.typeIndex), t: list && list[Number(row.dataset.typeIndex)] };
    };
    render();

    // Раскрытые разделы и типы переживают перерисовку (добавление, удаление…).
    root.addEventListener('toggle', (e) => {
      const d = e.target;
      if (d.matches('details.world-section')) state.openSections[d.dataset.section] = d.open;
      else if (d.matches('details.world-type')) {
        const key = `${d.dataset.kind}:${d.dataset.typeId}`;
        if (d.open) state.openRows.add(key); else state.openRows.delete(key);
      }
    }, true);

    root.oninput = root.onchange = (e) => {
      const r = rowOf(e.target);
      const f = e.target.dataset.field;
      if (!r || !r.t || !f) return;
      const t = r.t;
      if (f === 'parent') {
        const pid = e.target.value;
        t.parents = e.target.checked ? [...new Set([...t.parents, pid])] : t.parents.filter((p) => p !== pid);
      } else if (e.target.type === 'checkbox') t[f] = e.target.checked;
      else if (e.target.type === 'number' || e.target.type === 'range' || f === 'minZoomRel') t[f] = Number(e.target.value);
      else t[f] = e.target.value;
      if (f === 'color') {
        r.row.style.setProperty('--zone-color', t.color);
        r.row.querySelectorAll('.world-swatch, .world-icon-preview').forEach((el) => el.style.setProperty('--marker-color', t.color));
      }
      if (f === 'icon') r.row.querySelectorAll('.world-icon-preview i').forEach((i) => { i.className = `fas fa-${t.icon}`; });
      if (f === 'name') { const nm = r.row.querySelector('.world-type-title'); if (nm) nm.textContent = t.name; }
      markDirty();
      if (f === 'name' && e.type === 'change') render(); // имена в списках «может лежать внутри»
    };

    root.onclick = (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      e.preventDefault(); // кнопки в заголовке <summary> не сворачивают его
      const r = rowOf(btn);
      switch (btn.dataset.act) {
        case 'add': {
          const kind = btn.dataset.kind;
          const id = `${kind === 'marker' ? 'k' : 't'}${Date.now().toString(36)}`;
          if (kind === 'marker') state.marker.push({ id, name: 'Новая метка', icon: 'location-dot', color: '#5865f2', minZoomRel: 0, noCluster: false });
          else state.zone.push({ id, name: 'Новый тип', topLevel: false, parents: [], color: '#5865f2', fillOpacity: 0.15, weight: 2, dashed: false, hoverEffect: 'fill', clipToParent: true, minZoomRel: 0 });
          state.openSections[kind] = true;
          state.openRows.add(`${kind}:${id}`);
          render();
          markDirty();
          break;
        }
        case 'remove-type':
          if (!r) return;
          (async () => {
            const msg = `Тип «${r.t.name}» будет удалён. Уже нарисованное останется, но будет показано стилем по умолчанию.`;
            const ok = window.confirmDialog ? await window.confirmDialog.open({ title: 'Удалить тип?', message: msg }) : confirm(msg);
            if (!ok) return;
            r.list.splice(r.index, 1);
            render();
            markDirty();
          })();
          break;
        case 'type-up':
          if (r && r.index > 0) { [r.list[r.index - 1], r.list[r.index]] = [r.list[r.index], r.list[r.index - 1]]; render(); markDirty(); }
          break;
        case 'type-down':
          if (r && r.index < r.list.length - 1) { [r.list[r.index + 1], r.list[r.index]] = [r.list[r.index], r.list[r.index + 1]]; render(); markDirty(); }
          break;
      }
    };

    return {
      isDirty: () => state.dirty && state.canEdit,
      // Сохранение мира — вызывается обычным «Сохранить» редактора.
      async save() {
        if (!state.dirty || !state.canEdit) return true;
        const res = await api(`/api/servers/${encodeURIComponent(serverId)}/world`, 'PUT', { zoneTypes: state.zone, markerTypes: state.marker }); // календарь — отдельно (mountCalendarEditor)
        if (!res.success) { window.showMessage?.(`Не удалось сохранить типы мира: ${apiError(res)}`, 'error'); return false; }
        state.zone = res.data.zoneTypes.map((t) => ({ ...t, parents: [...(t.parents || [])] }));
        state.marker = (res.data.markerTypes || []).map((t) => ({ ...t }));
        state.isDefault = false;
        state.dirty = false;
        render();
        if (onSaved) onSaved({ zoneTypes: res.data.zoneTypes, markerTypes: res.data.markerTypes || [] });
        return true;
      },
      // Раскрыть раздел и тип (кнопка ⚙ в свойствах зоны/метки).
      openType(kind, id) {
        state.openSections[kind] = true;
        state.openRows.add(`${kind}:${id}`);
        const sec = root.querySelector(`details.world-section[data-section="${kind}"]`);
        if (sec) sec.open = true;
        const row = root.querySelector(`details.world-type[data-kind="${kind}"][data-type-id="${CSS.escape(id || '')}"]`);
        if (row) row.open = true;
        return row;
      }
    };
  }

  // ===== Календарь мира =====
  // Обычный (григорианский) или свои месяцы с названиями и длиной. Смена
  // календаря пересчитывает даты всех карт мира на сервере (число, месяц и
  // год остаются прежними), поэтому сохраняется отдельно и с подтверждением.

  const GREGORIAN_MONTHS = [['Январь', 31], ['Февраль', 28], ['Март', 31], ['Апрель', 30], ['Май', 31], ['Июнь', 30],
    ['Июль', 31], ['Август', 31], ['Сентябрь', 30], ['Октябрь', 31], ['Ноябрь', 30], ['Декабрь', 31]];

  // opts.beforeSave() → false — не сохранять (редактор карты сначала
  // сохраняет свои правки); opts.onSaved(world) — после смены календаря.
  async function mountCalendarEditor(container, serverId, opts = {}) {
    const CAL = window.MapCalendar;
    container.classList.add('cal-editor');
    container.innerHTML = '<p class="maps-tab-loading">Загрузка календаря…</p>';
    const result = await api(`/api/servers/${encodeURIComponent(serverId)}/world`);
    if (!container.isConnected) return;
    if (!result.success) {
      container.innerHTML = `<div class="server-permission-note"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(apiError(result))}</div>`;
      return;
    }
    const canEdit = !!result.data.can_edit;
    let saved = CAL.customMonths(result.data.calendar);
    const state = { custom: !!saved, months: (saved || GREGORIAN_MONTHS.map(([name, days]) => ({ name, days }))).map((m) => ({ ...m })) };
    const dis = canEdit ? '' : 'disabled';

    const current = () => (state.custom ? { months: state.months } : { months: null });
    const isDirty = () => CAL.signature(current()) !== CAL.signature({ months: saved });

    const render = () => {
      const len = state.months.reduce((sum, m) => sum + (Number(m.days) || 0), 0);
      const cal = current();
      const sample = CAL.format(cal, CAL.dateToDay(cal, 313, Math.min(3, CAL.monthCount(cal)), 5));
      container.innerHTML = `
        ${canEdit ? '' : '<div class="server-permission-note"><i class="fas fa-circle-info"></i> Менять календарь мира может только администратор сервера.</div>'}
        <p class="world-hint">Календарь, которым подписаны даты на всех картах мира: на шкале, в событиях, в полях дат.</p>
        <label class="checkbox-field"><input type="radio" name="cal-kind" value="greg" ${state.custom ? '' : 'checked'} ${dis}> Обычный (григорианский)</label>
        <label class="checkbox-field"><input type="radio" name="cal-kind" value="custom" ${state.custom ? 'checked' : ''} ${dis}> Свой календарь: названия месяцев, дней в месяце, длина года</label>
        ${state.custom ? '' : '<p class="world-hint">Выберите «Свой календарь», чтобы задать месяцы.</p>'}
        ${state.custom ? `
          <div class="maps-cal-head"><span></span><span>Месяц</span><span>Дней</span></div>
          <div class="maps-cal-months">${state.months.map((m, i) => `
            <div class="maps-cal-month" data-month-index="${i}">
              <span class="maps-cal-num">${i + 1}</span>
              <input type="text" class="form-input" data-mfield="name" value="${escapeHtml(m.name)}" maxlength="40" placeholder="Название" ${dis}>
              <input type="number" class="form-input maps-cal-days" data-mfield="days" value="${escapeHtml(m.days)}" min="1" max="${CAL.MAX_MONTH_DAYS}" title="Дней в месяце" ${dis}>
              ${canEdit ? `<span class="world-row-btns">
                <button type="button" class="map-icon-btn" data-cal-act="up" title="Выше"><i class="fas fa-arrow-up"></i></button>
                <button type="button" class="map-icon-btn" data-cal-act="down" title="Ниже"><i class="fas fa-arrow-down"></i></button>
                <button type="button" class="map-icon-btn is-danger" data-cal-act="remove" title="Удалить месяц" ${state.months.length < 2 ? 'disabled' : ''}><i class="fas fa-trash"></i></button>
              </span>` : ''}
            </div>`).join('')}</div>
          ${canEdit && state.months.length < CAL.MAX_MONTHS ? '<button type="button" class="btn btn-secondary btn-sm" data-cal-act="add"><i class="fas fa-plus"></i> Месяц</button>' : ''}
          <p class="maps-cal-year">Год: <b>${state.months.length} мес., ${len} дн.</b> — сумма месяцев, високосных лет нет.</p>` : ''}
        <p class="world-hint">Пример даты: <b>${escapeHtml(sample)}</b></p>
        ${canEdit ? `<div class="maps-cal-actions">
          <button type="button" class="btn btn-primary btn-sm" data-cal-act="save" ${isDirty() ? '' : 'disabled'}><i class="fas fa-floppy-disk"></i> Сохранить календарь</button>
          ${isDirty() ? '<span class="world-hint">Есть несохранённые изменения</span>' : ''}
        </div>` : ''}`;
    };

    container.onchange = (e) => {
      if (e.target.name === 'cal-kind') { state.custom = e.target.value === 'custom'; render(); return; }
      const row = e.target.closest('[data-month-index]');
      const f = e.target.dataset.mfield;
      if (!row || !f) return;
      const m = state.months[Number(row.dataset.monthIndex)];
      if (f === 'days') m.days = Math.min(CAL.MAX_MONTH_DAYS, Math.max(1, Math.round(Number(e.target.value) || 1)));
      else m.name = e.target.value.trim() || m.name;
      render();
    };

    container.onclick = async (e) => {
      const btn = e.target.closest('[data-cal-act]');
      if (!btn) return;
      const act = btn.dataset.calAct;
      const row = btn.closest('[data-month-index]');
      const i = row ? Number(row.dataset.monthIndex) : -1;
      const list = state.months;
      if (act === 'add') list.push({ name: `Месяц ${list.length + 1}`, days: 30 });
      else if (act === 'remove' && list.length > 1) list.splice(i, 1);
      else if (act === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
      else if (act === 'down' && i >= 0 && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
      else if (act === 'save') {
        const msg = 'Даты на всех картах этого мира и в блоках карт в статьях будут пересчитаны: число, месяц и год останутся прежними '
          + '(если в новом месяце меньше дней — последний день месяца, если месяца нет — последний месяц). Открытые сейчас редакторы карт этого мира нужно будет перезагрузить.';
        const ok = window.confirmDialog ? await window.confirmDialog.open({ title: 'Сменить календарь мира?', message: msg, confirmLabel: 'Сменить' }) : confirm(msg);
        if (!ok) return;
        if (opts.beforeSave && !(await opts.beforeSave())) return;
        btn.disabled = true;
        const res = await api(`/api/servers/${encodeURIComponent(serverId)}/world/calendar`, 'PUT', { calendar: current() });
        if (!res.success) { btn.disabled = false; window.showMessage?.(`Не удалось сохранить календарь: ${apiError(res)}`, 'error'); return; }
        saved = CAL.customMonths(res.data.calendar);
        state.custom = !!saved;
        if (saved) state.months = saved.map((m) => ({ ...m }));
        const c = res.data.converted || { maps: 0, articles: 0 };
        window.showMessage?.(`Календарь сохранён. Пересчитаны даты карт: ${c.maps}, статей с блоками карт: ${c.articles}`, 'success');
        if (opts.onSaved) { opts.onSaved(res.data); return; }
      } else return;
      render();
    };

    render();
  }

  function typeRowButtons(state) {
    return state.canEdit ? `
      <span class="world-row-btns">
        <button class="map-icon-btn" data-act="type-up" title="Выше"><i class="fas fa-arrow-up"></i></button>
        <button class="map-icon-btn" data-act="type-down" title="Ниже"><i class="fas fa-arrow-down"></i></button>
        <button class="map-icon-btn is-danger" data-act="remove-type" title="Удалить тип"><i class="fas fa-trash"></i></button>
      </span>` : '';
  }

  function renderZoneTypeRow(t, i, state) {
    const dis = state.canEdit ? '' : 'disabled';
    const others = state.zone.filter((o) => o.id !== t.id);
    return `
      <details class="world-type" data-kind="zone" data-type-index="${i}" data-type-id="${escapeHtml(t.id)}" style="--zone-color:${escapeHtml(t.color)}" ${state.openRows.has(`zone:${t.id}`) ? 'open' : ''}>
        <summary class="world-type-summary">
          <span class="world-swatch" style="background:${escapeHtml(t.color)}"></span>
          <span class="world-type-title">${escapeHtml(t.name)}</span>
          ${typeRowButtons(state)}
        </summary>
        <div class="world-type-head">
          <input type="color" data-field="color" value="${escapeHtml(t.color)}" ${dis} title="Цвет">
          <input type="text" class="form-input" data-field="name" value="${escapeHtml(t.name)}" maxlength="60" ${dis}>
        </div>
        <div class="world-type-grid">
          <label class="checkbox-field"><input type="checkbox" data-field="topLevel" ${t.topLevel ? 'checked' : ''} ${dis}> Может быть на верхнем уровне</label>
          <label class="checkbox-field"><input type="checkbox" data-field="clipToParent" ${t.clipToParent ? 'checked' : ''} ${dis}> Обрезать по родителю</label>
          <label class="checkbox-field"><input type="checkbox" data-field="dashed" ${t.dashed ? 'checked' : ''} ${dis}> Пунктирная граница</label>
          <label>Толщина границы <input type="number" min="0" max="10" step="0.5" data-field="weight" value="${t.weight}" ${dis}></label>
          <label>Прозрачность заливки <input type="range" min="0" max="1" step="0.05" data-field="fillOpacity" value="${t.fillOpacity}" ${dis}></label>
          <label>При наведении <select data-field="hoverEffect" ${dis}>${Object.entries(HOVER_LABELS).map(([v, l]) => `<option value="${v}"${t.hoverEffect === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Видно ${minZoomSelect(t.minZoomRel, dis)}</label>
        </div>
        <div class="world-type-parents">
          <span>Может лежать внутри:</span>
          ${others.length ? others.map((o) => `<label class="checkbox-field"><input type="checkbox" data-field="parent" value="${escapeHtml(o.id)}" ${t.parents.includes(o.id) ? 'checked' : ''} ${dis}> ${escapeHtml(o.name)}</label>`).join('') : '<em>других типов нет</em>'}
        </div>
      </details>`;
  }

  function renderMarkerTypeRow(t, i, state) {
    const dis = state.canEdit ? '' : 'disabled';
    return `
      <details class="world-type" data-kind="marker" data-type-index="${i}" data-type-id="${escapeHtml(t.id)}" style="--zone-color:${escapeHtml(t.color)}" ${state.openRows.has(`marker:${t.id}`) ? 'open' : ''}>
        <summary class="world-type-summary">
          <span class="world-icon-preview" style="--marker-color:${escapeHtml(t.color)}"><i class="fas fa-${escapeHtml(t.icon)}"></i></span>
          <span class="world-type-title">${escapeHtml(t.name)}</span>
          ${typeRowButtons(state)}
        </summary>
        <div class="world-type-head">
          <input type="color" data-field="color" value="${escapeHtml(t.color)}" ${dis} title="Цвет">
          <input type="text" class="form-input" data-field="name" value="${escapeHtml(t.name)}" maxlength="60" ${dis}>
        </div>
        <div class="world-type-grid">
          <label>Иконка <select data-field="icon" ${dis}>${Object.entries(MARKER_ICONS).map(([v, l]) => `<option value="${v}"${t.icon === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Видно ${minZoomSelect(t.minZoomRel, dis)}</label>
          <label class="checkbox-field"><input type="checkbox" data-field="noCluster" ${t.noCluster ? 'checked' : ''} ${dis}> Не прятать в группу (важные)</label>
        </div>
      </details>`;
  }

  window.MapsUI = {
    api,
    apiError,
    cleanupPage,
    openMapPage,
    openMapEditor,
    goBack,
    loadMapPage,
    renderServerMapsTab,
    mountWorldEditor,
    mountCalendarEditor,
    setCurrent(instance) { current = instance; }
  };
})();
