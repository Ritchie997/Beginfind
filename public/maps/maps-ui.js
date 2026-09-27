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
      ${data.basemaps.length > 1 ? `<select class="map-fs-select" data-act="basemap" title="Подложка">${data.basemaps.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.title)}</option>`).join('')}</select>` : ''}
      <button type="button" class="map-fs-btn" data-act="zones" title="Список зон"><i class="fas fa-list"></i><span class="map-fs-btn-label"> Зоны</span></button>
      ${data.can_edit ? '<button type="button" class="map-fs-btn" data-act="edit" title="Редактировать карту"><i class="fas fa-pen"></i><span class="map-fs-btn-label"> Редактировать</span></button>' : ''}`;

    if (!data.basemaps.length) {
      root.querySelector('.map-fs-viewer').innerHTML = `<div class="map-fs-empty"><i class="fas fa-image"></i><div>У карты ещё нет готовой подложки${data.can_edit ? ' — загрузите её в редакторе' : ''}.</div></div>`;
      bindPageActions(root, null, data);
      return;
    }

    const viewer = new window.MapCore.MapViewer(root.querySelector('.map-fs-viewer'), data, {
      mode: 'page',
      view: params.view,
      focusZoneId: params.zoneId,
      basemapId: params.basemapId,
      onSelect: (id, kind) => highlightInPanel(root, id, kind)
    });
    current = viewer;
    const select = root.querySelector('[data-act="basemap"]');
    if (select) select.value = viewer.currentBasemapId;
    bindPageActions(root, viewer, data);
  }

  function bindPageActions(root, viewer, data) {
    root.querySelector('[data-act="basemap"]')?.addEventListener('change', (e) => viewer && viewer.setBasemap(e.target.value));
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
      <div class="map-fs-zone-list"></div>`;
    const list = panel.querySelector('.map-fs-zone-list');
    const input = panel.querySelector('.map-fs-search');
    const types = window.MapCore.typeMap(data.zoneTypes);
    const markerTypes = window.MapCore.typeMap(data.markerTypes);
    const render = () => {
      const q = input.value.trim().toLowerCase().replace(/ё/g, 'е');
      const html = renderZoneTree(data.zones, types, q) + renderMarkerList(data.markers || [], markerTypes, q);
      list.innerHTML = html || '<div class="map-fs-zone-empty">Ничего не найдено</div>';
      if (viewer) highlightInPanel(root, viewer.selectedMarkerId || viewer.selectedId, viewer.selectedMarkerId ? 'marker' : 'zone');
    };
    input.addEventListener('input', render);
    panel.querySelector('[data-act="close-panel"]').addEventListener('click', () => { panel.hidden = true; });
    list.addEventListener('click', (e) => {
      const item = e.target.closest('[data-zone-id], [data-marker-id]');
      if (!item || !viewer) return;
      if (item.dataset.markerId) viewer.selectMarker(item.dataset.markerId, { fly: true });
      else viewer.selectZone(item.dataset.zoneId, { fly: true });
      if (window.MapCore.isTouchUi()) panel.hidden = true;
    });
    render();
    if (!window.MapCore.isTouchUi()) input.focus();
  }

  function renderZoneTree(zones, types, query) {
    if (!zones.length) return query ? '' : '<div class="map-fs-zone-empty">На карте пока нет зон</div>';
    const item = (z, depth) => {
      const t = types.get(z.typeId) || window.MapCore.FALLBACK_TYPE;
      return `<button type="button" class="map-fs-zone" data-zone-id="${escapeHtml(z.id)}" style="padding-left:${10 + depth * 16}px">
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

  function renderMarkerList(markers, types, query) {
    const norm = (v) => String(v || '').toLowerCase().replace(/ё/g, 'е');
    const found = markers
      .filter((m) => !query || norm(m.title).includes(query) || norm(m.text).includes(query))
      .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ru'));
    if (!found.length) return '';
    return `<div class="map-fs-list-head">Метки</div>` + found.map((m) => {
      const t = types.get(m.typeId) || window.MapCore.FALLBACK_MARKER_TYPE;
      return `<button type="button" class="map-fs-zone" data-marker-id="${escapeHtml(m.id)}">
        <i class="fas fa-${escapeHtml(t.icon)} map-fs-marker-icon" style="color:${escapeHtml(t.color)}"></i>
        <span class="map-fs-zone-name">${escapeHtml(m.title || t.name)}</span>
        <span class="map-fs-zone-type">${escapeHtml(t.name)}</span>
        ${m.locked ? '<i class="fas fa-lock map-fs-zone-lock" title="Статья закрыта"></i>' : ''}
      </button>`;
    }).join('');
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
        : '<div class="maps-empty"><i class="fas fa-map"></i><div>В этом мире пока нет карт</div></div>'}`;

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

  // Редактор мира (мир = сервер). Живёт во вкладке «Мир» редактора карты.
  // Сохраняется отдельно от карты (настройка всего мира, общая для всех его
  // карт); onSaved(world) — редактор карты сразу перерисовывает зоны и метки.
  // onChange(world) — на каждую правку, до сохранения: редактор карты
  // сразу показывает, как будут выглядеть зоны и метки.
  async function mountWorldEditor(container, serverId, { onSaved, onChange } = {}) {
    container.innerHTML = '<p class="maps-tab-loading">Загрузка настроек мира…</p>';
    const result = await api(`/api/servers/${encodeURIComponent(serverId)}/world`);
    if (!container.isConnected) return;
    if (!result.success) {
      container.innerHTML = `<div class="server-permission-note"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(apiError(result))}</div>`;
      return;
    }
    const state = {
      zone: result.data.zoneTypes.map((t) => ({ ...t })),
      marker: (result.data.markerTypes || []).map((t) => ({ ...t })),
      canEdit: !!result.data.can_edit,
      isDefault: !!result.data.isDefault,
      dirty: false
    };
    container.innerHTML = '<div class="world-tab-root"></div>';
    const root = container.firstElementChild;
    const render = () => {
      root.innerHTML = `
        ${!state.canEdit ? '<div class="server-permission-note"><i class="fas fa-circle-info"></i> Менять настройки мира может только администратор сервера.</div>' : ''}
        ${state.isDefault ? '<div class="server-permission-note"><i class="fas fa-circle-info"></i> Сейчас действует шаблон мира — его можно менять.</div>' : ''}
        <p class="world-hint">Общие для всех карт этого мира. «Видно с приближения» считается от вида всей карты: на общем виде — только крупное, при приближении проступает мелкое.</p>
        <div class="world-head">
          <span class="me-props-head">Типы зон (${state.zone.length})</span>
          ${state.canEdit ? '<button class="btn btn-secondary btn-sm" data-act="add" data-kind="zone"><i class="fas fa-plus"></i> Тип</button>' : ''}
        </div>
        <div class="world-types">${state.zone.map((t, i) => renderZoneTypeRow(t, i, state)).join('')}</div>
        <div class="world-head">
          <span class="me-props-head">Типы меток (${state.marker.length})</span>
          ${state.canEdit ? '<button class="btn btn-secondary btn-sm" data-act="add" data-kind="marker"><i class="fas fa-plus"></i> Тип</button>' : ''}
        </div>
        <div class="world-types">${state.marker.map((t, i) => renderMarkerTypeRow(t, i, state)).join('')}</div>
        ${state.canEdit ? `<div class="world-save">
          <span class="world-unsaved" data-el="world-unsaved" ${state.dirty ? '' : 'hidden'}>Изменения уже видны на карте, но ещё не сохранены</span>
          <button class="btn btn-primary btn-sm" data-act="save-world" ${state.dirty ? '' : 'disabled'}><i class="fas fa-floppy-disk"></i> Сохранить мир</button>
        </div>` : ''}`;
    };
    const emitChange = () => {
      if (onChange) onChange({ zoneTypes: state.zone.map((t) => ({ ...t, parents: [...(t.parents || [])] })), markerTypes: state.marker.map((t) => ({ ...t })) });
    };
    const markDirty = () => {
      state.dirty = true;
      const btn = root.querySelector('[data-act="save-world"]');
      if (btn) btn.disabled = false;
      const note = root.querySelector('[data-el="world-unsaved"]');
      if (note) note.hidden = false;
      emitChange();
    };
    const rowOf = (el) => {
      const row = el.closest('[data-type-index]');
      if (!row) return null;
      const list = state[row.dataset.kind];
      return { row, list, index: Number(row.dataset.typeIndex), t: list && list[Number(row.dataset.typeIndex)] };
    };
    render();

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
      if (f === 'color') r.row.style.setProperty('--zone-color', t.color);
      if (f === 'icon') { const prev = r.row.querySelector('.world-icon-preview i'); if (prev) prev.className = `fas fa-${t.icon}`; }
      markDirty();
      if (f === 'name' && e.type === 'change') render(); // имена в списках родителей
    };
    root.onclick = async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const r = rowOf(btn);
      switch (btn.dataset.act) {
        case 'add':
          if (btn.dataset.kind === 'marker') state.marker.push({ id: `k${Date.now().toString(36)}`, name: 'Новая метка', icon: 'location-dot', color: '#5865f2', minZoomRel: 0 });
          else state.zone.push({ id: `t${Date.now().toString(36)}`, name: 'Новый тип', topLevel: false, parents: [], color: '#5865f2', fillOpacity: 0.15, weight: 2, dashed: false, hoverEffect: 'fill', clipToParent: true, minZoomRel: 0 });
          state.dirty = true;
          render();
          emitChange();
          break;
        case 'remove-type':
          if (!r || !confirm(`Удалить тип «${r.t.name}»? Уже нарисованное останется, но будет показано стилем по умолчанию.`)) return;
          r.list.splice(r.index, 1);
          state.dirty = true;
          render();
          emitChange();
          break;
        case 'type-up':
          if (r && r.index > 0) { [r.list[r.index - 1], r.list[r.index]] = [r.list[r.index], r.list[r.index - 1]]; state.dirty = true; render(); emitChange(); }
          break;
        case 'type-down':
          if (r && r.index < r.list.length - 1) { [r.list[r.index + 1], r.list[r.index]] = [r.list[r.index], r.list[r.index + 1]]; state.dirty = true; render(); emitChange(); }
          break;
        case 'save-world': {
          const res = await api(`/api/servers/${encodeURIComponent(serverId)}/world`, 'PUT', { zoneTypes: state.zone, markerTypes: state.marker });
          if (!res.success) { window.showMessage?.(`Не удалось сохранить: ${apiError(res)}`, 'error'); return; }
          state.zone = res.data.zoneTypes.map((t) => ({ ...t }));
          state.marker = (res.data.markerTypes || []).map((t) => ({ ...t }));
          state.isDefault = false;
          state.dirty = false;
          render();
          if (onSaved) onSaved({ zoneTypes: res.data.zoneTypes, markerTypes: res.data.markerTypes || [] });
          window.showMessage?.('Настройки мира сохранены', 'success');
          break;
        }
      }
    };
  }

  function typeRowButtons(state) {
    return state.canEdit ? `
      <button class="map-icon-btn" data-act="type-up" title="Выше"><i class="fas fa-arrow-up"></i></button>
      <button class="map-icon-btn" data-act="type-down" title="Ниже"><i class="fas fa-arrow-down"></i></button>
      <button class="map-icon-btn is-danger" data-act="remove-type" title="Удалить тип"><i class="fas fa-trash"></i></button>` : '';
  }

  function renderZoneTypeRow(t, i, state) {
    const dis = state.canEdit ? '' : 'disabled';
    const others = state.zone.filter((o) => o.id !== t.id);
    return `
      <div class="world-type" data-kind="zone" data-type-index="${i}" style="--zone-color:${escapeHtml(t.color)}">
        <div class="world-type-head">
          <input type="color" data-field="color" value="${escapeHtml(t.color)}" ${dis} title="Цвет">
          <input type="text" class="form-input" data-field="name" value="${escapeHtml(t.name)}" maxlength="60" ${dis}>
          ${typeRowButtons(state)}
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
      </div>`;
  }

  function renderMarkerTypeRow(t, i, state) {
    const dis = state.canEdit ? '' : 'disabled';
    return `
      <div class="world-type" data-kind="marker" data-type-index="${i}" style="--zone-color:${escapeHtml(t.color)}">
        <div class="world-type-head">
          <span class="world-icon-preview" style="--marker-color:${escapeHtml(t.color)}"><i class="fas fa-${escapeHtml(t.icon)}"></i></span>
          <input type="color" data-field="color" value="${escapeHtml(t.color)}" ${dis} title="Цвет">
          <input type="text" class="form-input" data-field="name" value="${escapeHtml(t.name)}" maxlength="60" ${dis}>
          ${typeRowButtons(state)}
        </div>
        <div class="world-type-grid">
          <label>Иконка <select data-field="icon" ${dis}>${Object.entries(MARKER_ICONS).map(([v, l]) => `<option value="${v}"${t.icon === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Видно ${minZoomSelect(t.minZoomRel, dis)}</label>
        </div>
      </div>`;
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
    setCurrent(instance) { current = instance; }
  };
})();
