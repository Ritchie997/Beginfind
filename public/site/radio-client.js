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
    favoriteTrackIds: new Set(),
    mySection: 'favorites',
    userPlaylists: [],
    myStations: [],
    selectedStationForEdit: null,
    editorSlots: [],
    editorBlocks: [],
    editorStartTime: null,
    timelineZoom: 1.0,
    baseScaleSec: 1200,
    mediaDrawerOpen: false,
    mediaDrawerTab: 'tracks',
    draggedBlockIndex: null,
    activeGapInfo: null,
    // Запись с микрофона в редакторе
    mediaRecorder: null,
    recordedChunks: [],
    recordStartTime: 0,
    recordTimerInterval: null,
    globalUnsub: null,
    serverTimeDelta: 0,
    serverClockInterval: null
  };

  function getEffectiveNowMs() {
    return Date.now() + (state.serverTimeDelta || 0);
  }

  let dom = {};

  function queryDom() {
    return {
      navTabs: document.getElementById('radioNavTabs'),
      tabs: document.querySelectorAll('.radio-nav-tab'),
      tabLive: document.getElementById('tabContentLive'),
      tabFeed: document.getElementById('tabContentFeed'),
      tabMy: document.getElementById('tabContentMy'),
      tabEditor: document.getElementById('tabContentEditor'),
      mySectionFilters: document.getElementById('mySectionFilters'),
      mySectionContent: document.getElementById('mySectionContent'),
      btnOpenCreatePlaylist: document.getElementById('btnOpenCreatePlaylist'),
      btnUploadTrackFromMy: document.getElementById('btnUploadTrackFromMy'),

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
      trackPagePrevBtn: document.getElementById('trackPagePrevBtn'),
      trackPagePlayBtn: document.getElementById('trackPagePlayBtn'),
      trackPageNextBtn: document.getElementById('trackPageNextBtn'),
      trackPageProgressBar: document.getElementById('trackPageProgressBar'),
      trackPageProgressFill: document.getElementById('trackPageProgressFill'),
      trackPageCurrentTime: document.getElementById('trackPageCurrentTime'),
      trackPageTotalDuration: document.getElementById('trackPageTotalDuration'),
      trackPageLoopBtn: document.getElementById('trackPageLoopBtn'),
      trackPageMuteBtn: document.getElementById('trackPageMuteBtn'),
      trackPageVolumeSlider: document.getElementById('trackPageVolumeSlider'),
      trackPageFavoriteBtn: document.getElementById('trackPageFavoriteBtn'),
      trackPageFavoriteText: document.getElementById('trackPageFavoriteText'),
      trackPageAddToPlaylistBtn: document.getElementById('trackPageAddToPlaylistBtn'),
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
      deckPrevBtn: document.getElementById('deckPrevBtn'),
      deckPlayBtn: document.getElementById('deckPlayBtn'),
      deckNextBtn: document.getElementById('deckNextBtn') || document.getElementById('deckSkipBtn'),
      deckLoopBtn: document.getElementById('deckLoopBtn'),
      deckUnfreezeBtn: document.getElementById('deckUnfreezeBtn'),
      deckLiveSyncBtn: document.getElementById('deckLiveSyncBtn'),
      deckSkipBtn: document.getElementById('deckNextBtn') || document.getElementById('deckSkipBtn'),
      deckProgressBar: document.getElementById('deckProgressBar'),
      deckProgressFill: document.getElementById('deckProgressFill'),
      deckTimeCurrent: document.getElementById('deckTimeCurrent'),
      deckTimeRemaining: document.getElementById('deckTimeRemaining'),
      deckVolumeSlider: document.getElementById('deckVolumeSlider'),
      deckMuteBtn: document.getElementById('deckMuteBtn'),

      // Отдельный плеер ленты (если отображается)
      feedPlayerBar: document.getElementById('feedPlayerBar'),
      feedPlayerPrevBtn: document.getElementById('feedPlayerPrevBtn'),
      feedPlayerPlayBtn: document.getElementById('feedPlayerPlayBtn'),
      feedPlayerNextBtn: document.getElementById('feedPlayerNextBtn'),
      feedPlayerLoopBtn: document.getElementById('feedPlayerLoopBtn'),

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
      editorBlocksList: document.getElementById('editorBlocksList'),
      editorCapacityText: document.getElementById('editorCapacityText'),
      editorCapacityFill: document.getElementById('editorCapacityFill'),
      btnSaveTimeline: document.getElementById('btnSaveTimeline'),
      btnPickFromMyTracks: document.getElementById('btnPickFromMyTracks'),
      btnUploadPlaylist: document.getElementById('btnUploadPlaylist'),
      btnUploadNewSlot: document.getElementById('btnUploadNewSlot'),
      btnOpenInsertWordsModal: document.getElementById('btnOpenInsertWordsModal'),
      btnToggleRecord: document.getElementById('btnToggleRecord'),
      recordTimer: document.getElementById('recordTimer'),

      // Видео-таймлайн (Timeline Ribbon)
      radioTimelineContainer: document.getElementById('radioTimelineContainer'),
      timelineScaleBadge: document.getElementById('timelineScaleBadge'),
      timelineTotalDuration: document.getElementById('timelineTotalDuration'),
      timelineEndTime: document.getElementById('timelineEndTime'),
      btnTimelineZoomOut: document.getElementById('btnTimelineZoomOut'),
      btnTimelineZoomReset: document.getElementById('btnTimelineZoomReset'),
      btnTimelineZoomIn: document.getElementById('btnTimelineZoomIn'),
      btnTimelineExtendScale: document.getElementById('btnTimelineExtendScale'),
      radioTimelineTrackScroll: document.getElementById('radioTimelineTrackScroll'),
      radioTimelineTrackInner: document.getElementById('radioTimelineTrackInner'),
      radioTimelineRuler: document.getElementById('radioTimelineRuler'),
      radioTimelineTrack: document.getElementById('radioTimelineTrack'),
      radioTimelinePlayhead: document.getElementById('radioTimelinePlayhead'),

      // Боковая шторка медиатеки
      btnToggleMediaDrawer: document.getElementById('btnToggleMediaDrawer'),
      radioMediaDrawer: document.getElementById('radioMediaDrawer'),
      btnCloseMediaDrawer: document.getElementById('btnCloseMediaDrawer'),
      drawerContentList: document.getElementById('drawerContentList'),
      drawerSearchInput: document.getElementById('drawerSearchInput'),

      // Кнопки и модалки умного добавления
      btnOpenPickPlaylistForTimeline: document.getElementById('btnOpenPickPlaylistForTimeline'),
      modalPickPlaylistForTimeline: document.getElementById('modalPickPlaylistForTimeline'),
      pickPlaylistForTimelineList: document.getElementById('pickPlaylistForTimelineList'),
      btnOpenSmartGapFill: document.getElementById('btnOpenSmartGapFill'),
      modalSmartGapFill: document.getElementById('modalSmartGapFill'),
      smartGapInfoText: document.getElementById('smartGapInfoText'),
      smartGapPlaylistsList: document.getElementById('smartGapPlaylistsList'),
      smartGapSelectedCount: document.getElementById('smartGapSelectedCount'),
      smartGapOrderSelect: document.getElementById('smartGapOrderSelect'),
      smartGapFitStrategy: document.getElementById('smartGapFitStrategy'),
      smartGapCalculatedPlan: document.getElementById('smartGapCalculatedPlan'),
      smartGapPlanSummary: document.getElementById('smartGapPlanSummary'),
      btnSubmitSmartGapFill: document.getElementById('btnSubmitSmartGapFill'),

      // Модальные окна
      modalUploadTrack: document.getElementById('modalUploadTrack'),
      modalCreateStation: document.getElementById('modalCreateStation'),
      modalPickTrack: document.getElementById('modalPickTrack'),
      modalInsertWordsByTime: document.getElementById('modalInsertWordsByTime'),
      modalPlaylistProgress: document.getElementById('modalPlaylistProgress'),
      modalCreatePlaylist: document.getElementById('modalCreatePlaylist'),
      formCreatePlaylist: document.getElementById('formCreatePlaylist'),
      modalCreatePlaylistTitle: document.getElementById('modalCreatePlaylistTitle'),
      editPlaylistId: document.getElementById('editPlaylistId'),
      playlistTitleInput: document.getElementById('playlistTitleInput'),
      playlistDescInput: document.getElementById('playlistDescInput'),
      playlistPublicSelect: document.getElementById('playlistPublicSelect'),
      playlistCoverInput: document.getElementById('playlistCoverInput'),
      playlistCoverPreviewBox: document.getElementById('playlistCoverPreviewBox'),
      playlistCoverPreviewImg: document.getElementById('playlistCoverPreviewImg'),
      btnSubmitCreatePlaylist: document.getElementById('btnSubmitCreatePlaylist'),
      modalPickPlaylistForTrack: document.getElementById('modalPickPlaylistForTrack'),
      pickPlaylistForTrackList: document.getElementById('pickPlaylistForTrackList'),
      btnCreateNewPlaylistFromPick: document.getElementById('btnCreateNewPlaylistFromPick'),
      modalPlaylistView: document.getElementById('modalPlaylistView'),
      playlistViewModalTitle: document.getElementById('playlistViewModalTitle'),
      playlistViewHeader: document.getElementById('playlistViewHeader'),
      playlistViewTracksList: document.getElementById('playlistViewTracksList'),
      formUploadTrack: document.getElementById('formUploadTrack'),
      formCreateStation: document.getElementById('formCreateStation'),
      btnDeckEditStation: document.getElementById('btnDeckEditStation'),
      btnEditStationSettings: document.getElementById('btnEditStationSettings'),
      modalEditStation: document.getElementById('modalEditStation'),
      formEditStation: document.getElementById('formEditStation'),
      editStationId: document.getElementById('editStationId'),
      editStationName: document.getElementById('editStationName'),
      editStationDescription: document.getElementById('editStationDescription'),
      editStationFallback: document.getElementById('editStationFallback'),
      editStationAvatar: document.getElementById('editStationAvatar'),
      btnSubmitEditStation: document.getElementById('btnSubmitEditStation'),
      btnSyncClock: document.getElementById('btnSyncClock'),
      radioServerClock: document.getElementById('radioServerClock'),
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

    // 1. Режим воспроизведения трека (из ленты, плейлиста или редактора эфира)
    if (gState.mode === 'track' && gState.track) {
      const track = gState.track;
      const typeLabel = track.type === 'speech' ? 'Слова' : track.type === 'podcast' ? 'Подкаст' : track.type === 'jingle' ? 'Джингл' : 'Трек';
      const pillLabel = track.type === 'speech' ? 'РЕЧЬ' : track.type === 'podcast' ? 'ПОДКАСТ' : 'АУДИО';

      dom.deckTitle.innerHTML = `<span>${escapeHtml(track.title || 'Аудиотрек')}</span><span class="radio-freq-pill">${pillLabel}</span>`;
      if (dom.deckOwner) {
        dom.deckOwner.textContent = track.author_name ? `Исполнитель: ${escapeHtml(track.author_name)}` : 'Медиатека AllTell';
      }

      if (dom.deckAvatar) {
        if (track.cover_url) {
          dom.deckAvatar.innerHTML = `<img src="${escapeHtml(track.cover_url)}" alt="">`;
        } else {
          dom.deckAvatar.innerHTML = `<i class="fas fa-compact-disc"></i>`;
        }
      }

      if (dom.deckStatus) {
        if (gState.isPlaying) {
          dom.deckStatus.className = 'radio-status-tag is-live';
          dom.deckStatus.textContent = 'В эфире';
        } else {
          dom.deckStatus.className = 'radio-status-tag is-timeshift';
          dom.deckStatus.textContent = 'Пауза';
        }
      }

      if (dom.deckTrackTitle) dom.deckTrackTitle.textContent = track.title || 'Аудиотрек';
      if (dom.deckTrackType) {
        dom.deckTrackType.textContent = typeLabel;
        dom.deckTrackType.className = `radio-track-type-badge type-${track.type || 'track'}`;
      }

      const cur = (globalAudio && globalAudio.audio) ? (globalAudio.audio.currentTime || 0) : (gState.currentTime || 0);
      const dur = (globalAudio && globalAudio.audio && globalAudio.audio.duration) ? globalAudio.audio.duration : (track.duration || gState.duration || 0);

      if (dom.deckTrackSub) {
        dom.deckTrackSub.textContent = track.author_name ? `${track.author_name} • ${formatDuration(dur)}` : `Длительность: ${formatDuration(dur)}`;
      }

      if (dom.deckPlayBtn) {
        dom.deckPlayBtn.innerHTML = gState.isPlaying ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
      }
      if (dom.deckVisualizer) {
        dom.deckVisualizer.classList.toggle('is-playing', Boolean(gState.isPlaying));
      }

      if (dom.deckTimeCurrent) dom.deckTimeCurrent.textContent = formatDuration(cur);
      if (dom.deckTimeRemaining) {
        const rem = Math.max(0, dur - cur);
        dom.deckTimeRemaining.textContent = rem > 0 ? `-${formatDuration(rem)}` : formatDuration(dur);
      }
      if (dom.deckProgressFill && dur > 0) {
        dom.deckProgressFill.style.width = `${Math.min(100, Math.max(0, (cur / dur) * 100))}%`;
      }

      if (dom.deckLiveSyncBtn) {
        dom.deckLiveSyncBtn.style.display = (state.currentStation || (state.stations && state.stations.length)) ? 'inline-flex' : 'none';
        dom.deckLiveSyncBtn.title = 'Переключиться на живой эфир радиостанций';
      }

      if (dom.deckUnfreezeBtn) {
        dom.deckUnfreezeBtn.style.display = 'inline-flex';
        dom.deckUnfreezeBtn.title = 'Слушать трек с начала';
      }

      const isLoopActive = Boolean(gState.isLoop);
      const loopTitle = isLoopActive ? 'Зацикливание включено (нажмите, чтобы выключить)' : 'Зациклить';
      if (dom.deckLoopBtn) {
        dom.deckLoopBtn.classList.toggle('is-active', isLoopActive);
        dom.deckLoopBtn.title = loopTitle;
      }
      if (dom.trackPageLoopBtn) {
        dom.trackPageLoopBtn.classList.toggle('is-active', isLoopActive);
        dom.trackPageLoopBtn.title = loopTitle;
      }
      if (dom.feedPlayerLoopBtn) {
        dom.feedPlayerLoopBtn.classList.toggle('is-active', isLoopActive);
        dom.feedPlayerLoopBtn.title = loopTitle;
      }

      return;
    }

    // 2. Режим радиостанции
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
      if (dom.deckPlayBtn) dom.deckPlayBtn.innerHTML = '<i class="fas fa-play"></i>';
      if (dom.deckVisualizer) dom.deckVisualizer.classList.remove('is-playing');
      if (dom.deckProgressFill) dom.deckProgressFill.style.width = '0%';
      if (dom.deckTimeCurrent) dom.deckTimeCurrent.textContent = '00:00';
      if (dom.deckTimeRemaining) dom.deckTimeRemaining.textContent = '--:--';
      if (dom.deckLiveSyncBtn) dom.deckLiveSyncBtn.style.display = 'none';
      if (dom.btnDeckEditStation) dom.btnDeckEditStation.style.display = 'none';
      return;
    }

    const curUser = getCurrentUser();
    const isStationOwner = Boolean(curUser && (String(st.owner_id) === String(curUser.id) || curUser.is_root || (curUser.admin_level && curUser.admin_level > 0)));
    if (dom.btnDeckEditStation) {
      dom.btnDeckEditStation.style.display = isStationOwner ? 'inline-flex' : 'none';
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

    const cur = (globalAudio && globalAudio.audio) ? (globalAudio.audio.currentTime || 0) : (gState.currentTime || 0);
    const dur = (globalAudio && globalAudio.audio && globalAudio.audio.duration) ? globalAudio.audio.duration : (slot ? (slot.duration || 0) : (gState.duration || 0));
    if (dom.deckTimeCurrent) dom.deckTimeCurrent.textContent = formatDuration(cur);
    if (dom.deckTimeRemaining) {
      const rem = Math.max(0, dur - cur);
      dom.deckTimeRemaining.textContent = rem > 0 ? `-${formatDuration(rem)}` : formatDuration(dur);
    }
    if (dom.deckProgressFill && dur > 0) {
      dom.deckProgressFill.style.width = `${Math.min(100, Math.max(0, (cur / dur) * 100))}%`;
    }

    if (dom.deckLiveSyncBtn) {
      dom.deckLiveSyncBtn.style.display = state.isTimeshift ? 'inline-flex' : 'none';
      dom.deckLiveSyncBtn.title = 'Вернуться в прямой эфир станции';
    }

    if (dom.deckNextBtn) {
      if (!state.isTimeshift) {
        dom.deckNextBtn.disabled = true;
        dom.deckNextBtn.style.opacity = '0.35';
        dom.deckNextBtn.title = 'Будущие треки станут доступны только после выхода в эфир';
      } else {
        dom.deckNextBtn.disabled = false;
        dom.deckNextBtn.style.opacity = '1';
        dom.deckNextBtn.title = 'Следующий трек / В эфир';
      }
    }

    if (dom.deckPrevBtn) {
      dom.deckPrevBtn.disabled = false;
      dom.deckPrevBtn.style.opacity = '1';
      dom.deckPrevBtn.title = 'Предыдущий трек из эфира / С начала';
    }

    const isLoopActive = Boolean(gState.isLoop);
    const loopTitle = isLoopActive ? 'Зацикливание включено (нажмите, чтобы выключить)' : 'Зациклить';
    if (dom.deckLoopBtn) {
      dom.deckLoopBtn.classList.toggle('is-active', isLoopActive);
      dom.deckLoopBtn.title = loopTitle;
    }
    if (dom.trackPageLoopBtn) {
      dom.trackPageLoopBtn.classList.toggle('is-active', isLoopActive);
      dom.trackPageLoopBtn.title = loopTitle;
    }
    if (dom.feedPlayerLoopBtn) {
      dom.feedPlayerLoopBtn.classList.toggle('is-active', isLoopActive);
      dom.feedPlayerLoopBtn.title = loopTitle;
    }
  }

  function skipSlot() {
    const gAudio = getGlobalAudio();
    const curr = gAudio ? gAudio.getState() : {};
    if (curr.mode === 'track') {
      gAudio.playNext();
      updateDeckUI();
      return;
    }

    // В режиме радио: запрещено перескакивать в несыгранное будущее эфира!
    if (!state.isTimeshift) {
      showToast('Будущие треки станут доступны только после выхода в эфир', 'info');
      return;
    }

    // Если слушатель находился в таймшифте (отставал от эфира), он может двигаться вперед только до прямого эфира
    if (state.timeshiftForwardSlots && state.timeshiftForwardSlots.length > 0) {
      const nextSlot = state.timeshiftForwardSlots.shift();
      if (state.currentSlot) state.prevSlots.unshift(state.currentSlot);
      state.currentSlot = nextSlot;

      if (state.liveCurrentSlot && nextSlot.id === state.liveCurrentSlot.id) {
        state.isTimeshift = false;
        if (state.currentStation) {
          tuneStation(state.currentStation, true);
        }
        return;
      }

      if (gAudio && state.currentStation && nextSlot.audioUrl) {
        gAudio.playRadio(state.currentStation, nextSlot, 0);
      }
      updateDeckUI();
      return;
    }

    // Если слотов в таймшифте больше нет, возвращаем слушателя в живой эфир
    state.isTimeshift = false;
    if (state.currentStation) {
      tuneStation(state.currentStation, true);
      showToast('Вы вернулись в прямой эфир станции', 'info');
    }
  }

  function prevSlot() {
    const gAudio = getGlobalAudio();
    const curr = gAudio ? gAudio.getState() : {};
    if (curr.mode === 'track') {
      gAudio.playPrev();
      updateDeckUI();
      return;
    }
    const cur = (gAudio && gAudio.audio) ? (gAudio.audio.currentTime || 0) : (curr.currentTime || 0);
    if (cur > 3) {
      if (gAudio) gAudio.seek(0);
      state.isTimeshift = true;
      updateDeckUI();
      showToast('Трек запущен с начала (таймшифт)', 'info');
      return;
    }
    if (state.prevSlots && state.prevSlots.length > 0) {
      if (!state.timeshiftForwardSlots) state.timeshiftForwardSlots = [];
      if (state.currentSlot) state.timeshiftForwardSlots.unshift(state.currentSlot);

      const prev = state.prevSlots.shift();
      state.currentSlot = prev;
      state.isTimeshift = true;
      if (gAudio && state.currentStation && prev.audioUrl) {
        gAudio.playRadio(state.currentStation, prev, 0);
      }
      updateDeckUI();
      showToast(`Включен прошлый трек «${prev.title}» (архив эфира)`, 'info');
    } else if (gAudio) {
      gAudio.seek(0);
      state.isTimeshift = true;
      updateDeckUI();
    }
  }

  async function tuneStation(station, autoPlay = true) {
    state.currentStation = station;
    state.isTimeshift = false;
    state.timeshiftForwardSlots = [];
    updateDeckUI();

    try {
      const live = await api(`/api/radio/stations/${station.id}/live`);
      state.currentSlot = live.currentSlot;
      state.liveCurrentSlot = live.currentSlot;
      state.nextSlots = live.nextSlots || [];
      state.prevSlots = live.prevSlots || [];

      const globalAudio = getGlobalAudio();
      if (globalAudio && autoPlay) {
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
      const curUser = getCurrentUser();

      dom.stationsGrid.innerHTML = stations.map((st) => {
        const isOwner = Boolean(curUser && (String(st.owner_id) === String(curUser.id) || curUser.is_root || (curUser.admin_level && curUser.admin_level > 0)));
        return `
        <div class="radio-station-card ${activeStationId === st.id ? 'is-active-tune' : ''}" data-id="${st.id}">
          <div>
            <div class="radio-card-top">
              <div class="radio-card-avatar">
                ${st.avatar_url ? `<img src="${escapeHtml(st.avatar_url)}" alt="">` : '<i class="fas fa-broadcast-tower"></i>'}
              </div>
              <div class="radio-card-meta" style="flex:1;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                  <h3><span>${escapeHtml(st.name)}</span> <span class="radio-freq-pill">${escapeHtml(st.frequency)} FM</span></h3>
                  ${isOwner ? `<button type="button" class="btn btn-outline-secondary btn-xs btn-card-edit-station" data-station-id="${st.id}" title="Редактировать описание и параметры радиостанции"><i class="fas fa-pen"></i></button>` : ''}
                </div>
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
      `;
      }).join('');

      dom.stationsGrid.querySelectorAll('.btn-card-edit-station').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const sId = btn.dataset.stationId;
          const found = stations.find((s) => s.id == sId);
          if (found) openEditStationModal(found);
        });
      });

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
        } else if (gState.mode !== 'track') {
          // Находим станцию, в которой прямо сейчас идет живой эфир, либо первую в каталоге, и начинаем вещание со смещением!
          const targetStation = stations.find((s) => s.isLive) || stations[0];
          tuneStation(targetStation, true);
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

  // ===== 3. Избранное («Моё») и Плейлисты =====

  async function loadFavoriteIds() {
    const user = window.authManager && window.authManager.getUser();
    if (!user) {
      state.favoriteTrackIds.clear();
      return;
    }
    try {
      const res = await api('/api/radio/favorites/ids');
      if (res && Array.isArray(res.ids)) {
        state.favoriteTrackIds = new Set(res.ids);
      }
    } catch (_) {}
  }

  function renderTrackItemHtml(t, idx, tracksArray, isFavoriteView = false) {
    const globalAudio = getGlobalAudio();
    const gState = globalAudio ? globalAudio.getState() : {};
    const isThisPlaying = gState.isPlaying && gState.track && gState.track.id === t.id;
    const isFav = state.favoriteTrackIds.has(t.id);

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
          <button type="button" class="radio-action-btn btn-favorite-toggle ${isFav ? 'is-added' : ''}" data-id="${t.id}" title="${isFav ? 'Удалить из «Моё»' : 'Добавить в «Моё»'}">
            <i class="fas ${isFav ? 'fa-xmark' : 'fa-plus'}"></i>
          </button>
          <button type="button" class="radio-action-btn btn-add-to-playlist" data-id="${t.id}" title="Добавить в плейлист">
            <i class="fas fa-list-ul"></i>
          </button>
          <button type="button" class="radio-action-btn btn-open-track-detail" data-id="${t.id}" title="Страница трека">
            <i class="fas fa-arrow-up-right-from-square"></i>
          </button>
        </div>
      </div>
    `;
  }

  function attachTrackItemListeners(container, tracksArray, onFavoriteChange = null) {
    container.querySelectorAll('.radio-track-play-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        const t = tracksArray[idx];
        if (!t) return;

        const gAudio = getGlobalAudio();
        if (!gAudio) return;
        const curr = gAudio.getState();

        if (curr.isPlaying && curr.track && curr.track.id === t.id) {
          gAudio.pause();
        } else {
          gAudio.playTrack(t, tracksArray, idx);
        }
      });
    });

    container.querySelectorAll('.btn-open-track-detail').forEach((el) => {
      el.addEventListener('click', () => {
        openTrackPage(el.dataset.id);
      });
    });

    container.querySelectorAll('.btn-favorite-toggle').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const user = window.authManager && window.authManager.getUser();
        if (!user) {
          showToast('Войдите в аккаунт AllTell, чтобы сохранять треки в «Моё»', 'warning');
          return;
        }
        const id = parseInt(btn.dataset.id, 10);
        try {
          const res = await api(`/api/radio/favorites/${id}/toggle`, { method: 'POST' });
          if (res.favorited) {
            state.favoriteTrackIds.add(id);
            btn.classList.add('is-added');
            btn.title = 'Удалить из «Моё»';
            btn.innerHTML = '<i class="fas fa-xmark"></i>';
            showToast('Трек добавлен в «Моё»', 'success');
          } else {
            state.favoriteTrackIds.delete(id);
            btn.classList.remove('is-added');
            btn.title = 'Добавить в «Моё»';
            btn.innerHTML = '<i class="fas fa-plus"></i>';
            showToast('Трек удален из «Моё»', 'info');
          }
          if (typeof onFavoriteChange === 'function') onFavoriteChange(id, res.favorited);
        } catch (err) {
          showToast('Ошибка: ' + err.message, 'error');
        }
      });
    });

    container.querySelectorAll('.btn-add-to-playlist').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id, 10);
        openAddToPlaylistModal(id);
      });
    });
  }

  function renderPlaylistsGrid(container, playlists, isMine = false) {
    const currentUser = window.authManager && window.authManager.getUser();
    container.innerHTML = `
      <div class="radio-playlists-grid">
        ${playlists.map((p) => {
          const isOwner = isMine || Boolean(currentUser && (String(currentUser.id) === String(p.user_id) || currentUser.is_root || (currentUser.admin_level && currentUser.admin_level > 0)));
          const trackCount = p.trackCount || p.tracks_count || 0;
          const totalDur = p.totalDuration || p.total_duration || 0;
          return `
            <div class="radio-playlist-card" data-id="${p.id}">
              <div class="radio-playlist-cover-wrap btn-open-playlist" data-id="${p.id}">
                ${p.cover_url ? `<img src="${escapeHtml(p.cover_url)}" alt="">` : `<i class="fas fa-list-ul radio-playlist-cover-fallback"></i>`}
                <button type="button" class="radio-playlist-play-overlay btn-play-playlist" data-id="${p.id}" title="Слушать плейлист">
                  <i class="fas fa-play"></i>
                </button>
              </div>
              <div class="radio-playlist-body">
                <div class="radio-playlist-title btn-open-playlist" data-id="${p.id}">${escapeHtml(p.title)}</div>
                <div class="radio-playlist-desc">${escapeHtml(p.description || 'Без описания')}</div>
                <div class="radio-playlist-meta">
                  <span>${trackCount} треков • ${formatDuration(totalDur)}</span>
                  ${p.is_public ? '<span class="playlist-badge-public"><i class="fas fa-globe"></i> Публичный</span>' : '<span class="playlist-badge-private"><i class="fas fa-lock"></i> Закрытый</span>'}
                </div>
                ${isOwner ? `
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.06);">
                    <button type="button" class="btn btn-secondary btn-sm btn-open-playlist" data-id="${p.id}">Открыть</button>
                    <div style="display:flex; gap:6px;">
                      <button type="button" class="btn btn-secondary btn-sm btn-edit-playlist" data-id="${p.id}" title="Редактировать"><i class="fas fa-pen"></i></button>
                      <button type="button" class="btn btn-outline-danger btn-sm btn-delete-playlist" data-id="${p.id}" title="Удалить"><i class="fas fa-trash"></i></button>
                    </div>
                  </div>
                ` : `
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.06); font-size:0.8rem; color:#94a3b8;">
                    <span>Автор: <a href="/profile/${p.user_id}" style="color:#cbd5e1; text-decoration:none;">${escapeHtml(p.author_name)}</a></span>
                    <button type="button" class="btn btn-secondary btn-sm btn-open-playlist" data-id="${p.id}">Открыть</button>
                  </div>
                `}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    container.querySelectorAll('.btn-open-playlist').forEach((el) => {
      el.addEventListener('click', () => openPlaylistView(el.dataset.id));
    });

    container.querySelectorAll('.btn-play-playlist').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        try {
          const pl = await api(`/api/radio/playlists/${id}`);
          if (!pl.tracks || pl.tracks.length === 0) {
            showToast('В этом плейлисте пока нет треков', 'warning');
            return;
          }
          const gAudio = getGlobalAudio();
          if (gAudio) {
            gAudio.playTrack(pl.tracks[0], pl.tracks, 0);
            showToast(`Воспроизведение плейлиста «${pl.title}»`, 'success');
          }
        } catch (err) {
          showToast('Ошибка запуска плейлиста: ' + err.message, 'error');
        }
      });
    });

    container.querySelectorAll('.btn-edit-playlist').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        try {
          const pl = await api(`/api/radio/playlists/${id}`);
          openCreatePlaylistModal(pl);
        } catch (err) {
          showToast('Ошибка: ' + err.message, 'error');
        }
      });
    });

    container.querySelectorAll('.btn-delete-playlist').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const ok = await showConfirm('Удалить этот плейлист? Аудиозаписи останутся в медиатеке.', {
          title: 'Удалить плейлист?',
          confirmLabel: 'Удалить',
          danger: true
        });
        if (!ok) return;
        try {
          await api(`/api/radio/playlists/${id}`, { method: 'DELETE' });
          showToast('Плейлист удален', 'success');
          if (state.mySection === 'playlists') {
            loadMySection();
          } else if (state.feedFilter === 'playlists') {
            loadTracks();
          }
        } catch (err) {
          showToast('Ошибка удаления плейлиста: ' + err.message, 'error');
        }
      });
    });
  }

  // ===== Лента треков и подкастов =====
  async function loadTracks() {
    if (!dom.tracksList) return;
    dom.tracksList.innerHTML = '<p class="alltell-state">Загружаем данные…</p>';
    try {
      if (state.feedFilter === 'playlists') {
        const query = new URLSearchParams();
        query.set('includeMine', '1');
        if (state.feedSearch) query.set('search', state.feedSearch);
        const pData = await api(`/api/radio/playlists?${query.toString()}`);
        if (!pData.playlists || pData.playlists.length === 0) {
          dom.tracksList.innerHTML = `
            <div style="text-align:center; padding:40px; color:#94a3b8;">
              <i class="fas fa-list-ul" style="font-size:2rem; margin-bottom:12px; display:block; color:#64748b;"></i>
              Плейлисты пока не созданы. Создайте первый плейлист в разделе «Моё»!
            </div>
          `;
          return;
        }
        renderPlaylistsGrid(dom.tracksList, pData.playlists, false);
        return;
      }

      await loadFavoriteIds();

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

      dom.tracksList.innerHTML = data.tracks.map((t, idx) => renderTrackItemHtml(t, idx, data.tracks)).join('');
      attachTrackItemListeners(dom.tracksList, data.tracks);
    } catch (e) {
      if (dom.tracksList) {
        dom.tracksList.innerHTML = `<p class="alltell-error">Ошибка загрузки: ${escapeHtml(e.message)}</p>`;
      }
    }
  }

  // ===== Раздел «Моё» (Понравившееся, плейлисты, мои треки) =====
  async function loadMySection() {
    if (!dom.mySectionContent) return;
    const user = window.authManager && window.authManager.getUser();
    if (!user) {
      dom.mySectionContent.innerHTML = `
        <div style="text-align:center; padding:60px 20px; background:rgba(18,20,27,0.6); border-radius:16px; border:1px dashed rgba(255,255,255,0.15);">
          <div style="font-size:3rem; color:#ff4757; margin-bottom:16px;"><i class="fas fa-heart"></i></div>
          <h3 style="margin-bottom:8px;">Ваша коллекция музыки и плейлистов</h3>
          <p style="color:#94a3b8; max-width:480px; margin:0 auto 20px auto;">
            Войдите в аккаунт AllTell, чтобы сохранять понравившиеся аудиозаписи, создавать свои плейлисты и настраивать их приватность.
          </p>
          <button type="button" class="btn btn-primary btn-lg" onclick="document.querySelector('[data-auth-tab=\\'login\\']')?.click()">
            <i class="fas fa-right-to-bracket"></i> Войти в аккаунт
          </button>
        </div>
      `;
      return;
    }

    dom.mySectionContent.innerHTML = '<p class="alltell-state">Загружаем данные раздела «Моё»…</p>';

    if (state.mySection === 'favorites') {
      try {
        await loadFavoriteIds();
        const data = await api('/api/radio/favorites?limit=100');
        if (!data.tracks || data.tracks.length === 0) {
          dom.mySectionContent.innerHTML = `
            <div style="text-align:center; padding:50px 20px; color:#94a3b8;">
              <i class="fas fa-heart-crack" style="font-size:2.5rem; margin-bottom:12px; display:block; color:#475569;"></i>
              В «Моё» пока нет сохранённых треков.<br>
              Нажмите <strong>+</strong> рядом с любым треком в ленте, чтобы сохранить его сюда.
            </div>
          `;
          return;
        }
        dom.mySectionContent.innerHTML = data.tracks.map((t, idx) => renderTrackItemHtml(t, idx, data.tracks, true)).join('');
        attachTrackItemListeners(dom.mySectionContent, data.tracks, (id, favorited) => {
          if (!favorited) {
            loadMySection();
          }
        });
      } catch (err) {
        dom.mySectionContent.innerHTML = `<p class="alltell-state is-error">Ошибка загрузки избранного: ${escapeHtml(err.message)}</p>`;
      }
    } else if (state.mySection === 'playlists') {
      try {
        const data = await api('/api/radio/playlists/mine');
        if (!data.playlists || data.playlists.length === 0) {
          dom.mySectionContent.innerHTML = `
            <div style="text-align:center; padding:50px 20px; color:#94a3b8;">
              <i class="fas fa-list-ul" style="font-size:2.5rem; margin-bottom:12px; display:block; color:#475569;"></i>
              У вас пока нет созданных плейлистов.<br><br>
              <button type="button" class="btn btn-primary" onclick="window.RadioClient.openCreatePlaylistModal()">
                <i class="fas fa-plus"></i> Создать первый плейлист
              </button>
            </div>
          `;
          return;
        }
        renderPlaylistsGrid(dom.mySectionContent, data.playlists, true);
      } catch (err) {
        dom.mySectionContent.innerHTML = `<p class="alltell-state is-error">Ошибка загрузки плейлистов: ${escapeHtml(err.message)}</p>`;
      }
    } else if (state.mySection === 'mytracks') {
      try {
        await loadFavoriteIds();
        const data = await api(`/api/radio/tracks?userId=${user.id}&limit=100`);
        if (!data.tracks || data.tracks.length === 0) {
          dom.mySectionContent.innerHTML = `
            <div style="text-align:center; padding:50px 20px; color:#94a3b8;">
              <i class="fas fa-music" style="font-size:2.5rem; margin-bottom:12px; display:block; color:#475569;"></i>
              Вы ещё не опубликовали ни одной аудиозаписи.<br><br>
              <button type="button" class="btn btn-primary" onclick="window.RadioClient.openUploadModal()">
                <i class="fas fa-cloud-arrow-up"></i> Опубликовать аудио
              </button>
            </div>
          `;
          return;
        }
        dom.mySectionContent.innerHTML = data.tracks.map((t, idx) => renderTrackItemHtml(t, idx, data.tracks)).join('');
        attachTrackItemListeners(dom.mySectionContent, data.tracks);
      } catch (err) {
        dom.mySectionContent.innerHTML = `<p class="alltell-state is-error">Ошибка загрузки записей: ${escapeHtml(err.message)}</p>`;
      }
    }
  }

  // ===== Модальные окна плейлистов =====

  function openCreatePlaylistModal(playlistToEdit = null) {
    const user = window.authManager && window.authManager.getUser();
    if (!user) {
      showToast('Войдите в аккаунт AllTell, чтобы создавать плейлисты', 'warning');
      return;
    }

    const modal = document.getElementById('modalCreatePlaylist');
    const title = document.getElementById('modalCreatePlaylistTitle');
    const editId = document.getElementById('editPlaylistId');
    const titleInput = document.getElementById('playlistTitleInput');
    const descInput = document.getElementById('playlistDescInput');
    const pubSelect = document.getElementById('playlistPublicSelect');
    const coverInput = document.getElementById('playlistCoverInput');
    const previewBox = document.getElementById('playlistCoverPreviewBox');
    const previewImg = document.getElementById('playlistCoverPreviewImg');

    if (playlistToEdit) {
      if (title) title.textContent = 'Редактировать плейлист';
      if (editId) editId.value = playlistToEdit.id;
      if (titleInput) titleInput.value = playlistToEdit.title;
      if (descInput) descInput.value = playlistToEdit.description || '';
      if (pubSelect) pubSelect.value = playlistToEdit.is_public ? '1' : '0';
      if (playlistToEdit.cover_url && previewBox && previewImg) {
        previewImg.src = playlistToEdit.cover_url;
        previewBox.style.display = 'block';
      } else if (previewBox) {
        previewBox.style.display = 'none';
      }
    } else {
      if (title) title.textContent = 'Создать плейлист';
      if (editId) editId.value = '';
      if (titleInput) titleInput.value = '';
      if (descInput) descInput.value = '';
      if (pubSelect) pubSelect.value = '1';
      if (coverInput) coverInput.value = '';
      if (previewBox) previewBox.style.display = 'none';
    }

    showModal(modal);
  }

  async function openAddToPlaylistModal(trackId) {
    const user = window.authManager && window.authManager.getUser();
    if (!user) {
      showToast('Войдите в аккаунт AllTell, чтобы сохранять треки в плейлисты', 'warning');
      return;
    }

    const modal = document.getElementById('modalPickPlaylistForTrack');
    const list = document.getElementById('pickPlaylistForTrackList');
    showModal(modal);

    if (list) list.innerHTML = '<p class="alltell-state">Загружаем ваши плейлисты…</p>';

    try {
      const data = await api('/api/radio/playlists/mine');
      if (!data.playlists || data.playlists.length === 0) {
        if (list) {
          list.innerHTML = `
            <div style="text-align:center; padding:30px; color:#94a3b8;">
              <p>У вас пока нет плейлистов.</p>
              <button type="button" class="btn btn-primary" id="btnCreateFromPickInline">
                <i class="fas fa-plus"></i> Создать плейлист
              </button>
            </div>
          `;
          document.getElementById('btnCreateFromPickInline')?.addEventListener('click', () => {
            hideModal(modal);
            openCreatePlaylistModal();
          });
        }
        return;
      }

      if (list) {
        list.innerHTML = data.playlists.map((p) => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#12141a; border-radius:10px; margin-bottom:8px;">
            <div style="display:flex; align-items:center; gap:10px;">
              <div style="width:36px; height:36px; border-radius:8px; overflow:hidden; background:#1a1d26; display:flex; align-items:center; justify-content:center;">
                ${p.cover_url ? `<img src="${escapeHtml(p.cover_url)}" style="width:100%; height:100%; object-fit:cover;">` : '<i class="fas fa-list-ul" style="color:#64748b;"></i>'}
              </div>
              <div>
                <strong style="color:#fff; display:block;">${escapeHtml(p.title)}</strong>
                <span style="font-size:0.8rem; color:#94a3b8;">${p.trackCount || 0} треков • ${p.is_public ? 'Публичный' : 'Свой'}</span>
              </div>
            </div>
            <button type="button" class="btn btn-primary btn-sm btn-pick-pl-target" data-id="${p.id}">
              <i class="fas fa-plus"></i> Добавить
            </button>
          </div>
        `).join('');

        list.querySelectorAll('.btn-pick-pl-target').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const plId = btn.dataset.id;
            try {
              btn.disabled = true;
              btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
              const res = await api(`/api/radio/playlists/${plId}/tracks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ track_id: trackId })
              });
              if (res.alreadyExists) {
                showToast('Трек уже есть в этом плейлисте', 'info');
              } else {
                showToast('Трек успешно добавлен в плейлист!', 'success');
              }
              hideModal(modal);
            } catch (err) {
              showToast('Ошибка добавления: ' + err.message, 'error');
              btn.disabled = false;
              btn.innerHTML = '<i class="fas fa-plus"></i> Добавить';
            }
          });
        });
      }
    } catch (err) {
      if (list) list.innerHTML = `<p class="alltell-state is-error">Ошибка: ${escapeHtml(err.message)}</p>`;
    }
  }

  async function openPlaylistView(playlistId) {
    const modal = document.getElementById('modalPlaylistView');
    const header = document.getElementById('playlistViewHeader');
    const list = document.getElementById('playlistViewTracksList');
    showModal(modal);

    if (header) header.innerHTML = '<p class="alltell-state">Загружаем плейлист…</p>';
    if (list) list.innerHTML = '';

    try {
      const pl = await api(`/api/radio/playlists/${playlistId}`);
      if (!pl) throw new Error('Плейлист не найден');

      const currentUser = window.authManager && window.authManager.getUser();
      const isOwnerOrAdmin = currentUser && (currentUser.id === pl.user_id || currentUser.is_root || currentUser.admin_level > 0);

      if (header) {
        header.innerHTML = `
          <div style="display:flex; gap:18px; align-items:center;">
            <div style="width:110px; height:110px; border-radius:12px; overflow:hidden; background:#12141a; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
              ${pl.cover_url ? `<img src="${escapeHtml(pl.cover_url)}" style="width:100%; height:100%; object-fit:cover;">` : '<i class="fas fa-list-ul" style="font-size:2.5rem; color:#64748b;"></i>'}
            </div>
            <div style="flex:1;">
              <div style="margin-bottom:6px;">
                ${pl.is_public ? '<span class="playlist-badge-public"><i class="fas fa-globe"></i> Публичный</span>' : '<span class="playlist-badge-private"><i class="fas fa-lock"></i> Свой</span>'}
              </div>
              <h2 style="margin:0 0 6px 0; font-size:1.35rem; color:#fff;">${escapeHtml(pl.title)}</h2>
              <div style="font-size:0.85rem; color:#94a3b8; margin-bottom:8px;">
                Автор: <a href="/profile/${pl.user_id}" style="color:#cbd5e1; text-decoration:none;">${escapeHtml(pl.author_name)}</a> • ${pl.trackCount || 0} треков • ${formatDuration(pl.totalDuration || 0)}
              </div>
              ${pl.description ? `<p style="font-size:0.85rem; color:#cbd5e1; margin:0 0 10px 0;">${escapeHtml(pl.description)}</p>` : ''}
              <button type="button" class="btn btn-primary btn-sm btn-play-all-playlist" ${!pl.tracks || pl.tracks.length === 0 ? 'disabled' : ''}>
                <i class="fas fa-play"></i> Слушать плейлист
              </button>
            </div>
          </div>
        `;

        header.querySelector('.btn-play-all-playlist')?.addEventListener('click', () => {
          if (pl.tracks && pl.tracks.length > 0) {
            const gAudio = getGlobalAudio();
            if (gAudio) {
              gAudio.playTrack(pl.tracks[0], pl.tracks, 0);
              showToast(`Воспроизведение плейлиста «${pl.title}»`, 'success');
            }
          }
        });
      }

      if (list) {
        if (!pl.tracks || pl.tracks.length === 0) {
          list.innerHTML = '<p style="text-align:center; color:#94a3b8; padding:30px;">В плейлисте пока нет треков. Добавьте треки из ленты!</p>';
        } else {
          list.innerHTML = pl.tracks.map((t, idx) => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#12141a; border-radius:10px; margin-bottom:8px;">
              <div style="display:flex; align-items:center; gap:12px;">
                <span style="color:#64748b; font-weight:700; width:22px; text-align:center;">${idx + 1}</span>
                <button type="button" class="radio-track-play-btn btn-play-pl-track" data-index="${idx}" title="Воспроизвести">
                  <i class="fas fa-play"></i>
                </button>
                <div>
                  <strong style="color:#fff; display:block;">${escapeHtml(t.title)}</strong>
                  <span style="font-size:0.8rem; color:#94a3b8;">${escapeHtml(t.author_name)} • ${formatDuration(t.duration)}</span>
                </div>
              </div>
              <div style="display:flex; align-items:center; gap:8px;">
                ${isOwnerOrAdmin ? `
                  <button type="button" class="btn btn-outline-danger btn-sm btn-remove-track-from-pl" data-id="${t.id}" title="Удалить из плейлиста">
                    <i class="fas fa-xmark"></i>
                  </button>
                ` : ''}
              </div>
            </div>
          `).join('');

          list.querySelectorAll('.btn-play-pl-track').forEach((btn) => {
            btn.addEventListener('click', () => {
              const idx = parseInt(btn.dataset.index, 10);
              const gAudio = getGlobalAudio();
              if (gAudio) gAudio.playTrack(pl.tracks[idx], pl.tracks, idx);
            });
          });

          if (isOwnerOrAdmin) {
            list.querySelectorAll('.btn-remove-track-from-pl').forEach((btn) => {
              btn.addEventListener('click', async () => {
                const trackId = btn.dataset.id;
                try {
                  await api(`/api/radio/playlists/${playlistId}/tracks/${trackId}`, { method: 'DELETE' });
                  showToast('Трек удален из плейлиста', 'info');
                  openPlaylistView(playlistId);
                  if (state.mySection === 'playlists') loadMySection();
                } catch (err) {
                  showToast('Ошибка: ' + err.message, 'error');
                }
              });
            });
          }
        }
      }
    } catch (err) {
      if (header) header.innerHTML = `<p class="alltell-state is-error">Ошибка: ${escapeHtml(err.message)}</p>`;
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

  function updateTrackPageFavoriteUI() {
    if (!currentViewingTrack || !dom.trackPageFavoriteBtn) return;
    const isFav = state.favoriteTrackIds.has(currentViewingTrack.id);
    if (isFav) {
      dom.trackPageFavoriteBtn.className = 'btn btn-outline-danger';
      dom.trackPageFavoriteBtn.innerHTML = '<i class="fas fa-xmark"></i> <span>Удалить из «Моё»</span>';
      dom.trackPageFavoriteBtn.title = 'Удалить из «Моё»';
    } else {
      dom.trackPageFavoriteBtn.className = 'btn btn-primary';
      dom.trackPageFavoriteBtn.innerHTML = '<i class="fas fa-plus"></i> <span>В «Моё»</span>';
      dom.trackPageFavoriteBtn.title = 'Сохранить в «Моё»';
    }
  }

  async function openTrackPage(trackId) {
    try {
      const track = await api('/api/radio/tracks/' + trackId);
      if (!track) throw new Error('Трек не найден');
      currentViewingTrack = track;

      // Скрываем табы и показываем страницу трека
      if (dom.navTabs) { dom.navTabs.hidden = true; dom.navTabs.style.display = 'none'; }
      if (dom.tabLive) { dom.tabLive.hidden = true; dom.tabLive.style.display = 'none'; }
      if (dom.tabFeed) { dom.tabFeed.hidden = true; dom.tabFeed.style.display = 'none'; }
      if (dom.tabMy) { dom.tabMy.hidden = true; dom.tabMy.style.display = 'none'; }
      if (dom.tabEditor) { dom.tabEditor.hidden = true; dom.tabEditor.style.display = 'none'; }
      if (dom.trackView) { dom.trackView.hidden = false; dom.trackView.style.display = 'block'; }
      const gAudio = getGlobalAudio();
      if (gAudio) gAudio.syncBar();

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

      await loadFavoriteIds();
      updateTrackPageFavoriteUI();

      const currentUser = window.authManager && window.authManager.getUser();
      const isOwnerOrAdmin = currentUser && (
        Number(currentUser.id) === Number(track.user_id) ||
        Boolean(currentUser.is_root) ||
        Number(currentUser.admin_level) > 0 ||
        Boolean(currentUser.is_admin) ||
        currentUser.role === 'admin' ||
        currentUser.role === 'root'
      );
      if (dom.trackPageDeleteBtn) {
        dom.trackPageDeleteBtn.style.display = isOwnerOrAdmin ? 'inline-flex' : 'none';
      }

      if (gAudio) {
        const gState = gAudio.getState();
        if (dom.trackPageLoopBtn) {
          dom.trackPageLoopBtn.classList.toggle('is-active', Boolean(gState.isLoop));
          dom.trackPageLoopBtn.title = gState.isLoop ? 'Зацикливание включено (нажмите, чтобы выключить)' : 'Зациклить';
        }
        if (dom.trackPagePlayBtn) {
          const isThisPlaying = gState.isPlaying && gState.track && gState.track.id === track.id;
          dom.trackPagePlayBtn.innerHTML = isThisPlaying ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
        }
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

  function genBlockId() {
    return 'rb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // Компиляция блочной модели в плоскую последовательность слотов для бэкенда
  function compileBlocksToSlots(blocks, startTimeIso) {
    let cursor = new Date(startTimeIso || Date.now()).getTime();
    if (isNaN(cursor)) cursor = Date.now();
    const compiled = [];

    for (const b of (blocks || [])) {
      if (b.type === 'track') {
        const dur = Math.max(1, Number(b.duration) || 0);
        const startMs = cursor;
        const endMs = cursor + dur * 1000;
        compiled.push({
          block_id: b.id,
          track_id: b.track_id || null,
          title: b.title || 'Аудиозапись',
          type: b.subType || 'track',
          audio_url: b.audio_url,
          duration: dur,
          start_time: new Date(startMs).toISOString(),
          end_time: new Date(endMs).toISOString()
        });
        cursor = endMs;
      } else if (b.type === 'playlist') {
        for (const item of (b.items || [])) {
          const dur = Math.max(1, Number(item.duration) || 0);
          const startMs = cursor;
          const endMs = cursor + dur * 1000;
          compiled.push({
            block_id: b.id,
            playlist_id: b.playlist_id,
            playlist_title: b.title,
            track_id: item.track_id || item.id || null,
            title: item.title || 'Трек плейлиста',
            type: item.type || 'track',
            audio_url: item.audio_url,
            duration: dur,
            start_time: new Date(startMs).toISOString(),
            end_time: new Date(endMs).toISOString()
          });
          cursor = endMs;
        }
      } else if (b.type === 'speech' || b.type === 'jingle') {
        const dur = Math.max(1, Number(b.duration) || 0);
        const startMs = cursor;
        const endMs = cursor + dur * 1000;
        compiled.push({
          block_id: b.id,
          track_id: b.track_id || null,
          title: b.title || (b.type === 'speech' ? 'Слова ведущего' : 'Джингл'),
          type: b.type === 'speech' ? 'speech' : 'track',
          audio_url: b.audio_url,
          duration: dur,
          start_time: new Date(startMs).toISOString(),
          end_time: new Date(endMs).toISOString()
        });
        cursor = endMs;
      } else if (b.type === 'time_anchor') {
        const dur = Math.max(1, Number(b.duration) || 0);
        const startMs = cursor;
        const endMs = cursor + dur * 1000;
        compiled.push({
          block_id: b.id,
          track_id: b.track_id || null,
          title: b.title || 'Слова к точному времени',
          type: 'speech',
          audio_url: b.audio_url,
          duration: dur,
          start_time: new Date(startMs).toISOString(),
          end_time: new Date(endMs).toISOString()
        });
        cursor = endMs;
      } else if (b.type === 'gap') {
        const dur = Math.max(1, Number(b.duration) || 0);
        const startMs = cursor;
        const endMs = cursor + dur * 1000;
        compiled.push({
          block_id: b.id,
          track_id: null,
          title: b.title || 'Пауза в эфире (музыкальная пустота)',
          type: 'gap',
          audio_url: '',
          duration: dur,
          start_time: new Date(startMs).toISOString(),
          end_time: new Date(endMs).toISOString()
        });
        cursor = endMs;
      }
    }

    const totalSec = compiled.reduce((acc, s) => acc + (Number(s.duration) || 0), 0);
    return {
      slots: compiled,
      totalDurationSec: totalSec,
      endTimeIso: new Date(cursor).toISOString()
    };
  }

  // Обратный парсер: превращает массив слотов бэкенда в блоки редактора
  function convertSlotsToBlocks(slots) {
    const blocks = [];
    let currentPlaylist = null;

    for (const s of (slots || [])) {
      if (s.playlist_id) {
        if (currentPlaylist && currentPlaylist.playlist_id === s.playlist_id) {
          currentPlaylist.items.push({
            track_id: s.track_id,
            title: s.title,
            audio_url: s.audio_url,
            duration: Number(s.duration) || 0,
            type: s.type
          });
          currentPlaylist.duration += Number(s.duration) || 0;
          continue;
        } else {
          currentPlaylist = {
            id: genBlockId(),
            type: 'playlist',
            playlist_id: s.playlist_id,
            title: s.playlist_title || 'Плейлист эфира',
            duration: Number(s.duration) || 0,
            items: [{
              track_id: s.track_id,
              title: s.title,
              audio_url: s.audio_url,
              duration: Number(s.duration) || 0,
              type: s.type
            }],
            isCollapsed: true
          };
          blocks.push(currentPlaylist);
          continue;
        }
      }

      currentPlaylist = null;
      blocks.push({
        id: genBlockId(),
        type: s.type === 'speech' ? 'speech' : s.type === 'jingle' ? 'jingle' : 'track',
        track_id: s.track_id,
        title: s.title,
        audio_url: s.audio_url,
        duration: Number(s.duration) || 0,
        subType: s.type
      });
    }

    return blocks;
  }

  function syncCompiledSlots() {
    const compiled = compileBlocksToSlots(state.editorBlocks, state.editorStartTime);
    state.editorSlots = compiled.slots;
    return compiled;
  }

  function updateEditorLiveStatusBadge(isLive, startMs) {
    const badge = document.getElementById('editorLiveStatusBadge');
    if (!badge) return;
    if (!state.selectedStationForEdit || !state.editorBlocks || state.editorBlocks.length === 0) {
      badge.style.display = 'none';
      return;
    }
    badge.style.display = 'inline-flex';
    badge.style.alignItems = 'center';
    badge.style.gap = '6px';
    if (isLive) {
      badge.style.background = '#16a34a';
      badge.style.color = '#fff';
      badge.innerHTML = '<i class="fas fa-tower-broadcast fa-fade"></i> В эфире прямо сейчас';
      badge.title = 'Вещание идет прямо сейчас по виртуальному расписанию';
    } else {
      badge.style.background = '#2563eb';
      badge.style.color = '#fff';
      badge.innerHTML = `<i class="far fa-clock"></i> Старт в ${formatClockTime(startMs)}`;
      badge.title = 'Вещание запланировано на будущее время и запустится автоматически';
    }
  }

  // Запуск / публикация вещания радиостанции
  async function publishBroadcast(startTime, options = {}) {
    const { notify = true, autoTune = true } = options;
    if (!state.selectedStationForEdit) {
      if (state.myStations && state.myStations.length > 0) {
        state.selectedStationForEdit = state.myStations[0];
        if (dom.editorStationSelect) dom.editorStationSelect.value = state.myStations[0].id;
      } else {
        if (notify) showToast('Пожалуйста, выберите радиостанцию для вещания', 'warning');
        return false;
      }
    }

    if (startTime) {
      setEditorStartTime(startTime);
    }
    syncCompiledSlots();

    if (!state.editorSlots || state.editorSlots.length === 0) {
      if (notify) showToast('Сетка вещания пуста. Добавьте треки или плейлисты перед стартом эфира.', 'warning');
      return false;
    }

    const st = state.selectedStationForEdit;
    const startMs = state.editorStartTime ? new Date(state.editorStartTime).getTime() : Date.now();
    const isLiveNow = startMs <= Date.now();

    try {
      if (dom.btnSaveTimeline) {
        dom.btnSaveTimeline.disabled = true;
        dom.btnSaveTimeline.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Запуск вещания…';
      }

      await api(`/api/radio/stations/${st.id}/timeline`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slots: state.editorSlots,
          startTime: state.editorStartTime || new Date().toISOString()
        })
      });

      renderEditor();
      await loadStations();

      if (notify) {
        if (isLiveNow) {
          showToast(`🔴 Вещание радиостанции «${st.name}» успешно запущено в прямой эфир!`, 'success');
        } else {
          showToast(`🕒 Старт радиостанции «${st.name}» запланирован на ${formatClockTime(startMs)}. Эфир запустится точно по расписанию.`, 'info');
        }
      }

      // Если эфир активен прямо сейчас, настраиваем станцию и запускаем проигрывание с нужного времени!
      if (isLiveNow && autoTune) {
        const gAudio = getGlobalAudio();
        const gState = gAudio ? gAudio.getState() : {};
        const isAlreadyPlayingThisStation = gState.isPlaying && gState.mode === 'radio' && gState.station && String(gState.station.id) === String(st.id);
        if (!isAlreadyPlayingThisStation) {
          tuneStation(st, true);
        } else {
          updateDeckUI();
        }
      }

      return true;
    } catch (e) {
      console.error('[radio] Error starting broadcast:', e);
      if (notify) showToast('Ошибка запуска вещания: ' + e.message, 'error');
      return false;
    } finally {
      if (dom.btnSaveTimeline) {
        dom.btnSaveTimeline.disabled = false;
        dom.btnSaveTimeline.innerHTML = '<i class="fas fa-tower-broadcast"></i> Опубликовать в эфир (24ч)';
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
      state.editorBlocks = convertSlotsToBlocks(slots || []);

      // Если в сетке уже есть слоты — сохраняем исходное время начала эфира,
      // чтобы при нажатии «Опубликовать в эфир» эфир не откатывался к началу!
      if (slots && slots.length > 0 && slots[0].start_time) {
        setEditorStartTime(slots[0].start_time);
      } else {
        setEditorStartTime(getEffectiveNowMs());
      }

      renderEditor();
    } catch (e) {
      console.error('[radio] Error loading timeline:', e);
    }
  }

  // 1. Отрисовка видеомонтажной шкалы времени (Timeline Ribbon)
  function renderTimelineRibbon() {
    if (!dom.radioTimelineContainer) return;
    const { totalDurationSec, endTimeIso } = syncCompiledSlots();

    if (dom.timelineTotalDuration) {
      dom.timelineTotalDuration.textContent = formatDuration(totalDurationSec);
    }
    if (dom.timelineEndTime) {
      dom.timelineEndTime.textContent = formatClockTime(endTimeIso);
    }

    // Растущая шкала: базовая 20 минут (1200 сек), чем больше треков, тем больше растет!
    const baseScale = state.baseScaleSec || 1200;
    const neededScale = Math.max(baseScale, Math.ceil(totalDurationSec * 1.12));
    const effectiveScale = Math.max(60, Math.round(neededScale / state.timelineZoom));

    if (dom.timelineScaleBadge) {
      const min = Math.round(effectiveScale / 60);
      dom.timelineScaleBadge.textContent = min >= 60 ? `Шкала: ${(min / 60).toFixed(1)} ч` : `Шкала: ${min} мин`;
    }

    // Отрисовка временной линейки (Ruler)
    if (dom.radioTimelineRuler) {
      let stepSec = 300; // 5 минут
      if (effectiveScale > 3600 * 6) stepSec = 3600; // 1 час
      else if (effectiveScale > 3600 * 2) stepSec = 1800; // 30 мин
      else if (effectiveScale > 1800) stepSec = 600; // 10 мин
      else if (effectiveScale < 600) stepSec = 60; // 1 мин

      const baseStartMs = new Date(state.editorStartTime || Date.now()).getTime();
      let ticksHtml = '';
      for (let sec = 0; sec <= effectiveScale; sec += stepSec) {
        const pct = (sec / effectiveScale) * 100;
        const tickTime = formatClockTime(baseStartMs + sec * 1000);
        ticksHtml += `<div class="radio-timeline-tick" style="left: ${pct.toFixed(2)}%;">${tickTime.slice(0, 5)}</div>`;
      }
      dom.radioTimelineRuler.innerHTML = ticksHtml;
    }

    // Отрисовка дорожки клипов
    if (dom.radioTimelineTrack) {
      if (state.editorBlocks.length === 0) {
        dom.radioTimelineTrack.innerHTML = '<div class="radio-timeline-empty-hint"><i class="fas fa-hand-pointer"></i> Добавьте треки или плейлисты ниже, чтобы наполнить ленту вещания</div>';
      } else {
        dom.radioTimelineTrack.innerHTML = state.editorBlocks.map((block, idx) => {
          const pct = Math.max(1.8, (block.duration / effectiveScale) * 100);
          const typeClass = `clip-${block.type}`;
          const isPlaylist = block.type === 'playlist';
          const icon = isPlaylist ? 'fa-list-check' : block.type === 'speech' ? 'fa-microphone' : block.type === 'jingle' ? 'fa-bell' : block.type === 'time_anchor' ? 'fa-anchor' : block.type === 'gap' ? 'fa-pause' : 'fa-music';
          const titleText = escapeHtml(block.title);
          const durText = formatDuration(block.duration);
          const subInfo = isPlaylist ? ` (${(block.items || []).length} тр)` : '';

          return `
            <div class="radio-timeline-clip ${typeClass}" data-block-id="${block.id}" data-index="${idx}" draggable="true" style="width: ${pct.toFixed(2)}%;" title="${titleText}${subInfo} — ${durText}">
              ${isPlaylist ? '<div class="radio-clip-bracket bracket-left" title="Начало плейлиста ["></div>' : ''}
              <div class="clip-title"><i class="fas ${icon}"></i> ${titleText}${subInfo}</div>
              <div class="clip-dur">${durText}</div>
              ${isPlaylist ? '<div class="radio-clip-bracket bracket-right" title="] Конец плейлиста"></div>' : ''}
              <div class="radio-timeline-edge-handle" data-index="${idx}" title="Потяните за край блока, чтобы изменить длительность и увеличить таймлайн"></div>
            </div>
          `;
        }).join('');

        let isEdgeResizing = false;

        // Перемещение блоков по таймлайну (Drag & Drop) и взаимодействие с клипами
        dom.radioTimelineTrack.querySelectorAll('.radio-timeline-clip').forEach((el) => {
          el.addEventListener('click', (e) => {
            if (isEdgeResizing || e.target.closest('.radio-timeline-edge-handle')) return;
            const blockId = el.dataset.blockId;
            const card = document.getElementById('block_' + blockId);
            if (card) {
              card.scrollIntoView({ behavior: 'smooth', block: 'center' });
              card.style.outline = '2px solid var(--brand-accent, #6366f1)';
              setTimeout(() => { card.style.outline = ''; }, 1200);
            }
          });

          el.addEventListener('dblclick', (e) => {
            if (isEdgeResizing || e.target.closest('.radio-timeline-edge-handle')) return;
            e.stopPropagation();
            const bIdx = parseInt(el.dataset.index, 10);
            playEditorBlock(bIdx);
          });

          el.addEventListener('dragstart', (e) => {
            if (isEdgeResizing || e.target.closest('.radio-timeline-edge-handle')) {
              e.preventDefault();
              return;
            }
            const bIdx = parseInt(el.dataset.index, 10);
            state.draggedBlockIndex = bIdx;
            el.classList.add('is-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', JSON.stringify({
              type: 'move_block',
              index: bIdx,
              blockId: el.dataset.blockId
            }));
          });

          el.addEventListener('dragend', () => {
            state.draggedBlockIndex = null;
            el.classList.remove('is-dragging');
            dom.radioTimelineTrack?.querySelectorAll('.radio-timeline-clip').forEach((c) => {
              c.classList.remove('is-drag-over', 'is-drag-over-left', 'is-drag-over-right');
            });
            if (dom.radioTimelineTrack) dom.radioTimelineTrack.style.outline = '';
          });

          el.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            const rect = el.getBoundingClientRect();
            const isRightHalf = (e.clientX - rect.left) > (rect.width / 2);
            el.classList.toggle('is-drag-over-left', !isRightHalf);
            el.classList.toggle('is-drag-over-right', isRightHalf);
            el.classList.add('is-drag-over');
          });

          el.addEventListener('dragleave', (e) => {
            if (!el.contains(e.relatedTarget)) {
              el.classList.remove('is-drag-over', 'is-drag-over-left', 'is-drag-over-right');
            }
          });

          el.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            el.classList.remove('is-drag-over', 'is-drag-over-left', 'is-drag-over-right');

            const targetIdx = parseInt(el.dataset.index, 10);
            const rect = el.getBoundingClientRect();
            const isRightHalf = (e.clientX - rect.left) > (rect.width / 2);
            const insertIdx = isRightHalf ? targetIdx + 1 : targetIdx;

            let fromIdx = state.draggedBlockIndex;
            if (fromIdx === null || fromIdx === undefined) {
              try {
                const raw = e.dataTransfer.getData('text/plain');
                if (raw) {
                  const data = JSON.parse(raw);
                  if (data && data.type === 'move_block' && data.index !== undefined) fromIdx = data.index;
                }
              } catch (_) {}
            }

            if (fromIdx !== null && fromIdx !== undefined && !isNaN(fromIdx)) {
              if (fromIdx === insertIdx || fromIdx === insertIdx - 1) return;
              const item = state.editorBlocks.splice(fromIdx, 1)[0];
              const actualTargetIdx = fromIdx < insertIdx ? insertIdx - 1 : insertIdx;
              state.editorBlocks.splice(actualTargetIdx, 0, item);
              renderEditor();
              showToast(`Блок «${item.title || 'Элемент'}» перемещен на ленте`, 'info');
              return;
            }

            // Перетаскивание из боковой шторки
            try {
              const raw = e.dataTransfer.getData('text/plain');
              if (raw) {
                const item = JSON.parse(raw);
                if (item && item.type) {
                  if (item.type === 'playlist') {
                    openPickPlaylistForTimeline(item.id, insertIdx);
                  } else {
                    addBlockToEditor({
                      type: item.type === 'speech' ? 'speech' : 'track',
                      track_id: item.id,
                      title: item.title,
                      audio_url: item.audio_url,
                      duration: Number(item.duration) || 180
                    }, insertIdx);
                  }
                }
              }
            } catch (_) {}
          });
        });

        // Отодвигание за край блока (Edge Resize & Dynamic Timeline Expansion)
        dom.radioTimelineTrack.querySelectorAll('.radio-timeline-edge-handle').forEach((handle) => {
          handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            isEdgeResizing = true;
            handle.classList.add('is-resizing');

            const bIdx = parseInt(handle.dataset.index, 10);
            const block = state.editorBlocks[bIdx];
            if (!block) { isEdgeResizing = false; return; }

            const clipEl = handle.closest('.radio-timeline-clip');
            const initialDuration = Math.max(5, Number(block.duration) || 0);
            const startX = e.clientX;
            const trackRect = dom.radioTimelineTrack.getBoundingClientRect();
            const initialTotalDur = totalDurationSec;
            const initialBaseScale = state.baseScaleSec || 1200;
            const currentZoom = state.timelineZoom || 1.0;
            const secPerPx = effectiveScale / Math.max(10, trackRect.width);

            const tooltip = document.createElement('div');
            tooltip.className = 'radio-timeline-resize-tooltip';
            tooltip.innerHTML = `<span>${escapeHtml(block.title)}</span>: <strong>${formatDuration(initialDuration)}</strong>`;
            document.body.appendChild(tooltip);

            const updateTooltipPos = (clientX, clientY) => {
              tooltip.style.left = `${clientX}px`;
              tooltip.style.top = `${clientY}px`;
            };
            updateTooltipPos(e.clientX, e.clientY);

            let lastCalculatedDur = initialDuration;
            let lastTotalSec = initialTotalDur;

            const onMouseMove = (ev) => {
              const deltaX = ev.clientX - startX;
              const deltaSec = Math.round(deltaX * secPerPx);
              lastCalculatedDur = Math.max(5, initialDuration + deltaSec);
              const diffSec = lastCalculatedDur - initialDuration;
              lastTotalSec = Math.max(5, initialTotalDur + diffSec);

              // Отодвигание за край блока увеличивает временную линию в реальном времени!
              if (lastTotalSec > initialBaseScale) {
                state.baseScaleSec = Math.max(initialBaseScale, Math.ceil(lastTotalSec * 1.15));
                const newEffScale = Math.max(60, Math.round(state.baseScaleSec / currentZoom));
                if (dom.timelineScaleBadge) {
                  const min = Math.round(newEffScale / 60);
                  dom.timelineScaleBadge.textContent = min >= 60 ? `Шкала: ${(min / 60).toFixed(1)} ч` : `Шкала: ${min} мин`;
                }
              }

              const activeScale = Math.max(60, Math.round(Math.max(state.baseScaleSec || 1200, Math.ceil(lastTotalSec * 1.12)) / currentZoom));
              const newPct = Math.max(1.8, (lastCalculatedDur / activeScale) * 100);
              if (clipEl) {
                clipEl.style.width = `${newPct.toFixed(2)}%`;
                const durEl = clipEl.querySelector('.clip-dur');
                if (durEl) durEl.textContent = formatDuration(lastCalculatedDur);
              }

              if (dom.timelineTotalDuration) {
                dom.timelineTotalDuration.textContent = formatDuration(lastTotalSec);
              }
              if (dom.timelineEndTime) {
                const baseStartMs = new Date(state.editorStartTime || Date.now()).getTime();
                dom.timelineEndTime.textContent = formatClockTime(new Date(baseStartMs + lastTotalSec * 1000).toISOString());
              }

              const sign = diffSec >= 0 ? '+' : '';
              const pillClass = diffSec >= 0 ? 'positive' : 'negative';
              tooltip.innerHTML = `
                <span>${escapeHtml(block.title)}</span>: 
                <strong>${formatDuration(lastCalculatedDur)}</strong> 
                <span class="delta-pill ${pillClass}">(${sign}${formatDuration(diffSec)})</span>
              `;
              updateTooltipPos(ev.clientX, ev.clientY);
            };

            const onMouseUp = () => {
              window.removeEventListener('mousemove', onMouseMove);
              window.removeEventListener('mouseup', onMouseUp);
              handle.classList.remove('is-resizing');
              if (tooltip && tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
              setTimeout(() => { isEdgeResizing = false; }, 80);

              block.duration = lastCalculatedDur;
              if (block.type === 'playlist') {
                block.customDuration = lastCalculatedDur;
              }

              if (lastTotalSec > initialBaseScale) {
                state.baseScaleSec = Math.max(initialBaseScale, Math.ceil(lastTotalSec * 1.15));
              }

              renderEditor();
              showToast(`Длительность блока увеличена: ${formatDuration(lastCalculatedDur)}. Временная линия увеличена!`, 'info');
            };

            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
          });
        });
      }
    }

    // Плейхед прямого эфира (On-Air indicator)
    if (dom.radioTimelinePlayhead) {
      const nowMs = Date.now();
      const startMs = new Date(state.editorStartTime || Date.now()).getTime();
      const elapsedSec = (nowMs - startMs) / 1000;
      if (elapsedSec >= 0 && elapsedSec <= effectiveScale) {
        const playheadPct = (elapsedSec / effectiveScale) * 100;
        dom.radioTimelinePlayhead.style.display = 'block';
        dom.radioTimelinePlayhead.style.left = `${playheadPct.toFixed(2)}%`;
      } else {
        dom.radioTimelinePlayhead.style.display = 'none';
      }
    }
  }

  // 2. Отрисовка блочного конструктора эфира (в стиле Антропедии)
  function renderEditorBlocks() {
    const listEl = dom.editorBlocksList || dom.editorSlotsList;
    if (!listEl) return;

    if (state.editorBlocks.length === 0) {
      listEl.innerHTML = `
        <div style="text-align:center; padding:40px 20px; color:#94a3b8; background:rgba(0,0,0,0.2); border:1px dashed rgba(255,255,255,0.1); border-radius:14px;">
          <i class="fas fa-layer-group" style="font-size:2.2rem; color:var(--brand-accent,#6366f1); margin-bottom:12px; display:block;"></i>
          <h3 style="color:#fff; margin:0 0 8px 0;">Сетка вещания пока пуста</h3>
          <p style="margin:0 0 16px 0; font-size:0.9rem;">Добавьте готовый плейлист, соберите треки из медиатеки или запишите голос ведущего с микрофона.</p>
          <div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">
            <button type="button" class="btn btn-primary btn-sm" id="btnEmptyAddPlaylist"><i class="fas fa-list-check"></i> + Плейлист в эфир</button>
            <button type="button" class="btn btn-secondary btn-sm" id="btnEmptyAddTrack"><i class="fas fa-music"></i> + Трек из медиатеки</button>
            <button type="button" class="btn btn-secondary btn-sm" id="btnEmptyAddWords"><i class="fas fa-microphone"></i> + Слова ведущего</button>
          </div>
        </div>
      `;
      document.getElementById('btnEmptyAddPlaylist')?.addEventListener('click', openPickPlaylistForTimeline);
      document.getElementById('btnEmptyAddTrack')?.addEventListener('click', () => dom.btnPickFromMyTracks?.click());
      document.getElementById('btnEmptyAddWords')?.addEventListener('click', () => openInsertWordsModalForIndex(-1));
      updateCapacityUI();
      return;
    }

    let cursor = new Date(state.editorStartTime || Date.now()).getTime();

    let html = '';
    state.editorBlocks.forEach((block, index) => {
      const durSec = Number(block.duration) || 0;
      const startMs = cursor;
      const endMs = cursor + durSec * 1000;
      cursor = endMs;

      // Межблочный инсертер
      html += `
        <div class="radio-eb-insert-line" data-insert-index="${index}">
          <button type="button" class="radio-eb-insert-btn btn-insert-block-at" data-index="${index}" title="Вставить блок на эту позицию">
            <i class="fas fa-plus"></i> Вставить блок
          </button>
        </div>
      `;

      // Карточка блока в стиле Антропедии
      const isPlaylist = block.type === 'playlist';
      const items = Array.isArray(block.items) ? block.items : [];
      const typeLabel = isPlaylist ? 'Плейлист' : block.type === 'speech' ? 'Слова' : block.type === 'jingle' ? 'Джингл' : block.type === 'time_anchor' ? 'Якорь' : block.type === 'gap' ? 'Пауза' : 'Трек';
      const typeIcon = isPlaylist ? 'fa-list-check' : block.type === 'speech' ? 'fa-microphone' : block.type === 'jingle' ? 'fa-bell' : block.type === 'time_anchor' ? 'fa-anchor' : block.type === 'gap' ? 'fa-pause' : 'fa-music';

      let bodyHtml = '';
      if (isPlaylist) {
        const isCollapsed = Boolean(block.isCollapsed);
        bodyHtml = `
          <div class="radio-playlist-accordion">
            <div class="radio-playlist-accordion-header btn-toggle-playlist" data-index="${index}">
              <div style="display:flex; align-items:center; gap:8px;">
                <i class="fas ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}" style="color:#a5b4fc; font-size:0.85rem;"></i>
                <strong style="color:#fff;">${escapeHtml(block.title)}</strong>
                <span style="font-size:0.8rem; color:#a5b4fc;">(${items.length} треков)</span>
              </div>
              <div style="display:flex; gap:8px; align-items:center;">
                ${items.some(t => t.audio_url) ? `
                  <button type="button" class="btn btn-outline-primary btn-sm btn-play-playlist-block" data-index="${index}" title="Слушать плейлист в общем плеере">
                    <i class="fas fa-play"></i> Слушать
                  </button>
                ` : ''}
                <button type="button" class="btn btn-outline-secondary btn-sm btn-quick-split" data-index="${index}" title="Разрезать плейлист пополам для вставки слов/треков">
                  <i class="fas fa-scissors"></i> Разрезать
                </button>
              </div>
            </div>
            ${!isCollapsed ? `
              <div class="radio-playlist-tracks-nested">
                ${items.map((it, tIdx) => `
                  <div class="radio-playlist-nested-track" data-track-index="${tIdx}">
                    <span style="display:flex; align-items:center; gap:8px; min-width:0; overflow:hidden; text-overflow:ellipsis;">
                      ${it.audio_url ? `
                        <button type="button" class="radio-nested-play-btn btn-play-nested-track" data-block-index="${index}" data-track-index="${tIdx}" title="Воспроизвести в общем плеере">
                          <i class="fas fa-play"></i>
                        </button>
                      ` : ''}
                      <span style="color:#64748b; font-family:monospace; font-size:0.75rem;">${tIdx + 1}.</span>
                      <span style="color:#e2e8f0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(it.title)}</span>
                    </span>
                    <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                      <span style="font-size:0.75rem; color:#94a3b8; font-family:monospace;">${formatDuration(it.duration)}</span>
                      <button type="button" class="radio-nested-insert-btn btn-insert-speech-here" data-block-index="${index}" data-track-index="${tIdx}" title="Вставить слова ведущего ровно после этого трека">
                        <i class="fas fa-comment-dots"></i> + Врезка
                      </button>
                      <button type="button" class="radio-nested-insert-btn btn-split-playlist-at" data-block-index="${index}" data-track-index="${tIdx}" title="Разрезать плейлист после этого трека">
                        <i class="fas fa-scissors"></i>
                      </button>
                    </div>
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </div>
        `;
      } else if (block.type === 'track') {
        bodyHtml = `
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
            <div style="font-weight:600; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              ${escapeHtml(block.title)}
            </div>
          </div>
        `;
      } else if (block.type === 'speech' || block.type === 'jingle') {
        bodyHtml = `
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
            <div style="font-weight:600; color:#fbbf24; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              <i class="fas fa-microphone"></i> ${escapeHtml(block.title)}
            </div>
            ${!block.audio_url ? `
              <span class="badge" style="background:#ff4757; color:#fff; font-size:0.72rem; padding:2px 6px; border-radius:4px;">Требуется запись</span>
            ` : ''}
          </div>
        `;
      } else if (block.type === 'time_anchor') {
        bodyHtml = `
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
            <div>
              <strong style="color:#fb7185;"><i class="fas fa-anchor"></i> ${escapeHtml(block.title)}</strong>
              <div style="font-size:0.8rem; color:#94a3b8; margin-top:2px;">
                Фиксированный выход: ${block.anchor_time || '--:--'} • ${block.transition_mode === 'exact' ? 'Точная отсечка с возвратом трека' : 'Мягкий переход (доигрывание)'}
              </div>
            </div>
          </div>
        `;
      } else if (block.type === 'gap') {
        bodyHtml = `
          <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
            <div>
              <strong style="color:#fbbf24;"><i class="fas fa-pause-circle"></i> ${escapeHtml(block.title || 'Пауза в эфире (пустота)')}</strong>
              <div style="font-size:0.8rem; color:#94a3b8; margin-top:2px;">
                Свободный хронометраж: ${formatDuration(durSec)}. Можно заполнить подходящей музыкой из плейлистов или оставить как тишину.
              </div>
            </div>
            <div style="display:flex; gap:8px;">
              <button type="button" class="btn btn-warning btn-sm btn-fill-gap-playlist" data-index="${index}" title="Заполнить эту паузу музыкой из плейлистов">
                <i class="fas fa-wand-magic-sparkles"></i> Заполнить плейлистом
              </button>
            </div>
          </div>
        `;
      }

      html += `
        <div class="radio-eb-block ${block.type === 'gap' ? 'eb-block-gap' : ''} ${isPlaylist ? 'eb-block-playlist' : ''}" id="block_${block.id}" data-id="${block.id}" data-index="${index}" draggable="true">
          ${isPlaylist ? '<div class="radio-eb-bracket radio-eb-bracket-left" title="Начало плейлиста ["></div>' : ''}
          <div class="radio-eb-drag-handle" title="Потяните для изменения порядка в эфире">
            <i class="fas fa-grip-vertical"></i>
            <span class="radio-eb-order-num">${index + 1}</span>
          </div>
          <div class="radio-eb-header">
            <div class="radio-eb-meta-left">
              <span class="eb-type-badge type-${block.type}">
                <i class="fas ${typeIcon}"></i> ${typeLabel}
              </span>
              <span class="radio-eb-time-range">${formatClockTime(startMs)} — ${formatClockTime(endMs)}</span>
              <span class="radio-eb-duration-badge">${formatDuration(durSec)}</span>
            </div>
            <div class="radio-eb-actions">
              ${(block.audio_url || (isPlaylist && items.some(t => t.audio_url))) ? `
                <button type="button" class="radio-eb-btn btn-preview-block" data-index="${index}" title="Воспроизвести в общем плеере">
                  <i class="fas fa-play"></i>
                </button>
              ` : ''}
              <button type="button" class="radio-eb-btn btn-duplicate-block" data-index="${index}" title="Дублировать блок">
                <i class="fas fa-clone"></i>
              </button>
              <button type="button" class="radio-eb-btn btn-move-block-up" data-index="${index}" title="Сдвинуть выше" ${index === 0 ? 'disabled style="opacity:0.25;"' : ''}>
                <i class="fas fa-arrow-up"></i>
              </button>
              <button type="button" class="radio-eb-btn btn-move-block-down" data-index="${index}" title="Сдвинуть ниже" ${index === state.editorBlocks.length - 1 ? 'disabled style="opacity:0.25;"' : ''}>
                <i class="fas fa-arrow-down"></i>
              </button>
              <button type="button" class="radio-eb-btn danger btn-delete-block" data-index="${index}" title="Удалить из сетки">
                <i class="fas fa-trash"></i>
              </button>
            </div>
          </div>
          <div class="radio-eb-body">
            ${bodyHtml}
          </div>
          ${isPlaylist ? '<div class="radio-eb-bracket radio-eb-bracket-right" title="] Конец плейлиста"></div>' : ''}
        </div>
      `;
    });

    // Финальный инсертер в конце списка
    html += `
      <div class="radio-eb-insert-line" data-insert-index="${state.editorBlocks.length}">
        <button type="button" class="radio-eb-insert-btn btn-insert-block-at" data-index="${state.editorBlocks.length}" title="Добавить блок в конец эфира">
          <i class="fas fa-plus"></i> Добавить блок в конец
        </button>
      </div>
    `;

    listEl.innerHTML = html;
    bindBlockEditorEvents(listEl);
    updateCapacityUI();
  }

  // Привязка обработчиков событий блочного редактора
  function bindBlockEditorEvents(listEl) {
    if (!listEl) return;

    // Раскрытие / сворачивание аккордеона треков плейлиста
    listEl.querySelectorAll('.btn-toggle-playlist').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.btn-quick-split') || e.target.closest('button')) return;
        const idx = parseInt(el.dataset.index, 10);
        if (state.editorBlocks[idx]) {
          state.editorBlocks[idx].isCollapsed = !state.editorBlocks[idx].isCollapsed;
          renderEditorBlocks();
        }
      });
    });

    // Инструмент «Бритва» / Разрезание плейлиста (Split)
    listEl.querySelectorAll('.btn-quick-split').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        const block = state.editorBlocks[idx];
        if (block && block.items && block.items.length > 1) {
          const mid = Math.floor(block.items.length / 2) - 1;
          splitPlaylistBlock(idx, Math.max(0, mid));
        } else {
          showToast('В плейлисте должен быть минимум 2 трека для разделения', 'warning');
        }
      });
    });

    listEl.querySelectorAll('.btn-split-playlist-at').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bIdx = parseInt(btn.dataset.blockIndex, 10);
        const tIdx = parseInt(btn.dataset.trackIndex, 10);
        splitPlaylistBlock(bIdx, tIdx);
      });
    });

    // Врезка слов ведущего прямо внутрь плейлиста
    listEl.querySelectorAll('.btn-insert-speech-here').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bIdx = parseInt(btn.dataset.blockIndex, 10);
        const tIdx = parseInt(btn.dataset.trackIndex, 10);
        splitPlaylistBlock(bIdx, tIdx, { addSpeech: true });
      });
    });

    // Заполнение свободной паузы в эфире (музыкальной пустоты)
    listEl.querySelectorAll('.btn-fill-gap-playlist').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        const block = state.editorBlocks[idx];
        if (block) {
          openSmartGapFillModal({
            durationSec: block.duration,
            targetIndex: idx
          });
        }
      });
    });

    // Кнопки межблочных инсертеров
    listEl.querySelectorAll('.btn-insert-block-at').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetIdx = parseInt(btn.dataset.index, 10);
        openQuickInsertMenu(targetIdx);
      });
    });

    // Перемещение вверх / вниз
    listEl.querySelectorAll('.btn-move-block-up').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        if (idx > 0) {
          const temp = state.editorBlocks[idx];
          state.editorBlocks[idx] = state.editorBlocks[idx - 1];
          state.editorBlocks[idx - 1] = temp;
          renderEditor();
        }
      });
    });

    listEl.querySelectorAll('.btn-move-block-down').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        if (idx < state.editorBlocks.length - 1) {
          const temp = state.editorBlocks[idx];
          state.editorBlocks[idx] = state.editorBlocks[idx + 1];
          state.editorBlocks[idx + 1] = temp;
          renderEditor();
        }
      });
    });

    // Дублирование блока
    listEl.querySelectorAll('.btn-duplicate-block').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        const orig = state.editorBlocks[idx];
        if (orig) {
          const clone = JSON.parse(JSON.stringify(orig));
          clone.id = genBlockId();
          state.editorBlocks.splice(idx + 1, 0, clone);
          renderEditor();
          showToast(`Блок «${orig.title}» продублирован`, 'info');
        }
      });
    });

    // Удаление блока
    listEl.querySelectorAll('.btn-delete-block').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        state.editorBlocks.splice(idx, 1);
        renderEditor();
      });
    });

    // Воспроизведение фрагмента / блока в общем плеере AllTell
    listEl.querySelectorAll('.btn-preview-block').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        playEditorBlock(idx);
      });
    });

    listEl.querySelectorAll('.btn-play-playlist-block').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        playEditorBlock(idx);
      });
    });

    listEl.querySelectorAll('.btn-play-nested-track').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bIdx = parseInt(btn.dataset.blockIndex, 10);
        const tIdx = parseInt(btn.dataset.trackIndex, 10);
        playNestedPlaylistTrack(bIdx, tIdx);
      });
    });

    // Drag & Drop перетаскивание блоков
    listEl.querySelectorAll('.radio-eb-block').forEach((card) => {
      card.addEventListener('dragstart', (e) => {
        state.draggedBlockIndex = parseInt(card.dataset.index, 10);
        e.dataTransfer.effectAllowed = 'move';
        card.style.opacity = '0.5';
      });

      card.addEventListener('dragend', () => {
        state.draggedBlockIndex = null;
        card.style.opacity = '1';
        listEl.querySelectorAll('.radio-eb-block').forEach((c) => c.classList.remove('is-drag-over'));
      });

      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        card.classList.add('is-drag-over');
      });

      card.addEventListener('dragleave', () => {
        card.classList.remove('is-drag-over');
      });

      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('is-drag-over');
        const targetIdx = parseInt(card.dataset.index, 10);
        if (state.draggedBlockIndex !== null && state.draggedBlockIndex !== targetIdx) {
          const item = state.editorBlocks.splice(state.draggedBlockIndex, 1)[0];
          state.editorBlocks.splice(targetIdx, 0, item);
          renderEditor();
        }
      });
    });
  }

  // ===== ЕДИНАЯ СИСТЕМА ВОСПРОИЗВЕДЕНИЯ: РЕДАКТОР <-> ОБЩИЙ ПЛЕЕР =====

  function playEditorBlock(blockIndex) {
    const block = state.editorBlocks[blockIndex];
    if (!block) return;
    const gAudio = getGlobalAudio();
    if (!gAudio) return;

    const gState = gAudio.getState();

    // Если блок — плейлист
    if (block.type === 'playlist') {
      const items = (block.items || []).filter((t) => t.audio_url);
      if (items.length === 0) {
        showToast('В этом плейлисте нет треков с аудиофайлом', 'warning');
        return;
      }
      const isThisPlaylistPlaying = gState.track && gState.track.blockId === block.id;
      if (isThisPlaylistPlaying && gState.isPlaying) {
        gAudio.pause();
        return;
      }
      if (isThisPlaylistPlaying && !gState.isPlaying) {
        gAudio.resume();
        return;
      }

      const queue = items.map((it, subIdx) => ({
        id: it.track_id || `${block.id}_${subIdx}`,
        blockId: block.id,
        title: it.title,
        author_name: `Плейлист: ${block.title}`,
        duration: Number(it.duration) || 180,
        audio_url: it.audio_url,
        type: it.type || 'track'
      }));

      gAudio.playTrack(queue[0], queue, 0);
      showToast(`Воспроизведение плейлиста «${block.title}» в общем плеере`, 'info');
      updateEditorPlaybackUI();
      return;
    }

    if (!block.audio_url) {
      showToast('У этого блока нет аудиозаписи', 'warning');
      return;
    }

    const isThisTrackPlaying = gState.track && (gState.track.blockId === block.id || gState.track.audio_url === block.audio_url);
    if (isThisTrackPlaying && gState.isPlaying) {
      gAudio.pause();
      return;
    }
    if (isThisTrackPlaying && !gState.isPlaying) {
      gAudio.resume();
      return;
    }

    // Собираем сквозную очередь воспроизведения из всех доступных аудио блоков эфира
    const fullQueue = [];
    state.editorBlocks.forEach((b) => {
      if (b.type === 'playlist' && Array.isArray(b.items)) {
        b.items.forEach((it, sIdx) => {
          if (it.audio_url) {
            fullQueue.push({
              id: it.track_id || `${b.id}_${sIdx}`,
              blockId: b.id,
              title: it.title,
              author_name: `Плейлист: ${b.title}`,
              duration: Number(it.duration) || 180,
              audio_url: it.audio_url,
              type: it.type || 'track'
            });
          }
        });
      } else if (b.audio_url) {
        fullQueue.push({
          id: b.id,
          blockId: b.id,
          title: b.title,
          author_name: b.type === 'speech' ? 'Слова ведущего' : (b.type === 'jingle' ? 'Джингл' : 'Трек эфира'),
          duration: Number(b.duration) || 60,
          audio_url: b.audio_url,
          type: b.type || 'track'
        });
      }
    });

    let startIdx = fullQueue.findIndex((q) => q.blockId === block.id || q.audio_url === block.audio_url);
    if (startIdx === -1) startIdx = 0;

    const trackToPlay = fullQueue[startIdx] || {
      id: block.id,
      blockId: block.id,
      title: block.title,
      author_name: block.type === 'speech' ? 'Слова ведущего' : 'Трек эфира',
      duration: Number(block.duration) || 60,
      audio_url: block.audio_url,
      type: block.type || 'track'
    };

    gAudio.playTrack(trackToPlay, fullQueue.length ? fullQueue : [trackToPlay], startIdx);
    showToast(`Воспроизведение «${trackToPlay.title}» в общем плеере`, 'info');
    updateEditorPlaybackUI();
  }

  function playNestedPlaylistTrack(blockIndex, trackIndex) {
    const block = state.editorBlocks[blockIndex];
    if (!block || !block.items || !block.items[trackIndex]) return;
    const it = block.items[trackIndex];
    if (!it.audio_url) {
      showToast('У трека нет аудиофайла', 'warning');
      return;
    }
    const gAudio = getGlobalAudio();
    if (!gAudio) return;

    const gState = gAudio.getState();
    const targetId = it.track_id || `${block.id}_${trackIndex}`;
    const isSame = gState.track && (gState.track.id === targetId || gState.track.audio_url === it.audio_url);
    if (isSame && gState.isPlaying) {
      gAudio.pause();
      return;
    }
    if (isSame && !gState.isPlaying) {
      gAudio.resume();
      return;
    }

    const playlistQueue = block.items.filter((t) => t.audio_url).map((t, idx) => ({
      id: t.track_id || `${block.id}_${idx}`,
      blockId: block.id,
      title: t.title,
      author_name: `Плейлист: ${block.title}`,
      duration: Number(t.duration) || 180,
      audio_url: t.audio_url,
      type: t.type || 'track'
    }));

    let startIdx = playlistQueue.findIndex((q) => q.id === targetId || q.audio_url === it.audio_url);
    if (startIdx === -1) startIdx = 0;

    gAudio.playTrack(playlistQueue[startIdx], playlistQueue, startIdx);
    showToast(`Воспроизведение «${it.title}» в общем плеере`, 'info');
    updateEditorPlaybackUI();
  }

  function updateEditorPlaybackUI(gState = null) {
    const gAudio = getGlobalAudio();
    const current = gState || (gAudio ? gAudio.getState() : {});
    const isPlaying = Boolean(current.isPlaying);
    const currentTrack = current.track;
    const currentUrl = currentTrack && currentTrack.audio_url;
    const currentBlockId = currentTrack && currentTrack.blockId;

    // 1. Обновляем кнопки и подсветку блоков редактора
    const listEl = dom.editorBlocksList || dom.editorSlotsList;
    if (listEl) {
      listEl.querySelectorAll('.radio-eb-block').forEach((card) => {
        const bIdx = parseInt(card.dataset.index, 10);
        const block = state.editorBlocks[bIdx];
        const isThisBlockPlaying = isPlaying && block && (
          (currentBlockId && block.id === currentBlockId) ||
          (currentUrl && (block.audio_url === currentUrl || (block.items && block.items.some((it) => it.audio_url === currentUrl))))
        );

        card.classList.toggle('is-playing-block', Boolean(isThisBlockPlaying));

        // Кнопка предпрослушивания блока
        const previewBtn = card.querySelector('.btn-preview-block');
        if (previewBtn) {
          const isBtnActive = isPlaying && block && (
            (currentBlockId && block.id === currentBlockId) ||
            (currentUrl && (block.audio_url === currentUrl || (block.items && block.items.some((it) => it.audio_url === currentUrl))))
          );
          previewBtn.classList.toggle('is-playing', Boolean(isBtnActive));
          previewBtn.innerHTML = `<i class="fas ${isBtnActive ? 'fa-pause' : 'fa-play'}"></i>`;
          previewBtn.title = isBtnActive ? 'Пауза' : 'Воспроизвести в общем плеере';
        }

        // Кнопка плейлиста в аккордеоне
        const plPlayBtn = card.querySelector('.btn-play-playlist-block');
        if (plPlayBtn) {
          const isPlActive = isPlaying && block && (
            (currentBlockId && block.id === currentBlockId) ||
            (block.items && block.items.some((it) => it.audio_url === currentUrl))
          );
          plPlayBtn.classList.toggle('is-playing', Boolean(isPlActive));
          plPlayBtn.innerHTML = `<i class="fas ${isPlActive ? 'fa-pause' : 'fa-play'}"></i> ${isPlActive ? 'Пауза' : 'Слушать'}`;
        }

        // Вложенные треки плейлиста
        card.querySelectorAll('.radio-playlist-nested-track').forEach((nTrack) => {
          const tIdx = parseInt(nTrack.dataset.trackIndex, 10);
          const it = block && block.items && block.items[tIdx];
          const isTrackActive = isPlaying && it && (it.audio_url === currentUrl);
          nTrack.classList.toggle('is-playing', Boolean(isTrackActive));
          const nPlayBtn = nTrack.querySelector('.btn-play-nested-track');
          if (nPlayBtn) {
            nPlayBtn.classList.toggle('is-playing', Boolean(isTrackActive));
            nPlayBtn.innerHTML = `<i class="fas ${isTrackActive ? 'fa-pause' : 'fa-play'}"></i>`;
            nPlayBtn.title = isTrackActive ? 'Пауза' : 'Воспроизвести в общем плеере';
          }
        });
      });
    }

    // 2. Обновляем клипы на шкале времени (Timeline Ribbon)
    if (dom.radioTimelineTrack) {
      dom.radioTimelineTrack.querySelectorAll('.radio-timeline-clip').forEach((clip) => {
        const bIdx = parseInt(clip.dataset.index, 10);
        const block = state.editorBlocks[bIdx];
        const isClipPlaying = isPlaying && block && (
          (currentBlockId && block.id === currentBlockId) ||
          (currentUrl && (block.audio_url === currentUrl || (block.items && block.items.some((it) => it.audio_url === currentUrl))))
        );
        clip.classList.toggle('is-playing', Boolean(isClipPlaying));
      });
    }

    // 3. Обновляем кнопки в шторке медиатеки
    if (dom.drawerContentList) {
      dom.drawerContentList.querySelectorAll('.btn-drawer-play').forEach((btn) => {
        const url = btn.dataset.url;
        const isThisTrackPlaying = isPlaying && url && currentUrl === url;
        btn.innerHTML = `<i class="fas ${isThisTrackPlaying ? 'fa-pause' : 'fa-play'}"></i>`;
        btn.classList.toggle('is-playing', Boolean(isThisTrackPlaying));
      });
    }
  }

  // Общий рендерер редактора
  function renderEditor() {
    syncCompiledSlots();
    renderTimelineRibbon();
    renderEditorBlocks();
    updateCapacityUI();
    updateEditorPlaybackUI();
    const startMs = state.editorStartTime ? new Date(state.editorStartTime).getTime() : Date.now();
    updateEditorLiveStatusBadge(startMs <= Date.now() && state.editorBlocks && state.editorBlocks.length > 0, startMs);
  }

  // Сохраняем имя renderEditorSlots для обратной совместимости
  function renderEditorSlots() {
    renderEditor();
  }

  function addBlockToEditor(block, targetIndex = -1) {
    if (!block.id) block.id = genBlockId();
    if (targetIndex >= 0 && targetIndex <= state.editorBlocks.length) {
      state.editorBlocks.splice(targetIndex, 0, block);
    } else {
      state.editorBlocks.push(block);
    }
    renderEditor();
  }

  function addSlotToEditor(slot, targetIndex = -1) {
    const block = {
      id: genBlockId(),
      type: slot.type === 'speech' ? 'speech' : slot.type === 'jingle' ? 'jingle' : 'track',
      track_id: slot.track_id || null,
      title: slot.title || 'Новая аудиозапись',
      audio_url: slot.audio_url,
      duration: Math.max(1, Number(slot.duration) || 0),
      subType: slot.type
    };
    addBlockToEditor(block, targetIndex);
  }

  // Разрезание плейлиста на две независимые части (Split Playlist)
  function splitPlaylistBlock(blockIndex, trackIndex, options = {}) {
    const block = state.editorBlocks[blockIndex];
    if (!block || block.type !== 'playlist' || !block.items || block.items.length <= 1) return;

    const items = block.items;
    const part1Items = items.slice(0, trackIndex + 1);
    const part2Items = items.slice(trackIndex + 1);

    const dur1 = part1Items.reduce((sum, it) => sum + (Number(it.duration) || 0), 0);
    const dur2 = part2Items.reduce((sum, it) => sum + (Number(it.duration) || 0), 0);

    const block1 = {
      ...block,
      id: genBlockId(),
      title: `${block.title.replace(/\s*\(Часть \d+\)$/, '')} (Часть 1)`,
      items: part1Items,
      duration: dur1,
      isCollapsed: false
    };

    const replacements = [block1];

    if (options.addSpeech) {
      replacements.push({
        id: genBlockId(),
        type: 'speech',
        title: 'Слова ведущего / Врезка',
        duration: 15,
        audio_url: null
      });
    }

    if (part2Items.length > 0) {
      const block2 = {
        ...block,
        id: genBlockId(),
        title: `${block.title.replace(/\s*\(Часть \d+\)$/, '')} (Часть 2)`,
        items: part2Items,
        duration: dur2,
        isCollapsed: false
      };
      replacements.push(block2);
    }

    state.editorBlocks.splice(blockIndex, 1, ...replacements);
    renderEditor();
    showToast('Плейлист успешно разделен! Следующие треки сохранили строгую очередность.', 'success');
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

  function setTimelineZoom(zoomFactor) {
    state.timelineZoom = Math.max(0.5, Math.min(4.0, zoomFactor));
    renderTimelineRibbon();
  }

  function openQuickInsertMenu(targetIndex) {
    const choice = window.prompt(
      'Что вы хотите добавить в сетку вещания?\n1 - Трек из медиатеки\n2 - Плейлист в эфир\n3 - Слова ведущего\n4 - Джингл / Отбивку',
      '1'
    );
    if (!choice) return;
    const trimmed = choice.trim();
    if (trimmed === '1') {
      dom.btnPickFromMyTracks?.click();
    } else if (trimmed === '2') {
      openPickPlaylistForTimeline(targetIndex);
    } else if (trimmed === '3') {
      openInsertWordsModalForIndex(targetIndex - 1);
    } else if (trimmed === '4') {
      const jingleTitle = window.prompt('Название джингла / отбивки:', 'Джингл AllTell FM');
      if (jingleTitle) {
        addBlockToEditor({
          id: genBlockId(),
          type: 'jingle',
          title: jingleTitle.trim(),
          duration: 10,
          audio_url: null
        }, targetIndex);
      }
    }
  }

  async function openPickPlaylistForTimeline(targetIndex = -1) {
    const modal = document.getElementById('modalPickPlaylistForTimeline');
    const listEl = document.getElementById('pickPlaylistForTimelineList');
    showModal(modal);

    if (listEl) listEl.innerHTML = '<p class="alltell-state">Загружаем плейлисты…</p>';

    try {
      const myData = (window.authManager && window.authManager.getToken())
        ? await api('/api/radio/playlists/mine').catch(() => ({ playlists: [] }))
        : { playlists: [] };
      const publicData = await api('/api/radio/playlists?limit=50&includeMine=1').catch(() => ({ playlists: [] }));

      const map = new Map();
      (myData.playlists || []).forEach((p) => {
        p._isMine = true;
        map.set(p.id, p);
      });
      (publicData.playlists || []).forEach((p) => {
        if (!map.has(p.id)) {
          const curUser = window.authManager && window.authManager.getUser();
          p._isMine = Boolean(curUser && String(curUser.id) === String(p.user_id));
          map.set(p.id, p);
        }
      });

      const allPlaylists = Array.from(map.values());

      if (allPlaylists.length === 0) {
        if (listEl) {
          listEl.innerHTML = `
            <div style="text-align:center; padding:24px; color:#94a3b8;">
              <p>Плейлистов пока нет. Создайте плейлист в разделе «Моё» или загрузите пачку файлов.</p>
              <button type="button" class="btn btn-secondary btn-sm" id="btnGoToCreatePlaylistFromTimeline">
                <i class="fas fa-plus"></i> Создать плейлист
              </button>
            </div>
          `;
          document.getElementById('btnGoToCreatePlaylistFromTimeline')?.addEventListener('click', () => {
            hideModal(modal);
            switchTab('my');
          });
        }
        return;
      }

      let activeFilter = 'all'; // 'all', 'mine', 'public'

      function renderPickList() {
        if (!listEl) return;
        const filtered = allPlaylists.filter((pl) => {
          if (activeFilter === 'mine') return pl._isMine;
          if (activeFilter === 'public') return Boolean(pl.is_public);
          return true;
        });

        listEl.innerHTML = `
          <div style="display:flex; gap:8px; margin-bottom:12px; border-bottom:1px solid rgba(255,255,255,0.08); padding-bottom:8px;">
            <button type="button" class="btn btn-sm ${activeFilter === 'all' ? 'btn-primary' : 'btn-secondary'} btn-pick-filter" data-filter="all">Все (${allPlaylists.length})</button>
            <button type="button" class="btn btn-sm ${activeFilter === 'mine' ? 'btn-primary' : 'btn-secondary'} btn-pick-filter" data-filter="mine"><i class="fas fa-lock" style="font-size:0.75rem;"></i> Мои плейлисты (${allPlaylists.filter(p => p._isMine).length})</button>
            <button type="button" class="btn btn-sm ${activeFilter === 'public' ? 'btn-primary' : 'btn-secondary'} btn-pick-filter" data-filter="public">Публичные (${allPlaylists.filter(p => p.is_public).length})</button>
          </div>
          <div class="pick-playlists-items" style="display:flex; flex-direction:column; gap:8px;">
            ${filtered.length === 0 ? '<p style="color:#94a3b8; text-align:center; padding:16px;">Нет плейлистов в этой категории</p>' : filtered.map((pl) => {
              const trackCount = pl.trackCount || pl.tracks_count || (pl.tracks && pl.tracks.length) || 0;
              const totalDur = pl.totalDuration || pl.total_duration || 0;
              let badgeHtml = '';
              if (!pl.is_public) {
                badgeHtml = '<span style="font-size:0.72rem; color:#fca5a5; background:rgba(239,68,68,0.2); padding:2px 6px; border-radius:4px; margin-left:6px;"><i class="fas fa-lock"></i> Закрытый</span>';
              } else if (pl._isMine) {
                badgeHtml = '<span style="font-size:0.72rem; color:#a5b4fc; background:rgba(99,102,241,0.2); padding:2px 6px; border-radius:4px; margin-left:6px;"><i class="fas fa-user-check"></i> Мой</span>';
              } else {
                badgeHtml = '<span style="font-size:0.72rem; color:#6ee7b7; background:rgba(16,185,129,0.2); padding:2px 6px; border-radius:4px; margin-left:6px;"><i class="fas fa-globe"></i> Публичный</span>';
              }
              return `
                <div class="radio-drawer-item" style="padding:10px 14px;">
                  <div style="display:flex; align-items:center; gap:12px; min-width:0;">
                    <div style="width:40px; height:40px; border-radius:8px; background:rgba(139,92,246,0.2); display:flex; align-items:center; justify-content:center; color:#c084fc; font-size:1.1rem; flex-shrink:0;">
                      <i class="${!pl.is_public ? 'fas fa-lock' : 'fas fa-list-check'}"></i>
                    </div>
                    <div style="min-width:0;">
                      <div style="display:flex; align-items:center; gap:4px; flex-wrap:wrap;">
                        <strong style="color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(pl.title)}</strong>
                        ${badgeHtml}
                      </div>
                      <span style="font-size:0.8rem; color:#94a3b8;">${trackCount} треков • ${formatDuration(totalDur)}</span>
                    </div>
                  </div>
                  <button type="button" class="btn btn-primary btn-sm btn-pick-playlist-for-timeline" data-id="${pl.id}">
                    <i class="fas fa-plus"></i> Вставить
                  </button>
                </div>
              `;
            }).join('')}
          </div>
        `;

        listEl.querySelectorAll('.btn-pick-filter').forEach((btn) => {
          btn.addEventListener('click', () => {
            activeFilter = btn.dataset.filter;
            renderPickList();
          });
        });

        listEl.querySelectorAll('.btn-pick-playlist-for-timeline').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const plId = btn.dataset.id;
            try {
              btn.disabled = true;
              btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
              const fullPl = await api(`/api/radio/playlists/${plId}`);
              if (!fullPl || !fullPl.tracks) {
                showToast('Не удалось загрузить треки плейлиста', 'error');
                return;
              }
              const totalDur = (fullPl.tracks || []).reduce((sum, t) => sum + (Number(t.duration) || 0), 0);
              const playlistBlock = {
                id: genBlockId(),
                type: 'playlist',
                playlist_id: fullPl.id,
                title: fullPl.title,
                duration: totalDur,
                items: (fullPl.tracks || []).map((t) => ({
                  track_id: t.id,
                  title: t.title,
                  audio_url: t.audio_url,
                  duration: Number(t.duration) || 180,
                  type: t.type || 'track'
                })),
                isCollapsed: true
              };
              addBlockToEditor(playlistBlock, targetIndex);
              hideModal(modal);
              showToast(`Плейлист «${fullPl.title}» (${fullPl.tracks.length} треков, ${formatDuration(totalDur)}) добавлен в сетку!`, 'success');
            } catch (err) {
              showToast('Ошибка добавления плейлиста: ' + err.message, 'error');
            } finally {
              btn.disabled = false;
              btn.innerHTML = '<i class="fas fa-plus"></i> Вставить';
            }
          });
        });
      }

      renderPickList();
    } catch (e) {
      if (listEl) listEl.innerHTML = `<p class="alltell-error">Ошибка загрузки: ${escapeHtml(e.message)}</p>`;
    }
  }

  // Умное заполнение пустоты плейлистами (Smart Gap Filling)
  async function openSmartGapFillModal(gapInfo) {
    const modal = document.getElementById('modalSmartGapFill');
    showModal(modal);

    const { totalDurationSec } = syncCompiledSlots();
    const gapSec = (gapInfo && gapInfo.durationSec) || Math.max(300, (Math.ceil(totalDurationSec / 1800) * 1800 || 1800) - totalDurationSec);

    state.activeGapInfo = {
      durationSec: gapSec,
      targetIndex: (gapInfo && gapInfo.targetIndex) !== undefined ? gapInfo.targetIndex : state.editorBlocks.length
    };

    if (dom.smartGapInfoText) {
      dom.smartGapInfoText.textContent = `Свободный хронометраж для автозаполнения: ${formatDuration(gapSec)} (будет подобрана подходящая музыка)`;
    }

    if (dom.smartGapPlaylistsList) {
      dom.smartGapPlaylistsList.innerHTML = '<p class="alltell-state">Загружаем плейлисты…</p>';
    }

    try {
      const myData = (window.authManager && window.authManager.getToken())
        ? await api('/api/radio/playlists/mine').catch(() => ({ playlists: [] }))
        : { playlists: [] };
      const publicData = await api('/api/radio/playlists?limit=50&includeMine=1').catch(() => ({ playlists: [] }));

      const map = new Map();
      (myData.playlists || []).forEach((p) => {
        p._isMine = true;
        map.set(p.id, p);
      });
      (publicData.playlists || []).forEach((p) => {
        if (!map.has(p.id)) {
          const curUser = window.authManager && window.authManager.getUser();
          p._isMine = Boolean(curUser && String(curUser.id) === String(p.user_id));
          map.set(p.id, p);
        }
      });

      const playlists = Array.from(map.values());

      if (playlists.length === 0) {
        if (dom.smartGapPlaylistsList) {
          dom.smartGapPlaylistsList.innerHTML = '<p style="color:#94a3b8; text-align:center; padding:12px;">Нет доступных плейлистов для автозаполнения.</p>';
        }
        if (dom.btnSubmitSmartGapFill) dom.btnSubmitSmartGapFill.disabled = true;
        return;
      }

      if (dom.smartGapPlaylistsList) {
        dom.smartGapPlaylistsList.innerHTML = playlists.map((pl) => {
          const trackCount = pl.trackCount || pl.tracks_count || (pl.tracks && pl.tracks.length) || 0;
          const totalDur = pl.totalDuration || pl.total_duration || 0;
          let badgeHtml = '';
          if (!pl.is_public) {
            badgeHtml = '<span style="font-size:0.72rem; color:#fca5a5; background:rgba(239,68,68,0.2); padding:1px 5px; border-radius:4px; margin-left:6px;"><i class="fas fa-lock"></i> Закрытый</span>';
          } else if (pl._isMine) {
            badgeHtml = '<span style="font-size:0.72rem; color:#a5b4fc; background:rgba(99,102,241,0.2); padding:1px 5px; border-radius:4px; margin-left:6px;"><i class="fas fa-user-check"></i> Мой</span>';
          }
          return `
            <label style="display:flex; align-items:center; justify-content:space-between; padding:8px 10px; background:rgba(255,255,255,0.03); border-radius:8px; margin-bottom:6px; cursor:pointer;">
              <div style="display:flex; align-items:center; gap:10px;">
                <input type="checkbox" class="smart-gap-playlist-cb" value="${pl.id}" data-title="${escapeHtml(pl.title)}" data-tracks="${trackCount}" data-dur="${totalDur}">
                <div>
                  <div style="display:flex; align-items:center; gap:4px;">
                    <strong style="color:#fff; font-size:0.88rem;">${escapeHtml(pl.title)}</strong>
                    ${badgeHtml}
                  </div>
                  <span style="font-size:0.78rem; color:#94a3b8;">${trackCount} треков • ${formatDuration(totalDur)}</span>
                </div>
              </div>
              <span style="font-size:0.8rem; color:#a5b4fc; font-family:monospace;">${formatDuration(totalDur)}</span>
            </label>
          `;
        }).join('');

        const updateSelectedSummary = () => {
          const cbs = dom.smartGapPlaylistsList.querySelectorAll('.smart-gap-playlist-cb:checked');
          if (dom.smartGapSelectedCount) {
            dom.smartGapSelectedCount.textContent = `Выбрано: ${cbs.length}`;
          }
          if (dom.btnSubmitSmartGapFill) {
            dom.btnSubmitSmartGapFill.disabled = cbs.length === 0;
          }
          if (dom.smartGapCalculatedPlan) {
            if (cbs.length > 0) {
              dom.smartGapCalculatedPlan.style.display = 'block';
              if (dom.smartGapPlanSummary) {
                dom.smartGapPlanSummary.textContent = `Будут отобраны треки на ~${formatDuration(gapSec)} из ${cbs.length} выбранных плейлистов`;
              }
            } else {
              dom.smartGapCalculatedPlan.style.display = 'none';
            }
          }
        };

        dom.smartGapPlaylistsList.querySelectorAll('.smart-gap-playlist-cb').forEach((cb) => {
          cb.addEventListener('change', updateSelectedSummary);
        });

        // По умолчанию отмечаем первый плейлист
        const firstCb = dom.smartGapPlaylistsList.querySelector('.smart-gap-playlist-cb');
        if (firstCb) {
          firstCb.checked = true;
          updateSelectedSummary();
        }
      }
    } catch (e) {
      if (dom.smartGapPlaylistsList) {
        dom.smartGapPlaylistsList.innerHTML = `<p class="alltell-error">Ошибка: ${escapeHtml(e.message)}</p>`;
      }
    }
  }

  async function applySmartGapFill(e) {
    if (e) e.preventDefault();
    if (!dom.smartGapPlaylistsList || !state.activeGapInfo) return;

    const checked = Array.from(dom.smartGapPlaylistsList.querySelectorAll('.smart-gap-playlist-cb:checked'));
    if (checked.length === 0) {
      showToast('Выберите хотя бы один плейлист для автозаполнения', 'warning');
      return;
    }

    const order = dom.smartGapOrderSelect?.value || 'sequential';
    const strategy = dom.smartGapFitStrategy?.value || 'smart_fit';
    const targetGapSec = state.activeGapInfo.durationSec || 600;

    if (dom.btnSubmitSmartGapFill) {
      dom.btnSubmitSmartGapFill.disabled = true;
      dom.btnSubmitSmartGapFill.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Подбираем треки…';
    }

    try {
      let trackPool = [];
      for (const cb of checked) {
        const plId = cb.value;
        const fullPl = await api(`/api/radio/playlists/${plId}`);
        if (fullPl && Array.isArray(fullPl.tracks)) {
          trackPool.push(...fullPl.tracks.map((t) => ({
            playlist_id: fullPl.id,
            playlist_title: fullPl.title,
            track_id: t.id,
            title: t.title,
            audio_url: t.audio_url,
            duration: Number(t.duration) || 180,
            type: t.type || 'track'
          })));
        }
      }

      if (trackPool.length === 0) {
        showToast('В выбранных плейлистах нет треков', 'warning');
        return;
      }

      if (order === 'shuffle') {
        trackPool = trackPool.sort(() => Math.random() - 0.5);
      }

      let selectedTracks = [];
      let accumulatedDur = 0;

      if (strategy === 'smart_fit') {
        for (const tr of trackPool) {
          if (accumulatedDur + tr.duration <= targetGapSec + 60 || selectedTracks.length === 0) {
            selectedTracks.push(tr);
            accumulatedDur += tr.duration;
            if (accumulatedDur >= targetGapSec - 30) break;
          }
        }
      } else {
        for (const tr of trackPool) {
          selectedTracks.push(tr);
          accumulatedDur += tr.duration;
          if (accumulatedDur >= targetGapSec) break;
        }
      }

      const compositeBlock = {
        id: genBlockId(),
        type: 'playlist',
        title: `Автозаполнение эфира (${selectedTracks.length} тр)`,
        duration: accumulatedDur,
        items: selectedTracks,
        isCollapsed: false
      };

      if (state.activeGapInfo.targetIndex >= 0 && state.editorBlocks[state.activeGapInfo.targetIndex] && state.editorBlocks[state.activeGapInfo.targetIndex].type === 'gap') {
        state.editorBlocks.splice(state.activeGapInfo.targetIndex, 1, compositeBlock);
        renderEditor();
      } else {
        addBlockToEditor(compositeBlock, state.activeGapInfo.targetIndex);
      }
      hideModal('modalSmartGapFill');
      showToast(`Пауза эфира успешно заполнена: добавлено ${selectedTracks.length} треков на ${formatDuration(accumulatedDur)}!`, 'success');
    } catch (err) {
      showToast('Ошибка автозаполнения: ' + err.message, 'error');
    } finally {
      if (dom.btnSubmitSmartGapFill) {
        dom.btnSubmitSmartGapFill.disabled = false;
        dom.btnSubmitSmartGapFill.innerHTML = '<i class="fas fa-magic"></i> Заполнить эфир';
      }
    }
  }

  // Боковая шторка медиатеки эфира (Media Drawer)
  function toggleMediaDrawer(force) {
    if (!dom.radioMediaDrawer) return;
    const shouldOpen = typeof force === 'boolean' ? force : !state.mediaDrawerOpen;
    state.mediaDrawerOpen = shouldOpen;

    if (shouldOpen) {
      dom.radioMediaDrawer.hidden = false;
      dom.radioMediaDrawer.style.display = 'flex';
      renderMediaDrawerContent();
    } else {
      dom.radioMediaDrawer.hidden = true;
      dom.radioMediaDrawer.style.display = 'none';
    }
  }

  async function renderMediaDrawerContent() {
    if (!dom.drawerContentList) return;
    dom.drawerContentList.innerHTML = '<p class="alltell-state">Загружаем медиатеку…</p>';

    try {
      if (state.mediaDrawerTab === 'tracks') {
        const data = await api('/api/radio/tracks?limit=100');
        const tracks = (data && data.tracks) || [];
        if (tracks.length === 0) {
          dom.drawerContentList.innerHTML = '<p style="color:#94a3b8; text-align:center; padding:20px;">Нет треков в медиатеке</p>';
          return;
        }
        dom.drawerContentList.innerHTML = tracks.map((t) => `
          <div class="radio-drawer-item" draggable="true" data-type="track" data-id="${t.id}" data-title="${escapeHtml(t.title)}" data-url="${escapeHtml(t.audio_url)}" data-dur="${t.duration}">
            <div style="display:flex; align-items:center; gap:8px; min-width:0;">
              <i class="fas fa-music" style="color:#60a5fa;"></i>
              <span style="color:#fff; font-size:0.85rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(t.title)}</span>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:0.75rem; color:#94a3b8; font-family:monospace;">${formatDuration(t.duration)}</span>
              <button type="button" class="btn btn-outline-secondary btn-sm btn-drawer-play" data-id="${t.id}" data-url="${escapeHtml(t.audio_url)}" data-title="${escapeHtml(t.title)}" data-dur="${t.duration}" title="Слушать в общем плеере"><i class="fas fa-play"></i></button>
              <button type="button" class="btn btn-secondary btn-sm btn-drawer-add" title="Добавить в эфир"><i class="fas fa-plus"></i></button>
            </div>
          </div>
        `).join('');
      } else if (state.mediaDrawerTab === 'playlists') {
        const myData = (window.authManager && window.authManager.getToken())
          ? await api('/api/radio/playlists/mine').catch(() => ({ playlists: [] }))
          : { playlists: [] };
        const publicData = await api('/api/radio/playlists?limit=50&includeMine=1').catch(() => ({ playlists: [] }));

        const map = new Map();
        (myData.playlists || []).forEach((p) => {
          p._isMine = true;
          map.set(p.id, p);
        });
        (publicData.playlists || []).forEach((p) => {
          if (!map.has(p.id)) {
            const curUser = window.authManager && window.authManager.getUser();
            p._isMine = Boolean(curUser && String(curUser.id) === String(p.user_id));
            map.set(p.id, p);
          }
        });

        const playlists = Array.from(map.values());
        if (playlists.length === 0) {
          dom.drawerContentList.innerHTML = '<p style="color:#94a3b8; text-align:center; padding:20px;">Нет плейлистов</p>';
          return;
        }

        dom.drawerContentList.innerHTML = playlists.map((pl) => {
          const dur = pl.totalDuration || pl.total_duration || 0;
          const isClosed = !pl.is_public;
          return `
            <div class="radio-drawer-item" draggable="true" data-type="playlist" data-id="${pl.id}" data-title="${escapeHtml(pl.title)}" data-dur="${dur}">
              <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                <i class="${isClosed ? 'fas fa-lock' : 'fas fa-list-check'}" style="color:${isClosed ? '#f87171' : '#c084fc'}; flex-shrink:0;"></i>
                <span style="color:#fff; font-size:0.85rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(pl.title)}</span>
                ${isClosed ? '<span style="font-size:0.68rem; color:#fca5a5; background:rgba(239,68,68,0.2); padding:1px 4px; border-radius:3px; flex-shrink:0;">🔒</span>' : ''}
              </div>
              <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                <span style="font-size:0.75rem; color:#94a3b8; font-family:monospace;">${formatDuration(dur)}</span>
                <button type="button" class="btn btn-outline-secondary btn-sm btn-drawer-play-pl" data-id="${pl.id}" title="Слушать в общем плеере"><i class="fas fa-play"></i></button>
                <button type="button" class="btn btn-secondary btn-sm btn-drawer-add-pl" data-id="${pl.id}" title="Добавить в эфир"><i class="fas fa-plus"></i></button>
              </div>
            </div>
          `;
        }).join('');
      }

      // Drag & Drop из шторки
      dom.drawerContentList.querySelectorAll('.radio-drawer-item').forEach((item) => {
        item.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', JSON.stringify({
            type: item.dataset.type,
            id: item.dataset.id,
            title: item.dataset.title,
            audio_url: item.dataset.url,
            duration: Number(item.dataset.dur) || 180
          }));
          e.dataTransfer.effectAllowed = 'copy';
        });
      });

      // Воспроизведение треков и плейлистов из шторки в общем плеере
      dom.drawerContentList.querySelectorAll('.btn-drawer-play').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const trId = btn.dataset.id;
          const trUrl = btn.dataset.url;
          const trTitle = btn.dataset.title;
          const trDur = Number(btn.dataset.dur) || 180;
          const gAudio = getGlobalAudio();
          if (!gAudio) return;
          const gState = gAudio.getState();
          if (gState.track && gState.track.audio_url === trUrl && gState.isPlaying) {
            gAudio.pause();
            return;
          }
          if (gState.track && gState.track.audio_url === trUrl && !gState.isPlaying) {
            gAudio.resume();
            return;
          }
          const tr = { id: trId, title: trTitle, audio_url: trUrl, duration: trDur, author_name: 'Медиатека' };
          gAudio.playTrack(tr, [tr], 0);
          showToast(`Воспроизведение «${trTitle}» в общем плеере`, 'info');
        });
      });

      dom.drawerContentList.querySelectorAll('.btn-drawer-play-pl').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const plId = btn.dataset.id;
          try {
            btn.disabled = true;
            const fullPl = await api(`/api/radio/playlists/${plId}`);
            if (!fullPl || !fullPl.tracks || fullPl.tracks.length === 0) {
              showToast('В этом плейлисте нет треков', 'warning');
              return;
            }
            const gAudio = getGlobalAudio();
            if (gAudio) {
              gAudio.playTrack(fullPl.tracks[0], fullPl.tracks, 0);
              showToast(`Воспроизведение плейлиста «${fullPl.title}» в общем плеере`, 'success');
            }
          } catch (err) {
            showToast('Ошибка запуска: ' + err.message, 'error');
          } finally {
            btn.disabled = false;
          }
        });
      });

      // Клики по кнопке "+" в шторке
      dom.drawerContentList.querySelectorAll('.btn-drawer-add').forEach((btn) => {
        btn.addEventListener('click', () => {
          const item = btn.closest('.radio-drawer-item');
          if (item) {
            addBlockToEditor({
              id: genBlockId(),
              type: 'track',
              track_id: item.dataset.id,
              title: item.dataset.title,
              audio_url: item.dataset.url,
              duration: Number(item.dataset.dur) || 180
            });
            showToast(`«${item.dataset.title}» добавлен в ленту эфира`, 'info');
          }
        });
      });

      dom.drawerContentList.querySelectorAll('.btn-drawer-add-pl').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const plId = btn.dataset.id;
          try {
            const fullPl = await api(`/api/radio/playlists/${plId}`);
            if (fullPl && fullPl.tracks) {
              const dur = fullPl.tracks.reduce((s, t) => s + (Number(t.duration) || 0), 0);
              addBlockToEditor({
                id: genBlockId(),
                type: 'playlist',
                playlist_id: fullPl.id,
                title: fullPl.title,
                duration: dur,
                items: fullPl.tracks.map((t) => ({
                  track_id: t.id,
                  title: t.title,
                  audio_url: t.audio_url,
                  duration: Number(t.duration) || 180,
                  type: t.type || 'track'
                })),
                isCollapsed: true
              });
              showToast(`Плейлист «${fullPl.title}» добавлен в эфир`, 'success');
            }
          } catch (e) {
            showToast('Ошибка: ' + e.message, 'error');
          }
        });
      });
    } catch (e) {
      dom.drawerContentList.innerHTML = `<p class="alltell-error">Ошибка: ${escapeHtml(e.message)}</p>`;
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

    const baseMs = state.editorStartTime ? new Date(state.editorStartTime).getTime() : getEffectiveNowMs();
    const baseDate = new Date(baseMs);
    const targetDate = new Date(baseDate);
    targetDate.setHours(h, m, 0, 0);

    let targetMs = targetDate.getTime();
    if (targetMs < baseMs) {
      targetMs += 24 * 3600 * 1000;
    }

    let cursor = baseMs;
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

  function insertSpeechAtSlotIndex(slot, slotIndex) {
    const speechBlock = {
      id: genBlockId(),
      type: 'speech',
      track_id: slot.track_id || null,
      title: slot.title || 'Слова ведущего',
      audio_url: slot.audio_url,
      duration: Math.max(1, Number(slot.duration) || 0),
      subType: 'speech'
    };

    if (!state.editorBlocks || state.editorBlocks.length === 0) {
      state.editorBlocks = [speechBlock];
      syncCompiledSlots();
      renderEditor();
      return;
    }

    let accumulatedSlots = 0;
    let inserted = false;

    for (let bIdx = 0; bIdx < state.editorBlocks.length; bIdx++) {
      const block = state.editorBlocks[bIdx];
      const count = block.type === 'playlist' ? (block.items ? block.items.length : 0) : 1;

      if (accumulatedSlots + count >= slotIndex) {
        if (block.type === 'playlist' && block.items && block.items.length > 1) {
          const trackIdxInPlaylist = slotIndex - accumulatedSlots - 1;
          if (trackIdxInPlaylist >= 0 && trackIdxInPlaylist < block.items.length - 1) {
            splitPlaylistBlock(bIdx, trackIdxInPlaylist);
            state.editorBlocks.splice(bIdx + 1, 0, speechBlock);
            inserted = true;
            break;
          } else if (trackIdxInPlaylist < 0) {
            state.editorBlocks.splice(bIdx, 0, speechBlock);
            inserted = true;
            break;
          } else {
            state.editorBlocks.splice(bIdx + 1, 0, speechBlock);
            inserted = true;
            break;
          }
        } else {
          state.editorBlocks.splice(bIdx + 1, 0, speechBlock);
          inserted = true;
          break;
        }
      }
      accumulatedSlots += count;
    }

    if (!inserted) {
      state.editorBlocks.push(speechBlock);
    }

    syncCompiledSlots();
    renderEditor();
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
    const confirmEl = document.getElementById('confirmDialogModal');
    if (confirmEl) {
      confirmEl.style.display = 'flex';
      confirmEl.hidden = false;
    }
    if (window.confirmDialog && typeof window.confirmDialog.open === 'function') {
      return await window.confirmDialog.open({ message, ...opts });
    }
    if (typeof window.showConfirm === 'function') {
      return await window.showConfirm(message, opts);
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
    // Скрываем все остальные открытые модалки единой системы для избежания наслоения окон
    document.querySelectorAll('.modal-overlay:not(#confirmDialogModal)').forEach((m) => {
      if (m !== modal) hideModal(m);
    });
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

  // ===== Переключение навигационных вкладок радио =====
  function switchTab(tabName) {
    if (!tabName) return;

    const trackView = document.getElementById('radioTrackView');
    const navTabs = document.getElementById('radioNavTabs');
    if (trackView) {
      trackView.hidden = true;
      trackView.style.display = 'none';
    }
    if (navTabs) {
      navTabs.hidden = false;
      navTabs.style.display = '';
    }

    document.querySelectorAll('.radio-nav-tab').forEach((t) => {
      if (t.dataset.tab === tabName) {
        t.classList.add('is-active');
      } else {
        t.classList.remove('is-active');
      }
    });

    const tabLive = document.getElementById('tabContentLive');
    const tabFeed = document.getElementById('tabContentFeed');
    const tabMy = document.getElementById('tabContentMy');
    const tabEditor = document.getElementById('tabContentEditor');

    if (tabLive) {
      tabLive.hidden = tabName !== 'live';
      tabLive.style.display = tabName === 'live' ? '' : 'none';
    }
    if (tabFeed) {
      tabFeed.hidden = tabName !== 'feed';
      tabFeed.style.display = tabName === 'feed' ? '' : 'none';
    }
    if (tabMy) {
      tabMy.hidden = tabName !== 'my';
      tabMy.style.display = tabName === 'my' ? '' : 'none';
    }
    if (tabEditor) {
      tabEditor.hidden = tabName !== 'editor';
      tabEditor.style.display = tabName === 'editor' ? '' : 'none';
    }

    if (tabName === 'live') {
      loadStations();
      updateDeckUI();
    }
    if (tabName === 'feed') loadTracks();
    if (tabName === 'my') loadMySection();
    if (tabName === 'editor') initEditor();

    const gAudio = getGlobalAudio();
    if (gAudio) {
      gAudio.syncBar();
    }
  }

  // ===== ГЛАВНАЯ ИНИЦИАЛИЗАЦИЯ СТРАНИЦЫ =====
  function init() {
    // ЗАЩИТА ОТ ДВОЙНОГО ВЫЗОВА И ДВОЕНИЯ СЛУШАТЕЛЕЙ
    if (window.RadioClient._mounted) {
      return window.RadioClient._cleanup;
    }
    window.RadioClient._mounted = true;

    // Скрываем все модальные окна при старте страницы
    document.querySelectorAll('.modal-overlay:not(#confirmDialogModal)').forEach((m) => hideModal(m));

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
        if (currentViewingTrack) {
          const isThis = gState.track && gState.track.id === currentViewingTrack.id;
          if (dom.trackPagePlayBtn) {
            dom.trackPagePlayBtn.innerHTML = (gState.isPlaying && isThis) ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
          }
          if (dom.trackPageLoopBtn) {
            dom.trackPageLoopBtn.classList.toggle('is-active', Boolean(gState.isLoop));
            dom.trackPageLoopBtn.title = gState.isLoop ? 'Зацикливание включено (нажмите, чтобы выключить)' : 'Зациклить';
          }
          if (isThis) {
            const cur = globalAudio.audio.currentTime || 0;
            const dur = globalAudio.audio.duration || currentViewingTrack.duration || 0;
            if (dom.trackPageCurrentTime) dom.trackPageCurrentTime.textContent = formatDuration(cur);
            if (dom.trackPageTotalDuration) dom.trackPageTotalDuration.textContent = formatDuration(dur);
            if (dom.trackPageProgressFill && dur > 0) {
              dom.trackPageProgressFill.style.width = `${Math.min(100, (cur / dur) * 100)}%`;
            }
          }
          if (dom.trackView && !dom.trackView.hidden && dom.trackView.style.display !== 'none' && gState.track && gState.track.id !== currentViewingTrack.id) {
            openTrackPage(gState.track.id);
          }
        }

        // Обновление состояния воспроизведения в редакторе радиоэфира
        updateEditorPlaybackUI(gState);
      });
    }

    // 1. Табы
    dom.tabs.forEach((tab) => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        switchTab(tab.dataset.tab);
      });
    });

    dom.navTabs?.addEventListener('click', (e) => {
      const btn = e.target.closest('.radio-nav-tab');
      if (btn && btn.dataset.tab) {
        e.preventDefault();
        switchTab(btn.dataset.tab);
      }
    });

    // 2. Управление эфирной декой
    dom.deckPrevBtn?.addEventListener('click', () => {
      prevSlot();
    });

    dom.deckPlayBtn?.addEventListener('click', () => {
      const gAudio = getGlobalAudio();
      if (!gAudio) return;

      const curr = gAudio.getState();
      if (curr.mode === 'track') {
        if (curr.isPlaying) {
          gAudio.pause();
        } else {
          gAudio.resume();
        }
        updateDeckUI();
        return;
      }

      if (!state.currentStation) {
        const firstCard = document.querySelector('.radio-station-card');
        if (firstCard) firstCard.click();
        return;
      }

      if (curr.isPlaying && curr.mode === 'radio' && curr.station && curr.station.id === state.currentStation.id) {
        gAudio.pause();
      } else if (!curr.isPlaying && curr.mode === 'radio' && curr.station && curr.station.id === state.currentStation.id) {
        // Разжимаем паузу: продолжаем играть с того места, где звук стоял (не пропуская эфир!)
        gAudio.resume();

        // Проверяем отставание от живого эфира: если реальный эфир ушел вперед, переходим в таймшифт
        if (state.currentSlot && state.currentSlot.startTime) {
          const liveOffset = Math.max(0, (Date.now() - new Date(state.currentSlot.startTime).getTime()) / 1000);
          const curTime = (gAudio.audio ? gAudio.audio.currentTime : curr.currentTime) || 0;
          if (liveOffset > curTime + 2.5) {
            state.isTimeshift = true;
          }
        }
        updateDeckUI();
      } else {
        tuneStation(state.currentStation, true);
      }
    });

    dom.deckNextBtn?.addEventListener('click', () => {
      skipSlot();
    });

    dom.deckLoopBtn?.addEventListener('click', () => {
      const gAudio = getGlobalAudio();
      if (gAudio) {
        gAudio.toggleLoop();
        updateDeckUI();
        const isL = gAudio.getState().isLoop;
        showToast(isL ? 'Зацикливание трека включено' : 'Зацикливание выключено', 'info');
      }
    });

    dom.deckUnfreezeBtn?.addEventListener('click', () => {
      const gAudio = getGlobalAudio();
      if (!gAudio) return;
      gAudio.seek(0);
      state.isTimeshift = true;
      updateDeckUI();
      gAudio.resume();
      showToast('Текущий трек играет с самого начала (таймшифт)', 'info');
    });

    dom.deckLiveSyncBtn?.addEventListener('click', () => {
      state.isTimeshift = false;
      state.timeshiftForwardSlots = [];
      if (state.currentStation) {
        tuneStation(state.currentStation, true);
        showToast(`Вы вернулись в прямой эфир станции «${state.currentStation.name}»`, 'info');
      } else {
        const firstCard = document.querySelector('.radio-station-card');
        if (firstCard) firstCard.click();
      }
    });

    dom.deckProgressBar?.addEventListener('click', (e) => {
      const gAudio = getGlobalAudio();
      if (!gAudio) return;
      const rect = dom.deckProgressBar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

      const curr = gAudio.getState();
      if (curr.mode === 'radio' && state.currentStation && !state.isTimeshift && state.currentSlot) {
        const curOffset = Math.max(0, (Date.now() - new Date(state.currentSlot.startTime).getTime()) / 1000);
        const dur = (gAudio.audio && gAudio.audio.duration) ? gAudio.audio.duration : (state.currentSlot.duration || 0);
        const maxLiveRatio = dur > 0 ? (curOffset / dur) : 1;

        if (ratio > maxLiveRatio + 0.03) {
          showToast('Нельзя перемотать вперед: эта часть трека еще не проиграна в эфире', 'warning');
          return;
        }
        if (ratio < maxLiveRatio - 0.03) {
          state.isTimeshift = true;
        }
      }

      gAudio.seek(ratio);
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
        publishBroadcast(e.target.value, {
          notify: true,
          autoTune: new Date(e.target.value).getTime() <= Date.now()
        });
      }
    });

    dom.btnSetStartTimeNow?.addEventListener('click', () => {
      publishBroadcast(new Date(), {
        notify: true,
        autoTune: true
      });
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
        state.editorBlocks = [];
        renderEditorSlots();
        renderEditor();
        updateDeckUI();
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
        switchTab('live');
      } catch (err) {
        showToast('Ошибка при освобождении частоты: ' + err.message, 'error');
      }
    });

    dom.btnSaveTimeline?.addEventListener('click', async () => {
      await publishBroadcast(state.editorStartTime || new Date(), { notify: true, autoTune: true });
    });

    // Масштабирование видео-таймлайна
    dom.btnTimelineZoomIn?.addEventListener('click', () => setTimelineZoom(state.timelineZoom * 1.25));
    dom.btnTimelineZoomOut?.addEventListener('click', () => setTimelineZoom(state.timelineZoom / 1.25));
    dom.btnTimelineZoomReset?.addEventListener('click', () => setTimelineZoom(1.0));

    dom.radioTimelineTrackScroll?.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1.15 : 0.87;
        setTimelineZoom(state.timelineZoom * delta);
      }
    }, { passive: false });

    // Drag & drop медиафайлов из шторки прямо на дорожку таймлайна
    dom.radioTimelineTrack?.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      dom.radioTimelineTrack.style.outline = '2px dashed var(--brand-accent, #6366f1)';
    });

    dom.radioTimelineTrack?.addEventListener('dragleave', () => {
      dom.radioTimelineTrack.style.outline = '';
    });

    // Кнопка увеличения шкалы времени (+15м)
    dom.btnTimelineExtendScale?.addEventListener('click', () => {
      state.baseScaleSec = (state.baseScaleSec || 1200) + 900;
      renderTimelineRibbon();
      showToast(`Временная линия увеличена на 15 мин (Шкала: ${Math.round(state.baseScaleSec / 60)} мин)`, 'info');
    });

    dom.radioTimelineTrack?.addEventListener('drop', (e) => {
      e.preventDefault();
      dom.radioTimelineTrack.style.outline = '';
      if (e.target.closest('.radio-timeline-clip')) return;

      const trackRect = dom.radioTimelineTrack.getBoundingClientRect();
      const clickX = Math.max(0, e.clientX - trackRect.left);
      const { totalDurationSec } = syncCompiledSlots();
      const baseScale = state.baseScaleSec || 1200;
      const currentZoom = state.timelineZoom || 1.0;
      const neededScale = Math.max(baseScale, Math.ceil(totalDurationSec * 1.12));
      const effectiveScale = Math.max(60, Math.round(neededScale / currentZoom));
      const targetSec = Math.round((clickX / Math.max(10, trackRect.width)) * effectiveScale);

      // 1. Проверяем, перемещается ли существующий блок по таймлайну
      let fromIdx = state.draggedBlockIndex;
      if (fromIdx === null || fromIdx === undefined) {
        try {
          const raw = e.dataTransfer.getData('text/plain');
          if (raw) {
            const data = JSON.parse(raw);
            if (data && data.type === 'move_block' && data.index !== undefined) fromIdx = data.index;
          }
        } catch (_) {}
      }

      if (fromIdx !== null && fromIdx !== undefined && !isNaN(fromIdx)) {
        const item = state.editorBlocks.splice(fromIdx, 1)[0];
        if (!item) return;

        // Если блок отодвинут далеко вправо за край существующих треков:
        if (targetSec > totalDurationSec + 30) {
          const gapSec = targetSec - totalDurationSec;
          const gapBlock = {
            id: genBlockId(),
            type: 'gap',
            title: 'Пауза в эфире (музыкальная пустота)',
            duration: Math.max(30, gapSec)
          };
          state.editorBlocks.push(gapBlock);
          state.editorBlocks.push(item);
          if (targetSec + item.duration > baseScale) {
            state.baseScaleSec = Math.max(state.baseScaleSec, Math.ceil((targetSec + item.duration) * 1.15));
          }
          renderEditor();
          showToast(`Блок отодвинут за край. Создана пауза ${formatDuration(gapSec)}, временная линия увеличена!`, 'info');
        } else {
          state.editorBlocks.push(item);
          renderEditor();
          showToast(`Блок «${item.title}» перемещен в конец эфира`, 'info');
        }
        return;
      }

      // 2. Иначе это перетаскивание из боковой шторки
      try {
        const raw = e.dataTransfer.getData('text/plain');
        if (raw) {
          const item = JSON.parse(raw);
          if (item && item.type) {
            if (targetSec > totalDurationSec + 30) {
              const gapSec = targetSec - totalDurationSec;
              state.editorBlocks.push({
                id: genBlockId(),
                type: 'gap',
                title: 'Пауза в эфире (музыкальная пустота)',
                duration: Math.max(30, gapSec)
              });
              if (targetSec + (Number(item.duration) || 180) > baseScale) {
                state.baseScaleSec = Math.max(state.baseScaleSec, Math.ceil((targetSec + (Number(item.duration) || 180)) * 1.15));
              }
            }
            if (item.type === 'playlist') {
              openPickPlaylistForTimeline(item.id);
            } else {
              addBlockToEditor({
                id: genBlockId(),
                type: item.type === 'speech' ? 'speech' : 'track',
                track_id: item.id || null,
                title: item.title || 'Новая запись',
                audio_url: item.audio_url || null,
                duration: Number(item.duration) || 180
              });
              showToast(`«${item.title}» добавлен в ленту эфира!`, 'success');
            }
          }
        }
      } catch (err) {
        console.error('Ошибка Drag & Drop:', err);
      }
    });

    // Открытие добавления плейлиста в эфир
    dom.btnOpenPickPlaylistForTimeline?.addEventListener('click', () => openPickPlaylistForTimeline());

    // Открытие автозаполнения пустоты
    dom.btnOpenSmartGapFill?.addEventListener('click', () => openSmartGapFillModal());
    document.getElementById('formSmartGapFill')?.addEventListener('submit', applySmartGapFill);

    // Боковая шторка медиатеки
    dom.btnToggleMediaDrawer?.addEventListener('click', () => toggleMediaDrawer());
    dom.btnCloseMediaDrawer?.addEventListener('click', () => toggleMediaDrawer(false));

    dom.radioMediaDrawer?.querySelectorAll('.radio-media-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        dom.radioMediaDrawer?.querySelectorAll('.radio-media-tab').forEach((t) => t.classList.remove('is-active'));
        tab.classList.add('is-active');
        state.mediaDrawerTab = tab.dataset.drawerTab;
        renderMediaDrawerContent();
      });
    });

    dom.drawerSearchInput?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      dom.drawerContentList?.querySelectorAll('.radio-drawer-item').forEach((item) => {
        const title = (item.dataset.title || '').toLowerCase();
        item.style.display = !q || title.includes(q) ? 'flex' : 'none';
      });
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
            if (file && file.name) {
              formData.append('title', file.name.replace(/\.[^/.]+$/, ''));
            }
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
        if (file && file.name) {
          formData.append('title', file.name.replace(/\.[^/.]+$/, ''));
        }

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

          dom.pickTrackSelectAll.onchange = (e) => {
            list.querySelectorAll('.pick-track-checkbox').forEach((cb) => {
              cb.checked = e.target.checked;
            });
            updateBatchState();
          };

          dom.btnPickTracksBatch.onclick = () => {
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
          };

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
        insertSpeechAtSlotIndex({
          title,
          type: 'speech',
          audio_url: finalAudioUrl,
          duration: finalDuration
        }, calc.insertIndex);

        hideModal('modalInsertWordsByTime');
        showToast(`Слова ведущего установлены в сетку после трека №${calc.priorSlotIndex || 1} и сохранены в эфир!`, 'success');

        // Автоматически сохраняем обновленную сетку в эфир, чтобы расписание диктора не слетало
        await publishBroadcast(state.editorStartTime, { notify: false, autoTune: false });
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
      switchTab('feed');
    });

    dom.trackPagePrevBtn?.addEventListener('click', () => {
      const gAudio = getGlobalAudio();
      if (gAudio) gAudio.playPrev();
    });

    dom.trackPagePlayBtn?.addEventListener('click', () => {
      if (!currentViewingTrack) return;
      const gAudio = getGlobalAudio();
      if (!gAudio) return;

      const curr = gAudio.getState();
      if (curr.isPlaying && curr.track && curr.track.id === currentViewingTrack.id) {
        gAudio.pause();
      } else if (!curr.isPlaying && curr.track && curr.track.id === currentViewingTrack.id) {
        gAudio.resume();
      } else {
        const playlist = (state.feedTracks && state.feedTracks.length) ? state.feedTracks : [currentViewingTrack];
        const idx = playlist.findIndex((t) => t.id === currentViewingTrack.id);
        gAudio.playTrack(currentViewingTrack, playlist, idx >= 0 ? idx : 0);
      }
    });

    dom.trackPageNextBtn?.addEventListener('click', () => {
      const gAudio = getGlobalAudio();
      if (gAudio) gAudio.playNext();
    });

    dom.trackPageLoopBtn?.addEventListener('click', () => {
      const gAudio = getGlobalAudio();
      if (gAudio) {
        gAudio.toggleLoop();
        updateDeckUI();
        const isL = gAudio.getState().isLoop;
        showToast(isL ? 'Зацикливание трека включено' : 'Зацикливание выключено', 'info');
      }
    });

    // 7. Управление плеером ленты (если разметку открывают)
    dom.feedPlayerPrevBtn?.addEventListener('click', () => {
      const gAudio = getGlobalAudio();
      if (gAudio) gAudio.playPrev();
    });

    dom.feedPlayerPlayBtn?.addEventListener('click', () => {
      const gAudio = getGlobalAudio();
      if (!gAudio) return;
      if (gAudio.getState().isPlaying) gAudio.pause();
      else gAudio.resume();
    });

    dom.feedPlayerNextBtn?.addEventListener('click', () => {
      const gAudio = getGlobalAudio();
      if (gAudio) gAudio.playNext();
    });

    dom.feedPlayerLoopBtn?.addEventListener('click', () => {
      const gAudio = getGlobalAudio();
      if (gAudio) {
        gAudio.toggleLoop();
        updateDeckUI();
        const isL = gAudio.getState().isLoop;
        showToast(isL ? 'Зацикливание трека включено' : 'Зацикливание выключено', 'info');
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

    dom.trackPageFavoriteBtn?.addEventListener('click', async () => {
      if (!currentViewingTrack) return;
      const user = window.authManager && window.authManager.getUser();
      if (!user) {
        showToast('Войдите в аккаунт AllTell, чтобы сохранять треки в «Моё»', 'warning');
        return;
      }
      try {
        const res = await api(`/api/radio/favorites/${currentViewingTrack.id}/toggle`, { method: 'POST' });
        if (res.favorited) {
          state.favoriteTrackIds.add(currentViewingTrack.id);
          showToast('Трек добавлен в «Моё»', 'success');
        } else {
          state.favoriteTrackIds.delete(currentViewingTrack.id);
          showToast('Трек удален из «Моё»', 'info');
        }
        updateTrackPageFavoriteUI();
      } catch (err) {
        showToast('Ошибка: ' + err.message, 'error');
      }
    });

    dom.trackPageAddToPlaylistBtn?.addEventListener('click', () => {
      if (!currentViewingTrack) return;
      openAddToPlaylistModal(currentViewingTrack.id);
    });

    dom.trackPageDeleteBtn?.addEventListener('click', async () => {
      if (!currentViewingTrack) return;
      const trackToDelete = currentViewingTrack;
      const ok = await showConfirm(`Удалить аудиозапись «${trackToDelete.title}»? Действие необратимо.`, {
        title: 'Удалить аудиозапись?',
        confirmLabel: 'Удалить',
        danger: true
      });
      if (!ok) return;

      try {
        await api('/api/radio/tracks/' + trackToDelete.id, { method: 'DELETE' });
        showToast('Аудиозапись успешно удалена.', 'info');
        const gAudio = getGlobalAudio();
        if (gAudio) {
          const gState = gAudio.getState();
          if (gState.track && Number(gState.track.id) === Number(trackToDelete.id)) {
            gAudio.stop();
          }
        }
        currentViewingTrack = null;
        window.history.pushState(null, '', '/radio');
        switchTab('feed');
        loadTracks();
      } catch (err) {
        showToast('Ошибка при удалении трека: ' + err.message, 'error');
      }
    });

    // Слушатели раздела "Моё"
    dom.mySectionFilters?.querySelectorAll('.radio-filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        dom.mySectionFilters?.querySelectorAll('.radio-filter-btn').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        state.mySection = btn.dataset.mySection;
        loadMySection();
      });
    });

    dom.btnOpenCreatePlaylist?.addEventListener('click', () => openCreatePlaylistModal());
    dom.btnUploadTrackFromMy?.addEventListener('click', openUploadModal);

    // Слушатель формы создания/редактирования плейлиста
    dom.formCreatePlaylist?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const editId = dom.editPlaylistId?.value;
      const title = dom.playlistTitleInput?.value?.trim();
      const description = dom.playlistDescInput?.value?.trim();
      const isPublic = parseInt(dom.playlistPublicSelect?.value || '1', 10);
      const coverFile = dom.playlistCoverInput?.files[0];

      if (!title) {
        showToast('Укажите название плейлиста', 'warning');
        return;
      }

      try {
        if (dom.btnSubmitCreatePlaylist) {
          dom.btnSubmitCreatePlaylist.disabled = true;
          dom.btnSubmitCreatePlaylist.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Сохраняем…';
        }

        let coverUrl = null;
        if (coverFile) {
          const formData = new FormData();
          formData.append('image', coverFile);
          const uploadRes = await fetch('/api/upload-image', {
            method: 'POST',
            headers: window.authManager && window.authManager.getToken() ? { 'Authorization': 'Bearer ' + window.authManager.getToken() } : {},
            body: formData
          });
          if (uploadRes.ok) {
            const upData = await uploadRes.json();
            coverUrl = upData.url || upData.imageUrl;
          }
        }

        if (editId) {
          await api(`/api/radio/playlists/${editId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title,
              description,
              is_public: isPublic,
              ...(coverUrl ? { cover_url: coverUrl } : {})
            })
          });
          showToast('Плейлист обновлен', 'success');
        } else {
          await api('/api/radio/playlists', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title,
              description,
              is_public: isPublic,
              cover_url: coverUrl
            })
          });
          showToast('Плейлист успешно создан!', 'success');
        }

        hideModal('modalCreatePlaylist');
        if (state.mySection === 'playlists') {
          loadMySection();
        } else if (state.feedFilter === 'playlists') {
          loadTracks();
        }
      } catch (err) {
        showToast('Ошибка сохранения плейлиста: ' + err.message, 'error');
      } finally {
        if (dom.btnSubmitCreatePlaylist) {
          dom.btnSubmitCreatePlaylist.disabled = false;
          dom.btnSubmitCreatePlaylist.innerHTML = 'Сохранить';
        }
      }
    });

    dom.playlistCoverInput?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file && dom.playlistCoverPreviewBox && dom.playlistCoverPreviewImg) {
        dom.playlistCoverPreviewImg.src = URL.createObjectURL(file);
        dom.playlistCoverPreviewBox.style.display = 'block';
      }
    });

    dom.btnCreateNewPlaylistFromPick?.addEventListener('click', () => {
      hideModal('modalPickPlaylistForTrack');
      openCreatePlaylistModal();
    });

    // 7. Модальные окна: открытие и закрытие
    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const modalId = btn.dataset.close;
        hideModal(modalId);
      });
    });

    document.querySelectorAll('.modal-overlay:not(#confirmDialogModal)').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
          hideModal(backdrop);
        }
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay:not(#confirmDialogModal)').forEach((backdrop) => {
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
        if (title) {
          formData.append('title', title);
        } else if (file && file.name) {
          formData.append('title', file.name.replace(/\.[^/.]+$/, ''));
        }

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

    // Редактирование описания и настроек радиостанции
    function openEditStationModal(st) {
      if (!st) return;
      if (dom.editStationId) dom.editStationId.value = st.id;
      if (dom.editStationName) dom.editStationName.value = st.name || '';
      if (dom.editStationDescription) dom.editStationDescription.value = st.description || '';
      if (dom.editStationFallback) dom.editStationFallback.value = st.fallback_mode || 'loop';
      if (dom.editStationAvatar) dom.editStationAvatar.value = st.avatar_url || '';
      showModal('modalEditStation');
    }

    dom.btnEditStationSettings?.addEventListener('click', () => {
      if (state.selectedStationForEdit) {
        openEditStationModal(state.selectedStationForEdit);
      } else if (state.myStations && state.myStations.length > 0) {
        openEditStationModal(state.myStations[0]);
      } else {
        showToast('Выберите радиостанцию для редактирования', 'info');
      }
    });

    dom.btnDeckEditStation?.addEventListener('click', () => {
      if (state.currentStation) {
        openEditStationModal(state.currentStation);
      }
    });

    dom.formEditStation?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = dom.editStationId?.value;
      const name = dom.editStationName?.value?.trim();
      const description = dom.editStationDescription?.value?.trim();
      const fallbackMode = dom.editStationFallback?.value || 'loop';
      const avatarUrl = dom.editStationAvatar?.value?.trim() || null;

      if (!id || !name) {
        showToast('Укажите название радиостанции', 'warning');
        return;
      }

      const submitBtn = dom.btnSubmitEditStation;
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Сохранение…';
      }

      try {
        const updated = await api(`/api/radio/stations/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description, fallbackMode, avatarUrl })
        });

        if (state.currentStation && String(state.currentStation.id) === String(id)) {
          state.currentStation = { ...state.currentStation, ...updated };
        }
        if (state.selectedStationForEdit && String(state.selectedStationForEdit.id) === String(id)) {
          state.selectedStationForEdit = { ...state.selectedStationForEdit, ...updated };
        }

        hideModal('modalEditStation');
        showToast(`Настройки радиостанции «${updated.name}» успешно сохранены!`, 'success');
        await loadStations();
        updateDeckUI();
      } catch (err) {
        showToast('Ошибка сохранения настроек: ' + err.message, 'error');
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<i class="fas fa-save"></i> Сохранить настройки';
        }
      }
    });

    // Синхронизация и отображение времени эфира сервера (для мини-ПК)
    dom.btnSyncClock?.addEventListener('click', async () => {
      try {
        if (dom.btnSyncClock) {
          dom.btnSyncClock.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        }
        const res = await api('/api/system-settings/sync-time', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientTimeIso: new Date().toISOString() })
        });
        if (res && res.effectiveServerTime) {
          state.serverTimeDelta = new Date(res.effectiveServerTime).getTime() - Date.now();
          showToast('Время эфира успешно синхронизировано с часами вашего браузера!', 'success');
        }
      } catch (err) {
        showToast('Ошибка синхронизации времени: ' + err.message, 'error');
      } finally {
        if (dom.btnSyncClock) {
          dom.btnSyncClock.innerHTML = '<i class="fas fa-sync-alt"></i>';
        }
      }
    });

    async function syncClockWithServer() {
      try {
        const res = await api('/api/system-settings/public');
        if (res && res.serverTime) {
          state.serverTimeDelta = new Date(res.serverTime).getTime() - Date.now();
        }
      } catch (_) {}
    }
    syncClockWithServer();

    clearInterval(state.serverClockInterval);
    state.serverClockInterval = setInterval(() => {
      if (dom.radioServerClock) {
        const nowMs = getEffectiveNowMs();
        dom.radioServerClock.innerHTML = `<i class="fas fa-clock"></i> Эфир: ${formatClockTime(nowMs)}`;
      }
    }, 1000);

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

    // Фоновое обновление сетки вещания без прерывания играющего аудио
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      if (state.currentStation && state.isLiveMode && !state.isTimeshift) {
        const gAudio = getGlobalAudio();
        const gState = gAudio ? gAudio.getState() : {};
        if (gState.mode === 'track') return;

        try {
          const live = await api(`/api/radio/stations/${state.currentStation.id}/live`);
          const prevSlotId = state.currentSlot ? state.currentSlot.id : null;
          state.currentSlot = live.currentSlot;
          state.nextSlots = live.nextSlots || [];
          state.prevSlots = live.prevSlots || [];

          updateDeckUI();

          // Переключаем эфир на новый слот ТОЛЬКО если:
          // прямо сейчас играет радио этой станции, и слот действительно сменился на сервере
          if (gAudio && gState.isPlaying && gState.mode === 'radio' && gState.station && gState.station.id === state.currentStation.id) {
            if (live.currentSlot && live.currentSlot.audioUrl && live.currentSlot.id !== prevSlotId) {
              gAudio.playRadio(state.currentStation, live.currentSlot, live.offset || 0);
            }
          }
        } catch (_) {}
      }
    }, 30000);

    const cleanupFn = function cleanup() {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      clearInterval(state.serverClockInterval);
      state.serverClockInterval = null;
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
    switchTab,
    openTrackPage,
    openCreatePlaylistModal,
    openUploadModal,
    loadMySection,
    skipSlot,
    prevSlot,
    compileBlocksToSlots,
    convertSlotsToBlocks,
    addBlockToEditor,
    splitPlaylistBlock,
    setTimelineZoom,
    renderEditor,
    openPickPlaylistForTimeline,
    openSmartGapFillModal
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
