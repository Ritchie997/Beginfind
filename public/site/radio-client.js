// radio-client.js — клиентский контроллер интерактивного радио, медиатеки и редактора таймлайна AllTell.
// Интегрирован с синглтоном AllTellGlobalRadio для непрерывного воспроизведения между разделами и админ-панелью.
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

  function formatClockTime(dateOrMs) {
    const d = new Date(dateOrMs);
    const pad = (n) => (n < 10 ? '0' : '') + n;
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
  }

  // Получение глобального аудиоплеера
  function getGlobalAudio() {
    return window.AllTellGlobalRadio;
  }

  // ===== Состояние страницы Радио =====
  const state = {
    currentStation: null,
    currentSlot: null,
    nextSlots: [],
    prevSlots: [],
    isLiveMode: true,
    isTimeshift: false,
    pollTimer: null,
    feedFilter: 'all',
    feedSearch: '',
    myStations: [],
    selectedStationForEdit: null,
    editorSlots: [],
    editorStartTime: null,
    // Запись с микрофона в редакторе
    mediaRecorder: null,
    recordedChunks: [],
    recordStartTime: 0,
    recordTimerInterval: null,
    globalUnsub: null
  };

  let dom = {};

  function queryDom() {
    return {
      navTabs: document.getElementById('radioNavTabs'),
      tabs: document.querySelectorAll('.radio-nav-tab'),
      tabLive: document.getElementById('tabContentLive'),
      tabFeed: document.getElementById('tabContentFeed'),
      tabEditor: document.getElementById('tabContentEditor'),

      // Страница отдельного трека
      trackView: document.getElementById('radioTrackView'),
      btnBackFromTrackView: document.getElementById('btnBackFromTrackView'),
      trackPageCover: document.getElementById('trackPageCover'),
      trackPageTypeBadge: document.getElementById('trackPageTypeBadge'),
      trackPageFormatPill: document.getElementById('trackPageFormatPill'),
      trackPageTitle: document.getElementById('trackPageTitle'),
      trackPageAuthorWrap: document.getElementById('trackPageAuthorWrap'),
      trackPageAuthorLink: document.getElementById('trackPageAuthorLink'),
      trackPageDuration: document.getElementById('trackPageDuration'),
      trackPageSize: document.getElementById('trackPageSize'),
      trackPageDate: document.getElementById('trackPageDate'),
      trackPagePlayBtn: document.getElementById('trackPagePlayBtn'),
      trackPageProgressBar: document.getElementById('trackPageProgressBar'),
      trackPageProgressFill: document.getElementById('trackPageProgressFill'),
      trackPageCurrentTime: document.getElementById('trackPageCurrentTime'),
      trackPageTotalDuration: document.getElementById('trackPageTotalDuration'),
      trackPageLoopBtn: document.getElementById('trackPageLoopBtn'),
      trackPageMuteBtn: document.getElementById('trackPageMuteBtn'),
      trackPageVolumeSlider: document.getElementById('trackPageVolumeSlider'),
      trackPageAddToEditorBtn: document.getElementById('trackPageAddToEditorBtn'),
      trackPageDownloadBtn: document.getElementById('trackPageDownloadBtn'),
      trackPageShareBtn: document.getElementById('trackPageShareBtn'),
      trackPageDeleteBtn: document.getElementById('trackPageDeleteBtn'),

      // Главная эфирная дека
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

      // Редактор сетки
      editorStationSelect: document.getElementById('editorStationSelect'),
      editorBroadcastStartTime: document.getElementById('editorBroadcastStartTime'),
      btnSetStartTimeNow: document.getElementById('btnSetStartTimeNow'),
      btnClearTimelineBtn: document.getElementById('btnClearTimelineBtn'),
      btnReleaseStationBtn: document.getElementById('btnReleaseStationBtn'),
      editorSlotsList: document.getElementById('editorSlotsList'),
      editorCapacityText: document.getElementById('editorCapacityText'),
      editorCapacityFill: document.getElementById('editorCapacityFill'),
      btnSaveTimeline: document.getElementById('btnSaveTimeline'),
      btnPickFromMyTracks: document.getElementById('btnPickFromMyTracks'),
      btnUploadPlaylist: document.getElementById('btnUploadPlaylist'),
      btnUploadNewSlot: document.getElementById('btnUploadNewSlot'),
      btnOpenInsertWordsModal: document.getElementById('btnOpenInsertWordsModal'),
      btnToggleRecord: document.getElementById('btnToggleRecord'),
      recordTimer: document.getElementById('recordTimer'),

      // Модальные окна
      modalUploadTrack: document.getElementById('modalUploadTrack'),
      modalCreateStation: document.getElementById('modalCreateStation'),
      modalPickTrack: document.getElementById('modalPickTrack'),
      modalInsertWordsByTime: document.getElementById('modalInsertWordsByTime'),
      modalPlaylistProgress: document.getElementById('modalPlaylistProgress'),
      formUploadTrack: document.getElementById('formUploadTrack'),
      formCreateStation: document.getElementById('formCreateStation'),
      modalPickTrackList: document.getElementById('modalPickTrackList'),
      pickTrackSelectAll: document.getElementById('pickTrackSelectAll'),
      btnPickTracksBatch: document.getElementById('btnPickTracksBatch'),

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

  // ===== 1. Управление воспроизведением деки прямого эфира =====

  function updateDeckUI() {
    if (!dom.deckTitle) return;
    const globalAudio = getGlobalAudio();
    const gState = globalAudio ? globalAudio.getState() : {};
    const st = state.currentStation || gState.station;

    if (!st) {
      dom.deckTitle.innerHTML = '<span>Выберите станцию</span><span class="radio-freq-pill">--- FM</span>';
      if (dom.deckOwner) dom.deckOwner.textContent = 'Вещание не запущено';
      if (dom.deckStatus) {
        dom.deckStatus.className = 'radio-status-tag is-offline';
        dom.deckStatus.textContent = 'Офлайн';
      }
      if (dom.deckTrackTitle) dom.deckTrackTitle.textContent = 'Тишина в эфире';
      if (dom.deckTrackSub) dom.deckTrackSub.textContent = 'Настройтесь на активную частоту ниже';
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

    const slot = state.currentSlot || gState.currentSlot;

    if (dom.deckStatus) {
      if (state.isTimeshift) {
        dom.deckStatus.className = 'radio-status-tag is-timeshift';
        dom.deckStatus.textContent = 'Таймшифт';
      } else if (slot) {
        dom.deckStatus.className = 'radio-status-tag is-live';
        dom.deckStatus.textContent = 'В эфире';
      } else {
        dom.deckStatus.className = 'radio-status-tag is-offline';
        dom.deckStatus.textContent = st.fallback_mode === 'loop' ? 'Зациклено' : 'Офлайн';
      }
    }

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

    const isPlaying = gState.isPlaying && (gState.mode === 'radio' && gState.station && gState.station.id === st.id);

    if (dom.deckPlayBtn) {
      dom.deckPlayBtn.innerHTML = isPlaying ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
    }
    if (dom.deckVisualizer) {
      if (isPlaying) {
        dom.deckVisualizer.classList.add('is-playing');
      } else {
        dom.deckVisualizer.classList.remove('is-playing');
      }
    }

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

      const globalAudio = getGlobalAudio();
      if (globalAudio) {
        if (state.currentSlot && state.currentSlot.audioUrl) {
          globalAudio.playRadio(station, state.currentSlot, live.offset || 0);
        } else {
          globalAudio.playRadio(station, null, 0);
        }
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

  // ===== 2. Каталог радиостанций =====
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
        document.getElementById('btnEmptyCreateStation')?.addEventListener('click', openCreateStationModal);
        return;
      }

      const globalAudio = getGlobalAudio();
      const gState = globalAudio ? globalAudio.getState() : {};
      const activeStationId = (state.currentStation && state.currentStation.id) || (gState.station && gState.station.id);

      dom.stationsGrid.innerHTML = stations.map((st) => `
        <div class="radio-station-card ${activeStationId === st.id ? 'is-active-tune' : ''}" data-id="${st.id}">
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
        if (gState.station) {
          state.currentStation = gState.station;
          updateDeckUI();
          highlightActiveStation(gState.station.id);
        } else {
          tuneStation(stations[0], false);
        }
      }
    } catch (e) {
      if (dom.stationsGrid) {
        dom.stationsGrid.innerHTML = `<p class="alltell-error">Ошибка загрузки станций: ${escapeHtml(e.message)}</p>`;
      }
    }
  }

  // ===== 3. Лента треков и подкастов =====
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

      const globalAudio = getGlobalAudio();
      const gState = globalAudio ? globalAudio.getState() : {};

      dom.tracksList.innerHTML = data.tracks.map((t, idx) => {
        const isThisPlaying = gState.isPlaying && gState.track && gState.track.id === t.id;
        return `
          <div class="radio-track-item ${isThisPlaying ? 'is-playing-now' : ''}" data-id="${t.id}" data-index="${idx}">
            <div class="radio-track-left">
              <button type="button" class="radio-track-play-btn" data-index="${idx}" title="Воспроизвести">
                <i class="fas ${isThisPlaying ? 'fa-pause' : 'fa-play'}"></i>
              </button>
              <div class="radio-track-cover-mini btn-open-track-detail" data-id="${t.id}" style="width:40px; height:40px; border-radius:8px; overflow:hidden; background:#12141a; display:flex; align-items:center; justify-content:center; cursor:pointer;">
                ${t.cover_url ? `<img src="${escapeHtml(t.cover_url)}" style="width:100%; height:100%; object-fit:cover;">` : '<i class="fas fa-music" style="color:#64748b;"></i>'}
              </div>
              <div class="radio-track-info">
                <div class="radio-track-title btn-open-track-detail" data-id="${t.id}" style="cursor:pointer;" title="Открыть страницу трека">${escapeHtml(t.title)}</div>
                <div class="radio-track-author">
                  <i class="fas fa-user-circle"></i> ${escapeHtml(t.author_name)} • 
                  <span class="radio-track-type-badge type-${t.type}">${t.type === 'podcast' ? 'Подкаст' : t.type === 'speech' ? 'Слова' : 'Музыка'}</span> • 
                  <span>${escapeHtml(String(t.format || 'mp3').toUpperCase())}</span>
                </div>
              </div>
            </div>
            <div class="radio-track-right">
              <span class="radio-track-duration">${formatDuration(t.duration)}</span>
              <button type="button" class="radio-action-btn btn-open-track-detail" data-id="${t.id}" title="Страница трека">
                <i class="fas fa-arrow-up-right-from-square"></i>
              </button>
              <button type="button" class="radio-action-btn btn-add-to-timeline" data-id="${t.id}" data-url="${escapeHtml(t.audio_url)}" data-title="${escapeHtml(t.title)}" data-duration="${t.duration}" data-type="${t.type}" title="Добавить в сетку эфира">
                <i class="fas fa-calendar-plus"></i> В эфир
              </button>
            </div>
          </div>
        `;
      }).join('');

      // Клик по Play: воспроизводит трек через глобальный плеер AllTell
      dom.tracksList.querySelectorAll('.radio-track-play-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.dataset.index, 10);
          const t = data.tracks[idx];
          if (!t) return;

          const gAudio = getGlobalAudio();
          if (!gAudio) return;
          const curr = gAudio.getState();

          if (curr.isPlaying && curr.track && curr.track.id === t.id) {
            gAudio.pause();
          } else {
            gAudio.playTrack(t, data.tracks, idx);
          }
        });
      });

      // Клик по названию или обложке: открывает отдельную страницу трека
      dom.tracksList.querySelectorAll('.btn-open-track-detail').forEach((el) => {
        el.addEventListener('click', () => {
          openTrackPage(el.dataset.id);
        });
      });

      // Добавить в эфир
      dom.tracksList.querySelectorAll('.btn-add-to-timeline').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const slot = {
            track_id: btn.dataset.id,
            title: btn.dataset.title,
            audio_url: btn.dataset.url,
            duration: parseFloat(btn.dataset.duration) || 180,
            type: btn.dataset.type || 'track'
          };
          addSlotToEditor(slot);
          showToast(`Запись «${slot.title}» добавлена в сетку вещания`, 'success');
        });
      });
    } catch (e) {
      if (dom.tracksList) {
        dom.tracksList.innerHTML = `<p class="alltell-error">Ошибка загрузки треков: ${escapeHtml(e.message)}</p>`;
      }
    }
  }

  function updateFeedPlayButtons() {
    const globalAudio = getGlobalAudio();
    const gState = globalAudio ? globalAudio.getState() : {};

    document.querySelectorAll('.radio-track-item').forEach((item) => {
      const id = item.dataset.id;
      const btn = item.querySelector('.radio-track-play-btn');
      if (!btn) return;
      if (gState.track && gState.track.id == id && gState.isPlaying) {
        btn.innerHTML = '<i class="fas fa-pause"></i>';
        item.classList.add('is-playing-now');
      } else {
        btn.innerHTML = '<i class="fas fa-play"></i>';
        item.classList.remove('is-playing-now');
      }
    });
  }

  // ===== 4. Страница отдельного трека (Radio Track Page) =====

  let currentViewingTrack = null;

  async function openTrackPage(trackId) {
    try {
      const track = await api('/api/radio/tracks/' + trackId);
      if (!track) throw new Error('Трек не найден');
      currentViewingTrack = track;

      // Скрываем табы и показываем страницу трека
      if (dom.navTabs) { dom.navTabs.hidden = true; dom.navTabs.style.display = 'none'; }
      if (dom.tabLive) { dom.tabLive.hidden = true; dom.tabLive.style.display = 'none'; }
      if (dom.tabFeed) { dom.tabFeed.hidden = true; dom.tabFeed.style.display = 'none'; }
      if (dom.tabEditor) { dom.tabEditor.hidden = true; dom.tabEditor.style.display = 'none'; }
      if (dom.trackView) { dom.trackView.hidden = false; dom.trackView.style.display = 'block'; }

      // Заполняем данные
      if (dom.trackPageTitle) dom.trackPageTitle.textContent = track.title;
      if (dom.trackPageAuthorLink) {
        dom.trackPageAuthorLink.textContent = track.author_name;
        dom.trackPageAuthorLink.href = `/profile/${track.user_id}`;
      }

      if (dom.trackPageCover) {
        if (track.cover_url) {
          dom.trackPageCover.innerHTML = `<img src="${escapeHtml(track.cover_url)}" alt="">`;
        } else {
          dom.trackPageCover.innerHTML = `<i class="fas fa-compact-disc"></i>`;
        }
      }

      if (dom.trackPageTypeBadge) {
        const typeLabels = { track: '🎵 Музыка', podcast: '🎙️ Подкаст', speech: '🗣️ Речь ведущего' };
        dom.trackPageTypeBadge.textContent = typeLabels[track.type] || '🎵 Музыка';
        dom.trackPageTypeBadge.className = `radio-track-type-badge type-${track.type || 'track'}`;
      }

      if (dom.trackPageFormatPill) {
        dom.trackPageFormatPill.textContent = String(track.format || 'MP3').toUpperCase();
      }

      if (dom.trackPageDuration) dom.trackPageDuration.innerHTML = `<i class="far fa-clock"></i> ${formatDuration(track.duration)}`;
      if (dom.trackPageSize) dom.trackPageSize.innerHTML = `<i class="fas fa-hard-drive"></i> ${(track.size / (1024 * 1024)).toFixed(1)} МБ`;
      if (dom.trackPageDate) dom.trackPageDate.innerHTML = `<i class="far fa-calendar"></i> ${new Date(track.created_at).toLocaleDateString()}`;

      if (dom.trackPageDownloadBtn) {
        dom.trackPageDownloadBtn.href = track.audio_url;
        dom.trackPageDownloadBtn.setAttribute('download', `${track.title}.${track.format || 'mp3'}`);
      }

      const currentUser = window.authManager && window.authManager.getUser();
      const isOwnerOrAdmin = currentUser && (currentUser.id === track.user_id || currentUser.is_root || currentUser.admin_level > 0);
      if (dom.trackPageDeleteBtn) {
        dom.trackPageDeleteBtn.style.display = isOwnerOrAdmin ? 'inline-flex' : 'none';
      }

      window.history.pushState(null, '', `/radio/track/${track.id}`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      showToast('Ошибка открытия страницы трека: ' + err.message, 'error');
    }
  }

  // ===== 5. Редактор сетки вещания (24 часа) =====

  async function initEditor() {
    if (!dom.editorSlotsList) return;
    const user = window.authManager && window.authManager.getUser();
    if (!user) {
      dom.editorSlotsList.innerHTML = `
        <div style="text-align:center; padding:40px; color:#94a3b8;">
          <i class="fas fa-lock" style="font-size:2rem; margin-bottom:12px; display:block; color:#64748b;"></i>
          Для управления радиостанцией и сеткой вещания необходимо войти в аккаунт AllTell.
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
        document.getElementById('btnCreateFirstStation')?.addEventListener('click', openCreateStationModal);
        return;
      }

      if (dom.editorStationSelect) {
        dom.editorStationSelect.innerHTML = state.myStations.map((s) => `
          <option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.frequency)} FM)</option>
        `).join('');
      }

      state.selectedStationForEdit = state.myStations[0];
      setEditorStartTime(new Date());
      loadStationTimeline(state.selectedStationForEdit.id);
    } catch (e) {
      if (dom.editorSlotsList) {
        dom.editorSlotsList.innerHTML = `<p class="alltell-error">Ошибка инициализации редактора: ${escapeHtml(e.message)}</p>`;
      }
    }
  }

  function setEditorStartTime(date) {
    state.editorStartTime = new Date(date).toISOString();
    if (dom.editorBroadcastStartTime) {
      const d = new Date(date);
      const pad = (n) => (n < 10 ? '0' : '') + n;
      const localStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      dom.editorBroadcastStartTime.value = localStr;
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
          Сетка пуста. Загрузите плейлист, добавьте треки из медиатеки или запишите слова с микрофона.
        </p>
      `;
      updateCapacityUI();
      return;
    }

    let cursor = new Date(state.editorStartTime || Date.now()).getTime();

    dom.editorSlotsList.innerHTML = state.editorSlots.map((slot, index) => {
      const durSec = Number(slot.duration) || 0;
      const startMs = cursor;
      const endMs = cursor + durSec * 1000;
      cursor = endMs;

      return `
        <div class="radio-slot-item" data-index="${index}">
          <div style="display:flex; align-items:center; gap:10px; flex:1; min-width:0; flex-wrap:wrap;">
            <span class="radio-slot-order">${index + 1}</span>
            <span class="radio-slot-time-range">${formatClockTime(startMs)} — ${formatClockTime(endMs)}</span>
            <span class="radio-track-type-badge type-${slot.type}">${slot.type === 'podcast' ? 'Подкаст' : slot.type === 'speech' ? 'Слова' : 'Трек'}</span>
            <span style="font-weight:600; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(slot.title)}</span>
          </div>
          <div class="radio-slot-actions">
            <button type="button" class="radio-slot-quick-words btn-quick-insert-words" data-index="${index}" title="Вставить слова/джингл сразу после этого трека">
              <i class="fas fa-comment-dots"></i> + Слова
            </button>
            <span style="font-size:0.85rem; color:#94a3b8; font-family:monospace; margin:0 4px;">${formatDuration(slot.duration)}</span>
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
      `;
    }).join('');

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

    dom.editorSlotsList.querySelectorAll('.btn-quick-insert-words').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.index, 10);
        openInsertWordsModalForIndex(i);
      });
    });

    updateCapacityUI();
  }

  function addSlotToEditor(slot, targetIndex = -1) {
    if (targetIndex >= 0 && targetIndex <= state.editorSlots.length) {
      state.editorSlots.splice(targetIndex, 0, slot);
    } else {
      state.editorSlots.push(slot);
    }
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

  // ===== 6. Умная вставка слов ведущего по времени =====

  let insertWordsContext = {
    targetSlotIndex: -1,
    audioUrl: null,
    duration: 5,
    micRecordedBlob: null
  };

  function calculateSpeechInsertionSlot(targetTimeStr) {
    if (!targetTimeStr) return { insertIndex: state.editorSlots.length };
    const parts = targetTimeStr.split(':').map((v) => parseInt(v, 10));
    if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) {
      return { insertIndex: state.editorSlots.length };
    }
    const [h, m] = parts;

    const baseDate = new Date(state.editorStartTime || Date.now());
    const targetDate = new Date(baseDate);
    targetDate.setHours(h, m, 0, 0);

    let targetMs = targetDate.getTime();
    if (targetMs < baseDate.getTime() - 12 * 3600 * 1000) {
      targetMs += 24 * 3600 * 1000;
    }

    let cursor = baseDate.getTime();
    for (let i = 0; i < state.editorSlots.length; i++) {
      const slot = state.editorSlots[i];
      const durMs = (Number(slot.duration) || 0) * 1000;
      const endMs = cursor + durMs;

      if (targetMs <= endMs) {
        return {
          insertIndex: i + 1,
          priorSlot: slot,
          priorSlotIndex: i + 1,
          priorEndTime: formatClockTime(endMs),
          nextSlot: state.editorSlots[i + 1] || null
        };
      }
      cursor = endMs;
    }

    return {
      insertIndex: state.editorSlots.length,
      priorSlot: state.editorSlots[state.editorSlots.length - 1] || null,
      priorSlotIndex: state.editorSlots.length,
      priorEndTime: formatClockTime(cursor),
      nextSlot: null
    };
  }

  function openInsertWordsModalForIndex(slotIndex) {
    insertWordsContext.targetSlotIndex = slotIndex + 1;
    insertWordsContext.audioUrl = null;

    showModal('modalInsertWordsByTime');

    let cursor = new Date(state.editorStartTime || Date.now()).getTime();
    for (let i = 0; i <= slotIndex && i < state.editorSlots.length; i++) {
      cursor += (Number(state.editorSlots[i].duration) || 0) * 1000;
    }
    const d = new Date(cursor);
    const pad = (n) => (n < 10 ? '0' : '') + n;
    const timeInput = document.getElementById('speechTargetTimeInput');
    if (timeInput) timeInput.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

    updateSpeechPlanPreview();
  }

  function updateSpeechPlanPreview() {
    const timeInput = document.getElementById('speechTargetTimeInput');
    const planBox = document.getElementById('speechPlanCalculatedBox');
    const planText = document.getElementById('speechPlanText');
    if (!timeInput || !planBox || !planText) return;

    const targetTime = timeInput.value;
    if (!targetTime || state.editorSlots.length === 0) {
      planBox.style.display = 'none';
      return;
    }

    const calc = calculateSpeechInsertionSlot(targetTime);
    insertWordsContext.targetSlotIndex = calc.insertIndex;

    planBox.style.display = 'block';
    if (calc.priorSlot) {
      planText.innerHTML = `В ${targetTime} звучит трек <b>№${calc.priorSlotIndex} «${escapeHtml(calc.priorSlot.title)}»</b> (завершается в <b>${calc.priorEndTime}</b>). Слова ведущего начнут играть ровно после него, а следующий трек начнется сразу после завершения слов.`;
    } else {
      planText.textContent = `Слова встанут в сетку в позицию №${calc.insertIndex + 1}.`;
    }
  }

  // ===== Вспомогательные функции для всплывающих и модальных окон AllTell =====
  function showToast(text, type = 'info', duration = 4000) {
    if (window.toast && typeof window.toast.show === 'function') {
      return window.toast.show(text, type, duration);
    }
    if (typeof window.showToast === 'function') {
      return window.showToast(text, type, duration);
    }
    console.log(`[Toast ${type}]: ${text}`);
  }

  async function showConfirm(message, opts = {}) {
    if (typeof window.showConfirm === 'function') {
      return await window.showConfirm(message, opts);
    }
    if (window.confirmDialog && typeof window.confirmDialog.open === 'function') {
      return await window.confirmDialog.open({ message, ...opts });
    }
    return window.confirm(message);
  }

  function showAlert(message, opts = {}) {
    if (typeof window.showAlert === 'function') {
      return window.showAlert(message, opts);
    }
    if (window.confirmDialog && typeof window.confirmDialog.alert === 'function') {
      return window.confirmDialog.alert({ message, ...opts });
    }
    showToast(message, 'info');
  }

  function showPrompt(message, defaultValue = '', opts = {}) {
    if (typeof window.showPrompt === 'function') {
      return window.showPrompt(message, defaultValue, opts);
    }
    if (window.confirmDialog && typeof window.confirmDialog.prompt === 'function') {
      return window.confirmDialog.prompt({ message, defaultValue, ...opts });
    }
    return window.prompt(message, defaultValue);
  }

  // ===== Вспомогательные функции для модальных окон страницы =====
  function showModal(modal) {
    if (typeof modal === 'string') modal = document.getElementById(modal);
    if (!modal) return;
    modal.hidden = false;
    modal.style.display = 'flex';
  }

  function hideModal(modal) {
    if (typeof modal === 'string') modal = document.getElementById(modal);
    if (!modal) return;
    modal.hidden = true;
    modal.style.display = 'none';
  }

  // ===== Открытие / закрытие модалок =====
  function openUploadModal() {
    const user = window.authManager && window.authManager.getUser();
    if (!user) {
      showToast('Для загрузки аудиозаписей необходимо войти в аккаунт AllTell', 'warning');
      return;
    }
    showModal('modalUploadTrack');
  }

  function openCreateStationModal() {
    const user = window.authManager && window.authManager.getUser();
    if (!user) {
      showToast('Для занятия радиочастоты необходимо войти в аккаунт AllTell', 'warning');
      return;
    }
    showModal('modalCreateStation');
  }

  // ===== ГЛАВНАЯ ИНИЦИАЛИЗАЦИЯ СТРАНИЦЫ =====
  function init() {
    // ЗАЩИТА ОТ ДВОЙНОГО ВЫЗОВА И ДВОЕНИЯ СЛУШАТЕЛЕЙ
    if (window.RadioClient._mounted) {
      return window.RadioClient._cleanup;
    }
    window.RadioClient._mounted = true;

    // Скрываем все модальные окна при старте страницы
    document.querySelectorAll('.modal-overlay, .radio-modal-backdrop').forEach((m) => hideModal(m));

    dom = queryDom();
    if (!dom.deckPlayBtn) {
      window.RadioClient._mounted = false;
      return null;
    }

    const globalAudio = getGlobalAudio();

    // Подписка на глобальный аудиоплеер AllTell
    if (globalAudio) {
      state.globalUnsub = globalAudio.subscribe((gState) => {
        updateDeckUI();
        updateFeedPlayButtons();

        // Обновление плеера на странице трека
        if (currentViewingTrack && gState.track && gState.track.id === currentViewingTrack.id) {
          if (dom.trackPagePlayBtn) {
            dom.trackPagePlayBtn.innerHTML = gState.isPlaying ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
          }
          const cur = globalAudio.audio.currentTime || 0;
          const dur = globalAudio.audio.duration || currentViewingTrack.duration || 0;
          if (dom.trackPageCurrentTime) dom.trackPageCurrentTime.textContent = formatDuration(cur);
          if (dom.trackPageTotalDuration) dom.trackPageTotalDuration.textContent = formatDuration(dur);
          if (dom.trackPageProgressFill && dur > 0) {
            dom.trackPageProgressFill.style.width = `${Math.min(100, (cur / dur) * 100)}%`;
          }
        }
      });
    }

    // 1. Табы
    dom.tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        if (dom.trackView) { dom.trackView.hidden = true; dom.trackView.style.display = 'none'; }
        if (dom.navTabs) { dom.navTabs.hidden = false; dom.navTabs.style.display = ''; }

        dom.tabs.forEach((t) => t.classList.remove('is-active'));
        tab.classList.add('is-active');

        const tabName = tab.dataset.tab;
        if (dom.tabLive) {
          dom.tabLive.hidden = tabName !== 'live';
          dom.tabLive.style.display = tabName === 'live' ? '' : 'none';
        }
        if (dom.tabFeed) {
          dom.tabFeed.hidden = tabName !== 'feed';
          dom.tabFeed.style.display = tabName === 'feed' ? '' : 'none';
        }
        if (dom.tabEditor) {
          dom.tabEditor.hidden = tabName !== 'editor';
          dom.tabEditor.style.display = tabName === 'editor' ? '' : 'none';
        }

        if (tabName === 'live') loadStations();
        if (tabName === 'feed') loadTracks();
        if (tabName === 'editor') initEditor();
      });
    });

    // 2. Управление эфирной декой
    dom.deckPlayBtn?.addEventListener('click', () => {
      const gAudio = getGlobalAudio();
      if (!gAudio) return;

      if (!state.currentStation) {
        const firstCard = document.querySelector('.radio-station-card');
        if (firstCard) firstCard.click();
        return;
      }

      const curr = gAudio.getState();
      if (curr.isPlaying) {
        gAudio.pause();
      } else {
        gAudio.resume();
      }
    });

    dom.deckUnfreezeBtn?.addEventListener('click', () => {
      const gAudio = getGlobalAudio();
      if (!gAudio) return;
      gAudio.seek(0);
      state.isTimeshift = true;
      updateDeckUI();
      gAudio.resume();
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
        const gAudio = getGlobalAudio();
        if (gAudio) {
          gAudio.playRadio(state.currentStation, next, 0);
        }
        updateDeckUI();
      } else if (state.currentStation) {
        tuneStation(state.currentStation, true);
      }
    });

    dom.deckProgressBar?.addEventListener('click', (e) => {
      const gAudio = getGlobalAudio();
      if (!gAudio) return;
      const rect = dom.deckProgressBar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      gAudio.seek(ratio);
      state.isTimeshift = true;
      updateDeckUI();
    });

    dom.deckVolumeSlider?.addEventListener('input', (e) => {
      const gAudio = getGlobalAudio();
      if (gAudio) gAudio.setVolume(parseFloat(e.target.value));
    });

    dom.deckMuteBtn?.addEventListener('click', () => {
      const gAudio = getGlobalAudio();
      if (gAudio) {
        gAudio.toggleMute();
        dom.deckMuteBtn.innerHTML = gAudio.getState().muted ? '<i class="fas fa-volume-xmark"></i>' : '<i class="fas fa-volume-high"></i>';
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

    // 4. Редактор сетки вещания

    dom.editorStationSelect?.addEventListener('change', (e) => {
      const id = e.target.value;
      const found = state.myStations.find((s) => s.id == id);
      if (found) {
        state.selectedStationForEdit = found;
        loadStationTimeline(found.id);
      }
    });

    dom.editorBroadcastStartTime?.addEventListener('change', (e) => {
      if (e.target.value) {
        state.editorStartTime = new Date(e.target.value).toISOString();
        renderEditorSlots();
      }
    });

    dom.btnSetStartTimeNow?.addEventListener('click', () => {
      setEditorStartTime(new Date());
      renderEditorSlots();
    });

    dom.btnClearTimelineBtn?.addEventListener('click', async () => {
      if (!state.selectedStationForEdit) return;
      const ok = await showConfirm(`Очистить всю сетку вещания радиостанции «${state.selectedStationForEdit.name}»? Эфир будет освобожден.`, {
        title: 'Очистить сетку вещания?',
        confirmLabel: 'Очистить эфир',
        danger: true
      });
      if (!ok) return;

      try {
        await api(`/api/radio/stations/${state.selectedStationForEdit.id}/timeline`, {
          method: 'DELETE'
        });
        state.editorSlots = [];
        renderEditorSlots();
        showToast('Сетка вещания радиостанции очищена. Эфир освобожден.', 'info');
        loadStations();
      } catch (err) {
        showToast('Ошибка при очистке сетки: ' + err.message, 'error');
      }
    });

    dom.btnReleaseStationBtn?.addEventListener('click', async () => {
      if (!state.selectedStationForEdit) return;
      const st = state.selectedStationForEdit;
      const ok = await showConfirm(`Освободить частоту ${st.frequency} FM? Радиостанция «${st.name}» и вся сетка вещания будут удалены навсегда, а частота станет доступна для всех пользователей.`, {
        title: 'Освободить частоту?',
        confirmLabel: 'Удалить станцию и освободить',
        danger: true
      });
      if (!ok) return;

      try {
        await api(`/api/radio/stations/${st.id}`, { method: 'DELETE' });
        showToast(`Частота ${st.frequency} FM успешно освобождена!`, 'success');
        state.selectedStationForEdit = null;
        state.editorSlots = [];
        loadStations();
        document.querySelector('.radio-nav-tab[data-tab="live"]')?.click();
      } catch (err) {
        showToast('Ошибка при освобождении частоты: ' + err.message, 'error');
      }
    });

    dom.btnSaveTimeline?.addEventListener('click', async () => {
      if (!state.selectedStationForEdit) {
        showToast('Пожалуйста, выберите радиостанцию', 'warning');
        return;
      }
      if (state.editorSlots.length === 0) {
        showToast('Сетка пуста. Добавьте хотя бы один трек.', 'warning');
        return;
      }

      try {
        dom.btnSaveTimeline.disabled = true;
        dom.btnSaveTimeline.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Сохраняем…';

        await api(`/api/radio/stations/${state.selectedStationForEdit.id}/timeline`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slots: state.editorSlots,
            startTime: state.editorStartTime || new Date().toISOString()
          })
        });

        showToast('Сетка вещания успешно опубликована на 24 часа! Эфир обновлен.', 'success');
        loadStations();
      } catch (e) {
        showToast('Ошибка сохранения сетки: ' + e.message, 'error');
      } finally {
        if (dom.btnSaveTimeline) {
          dom.btnSaveTimeline.disabled = false;
          dom.btnSaveTimeline.innerHTML = '<i class="fas fa-tower-broadcast"></i> Опубликовать в эфир (24ч)';
        }
      }
    });

    // Пакетная загрузка плейлиста
    dom.btnUploadPlaylist?.addEventListener('click', () => {
      const user = window.authManager && window.authManager.getUser();
      if (!user) {
        showToast('Для загрузки плейлиста в эфир необходимо войти в аккаунт AllTell', 'warning');
        return;
      }

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.multiple = true;
      fileInput.accept = 'audio/*';

      fileInput.onchange = async () => {
        const files = Array.from(fileInput.files || []);
        if (files.length === 0) return;

        const progressModal = document.getElementById('modalPlaylistProgress');
        const progressText = document.getElementById('playlistProgressText');
        const progressFill = document.getElementById('playlistProgressFill');
        showModal(progressModal);

        let addedCount = 0;
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (progressText) progressText.textContent = `Загрузка ${i + 1} из ${files.length}: ${file.name}`;
          if (progressFill) progressFill.style.width = `${Math.round(((i) / files.length) * 100)}%`;

          try {
            const formData = new FormData();
            formData.append('audio', file);
            const uploadRes = await api('/api/upload-audio', {
              method: 'POST',
              body: formData
            });

            const tempAudio = new Audio(uploadRes.url);
            const dur = await new Promise((res) => {
              tempAudio.addEventListener('loadedmetadata', () => res(Math.round(tempAudio.duration) || 180));
              tempAudio.addEventListener('error', () => res(180));
              setTimeout(() => res(180), 3000);
            });

            addSlotToEditor({
              title: uploadRes.title || file.name.replace(/\.[^/.]+$/, ''),
              type: 'track',
              audio_url: uploadRes.url,
              duration: dur
            });
            addedCount++;
          } catch (err) {
            console.error('Ошибка загрузки трека плейлиста:', file.name, err);
          }
        }

        if (progressFill) progressFill.style.width = '100%';
        hideModal(progressModal);
        showToast(`Плейлист из ${addedCount} треков успешно добавлен в сетку!`, 'success');
      };

      fileInput.click();
    });

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
              title: uploadRes.title || file.name.replace(/\.[^/.]+$/, ''),
              type: 'track',
              audio_url: uploadRes.url,
              duration: dur
            });
          });
        } catch (e) {
          showToast('Ошибка загрузки файла: ' + e.message, 'error');
        }
      };
      fileInput.click();
    });

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
            showToast('Не удалось загрузить аудиозапись с микрофона: ' + uploadErr.message, 'error');
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
        showToast('Ошибка доступа к микрофону: ' + err.message, 'error');
      }
    });

    dom.btnPickFromMyTracks?.addEventListener('click', async () => {
      const modal = document.getElementById('modalPickTrack');
      const list = document.getElementById('modalPickTrackList');
      showModal(modal);
      if (list) list.innerHTML = '<p class="alltell-state">Загружаем ваши аудиозаписи…</p>';
      if (dom.btnPickTracksBatch) dom.btnPickTracksBatch.disabled = true;
      if (dom.pickTrackSelectAll) dom.pickTrackSelectAll.checked = false;

      try {
        const data = await api('/api/radio/tracks?limit=100');
        if (!data.tracks || data.tracks.length === 0) {
          if (list) list.innerHTML = '<p style="text-align:center; color:#94a3b8;">В медиатеке пока нет записей.</p>';
          return;
        }

        if (list) {
          list.innerHTML = data.tracks.map((t) => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#12141a; border-radius:10px; margin-bottom:8px;">
              <div style="display:flex; align-items:center; gap:12px;">
                <input type="checkbox" class="pick-track-checkbox" data-id="${t.id}" data-title="${escapeHtml(t.title)}" data-url="${escapeHtml(t.audio_url)}" data-duration="${t.duration}" data-type="${t.type}">
                <div>
                  <strong style="color:#fff; display:block;">${escapeHtml(t.title)}</strong>
                  <span style="font-size:0.8rem; color:#94a3b8;">${escapeHtml(t.author_name)} • ${formatDuration(t.duration)}</span>
                </div>
              </div>
              <button type="button" class="btn btn-primary btn-sm btn-pick-single-item" data-id="${t.id}" data-title="${escapeHtml(t.title)}" data-url="${escapeHtml(t.audio_url)}" data-duration="${t.duration}" data-type="${t.type}">
                Выбрать
              </button>
            </div>
          `).join('');

          const updateBatchState = () => {
            const checked = list.querySelectorAll('.pick-track-checkbox:checked');
            if (dom.btnPickTracksBatch) {
              dom.btnPickTracksBatch.disabled = checked.length === 0;
              dom.btnPickTracksBatch.innerHTML = `<i class="fas fa-plus"></i> Добавить (${checked.length})`;
            }
          };

          list.querySelectorAll('.pick-track-checkbox').forEach((cb) => {
            cb.addEventListener('change', updateBatchState);
          });

          dom.pickTrackSelectAll?.addEventListener('change', (e) => {
            list.querySelectorAll('.pick-track-checkbox').forEach((cb) => {
              cb.checked = e.target.checked;
            });
            updateBatchState();
          });

          dom.btnPickTracksBatch?.addEventListener('click', () => {
            const checked = list.querySelectorAll('.pick-track-checkbox:checked');
            checked.forEach((cb) => {
              addSlotToEditor({
                track_id: cb.dataset.id,
                title: cb.dataset.title,
                audio_url: cb.dataset.url,
                duration: parseFloat(cb.dataset.duration) || 180,
                type: cb.dataset.type || 'track'
              });
            });
            hideModal(modal);
          });

          list.querySelectorAll('.btn-pick-single-item').forEach((b) => {
            b.addEventListener('click', () => {
              addSlotToEditor({
                track_id: b.dataset.id,
                title: b.dataset.title,
                audio_url: b.dataset.url,
                duration: parseFloat(b.dataset.duration) || 180,
                type: b.dataset.type || 'track'
              });
              hideModal(modal);
            });
          });
        }
      } catch (e) {
        if (list) list.innerHTML = `<p class="alltell-error">${escapeHtml(e.message)}</p>`;
      }
    });

    // 5. Модалка слов
    dom.btnOpenInsertWordsModal?.addEventListener('click', () => {
      showModal('modalInsertWordsByTime');
      const d = new Date();
      const pad = (n) => (n < 10 ? '0' : '') + n;
      const timeInput = document.getElementById('speechTargetTimeInput');
      if (timeInput) timeInput.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      updateSpeechPlanPreview();
    });

    document.getElementById('speechTargetTimeInput')?.addEventListener('input', updateSpeechPlanPreview);

    const tabMic = document.getElementById('btnSpeechTabMic');
    const tabFile = document.getElementById('btnSpeechTabFile');
    const tabLib = document.getElementById('btnSpeechTabLib');
    const boxMic = document.getElementById('speechBoxMic');
    const boxFile = document.getElementById('speechBoxFile');
    const boxLib = document.getElementById('speechBoxLib');

    function selectSpeechTab(tab) {
      tabMic?.classList.toggle('is-active', tab === 'mic');
      tabFile?.classList.toggle('is-active', tab === 'file');
      tabLib?.classList.toggle('is-active', tab === 'lib');
      if (boxMic) boxMic.style.display = tab === 'mic' ? 'flex' : 'none';
      if (boxFile) boxFile.style.display = tab === 'file' ? 'block' : 'none';
      if (boxLib) boxLib.style.display = tab === 'lib' ? 'block' : 'none';
    }

    tabMic?.addEventListener('click', () => selectSpeechTab('mic'));
    tabFile?.addEventListener('click', () => selectSpeechTab('file'));
    tabLib?.addEventListener('click', async () => {
      selectSpeechTab('lib');
      if (boxLib) {
        boxLib.innerHTML = '<p class="alltell-state">Загружаем записи...</p>';
        try {
          const data = await api('/api/radio/tracks?type=speech');
          if (!data.tracks || data.tracks.length === 0) {
            boxLib.innerHTML = '<p style="color:#94a3b8; font-size:0.85rem; padding:8px;">Речевых записей не найдено.</p>';
            return;
          }
          boxLib.innerHTML = data.tracks.map((t) => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 10px; border-bottom:1px solid rgba(255,255,255,0.06);">
              <span style="font-size:0.85rem; color:#fff;">${escapeHtml(t.title)} (${formatDuration(t.duration)})</span>
              <button type="button" class="btn btn-secondary btn-sm btn-pick-lib-speech" data-url="${escapeHtml(t.audio_url)}" data-title="${escapeHtml(t.title)}" data-dur="${t.duration}">Выбрать</button>
            </div>
          `).join('');

          boxLib.querySelectorAll('.btn-pick-lib-speech').forEach((btn) => {
            btn.addEventListener('click', () => {
              insertWordsContext.audioUrl = btn.dataset.url;
              insertWordsContext.duration = parseFloat(btn.dataset.dur) || 10;
              document.getElementById('speechSlotTitleInput').value = btn.dataset.title;
              showToast(`Выбрана запись: ${btn.dataset.title}`, 'info');
            });
          });
        } catch (e) {
          boxLib.innerHTML = `<p class="alltell-error">${escapeHtml(e.message)}</p>`;
        }
      }
    });

    let modalMediaRecorder = null;
    let modalChunks = [];
    let modalRecStart = 0;
    let modalTimerInterval = null;

    document.getElementById('btnModalRecordSpeech')?.addEventListener('click', async () => {
      const btn = document.getElementById('btnModalRecordSpeech');
      const timer = document.getElementById('speechModalRecordTimer');
      const status = document.getElementById('speechMicStatus');

      if (modalMediaRecorder && modalMediaRecorder.state === 'recording') {
        modalMediaRecorder.stop();
        clearInterval(modalTimerInterval);
        if (btn) {
          btn.classList.remove('is-recording');
          btn.innerHTML = '<i class="fas fa-circle"></i> Записать заново';
        }
        if (timer) timer.style.display = 'none';
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        modalChunks = [];
        modalMediaRecorder = new MediaRecorder(stream);

        modalMediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) modalChunks.push(e.data);
        };

        modalMediaRecorder.onstop = () => {
          const blob = new Blob(modalChunks, { type: 'audio/webm' });
          insertWordsContext.micRecordedBlob = blob;
          const dur = Math.round((Date.now() - modalRecStart) / 1000) || 5;
          insertWordsContext.duration = dur;
          if (status) status.innerHTML = `<i class="fas fa-circle-check" style="color:#2ed573;"></i> Голос записан (${formatDuration(dur)})`;
        };

        modalMediaRecorder.start();
        modalRecStart = Date.now();
        if (btn) {
          btn.classList.add('is-recording');
          btn.innerHTML = '<i class="fas fa-stop"></i> Стоп';
        }
        if (timer) {
          timer.style.display = 'inline';
          timer.textContent = '00:00';
        }
        modalTimerInterval = setInterval(() => {
          const sec = Math.floor((Date.now() - modalRecStart) / 1000);
          if (timer) timer.textContent = formatDuration(sec);
        }, 500);
      } catch (err) {
        showToast('Ошибка доступа к микрофону: ' + err.message, 'error');
      }
    });

    document.getElementById('formInsertWordsByTime')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = document.getElementById('speechSlotTitleInput')?.value.trim() || 'Слова ведущего';
      const targetTime = document.getElementById('speechTargetTimeInput')?.value;
      const submitBtn = document.getElementById('btnSubmitInsertSpeech');

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Обработка…';
      }

      try {
        let finalAudioUrl = insertWordsContext.audioUrl;
        let finalDuration = insertWordsContext.duration || 5;

        if (insertWordsContext.micRecordedBlob && !finalAudioUrl) {
          const formData = new FormData();
          const file = new File([insertWordsContext.micRecordedBlob], `speech-${Date.now()}.webm`, { type: 'audio/webm' });
          formData.append('audio', file);
          const uploadRes = await api('/api/upload-audio', { method: 'POST', body: formData });
          finalAudioUrl = uploadRes.url;
        }

        const fileInput = document.getElementById('speechFileInput');
        if (fileInput && fileInput.files[0] && !finalAudioUrl) {
          const file = fileInput.files[0];
          const formData = new FormData();
          formData.append('audio', file);
          const uploadRes = await api('/api/upload-audio', { method: 'POST', body: formData });
          finalAudioUrl = uploadRes.url;

          const tempAudio = new Audio(uploadRes.url);
          finalDuration = await new Promise((res) => {
            tempAudio.addEventListener('loadedmetadata', () => res(Math.round(tempAudio.duration) || 10));
            setTimeout(() => res(10), 2000);
          });
        }

        if (!finalAudioUrl) {
          showToast('Пожалуйста, запишите голос с микрофона, выберите аудиофайл или запись из медиатеки', 'warning');
          return;
        }

        const calc = calculateSpeechInsertionSlot(targetTime);
        addSlotToEditor({
          title,
          type: 'speech',
          audio_url: finalAudioUrl,
          duration: finalDuration
        }, calc.insertIndex);

        hideModal('modalInsertWordsByTime');
        showToast(`Слова ведущего установлены в сетку после трека №${calc.priorSlotIndex || 1}`, 'success');
      } catch (err) {
        showToast('Ошибка добавления слов: ' + err.message, 'error');
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = 'Вставить в сетку';
        }
      }
    });

    // 6. Управление страницей отдельного трека

    dom.btnBackFromTrackView?.addEventListener('click', () => {
      window.history.pushState(null, '', '/radio');
      if (dom.trackView) { dom.trackView.hidden = true; dom.trackView.style.display = 'none'; }
      if (dom.navTabs) { dom.navTabs.hidden = false; dom.navTabs.style.display = ''; }
      if (dom.tabFeed) { dom.tabFeed.hidden = false; dom.tabFeed.style.display = ''; }
    });

    dom.trackPagePlayBtn?.addEventListener('click', () => {
      if (!currentViewingTrack) return;
      const gAudio = getGlobalAudio();
      if (!gAudio) return;

      const curr = gAudio.getState();
      if (curr.isPlaying && curr.track && curr.track.id === currentViewingTrack.id) {
        gAudio.pause();
      } else {
        gAudio.playTrack(currentViewingTrack, [currentViewingTrack], 0);
      }
    });

    dom.trackPageProgressBar?.addEventListener('click', (e) => {
      const gAudio = getGlobalAudio();
      if (!gAudio) return;
      const rect = dom.trackPageProgressBar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      gAudio.seek(ratio);
    });

    dom.trackPageMuteBtn?.addEventListener('click', () => {
      const gAudio = getGlobalAudio();
      if (gAudio) gAudio.toggleMute();
    });

    dom.trackPageVolumeSlider?.addEventListener('input', (e) => {
      const gAudio = getGlobalAudio();
      if (gAudio) gAudio.setVolume(parseFloat(e.target.value));
    });

    dom.trackPageShareBtn?.addEventListener('click', () => {
      if (!currentViewingTrack) return;
      const url = `${window.location.origin}/radio/track/${currentViewingTrack.id}`;
      navigator.clipboard.writeText(url).then(() => {
        showToast('Ссылка на трек скопирована в буфер обмена!', 'success');
      }).catch(() => {
        showPrompt('Ссылка на трек:', url);
      });
    });

    dom.trackPageAddToEditorBtn?.addEventListener('click', () => {
      if (!currentViewingTrack) return;
      addSlotToEditor({
        track_id: currentViewingTrack.id,
        title: currentViewingTrack.title,
        audio_url: currentViewingTrack.audio_url,
        duration: Number(currentViewingTrack.duration) || 180,
        type: currentViewingTrack.type || 'track'
      });
      showToast(`Трек «${currentViewingTrack.title}» добавлен в сетку вещания`, 'success');
    });

    dom.trackPageDeleteBtn?.addEventListener('click', async () => {
      if (!currentViewingTrack) return;
      const ok = await showConfirm(`Удалить аудиозапись «${currentViewingTrack.title}»? Действие необратимо.`, {
        title: 'Удалить аудиозапись?',
        confirmLabel: 'Удалить',
        danger: true
      });
      if (!ok) return;

      try {
        await api('/api/radio/tracks/' + currentViewingTrack.id, { method: 'DELETE' });
        showToast('Аудиозапись успешно удалена.', 'info');
        dom.btnBackFromTrackView?.click();
        loadTracks();
      } catch (err) {
        showToast('Ошибка при удалении трека: ' + err.message, 'error');
      }
    });

    // 7. Модальные окна: открытие и закрытие
    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const modalId = btn.dataset.close;
        hideModal(modalId);
      });
    });

    document.querySelectorAll('.modal-overlay, .radio-modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
          hideModal(backdrop);
        }
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay, .radio-modal-backdrop').forEach((backdrop) => {
          hideModal(backdrop);
        });
      }
    });

    dom.btnOpenUploadTrack?.addEventListener('click', openUploadModal);
    dom.btnUploadTrackFromFeed?.addEventListener('click', openUploadModal);
    dom.btnOpenCreateStation?.addEventListener('click', openCreateStationModal);

    document.getElementById('trackCoverInput')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      const previewBox = document.getElementById('trackCoverPreviewBox');
      const previewImg = document.getElementById('trackCoverPreviewImg');
      if (file && previewBox && previewImg) {
        previewImg.src = URL.createObjectURL(file);
        previewBox.style.display = 'flex';
      }
    });

    // ФЛАГ-БЛОКИРОВЩИК ОТ ПОВТОРНОЙ ОТПРАВКИ И ДВОЕНИЯ УВЕДОМЛЕНИЙ
    let isUploadingTrack = false;
    dom.formUploadTrack?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isUploadingTrack) return;
      isUploadingTrack = true;

      const file = document.getElementById('trackFileInput')?.files[0];
      const title = document.getElementById('trackTitleInput')?.value.trim();
      const type = document.getElementById('trackTypeSelect')?.value;
      const coverFile = document.getElementById('trackCoverInput')?.files[0];
      const submitBtn = document.getElementById('btnSubmitUploadTrack');

      if (!file) {
        isUploadingTrack = false;
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Загрузка аудиофайла…';
      }

      try {
        let coverUrl = null;
        if (coverFile) {
          const coverForm = new FormData();
          coverForm.append('image', coverFile);
          const coverRes = await api('/api/upload-image', {
            method: 'POST',
            body: coverForm
          });
          coverUrl = coverRes.url;
        }

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
            type,
            coverUrl
          })
        });

        showToast('Аудиозапись успешно опубликована!', 'success');
        dom.formUploadTrack?.reset();
        const previewBox = document.getElementById('trackCoverPreviewBox');
        if (previewBox) previewBox.style.display = 'none';

        hideModal('modalUploadTrack');
        loadTracks();
      } catch (err) {
        showToast('Ошибка публикации аудиозаписи: ' + err.message, 'error');
      } finally {
        isUploadingTrack = false;
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = 'Опубликовать';
        }
      }
    });

    let isCreatingStation = false;
    dom.formCreateStation?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isCreatingStation) return;
      isCreatingStation = true;

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

        showToast(`Частота ${newStation.frequency} FM успешно занята радиостанцией «${newStation.name}»!`, 'success');
        dom.formCreateStation?.reset();
        hideModal('modalCreateStation');
        loadStations();
        document.getElementById('tabEditorBtn')?.click();
      } catch (err) {
        showToast('Ошибка создания радиостанции: ' + err.message, 'error');
      } finally {
        isCreatingStation = false;
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = 'Занять частоту';
        }
      }
    });

    // Проверка открытия конкретного трека через URL: /radio/track/:id или ?track=id
    const trackPathMatch = window.location.pathname.match(/\/radio\/track\/([^/]+)/);
    const searchTrackId = new URLSearchParams(window.location.search).get('track');
    const trackIdToOpen = (trackPathMatch && trackPathMatch[1]) || searchTrackId;

    if (trackIdToOpen) {
      openTrackPage(trackIdToOpen);
    } else {
      loadStations();
      loadTracks();
    }

    // Синхронизация прямого эфира каждые 30 секунд
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      if (state.currentStation && state.isLiveMode && !state.isTimeshift) {
        const gAudio = getGlobalAudio();
        const gState = gAudio ? gAudio.getState() : {};
        tuneStation(state.currentStation, gState.isPlaying);
      }
    }, 30000);

    const cleanupFn = function cleanup() {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
        state.mediaRecorder.stop();
      }
      clearInterval(state.recordTimerInterval);
      if (typeof state.globalUnsub === 'function') {
        state.globalUnsub();
        state.globalUnsub = null;
      }
      window.RadioClient._mounted = false;

      // НЕ ОСТАНАВЛИВАЕМ globalAudio! Радио или музыка продолжают играть
      // на любой другой странице публичного сайта или в панели администратора.
      const gAudio = getGlobalAudio();
      if (gAudio) {
        gAudio.syncBar();
      }
    };

    window.RadioClient._cleanup = cleanupFn;
    return cleanupFn;
  }

  window.RadioClient = {
    _mounted: false,
    _cleanup: null,
    init,
    cleanup() {
      if (typeof window.RadioClient._cleanup === 'function') {
        window.RadioClient._cleanup();
      }
      window.RadioClient._mounted = false;
    },
    openTrackPage
  };

  // Автозапуск при прямой загрузке страницы /radio (без SPA перехода)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if ((document.body.getAttribute('data-page') === 'radio' || window.location.pathname.startsWith('/radio')) && !window.RadioClient._mounted) {
        window.RadioClient.init();
      }
    });
  } else {
    if ((document.body.getAttribute('data-page') === 'radio' || window.location.pathname.startsWith('/radio')) && !window.RadioClient._mounted) {
      window.RadioClient.init();
    }
  }
})();
