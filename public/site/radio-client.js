// radio-client.js — клиентский контроллер интерактивного радио, медиатеки и редактора таймлайна AllTell.
(function () {
  'use strict';

  function formatDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const totalSec = Math.floor(sec);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => (n < 10 ? '0' : '') + n;
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
  }

  // ===== Состояние плеера и радио =====
  const state = {
    currentStation: null,
    currentSlot: null,
    nextSlots: [],
    prevSlots: [],
    isLiveMode: true,
    isTimeshift: false,
    audio: new Audio(),
    isPlaying: false,
    pollTimer: null,
    feedFilter: 'all',
    feedSearch: '',
    myStations: [],
    selectedStationForEdit: null,
    editorSlots: [],
    // Запись с микрофона
    mediaRecorder: null,
    recordedChunks: [],
    recordStartTime: 0,
    recordTimerInterval: null,
    audioHandlersBound: false
  };

  let dom = {};

  function queryDom() {
    return {
      tabs: document.querySelectorAll('.radio-nav-tab'),
      tabLive: document.getElementById('tabContentLive'),
      tabFeed: document.getElementById('tabContentFeed'),
      tabEditor: document.getElementById('tabContentEditor'),

      // Дека
      deckTitle: document.getElementById('deckStationTitle'),
      deckFreq: document.getElementById('deckStationFreq'),
      deckOwner: document.getElementById('deckStationOwner'),
      deckAvatar: document.getElementById('deckStationAvatar'),
      deckStatus: document.getElementById('deckStatusTag'),
      deckTrackTitle: document.getElementById('deckTrackTitle'),
      deckTrackSub: document.getElementById('deckTrackSub'),
      deckTrackType: document.getElementById('deckTrackType'),
      deckVisualizer: document.getElementById('deckVisualizer'),
      deckPlayBtn: document.getElementById('deckPlayBtn'),
      deckUnfreezeBtn: document.getElementById('deckUnfreezeBtn'),
      deckLiveSyncBtn: document.getElementById('deckLiveSyncBtn'),
      deckSkipBtn: document.getElementById('deckSkipBtn'),
      deckProgressBar: document.getElementById('deckProgressBar'),
      deckProgressFill: document.getElementById('deckProgressFill'),
      deckTimeCurrent: document.getElementById('deckTimeCurrent'),
      deckTimeRemaining: document.getElementById('deckTimeRemaining'),
      deckVolumeSlider: document.getElementById('deckVolumeSlider'),
      deckMuteBtn: document.getElementById('deckMuteBtn'),

      // Станции и лента
      stationsGrid: document.getElementById('stationsGrid'),
      btnRefreshStations: document.getElementById('btnRefreshStations'),
      tracksList: document.getElementById('tracksFeedList'),
      trackTypeFilters: document.getElementById('trackTypeFilters'),
      tracksSearchInput: document.getElementById('tracksSearchInput'),

      // Редактор
      editorSlotsList: document.getElementById('editorSlotsList'),
      editorCapacityText: document.getElementById('editorCapacityText'),
      editorCapacityFill: document.getElementById('editorCapacityFill'),
      btnSaveTimeline: document.getElementById('btnSaveTimeline'),
      btnPickFromMyTracks: document.getElementById('btnPickFromMyTracks'),
      btnUploadNewSlot: document.getElementById('btnUploadNewSlot'),
      btnToggleRecord: document.getElementById('btnToggleRecord'),
      recordTimer: document.getElementById('recordTimer'),

      // Модальные окна
      modalUploadTrack: document.getElementById('modalUploadTrack'),
      modalCreateStation: document.getElementById('modalCreateStation'),
      modalPickTrack: document.getElementById('modalPickTrack'),
      formUploadTrack: document.getElementById('formUploadTrack'),
      formCreateStation: document.getElementById('formCreateStation'),
      modalPickTrackList: document.getElementById('modalPickTrackList'),

      // Кнопки открытия модалок
      btnOpenUploadTrack: document.getElementById('btnOpenUploadTrack'),
      btnOpenCreateStation: document.getElementById('btnOpenCreateStation'),
      btnUploadTrackFromFeed: document.getElementById('btnUploadTrackFromFeed')
    };
  }

  // ===== Работа с API =====
  async function api(url, options = {}) {
    const headers = options.headers || {};
    if (window.authManager && window.authManager.getToken()) {
      headers['Authorization'] = 'Bearer ' + window.authManager.getToken();
    }
    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ===== Управление воспроизведением деки =====

  function updateDeckUI() {
    if (!dom.deckTitle) return;
    const st = state.currentStation;
    if (!st) {
      dom.deckTitle.innerHTML = '<span>Выберите станцию</span><span class="radio-freq-pill">--- FM</span>';
      if (dom.deckOwner) dom.deckOwner.textContent = 'Вещание не запущено';
      if (dom.deckStatus) {
        dom.deckStatus.className = 'radio-status-tag is-offline';
        dom.deckStatus.textContent = 'Офлайн';
      }
      if (dom.deckTrackTitle) dom.deckTrackTitle.textContent = 'Тишина в эфире';
      if (dom.deckTrackSub) dom.deckTrackSub.textContent = 'Настройтесь на активную частоту из списка ниже';
      return;
    }

    dom.deckTitle.innerHTML = `<span>${escapeHtml(st.name)}</span><span class="radio-freq-pill">${escapeHtml(st.frequency)} FM</span>`;
    if (dom.deckOwner) dom.deckOwner.textContent = `Ведущий: ${escapeHtml(st.owner_name || 'AllTell Radio')}`;

    if (dom.deckAvatar) {
      if (st.avatar_url) {
        dom.deckAvatar.innerHTML = `<img src="${escapeHtml(st.avatar_url)}" alt="">`;
      } else {
        dom.deckAvatar.innerHTML = `<i class="fas fa-broadcast-tower"></i>`;
      }
    }

    if (dom.deckStatus) {
      if (state.isTimeshift) {
        dom.deckStatus.className = 'radio-status-tag is-timeshift';
        dom.deckStatus.textContent = 'Таймшифт';
      } else if (state.currentSlot) {
        dom.deckStatus.className = 'radio-status-tag is-live';
        dom.deckStatus.textContent = 'В эфире';
      } else {
        dom.deckStatus.className = 'radio-status-tag is-offline';
        dom.deckStatus.textContent = st.fallback_mode === 'loop' ? 'Зациклено' : 'Офлайн';
      }
    }

    const slot = state.currentSlot;
    if (slot) {
      if (dom.deckTrackTitle) dom.deckTrackTitle.textContent = slot.title;
      if (dom.deckTrackType) {
        dom.deckTrackType.textContent = slot.type === 'podcast' ? 'Подкаст' : slot.type === 'speech' ? 'Слова' : 'Музыка';
        dom.deckTrackType.className = `radio-track-type-badge type-${slot.type || 'track'}`;
      }
      if (dom.deckTrackSub) dom.deckTrackSub.textContent = `Длительность: ${formatDuration(slot.duration)}`;
    } else {
      if (dom.deckTrackTitle) dom.deckTrackTitle.textContent = st.fallback_mode === 'loop' ? 'Эфир зациклен' : 'Нет запланированных треков';
      if (dom.deckTrackSub) dom.deckTrackSub.textContent = 'Ожидание выхода в эфир';
    }

    // Кнопка play
    if (dom.deckPlayBtn) {
      dom.deckPlayBtn.innerHTML = state.isPlaying ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
    }
    if (dom.deckVisualizer) {
      if (state.isPlaying) {
        dom.deckVisualizer.classList.add('is-playing');
      } else {
        dom.deckVisualizer.classList.remove('is-playing');
      }
    }

    // Состояние кнопки Live
    if (dom.deckLiveSyncBtn) {
      dom.deckLiveSyncBtn.style.display = state.isTimeshift ? 'inline-flex' : 'none';
    }
  }

  async function tuneStation(station, autoPlay = true) {
    state.currentStation = station;
    state.isTimeshift = false;
    updateDeckUI();

    try {
      const live = await api(`/api/radio/stations/${station.id}/live`);
      state.currentSlot = live.currentSlot;
      state.nextSlots = live.nextSlots || [];
      state.prevSlots = live.prevSlots || [];

      if (state.currentSlot && state.currentSlot.audioUrl) {
        state.audio.src = state.currentSlot.audioUrl;
        const offset = live.offset || 0;
        state.audio.currentTime = offset;

        if (autoPlay) {
          state.audio.play().then(() => {
            state.isPlaying = true;
            updateDeckUI();
          }).catch((err) => {
            console.warn('[radio] Autoplay blocked, click play:', err);
            state.isPlaying = false;
            updateDeckUI();
          });
        }
      } else {
        state.audio.pause();
        state.audio.src = '';
        state.isPlaying = false;
      }
      updateDeckUI();
      highlightActiveStation(station.id);
    } catch (e) {
      console.error('[radio] Tune station error:', e);
    }
  }

  function highlightActiveStation(stationId) {
    document.querySelectorAll('.radio-station-card').forEach((card) => {
      if (card.dataset.id == stationId) {
        card.classList.add('is-active-tune');
      } else {
        card.classList.remove('is-active-tune');
      }
    });
  }

  function bindAudioEvents() {
    if (state.audioHandlersBound) return;
    state.audioHandlersBound = true;

    state.audio.addEventListener('timeupdate', () => {
      if (!dom.deckTimeCurrent) return;
      const cur = state.audio.currentTime || 0;
      const dur = state.audio.duration || (state.currentSlot ? state.currentSlot.duration : 0);
      dom.deckTimeCurrent.textContent = formatDuration(cur);
      if (dom.deckTimeRemaining) dom.deckTimeRemaining.textContent = formatDuration(Math.max(0, dur - cur));

      const percent = dur > 0 ? (cur / dur) * 100 : 0;
      if (dom.deckProgressFill) dom.deckProgressFill.style.width = `${percent}%`;
    });

    state.audio.addEventListener('play', () => {
      state.isPlaying = true;
      updateDeckUI();
    });

    state.audio.addEventListener('pause', () => {
      state.isPlaying = false;
      updateDeckUI();
    });

    state.audio.addEventListener('ended', async () => {
      if (state.isTimeshift && state.nextSlots.length > 0) {
        const next = state.nextSlots.shift();
        state.prevSlots.unshift(state.currentSlot);
        state.currentSlot = next;
        state.audio.src = next.audioUrl;
        state.audio.currentTime = 0;
        state.audio.play();
        updateDeckUI();
      } else if (state.currentStation) {
        tuneStation(state.currentStation, true);
      }
    });
  }

  // ===== Каталог радиостанций =====
  async function loadStations() {
    if (!dom.stationsGrid) return;
    dom.stationsGrid.innerHTML = '<p class="alltell-state">Загружаем список радиостанций…</p>';
    try {
      const stations = await api('/api/radio/stations');
      if (!stations || stations.length === 0) {
        dom.stationsGrid.innerHTML = `
          <div style="grid-column: 1 / -1; text-align:center; padding: 40px; color:#94a3b8;">
            <i class="fas fa-radio" style="font-size:2.5rem; margin-bottom:12px; display:block; color:#64748b;"></i>
            Пока никто не занял радиочастоту. Станьте первым ведущим радиостанции!
            <div style="margin-top:16px;">
              <button class="btn btn-primary" id="btnEmptyCreateStation"><i class="fas fa-plus"></i> Занять частоту</button>
            </div>
          </div>
        `;
        document.getElementById('btnEmptyCreateStation')?.addEventListener('click', () => {
          openCreateStationModal();
        });
        return;
      }

      dom.stationsGrid.innerHTML = stations.map((st) => `
        <div class="radio-station-card ${state.currentStation && state.currentStation.id === st.id ? 'is-active-tune' : ''}" data-id="${st.id}">
          <div>
            <div class="radio-card-top">
              <div class="radio-card-avatar">
                ${st.avatar_url ? `<img src="${escapeHtml(st.avatar_url)}" alt="">` : '<i class="fas fa-broadcast-tower"></i>'}
              </div>
              <div class="radio-card-meta">
                <h3><span>${escapeHtml(st.name)}</span> <span class="radio-freq-pill">${escapeHtml(st.frequency)} FM</span></h3>
                <div class="radio-card-owner">Ведущий: ${escapeHtml(st.owner_name)}</div>
              </div>
            </div>
            ${st.description ? `<p style="font-size:0.85rem; color:#94a3b8; margin:6px 0 10px;">${escapeHtml(st.description)}</p>` : ''}
          </div>
          <div>
            <div class="radio-card-playing">
              <i class="fas fa-compact-disc ${st.isLive ? 'fa-spin' : ''}" style="color:${st.isLive ? '#2ed573' : '#94a3b8'};"></i>
              <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                ${st.currentTrack ? escapeHtml(st.currentTrack.title) : (st.fallback_mode === 'loop' ? 'Эфир зациклен' : 'Офлайн')}
              </span>
            </div>
          </div>
        </div>
      `).join('');

      dom.stationsGrid.querySelectorAll('.radio-station-card').forEach((card) => {
        card.addEventListener('click', () => {
          const id = card.dataset.id;
          const found = stations.find((s) => s.id == id);
          if (found) tuneStation(found, true);
        });
      });

      if (!state.currentStation && stations.length > 0) {
        tuneStation(stations[0], false);
      }
    } catch (e) {
      if (dom.stationsGrid) {
        dom.stationsGrid.innerHTML = `<p class="alltell-error">Ошибка загрузки станций: ${escapeHtml(e.message)}</p>`;
      }
    }
  }

  // ===== Лента треков и подкастов =====
  async function loadTracks() {
    if (!dom.tracksList) return;
    dom.tracksList.innerHTML = '<p class="alltell-state">Загружаем аудиозаписи…</p>';
    try {
      const query = new URLSearchParams();
      if (state.feedFilter && state.feedFilter !== 'all') query.set('type', state.feedFilter);
      if (state.feedSearch) query.set('search', state.feedSearch);

      const data = await api(`/api/radio/tracks?${query.toString()}`);
      if (!data.tracks || data.tracks.length === 0) {
        dom.tracksList.innerHTML = `
          <div style="text-align:center; padding:40px; color:#94a3b8;">
            <i class="fas fa-music" style="font-size:2rem; margin-bottom:12px; display:block; color:#64748b;"></i>
            Аудиозаписи не найдены. Опубликуйте свой трек или подкаст!
          </div>
        `;
        return;
      }

      dom.tracksList.innerHTML = data.tracks.map((t) => `
        <div class="radio-track-item" data-id="${t.id}">
          <div class="radio-track-left">
            <button type="button" class="radio-track-play-btn" data-url="${escapeHtml(t.audio_url)}" data-title="${escapeHtml(t.title)}" data-type="${escapeHtml(t.type)}" title="Воспроизвести">
              <i class="fas fa-play"></i>
            </button>
            <div class="radio-track-info">
              <div class="radio-track-title">${escapeHtml(t.title)}</div>
              <div class="radio-track-author">
                <i class="fas fa-user-circle"></i> ${escapeHtml(t.author_name)} • 
                <span class="radio-track-type-badge type-${t.type}">${t.type === 'podcast' ? 'Подкаст' : t.type === 'speech' ? 'Слова' : 'Музыка'}</span> • 
                <span>${escapeHtml(String(t.format || 'mp3').toUpperCase())}</span>
              </div>
            </div>
          </div>
          <div class="radio-track-right">
            <span class="radio-track-duration">${formatDuration(t.duration)}</span>
            <button type="button" class="radio-action-btn btn-add-to-timeline" data-id="${t.id}" data-url="${escapeHtml(t.audio_url)}" data-title="${escapeHtml(t.title)}" data-duration="${t.duration}" data-type="${t.type}" title="Добавить в сетку эфира">
              <i class="fas fa-calendar-plus"></i> В эфир
            </button>
          </div>
        </div>
      `).join('');

      dom.tracksList.querySelectorAll('.radio-track-play-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const url = btn.dataset.url;
          state.currentSlot = {
            title: btn.dataset.title,
            type: btn.dataset.type,
            audioUrl: url,
            duration: 0
          };
          state.isTimeshift = true;
          state.audio.src = url;
          state.audio.play();
          updateDeckUI();
        });
      });

      dom.tracksList.querySelectorAll('.btn-add-to-timeline').forEach((btn) => {
        btn.addEventListener('click', () => {
          const slot = {
            track_id: btn.dataset.id,
            title: btn.dataset.title,
            audio_url: btn.dataset.url,
            duration: parseFloat(btn.dataset.duration) || 180,
            type: btn.dataset.type || 'track'
          };
          addSlotToEditor(slot);
          alert(`Запись "${slot.title}" добавлена в сетку вещания! Перейдите во вкладку "Редактор эфира" для публикации.`);
        });
      });
    } catch (e) {
      if (dom.tracksList) {
        dom.tracksList.innerHTML = `<p class="alltell-error">Ошибка загрузки треков: ${escapeHtml(e.message)}</p>`;
      }
    }
  }

  // ===== Редактор ленты времени (24 часа) =====

  async function initEditor() {
    if (!dom.editorSlotsList) return;
    const user = window.authManager && window.authManager.getUser();
    if (!user) {
      dom.editorSlotsList.innerHTML = `
        <div style="text-align:center; padding:40px; color:#94a3b8;">
          <i class="fas fa-lock" style="font-size:2rem; margin-bottom:12px; display:block; color:#64748b;"></i>
          Для управления радиостанцией и редактирования эфирной сетки необходимо авторизоваться.
        </div>
      `;
      return;
    }

    try {
      const allStations = await api('/api/radio/stations');
      state.myStations = allStations.filter((s) => s.owner_id === user.id);

      if (state.myStations.length === 0) {
        dom.editorSlotsList.innerHTML = `
          <div style="text-align:center; padding:40px; color:#94a3b8;">
            <i class="fas fa-tower-broadcast" style="font-size:2.5rem; margin-bottom:12px; display:block; color:#64748b;"></i>
            У вас пока нет зарегистрированной радиостанции. Займите свободную частоту прямо сейчас!
            <div style="margin-top:16px;">
              <button class="btn btn-primary" id="btnCreateFirstStation"><i class="fas fa-plus"></i> Занять частоту</button>
            </div>
          </div>
        `;
        document.getElementById('btnCreateFirstStation')?.addEventListener('click', () => {
          openCreateStationModal();
        });
        return;
      }

      state.selectedStationForEdit = state.myStations[0];
      loadStationTimeline(state.selectedStationForEdit.id);
    } catch (e) {
      if (dom.editorSlotsList) {
        dom.editorSlotsList.innerHTML = `<p class="alltell-error">Ошибка инициализации редактора: ${escapeHtml(e.message)}</p>`;
      }
    }
  }

  async function loadStationTimeline(stationId) {
    try {
      const slots = await api(`/api/radio/stations/${stationId}/timeline`);
      state.editorSlots = (slots || []).map((s) => ({
        track_id: s.track_id,
        title: s.title,
        audio_url: s.audio_url,
        duration: Number(s.duration) || 0,
        type: s.type || 'track'
      }));
      renderEditorSlots();
    } catch (e) {
      console.error('[radio] Error loading timeline:', e);
    }
  }

  function renderEditorSlots() {
    if (!dom.editorSlotsList) return;
    if (state.editorSlots.length === 0) {
      dom.editorSlotsList.innerHTML = `
        <p style="color:#94a3b8; text-align:center; padding:30px;">
          Сетка пуста. Добавьте треки из медиатеки, загрузите файл или запишите голос с микрофона.
        </p>
      `;
      updateCapacityUI();
      return;
    }

    dom.editorSlotsList.innerHTML = state.editorSlots.map((slot, index) => `
      <div class="radio-slot-item" data-index="${index}">
        <div style="display:flex; align-items:center; gap:12px; flex:1; min-width:0;">
          <span class="radio-slot-order">${index + 1}</span>
          <span class="radio-track-type-badge type-${slot.type}">${slot.type === 'podcast' ? 'Подкаст' : slot.type === 'speech' ? 'Слова' : 'Трек'}</span>
          <span style="font-weight:600; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(slot.title)}</span>
        </div>
        <div class="radio-slot-actions">
          <span style="font-size:0.85rem; color:#94a3b8; font-family:monospace; margin-right:8px;">${formatDuration(slot.duration)}</span>
          <button type="button" class="radio-slot-action-btn btn-slot-up" data-index="${index}" title="Сдвинуть вверх" ${index === 0 ? 'disabled style="opacity:0.3;"' : ''}>
            <i class="fas fa-arrow-up"></i>
          </button>
          <button type="button" class="radio-slot-action-btn btn-slot-down" data-index="${index}" title="Сдвинуть вниз" ${index === state.editorSlots.length - 1 ? 'disabled style="opacity:0.3;"' : ''}>
            <i class="fas fa-arrow-down"></i>
          </button>
          <button type="button" class="radio-slot-action-btn delete-btn btn-slot-delete" data-index="${index}" title="Удалить из сетки">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>
    `).join('');

    dom.editorSlotsList.querySelectorAll('.btn-slot-up').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.index, 10);
        if (i > 0) {
          const temp = state.editorSlots[i];
          state.editorSlots[i] = state.editorSlots[i - 1];
          state.editorSlots[i - 1] = temp;
          renderEditorSlots();
        }
      });
    });

    dom.editorSlotsList.querySelectorAll('.btn-slot-down').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.index, 10);
        if (i < state.editorSlots.length - 1) {
          const temp = state.editorSlots[i];
          state.editorSlots[i] = state.editorSlots[i + 1];
          state.editorSlots[i + 1] = temp;
          renderEditorSlots();
        }
      });
    });

    dom.editorSlotsList.querySelectorAll('.btn-slot-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.index, 10);
        state.editorSlots.splice(i, 1);
        renderEditorSlots();
      });
    });

    updateCapacityUI();
  }

  function addSlotToEditor(slot) {
    state.editorSlots.push(slot);
    renderEditorSlots();
  }

  function updateCapacityUI() {
    if (!dom.editorCapacityText || !dom.editorCapacityFill) return;
    const totalSec = state.editorSlots.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
    const maxSec = 24 * 3600;
    const percent = Math.min(100, (totalSec / maxSec) * 100);

    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec % 60);
    const pad = (n) => (n < 10 ? '0' : '') + n;

    dom.editorCapacityText.textContent = `${pad(h)}:${pad(m)}:${pad(s)} / 24:00:00`;
    dom.editorCapacityFill.style.width = `${percent}%`;

    if (totalSec >= maxSec) {
      dom.editorCapacityFill.style.background = '#ff4757';
    } else {
      dom.editorCapacityFill.style.background = '#2ed573';
    }
  }

  // ===== Открытие / закрытие модалок =====
  function openUploadModal() {
    const user = window.authManager && window.authManager.getUser();
    if (!user) {
      alert('Для загрузки аудиозаписей необходимо войти в аккаунт AllTell');
      return;
    }
    const modal = document.getElementById('modalUploadTrack');
    if (modal) modal.hidden = false;
  }

  function openCreateStationModal() {
    const user = window.authManager && window.authManager.getUser();
    if (!user) {
      alert('Для занятия радиочастоты необходимо войти в аккаунт AllTell');
      return;
    }
    const modal = document.getElementById('modalCreateStation');
    if (modal) modal.hidden = false;
  }

  // ===== Главная инициализация страницы =====
  function init() {
    dom = queryDom();
    if (!dom.deckPlayBtn) return null; // Не на странице радио

    bindAudioEvents();

    // 1. Табы
    dom.tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        dom.tabs.forEach((t) => t.classList.remove('is-active'));
        tab.classList.add('is-active');

        const tabName = tab.dataset.tab;
        if (dom.tabLive) dom.tabLive.hidden = tabName !== 'live';
        if (dom.tabFeed) dom.tabFeed.hidden = tabName !== 'feed';
        if (dom.tabEditor) dom.tabEditor.hidden = tabName !== 'editor';

        if (tabName === 'live') loadStations();
        if (tabName === 'feed') loadTracks();
        if (tabName === 'editor') initEditor();
      });
    });

    // 2. Управление декой
    dom.deckPlayBtn?.addEventListener('click', () => {
      if (!state.currentStation) {
        const firstCard = document.querySelector('.radio-station-card');
        if (firstCard) firstCard.click();
        return;
      }
      if (state.isPlaying) {
        state.audio.pause();
      } else {
        state.audio.play();
      }
    });

    dom.deckUnfreezeBtn?.addEventListener('click', () => {
      if (!state.currentSlot) return;
      state.audio.currentTime = 0;
      state.isTimeshift = true;
      updateDeckUI();
      if (!state.isPlaying) state.audio.play();
    });

    dom.deckLiveSyncBtn?.addEventListener('click', () => {
      if (!state.currentStation) return;
      tuneStation(state.currentStation, true);
    });

    dom.deckSkipBtn?.addEventListener('click', () => {
      if (state.nextSlots.length > 0) {
        const next = state.nextSlots.shift();
        state.prevSlots.unshift(state.currentSlot);
        state.currentSlot = next;
        state.isTimeshift = true;
        state.audio.src = next.audioUrl;
        state.audio.currentTime = 0;
        state.audio.play();
        updateDeckUI();
      } else if (state.currentStation) {
        tuneStation(state.currentStation, true);
      }
    });

    dom.deckProgressBar?.addEventListener('click', (e) => {
      const rect = dom.deckProgressBar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const dur = state.audio.duration || (state.currentSlot ? state.currentSlot.duration : 0);
      if (dur > 0) {
        state.audio.currentTime = ratio * dur;
        state.isTimeshift = true;
        updateDeckUI();
      }
    });

    dom.deckVolumeSlider?.addEventListener('input', (e) => {
      state.audio.volume = parseFloat(e.target.value);
    });

    dom.deckMuteBtn?.addEventListener('click', () => {
      state.audio.muted = !state.audio.muted;
      if (dom.deckMuteBtn) {
        dom.deckMuteBtn.innerHTML = state.audio.muted ? '<i class="fas fa-volume-xmark"></i>' : '<i class="fas fa-volume-high"></i>';
      }
    });

    dom.btnRefreshStations?.addEventListener('click', loadStations);

    // 3. Фильтры и поиск медиатеки
    dom.trackTypeFilters?.querySelectorAll('.radio-filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        dom.trackTypeFilters?.querySelectorAll('.radio-filter-btn').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        state.feedFilter = btn.dataset.type;
        loadTracks();
      });
    });

    let searchTimeout = null;
    dom.tracksSearchInput?.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        state.feedSearch = e.target.value.trim();
        loadTracks();
      }, 300);
    });

    // 4. Редактор сетки
    dom.btnSaveTimeline?.addEventListener('click', async () => {
      if (!state.selectedStationForEdit) {
        alert('Выберите радиостанцию');
        return;
      }
      if (state.editorSlots.length === 0) {
        alert('Сетка пуста. Добавьте хотя бы один трек.');
        return;
      }

      try {
        dom.btnSaveTimeline.disabled = true;
        dom.btnSaveTimeline.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Сохраняем…';

        await api(`/api/radio/stations/${state.selectedStationForEdit.id}/timeline`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slots: state.editorSlots })
        });

        alert('Сетка вещания успешно опубликована на 24 часа! Эфир обновлен.');
        loadStations();
      } catch (e) {
        alert('Ошибка сохранения сетки: ' + e.message);
      } finally {
        if (dom.btnSaveTimeline) {
          dom.btnSaveTimeline.disabled = false;
          dom.btnSaveTimeline.innerHTML = '<i class="fas fa-tower-broadcast"></i> Опубликовать в эфир (24ч)';
        }
      }
    });

    // Запись с микрофона
    dom.btnToggleRecord?.addEventListener('click', async () => {
      if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
        state.mediaRecorder.stop();
        clearInterval(state.recordTimerInterval);
        dom.btnToggleRecord.classList.remove('is-recording');
        dom.btnToggleRecord.innerHTML = '<i class="fas fa-circle"></i> Начать запись';
        if (dom.recordTimer) dom.recordTimer.style.display = 'none';
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        state.recordedChunks = [];
        state.mediaRecorder = new MediaRecorder(stream);

        state.mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) state.recordedChunks.push(e.data);
        };

        state.mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(state.recordedChunks, { type: 'audio/webm' });
          const file = new File([audioBlob], `speech-${Date.now()}.webm`, { type: 'audio/webm' });

          const formData = new FormData();
          formData.append('audio', file);

          if (dom.btnToggleRecord) {
            dom.btnToggleRecord.disabled = true;
            dom.btnToggleRecord.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Обработка…';
          }

          try {
            const res = await api('/api/upload-audio', {
              method: 'POST',
              body: formData
            });

            const tempAudio = new Audio(res.url);
            tempAudio.addEventListener('loadedmetadata', () => {
              const dur = Math.round(tempAudio.duration) || 5;
              addSlotToEditor({
                title: `Слова ведущего (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`,
                type: 'speech',
                audio_url: res.url,
                duration: dur
              });
            });
          } catch (uploadErr) {
            alert('Не удалось загрузить аудиозапись с микрофона: ' + uploadErr.message);
          } finally {
            if (dom.btnToggleRecord) {
              dom.btnToggleRecord.disabled = false;
              dom.btnToggleRecord.innerHTML = '<i class="fas fa-circle"></i> Начать запись';
            }
          }
        };

        state.mediaRecorder.start();
        state.recordStartTime = Date.now();
        if (dom.recordTimer) {
          dom.recordTimer.style.display = 'inline';
          dom.recordTimer.textContent = '00:00';
        }
        dom.btnToggleRecord.classList.add('is-recording');
        dom.btnToggleRecord.innerHTML = '<i class="fas fa-stop"></i> Завершить';

        state.recordTimerInterval = setInterval(() => {
          const sec = Math.floor((Date.now() - state.recordStartTime) / 1000);
          if (dom.recordTimer) dom.recordTimer.textContent = formatDuration(sec);
        }, 500);

      } catch (err) {
        alert('Ошибка доступа к микрофону: ' + err.message);
      }
    });

    // Загрузка файла в сетку
    dom.btnUploadNewSlot?.addEventListener('click', () => {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'audio/*';
      fileInput.onchange = async () => {
        const file = fileInput.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append('audio', file);

        try {
          const uploadRes = await api('/api/upload-audio', {
            method: 'POST',
            body: formData
          });

          const tempAudio = new Audio(uploadRes.url);
          tempAudio.addEventListener('loadedmetadata', () => {
            const dur = Math.round(tempAudio.duration) || 180;
            addSlotToEditor({
              title: uploadRes.title || file.name,
              type: 'track',
              audio_url: uploadRes.url,
              duration: dur
            });
          });
        } catch (e) {
          alert('Ошибка загрузки файла: ' + e.message);
        }
      };
      fileInput.click();
    });

    // Выбор из медиатеки
    dom.btnPickFromMyTracks?.addEventListener('click', async () => {
      const modal = document.getElementById('modalPickTrack');
      const list = document.getElementById('modalPickTrackList');
      if (modal) modal.hidden = false;
      if (list) list.innerHTML = '<p class="alltell-state">Загружаем ваши аудиозаписи…</p>';
      try {
        const data = await api('/api/radio/tracks?limit=100');
        if (!data.tracks || data.tracks.length === 0) {
          if (list) list.innerHTML = '<p style="text-align:center; color:#94a3b8;">В медиатеке пока нет записей.</p>';
          return;
        }
        if (list) {
          list.innerHTML = data.tracks.map((t) => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#12141a; border-radius:10px; margin-bottom:8px;">
              <div>
                <strong style="color:#fff; display:block;">${escapeHtml(t.title)}</strong>
                <span style="font-size:0.8rem; color:#94a3b8;">${escapeHtml(t.author_name)} • ${formatDuration(t.duration)}</span>
              </div>
              <button type="button" class="btn btn-primary btn-sm btn-pick-item" data-id="${t.id}" data-title="${escapeHtml(t.title)}" data-url="${escapeHtml(t.audio_url)}" data-duration="${t.duration}" data-type="${t.type}">
                Выбрать
              </button>
            </div>
          `).join('');

          list.querySelectorAll('.btn-pick-item').forEach((b) => {
            b.addEventListener('click', () => {
              addSlotToEditor({
                track_id: b.dataset.id,
                title: b.dataset.title,
                audio_url: b.dataset.url,
                duration: parseFloat(b.dataset.duration) || 180,
                type: b.dataset.type || 'track'
              });
              if (modal) modal.hidden = true;
            });
          });
        }
      } catch (e) {
        if (list) list.innerHTML = `<p class="alltell-error">${escapeHtml(e.message)}</p>`;
      }
    });

    // 5. Модальные окна: открытие и закрытие
    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const modalId = btn.dataset.close;
        const target = document.getElementById(modalId);
        if (target) target.hidden = true;
      });
    });

    document.querySelectorAll('.radio-modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
          backdrop.hidden = true;
        }
      });
    });

    dom.btnOpenUploadTrack?.addEventListener('click', openUploadModal);
    dom.btnUploadTrackFromFeed?.addEventListener('click', openUploadModal);
    dom.btnOpenCreateStation?.addEventListener('click', openCreateStationModal);

    // Отправка формы загрузки трека
    dom.formUploadTrack?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = document.getElementById('trackFileInput')?.files[0];
      const title = document.getElementById('trackTitleInput')?.value.trim();
      const type = document.getElementById('trackTypeSelect')?.value;
      const submitBtn = document.getElementById('btnSubmitUploadTrack');

      if (!file) return;

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Загрузка аудиофайла…';
      }

      try {
        const formData = new FormData();
        formData.append('audio', file);

        const uploadRes = await api('/api/upload-audio', {
          method: 'POST',
          body: formData
        });

        const tempAudio = new Audio(uploadRes.url);
        await new Promise((res) => {
          tempAudio.addEventListener('loadedmetadata', res);
          tempAudio.addEventListener('error', res);
          setTimeout(res, 2000);
        });

        const dur = Math.round(tempAudio.duration) || 0;

        await api('/api/radio/tracks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title || uploadRes.title,
            audioUrl: uploadRes.url,
            duration: dur,
            size: uploadRes.size || file.size,
            format: uploadRes.format || 'mp3',
            type
          })
        });

        alert('Аудиозапись успешно опубликована!');
        dom.formUploadTrack?.reset();
        const modal = document.getElementById('modalUploadTrack');
        if (modal) modal.hidden = true;
        loadTracks();
      } catch (err) {
        alert('Ошибка публикации аудиозаписи: ' + err.message);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = 'Опубликовать';
        }
      }
    });

    // Отправка формы создания станции
    dom.formCreateStation?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const freq = document.getElementById('stationFreqInput')?.value;
      const name = document.getElementById('stationNameInput')?.value.trim();
      const desc = document.getElementById('stationDescInput')?.value.trim();
      const fallback = document.getElementById('stationFallbackSelect')?.value;
      const submitBtn = document.getElementById('btnSubmitCreateStation');

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Регистрация частоты…';
      }

      try {
        const newStation = await api('/api/radio/stations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            frequency: freq,
            name,
            description: desc,
            fallbackMode: fallback
          })
        });

        alert(`Поздравляем! Частота ${newStation.frequency} FM успешно занята вашей радиостанцией "${newStation.name}".`);
        dom.formCreateStation?.reset();
        const modal = document.getElementById('modalCreateStation');
        if (modal) modal.hidden = true;
        loadStations();
        document.getElementById('tabEditorBtn')?.click();
      } catch (err) {
        alert('Ошибка создания радиостанции: ' + err.message);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = 'Занять частоту';
        }
      }
    });

    // Загрузка начальных данных
    loadStations();
    loadTracks();

    // Синхронизация прямого эфира каждые 30 секунд
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      if (state.currentStation && state.isLiveMode && !state.isTimeshift) {
        tuneStation(state.currentStation, state.isPlaying);
      }
    }, 30000);

    window.RadioClient._mounted = true;

    return function cleanup() {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
        state.mediaRecorder.stop();
      }
      clearInterval(state.recordTimerInterval);
      state.audio.pause();
      state.audio.src = '';
      state.isPlaying = false;
      window.RadioClient._mounted = false;
    };
  }

  window.RadioClient = {
    _mounted: false,
    init,
    cleanup() {
      if (window.RadioClient._mounted) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        state.audio.pause();
        state.audio.src = '';
        state.isPlaying = false;
        window.RadioClient._mounted = false;
      }
    }
  };

  // Автозапуск при прямой загрузке страницы /radio (без SPA перехода)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (document.body.getAttribute('data-page') === 'radio' && !window.RadioClient._mounted) {
        window.RadioClient.init();
      }
    });
  } else {
    if (document.body.getAttribute('data-page') === 'radio' && !window.RadioClient._mounted) {
      window.RadioClient.init();
    }
  }
})();
