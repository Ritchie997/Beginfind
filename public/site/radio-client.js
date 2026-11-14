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

  // ===== Состояние радио-эфира (Главная дека) =====
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
    editorStartTime: null, // Дата/время старта вещания в редакторе
    // Запись с микрофона в редакторе
    mediaRecorder: null,
    recordedChunks: [],
    recordStartTime: 0,
    recordTimerInterval: null,
    audioHandlersBound: false
  };

  // ===== Состояние отдельного плеера ленты треков =====
  const feedPlayerState = {
    audio: new Audio(),
    currentTrack: null,
    isPlaying: false,
    tracks: [],
    currentIndex: -1,
    isLoop: false,
    handlersBound: false
  };

  // ===== Состояние плеера страницы трека =====
  const trackPageState = {
    audio: new Audio(),
    track: null,
    isPlaying: false,
    isLoop: false,
    handlersBound: false
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

      // Отдельный плеер ленты (Bottom Player Bar)
      feedPlayerBar: document.getElementById('feedPlayerBar'),
      feedPlayerCover: document.getElementById('feedPlayerCover'),
      feedPlayerTitle: document.getElementById('feedPlayerTitle'),
      feedPlayerAuthor: document.getElementById('feedPlayerAuthor'),
      feedPlayerPrevBtn: document.getElementById('feedPlayerPrevBtn'),
      feedPlayerPlayBtn: document.getElementById('feedPlayerPlayBtn'),
      feedPlayerNextBtn: document.getElementById('feedPlayerNextBtn'),
      feedPlayerProgressBar: document.getElementById('feedPlayerProgressBar'),
      feedPlayerProgressFill: document.getElementById('feedPlayerProgressFill'),
      feedPlayerCurrentTime: document.getElementById('feedPlayerCurrentTime'),
      feedPlayerDuration: document.getElementById('feedPlayerDuration'),
      feedPlayerLoopBtn: document.getElementById('feedPlayerLoopBtn'),
      feedPlayerMuteBtn: document.getElementById('feedPlayerMuteBtn'),
      feedPlayerVolume: document.getElementById('feedPlayerVolume'),
      feedPlayerOpenTrackBtn: document.getElementById('feedPlayerOpenTrackBtn'),
      feedPlayerCloseBtn: document.getElementById('feedPlayerCloseBtn'),

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
    const st = state.currentStation;
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
        // Если играет плеер ленты — глушим его
        if (feedPlayerState.isPlaying) {
          feedPlayerState.audio.pause();
          feedPlayerState.isPlaying = false;
          updateFeedPlayerUI();
        }

        state.audio.src = state.currentSlot.audioUrl;
        const offset = live.offset || 0;
        state.audio.currentTime = offset;

        if (autoPlay) {
          state.audio.play().then(() => {
            state.isPlaying = true;
            updateDeckUI();
          }).catch((err) => {
            console.warn('[radio] Autoplay blocked:', err);
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

  function bindDeckAudioEvents() {
    if (state.audioHandlersBound) return;
    state.audioHandlersBound = true;

    state.audio.addEventListener('timeupdate', () => {
      if (!dom.deckTimeCurrent) return;
      const cur = state.audio.currentTime || 0;
      const dur = state.audio.duration || (state.currentSlot ? state.currentSlot.duration : 0);
      dom.deckTimeCurrent.textContent = formatDuration(cur);

      if (dom.deckTimeRemaining) {
        const rem = Math.max(0, dur - cur);
        dom.deckTimeRemaining.textContent = '-' + formatDuration(rem);
      }

      if (dom.deckProgressFill && dur > 0) {
        const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
        dom.deckProgressFill.style.width = `${pct}%`;
      }
    });

    state.audio.addEventListener('ended', () => {
      if (state.nextSlots.length > 0) {
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

    state.audio.addEventListener('play', () => {
      state.isPlaying = true;
      updateDeckUI();
    });

    state.audio.addEventListener('pause', () => {
      state.isPlaying = false;
      updateDeckUI();
    });
  }

  // ===== 2. Отдельный аудиоплеер для ленты треков и подкастов (Bottom Bar) =====

  function bindFeedPlayerEvents() {
    if (feedPlayerState.handlersBound) return;
    feedPlayerState.handlersBound = true;

    feedPlayerState.audio.addEventListener('timeupdate', () => {
      if (!dom.feedPlayerCurrentTime) return;
      const cur = feedPlayerState.audio.currentTime || 0;
      const dur = feedPlayerState.audio.duration || (feedPlayerState.currentTrack ? feedPlayerState.currentTrack.duration : 0);
      dom.feedPlayerCurrentTime.textContent = formatDuration(cur);
      if (dom.feedPlayerDuration) dom.feedPlayerDuration.textContent = formatDuration(dur);

      if (dom.feedPlayerProgressFill && dur > 0) {
        const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
        dom.feedPlayerProgressFill.style.width = `${pct}%`;
      }
    });

    feedPlayerState.audio.addEventListener('ended', () => {
      if (feedPlayerState.isLoop) {
        feedPlayerState.audio.currentTime = 0;
        feedPlayerState.audio.play();
      } else if (feedPlayerState.currentIndex >= 0 && feedPlayerState.currentIndex < feedPlayerState.tracks.length - 1) {
        playFeedTrackAt(feedPlayerState.currentIndex + 1);
      } else {
        feedPlayerState.isPlaying = false;
        updateFeedPlayerUI();
      }
    });

    feedPlayerState.audio.addEventListener('play', () => {
      feedPlayerState.isPlaying = true;
      updateFeedPlayerUI();
    });

    feedPlayerState.audio.addEventListener('pause', () => {
      feedPlayerState.isPlaying = false;
      updateFeedPlayerUI();
    });

    // Клики по контроллерам плеера ленты
    dom.feedPlayerPlayBtn?.addEventListener('click', () => {
      if (!feedPlayerState.currentTrack) return;
      if (feedPlayerState.isPlaying) {
        feedPlayerState.audio.pause();
      } else {
        feedPlayerState.audio.play();
      }
    });

    dom.feedPlayerPrevBtn?.addEventListener('click', () => {
      if (feedPlayerState.currentIndex > 0) {
        playFeedTrackAt(feedPlayerState.currentIndex - 1);
      }
    });

    dom.feedPlayerNextBtn?.addEventListener('click', () => {
      if (feedPlayerState.currentIndex < feedPlayerState.tracks.length - 1) {
        playFeedTrackAt(feedPlayerState.currentIndex + 1);
      }
    });

    dom.feedPlayerProgressBar?.addEventListener('click', (e) => {
      const rect = dom.feedPlayerProgressBar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const dur = feedPlayerState.audio.duration || 0;
      if (dur > 0) {
        feedPlayerState.audio.currentTime = ratio * dur;
      }
    });

    dom.feedPlayerLoopBtn?.addEventListener('click', () => {
      feedPlayerState.isLoop = !feedPlayerState.isLoop;
      dom.feedPlayerLoopBtn.classList.toggle('is-active', feedPlayerState.isLoop);
    });

    dom.feedPlayerMuteBtn?.addEventListener('click', () => {
      feedPlayerState.audio.muted = !feedPlayerState.audio.muted;
      dom.feedPlayerMuteBtn.innerHTML = feedPlayerState.audio.muted ? '<i class="fas fa-volume-xmark"></i>' : '<i class="fas fa-volume-high"></i>';
    });

    dom.feedPlayerVolume?.addEventListener('input', (e) => {
      feedPlayerState.audio.volume = parseFloat(e.target.value);
    });

    dom.feedPlayerCloseBtn?.addEventListener('click', () => {
      feedPlayerState.audio.pause();
      feedPlayerState.isPlaying = false;
      if (dom.feedPlayerBar) dom.feedPlayerBar.hidden = true;
      updateFeedPlayButtons();
    });

    dom.feedPlayerOpenTrackBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      if (feedPlayerState.currentTrack) {
        openTrackPage(feedPlayerState.currentTrack.id);
      }
    });

    dom.feedPlayerTitle?.addEventListener('click', (e) => {
      e.preventDefault();
      if (feedPlayerState.currentTrack) {
        openTrackPage(feedPlayerState.currentTrack.id);
      }
    });
  }

  function playFeedTrack(track, tracksList, index) {
    // Пауза деки прямого эфира, чтобы звуки не накладывались
    if (state.isPlaying) {
      state.audio.pause();
      state.isPlaying = false;
      updateDeckUI();
    }

    feedPlayerState.currentTrack = track;
    feedPlayerState.tracks = tracksList || feedPlayerState.tracks;
    feedPlayerState.currentIndex = index !== undefined ? index : feedPlayerState.tracks.findIndex((t) => t.id === track.id);

    feedPlayerState.audio.src = track.audio_url;
    feedPlayerState.audio.currentTime = 0;
    feedPlayerState.audio.play().then(() => {
      feedPlayerState.isPlaying = true;
      updateFeedPlayerUI();
    }).catch((err) => {
      console.warn('Feed track autoplay blocked:', err);
      feedPlayerState.isPlaying = false;
      updateFeedPlayerUI();
    });

    if (dom.feedPlayerBar) dom.feedPlayerBar.hidden = false;
    updateFeedPlayerUI();
    updateFeedPlayButtons();
  }

  function playFeedTrackAt(index) {
    if (index >= 0 && index < feedPlayerState.tracks.length) {
      playFeedTrack(feedPlayerState.tracks[index], feedPlayerState.tracks, index);
    }
  }

  function updateFeedPlayerUI() {
    if (!dom.feedPlayerTitle) return;
    const t = feedPlayerState.currentTrack;
    if (!t) return;

    dom.feedPlayerTitle.textContent = t.title;
    if (dom.feedPlayerAuthor) dom.feedPlayerAuthor.textContent = `${t.author_name} • ${t.type === 'podcast' ? 'Подкаст' : t.type === 'speech' ? 'Слова' : 'Музыка'}`;

    if (dom.feedPlayerCover) {
      if (t.cover_url) {
        dom.feedPlayerCover.innerHTML = `<img src="${escapeHtml(t.cover_url)}" alt="">`;
      } else {
        dom.feedPlayerCover.innerHTML = `<i class="fas fa-music"></i>`;
      }
    }

    if (dom.feedPlayerPlayBtn) {
      dom.feedPlayerPlayBtn.innerHTML = feedPlayerState.isPlaying ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
    }

    updateFeedPlayButtons();
  }

  function updateFeedPlayButtons() {
    document.querySelectorAll('.radio-track-item').forEach((item) => {
      const id = item.dataset.id;
      const btn = item.querySelector('.radio-track-play-btn');
      if (!btn) return;
      if (feedPlayerState.currentTrack && feedPlayerState.currentTrack.id == id && feedPlayerState.isPlaying) {
        btn.innerHTML = '<i class="fas fa-pause"></i>';
        item.classList.add('is-playing-now');
      } else {
        btn.innerHTML = '<i class="fas fa-play"></i>';
        item.classList.remove('is-playing-now');
      }
    });
  }

  // ===== 3. Страница отдельного трека (Radio Track Page) =====

  function bindTrackPageEvents() {
    if (trackPageState.handlersBound) return;
    trackPageState.handlersBound = true;

    trackPageState.audio.addEventListener('timeupdate', () => {
      if (!dom.trackPageCurrentTime) return;
      const cur = trackPageState.audio.currentTime || 0;
      const dur = trackPageState.audio.duration || (trackPageState.track ? trackPageState.track.duration : 0);
      dom.trackPageCurrentTime.textContent = formatDuration(cur);
      if (dom.trackPageTotalDuration) dom.trackPageTotalDuration.textContent = formatDuration(dur);

      if (dom.trackPageProgressFill && dur > 0) {
        const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
        dom.trackPageProgressFill.style.width = `${pct}%`;
      }
    });

    trackPageState.audio.addEventListener('play', () => {
      trackPageState.isPlaying = true;
      if (dom.trackPagePlayBtn) dom.trackPagePlayBtn.innerHTML = '<i class="fas fa-pause"></i>';
    });

    trackPageState.audio.addEventListener('pause', () => {
      trackPageState.isPlaying = false;
      if (dom.trackPagePlayBtn) dom.trackPagePlayBtn.innerHTML = '<i class="fas fa-play"></i>';
    });

    trackPageState.audio.addEventListener('ended', () => {
      if (trackPageState.isLoop) {
        trackPageState.audio.currentTime = 0;
        trackPageState.audio.play();
      } else {
        trackPageState.isPlaying = false;
        if (dom.trackPagePlayBtn) dom.trackPagePlayBtn.innerHTML = '<i class="fas fa-play"></i>';
      }
    });

    dom.trackPagePlayBtn?.addEventListener('click', () => {
      if (!trackPageState.track) return;
      if (state.isPlaying) state.audio.pause();
      if (feedPlayerState.isPlaying) feedPlayerState.audio.pause();

      if (trackPageState.isPlaying) {
        trackPageState.audio.pause();
      } else {
        trackPageState.audio.play();
      }
    });

    dom.trackPageProgressBar?.addEventListener('click', (e) => {
      const rect = dom.trackPageProgressBar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const dur = trackPageState.audio.duration || 0;
      if (dur > 0) {
        trackPageState.audio.currentTime = ratio * dur;
      }
    });

    dom.trackPageLoopBtn?.addEventListener('click', () => {
      trackPageState.isLoop = !trackPageState.isLoop;
      dom.trackPageLoopBtn.classList.toggle('is-active', trackPageState.isLoop);
    });

    dom.trackPageMuteBtn?.addEventListener('click', () => {
      trackPageState.audio.muted = !trackPageState.audio.muted;
      dom.trackPageMuteBtn.innerHTML = trackPageState.audio.muted ? '<i class="fas fa-volume-xmark"></i>' : '<i class="fas fa-volume-high"></i>';
    });

    dom.trackPageVolumeSlider?.addEventListener('input', (e) => {
      trackPageState.audio.volume = parseFloat(e.target.value);
    });

    dom.btnBackFromTrackView?.addEventListener('click', () => {
      trackPageState.audio.pause();
      trackPageState.isPlaying = false;
      window.history.pushState(null, '', '/radio');
      if (dom.trackView) dom.trackView.hidden = true;
      if (dom.navTabs) dom.navTabs.hidden = false;
      if (dom.tabFeed) dom.tabFeed.hidden = false;
    });

    dom.trackPageShareBtn?.addEventListener('click', () => {
      if (!trackPageState.track) return;
      const url = `${window.location.origin}/radio/track/${trackPageState.track.id}`;
      navigator.clipboard.writeText(url).then(() => {
        alert('Ссылка на трек скопирована в буфер обмена!');
      }).catch(() => {
        prompt('Ссылка на трек:', url);
      });
    });

    dom.trackPageAddToEditorBtn?.addEventListener('click', () => {
      if (!trackPageState.track) return;
      addSlotToEditor({
        track_id: trackPageState.track.id,
        title: trackPageState.track.title,
        audio_url: trackPageState.track.audio_url,
        duration: Number(trackPageState.track.duration) || 180,
        type: trackPageState.track.type || 'track'
      });
      alert(`Трек "${trackPageState.track.title}" успешно добавлен в сетку вещания! Перейдите во вкладку "Редактор эфира" для публикации.`);
    });

    dom.trackPageDeleteBtn?.addEventListener('click', async () => {
      if (!trackPageState.track) return;
      if (!confirm(`Вы действительно хотите удалить аудиозапись "${trackPageState.track.title}"?`)) return;
      try {
        await api('/api/radio/tracks/' + trackPageState.track.id, { method: 'DELETE' });
        alert('Аудиозапись успешно удалена.');
        dom.btnBackFromTrackView?.click();
        loadTracks();
      } catch (err) {
        alert('Ошибка при удалении трека: ' + err.message);
      }
    });
  }

  async function openTrackPage(trackId) {
    try {
      const track = await api('/api/radio/tracks/' + trackId);
      if (!track) throw new Error('Трек не найден');

      trackPageState.track = track;
      trackPageState.audio.src = track.audio_url;
      trackPageState.audio.currentTime = 0;

      // Скрываем табы и показываем страницу трека
      if (dom.navTabs) dom.navTabs.hidden = true;
      if (dom.tabLive) dom.tabLive.hidden = true;
      if (dom.tabFeed) dom.tabFeed.hidden = true;
      if (dom.tabEditor) dom.tabEditor.hidden = true;
      if (dom.trackView) dom.trackView.hidden = false;

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
      alert('Ошибка открытия страницы трека: ' + err.message);
    }
  }

  // ===== 4. Каталог радиостанций =====
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

  // ===== 5. Лента треков и подкастов =====
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

      dom.tracksList.innerHTML = data.tracks.map((t, idx) => `
        <div class="radio-track-item ${feedPlayerState.currentTrack && feedPlayerState.currentTrack.id === t.id && feedPlayerState.isPlaying ? 'is-playing-now' : ''}" data-id="${t.id}" data-index="${idx}">
          <div class="radio-track-left">
            <button type="button" class="radio-track-play-btn" data-index="${idx}" title="Воспроизвести в отдельном плеере">
              <i class="fas ${feedPlayerState.currentTrack && feedPlayerState.currentTrack.id === t.id && feedPlayerState.isPlaying ? 'fa-pause' : 'fa-play'}"></i>
            </button>
            <div class="radio-track-cover-mini" data-id="${t.id}" style="width:40px; height:40px; border-radius:8px; overflow:hidden; background:#12141a; display:flex; align-items:center; justify-content:center; cursor:pointer;">
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
      `).join('');

      // Клик по Play: запускает в отдельном нижнем плеере
      dom.tracksList.querySelectorAll('.radio-track-play-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.dataset.index, 10);
          const t = data.tracks[idx];
          if (!t) return;

          if (feedPlayerState.currentTrack && feedPlayerState.currentTrack.id === t.id && feedPlayerState.isPlaying) {
            feedPlayerState.audio.pause();
          } else {
            playFeedTrack(t, data.tracks, idx);
          }
        });
      });

      // Клик по названию или обложке: открывает отдельную страницу трека
      dom.tracksList.querySelectorAll('.btn-open-track-detail, .radio-track-cover-mini').forEach((el) => {
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
          alert(`Запись "${slot.title}" добавлена в сетку вещания! Перейдите во вкладку "Редактор эфира" для публикации.`);
        });
      });
    } catch (e) {
      if (dom.tracksList) {
        dom.tracksList.innerHTML = `<p class="alltell-error">Ошибка загрузки треков: ${escapeHtml(e.message)}</p>`;
      }
    }
  }

  // ===== 6. Редактор сетки вещания (24 часа) с точным расписанием =====

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

      // Заполняем селектор станций
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

    // Обработчики кнопок слотов
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

  // ===== 7. Умная вставка слов ведущего по времени =====

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

      // Если целевое время попадает в пределы этого слота
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

    const modal = document.getElementById('modalInsertWordsByTime');
    if (modal) modal.hidden = false;

    // Рассчитываем приблизительное время окончания этого трека
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

    bindDeckAudioEvents();
    bindFeedPlayerEvents();
    bindTrackPageEvents();

    // 1. Табы
    dom.tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        // Если была открыта страница отдельного трека — скрываем её
        if (dom.trackView) dom.trackView.hidden = true;
        if (dom.navTabs) dom.navTabs.hidden = false;

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

    // 2. Управление эфирной декой
    dom.deckPlayBtn?.addEventListener('click', () => {
      if (!state.currentStation) {
        const firstCard = document.querySelector('.radio-station-card');
        if (firstCard) firstCard.click();
        return;
      }
      if (state.isPlaying) {
        state.audio.pause();
      } else {
        if (feedPlayerState.isPlaying) feedPlayerState.audio.pause();
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

    // 4. Редактор сетки вещания и управление станцией

    // Смена станции в редакторе
    dom.editorStationSelect?.addEventListener('change', (e) => {
      const id = e.target.value;
      const found = state.myStations.find((s) => s.id == id);
      if (found) {
        state.selectedStationForEdit = found;
        loadStationTimeline(found.id);
      }
    });

    // Изменение времени старта вещания в редакторе
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

    // Очистить сетку (Освободить эфир)
    dom.btnClearTimelineBtn?.addEventListener('click', async () => {
      if (!state.selectedStationForEdit) return;
      if (!confirm(`Вы действительно хотите очистить всю сетку вещания радиостанции "${state.selectedStationForEdit.name}"? Эфир будет освобожден.`)) {
        return;
      }

      try {
        await api(`/api/radio/stations/${state.selectedStationForEdit.id}/timeline`, {
          method: 'DELETE'
        });
        state.editorSlots = [];
        renderEditorSlots();
        alert('Сетка вещания радиостанции очищена. Эфир освобожден.');
        loadStations();
      } catch (err) {
        alert('Ошибка при очистке сетки: ' + err.message);
      }
    });

    // Освободить частоту (Удалить радиостанцию навсегда)
    dom.btnReleaseStationBtn?.addEventListener('click', async () => {
      if (!state.selectedStationForEdit) return;
      const st = state.selectedStationForEdit;
      if (!confirm(`Вы действительно хотите освободить частоту ${st.frequency} FM? Радиостанция "${st.name}" и вся сетка вещания будут удалены навсегда, а частота станет доступна для всех пользователей.`)) {
        return;
      }

      try {
        await api(`/api/radio/stations/${st.id}`, { method: 'DELETE' });
        alert(`Частота ${st.frequency} FM успешно освобождена!`);
        state.selectedStationForEdit = null;
        state.editorSlots = [];
        loadStations();
        document.querySelector('.radio-nav-tab[data-tab="live"]')?.click();
      } catch (err) {
        alert('Ошибка при освобождении частоты: ' + err.message);
      }
    });

    // Сохранить сетку в эфир на 24 часа
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
          body: JSON.stringify({
            slots: state.editorSlots,
            startTime: state.editorStartTime || new Date().toISOString()
          })
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

    // Загрузка плейлиста в эфир (несколько файлов сразу)
    dom.btnUploadPlaylist?.addEventListener('click', () => {
      const user = window.authManager && window.authManager.getUser();
      if (!user) {
        alert('Для загрузки плейлиста в эфир необходимо войти в аккаунт AllTell');
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
        if (progressModal) progressModal.hidden = false;

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
        if (progressModal) progressModal.hidden = true;
        alert(`Плейлист из ${addedCount} треков успешно добавлен в сетку! Вы можете поменять их порядок или вставить слова, а затем нажать "Опубликовать в эфир".`);
      };

      fileInput.click();
    });

    // Загрузка одного файла
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
          alert('Ошибка загрузки файла: ' + e.message);
        }
      };
      fileInput.click();
    });

    // Запись голоса ведущего с микрофона (виджет в шапке редактора)
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

    // Выбор из медиатеки с пакетным добавлением
    dom.btnPickFromMyTracks?.addEventListener('click', async () => {
      const modal = document.getElementById('modalPickTrack');
      const list = document.getElementById('modalPickTrackList');
      if (modal) modal.hidden = false;
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
            if (modal) modal.hidden = true;
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
              if (modal) modal.hidden = true;
            });
          });
        }
      } catch (e) {
        if (list) list.innerHTML = `<p class="alltell-error">${escapeHtml(e.message)}</p>`;
      }
    });

    // 5. Модальное окно: Вставка слов по времени

    dom.btnOpenInsertWordsModal?.addEventListener('click', () => {
      const modal = document.getElementById('modalInsertWordsByTime');
      if (modal) modal.hidden = false;
      const d = new Date();
      const pad = (n) => (n < 10 ? '0' : '') + n;
      const timeInput = document.getElementById('speechTargetTimeInput');
      if (timeInput) timeInput.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      updateSpeechPlanPreview();
    });

    document.getElementById('speechTargetTimeInput')?.addEventListener('input', updateSpeechPlanPreview);

    // Табы источника в модалке слов
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
              alert(`Выбрана запись: ${btn.dataset.title}`);
            });
          });
        } catch (e) {
          boxLib.innerHTML = `<p class="alltell-error">${escapeHtml(e.message)}</p>`;
        }
      }
    });

    // Запись с микрофона в модалке слов
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
        alert('Ошибка доступа к микрофону: ' + err.message);
      }
    });

    // Отправка формы вставки слов
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

        // Если записан микрофон
        if (insertWordsContext.micRecordedBlob && !finalAudioUrl) {
          const formData = new FormData();
          const file = new File([insertWordsContext.micRecordedBlob], `speech-${Date.now()}.webm`, { type: 'audio/webm' });
          formData.append('audio', file);
          const uploadRes = await api('/api/upload-audio', { method: 'POST', body: formData });
          finalAudioUrl = uploadRes.url;
        }

        // Если выбран файл
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
          alert('Пожалуйста, запишите голос с микрофона, выберите аудиофайл или запись из медиатеки.');
          return;
        }

        const calc = calculateSpeechInsertionSlot(targetTime);
        addSlotToEditor({
          title,
          type: 'speech',
          audio_url: finalAudioUrl,
          duration: finalDuration
        }, calc.insertIndex);

        const modal = document.getElementById('modalInsertWordsByTime');
        if (modal) modal.hidden = true;
        alert(`Слова ведущего успешно установлены в сетку вещания сразу после трека №${calc.priorSlotIndex || 1}!`);
      } catch (err) {
        alert('Ошибка добавления слов: ' + err.message);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = 'Вставить в сетку';
        }
      }
    });

    // 6. Модальные окна: открытие и закрытие
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

    // Превью обложки трека в форме загрузки
    document.getElementById('trackCoverInput')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      const previewBox = document.getElementById('trackCoverPreviewBox');
      const previewImg = document.getElementById('trackCoverPreviewImg');
      if (file && previewBox && previewImg) {
        previewImg.src = URL.createObjectURL(file);
        previewBox.style.display = 'flex';
      }
    });

    // Отправка формы загрузки трека
    dom.formUploadTrack?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = document.getElementById('trackFileInput')?.files[0];
      const title = document.getElementById('trackTitleInput')?.value.trim();
      const type = document.getElementById('trackTypeSelect')?.value;
      const coverFile = document.getElementById('trackCoverInput')?.files[0];
      const submitBtn = document.getElementById('btnSubmitUploadTrack');

      if (!file) return;

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Загрузка аудиофайла…';
      }

      try {
        // Загрузка обложки при наличии
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

        alert('Аудиозапись успешно опубликована!');
        dom.formUploadTrack?.reset();
        const previewBox = document.getElementById('trackCoverPreviewBox');
        if (previewBox) previewBox.style.display = 'none';

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

    // Проверка открытия конкретного трека через URL: /radio/track/:id или ?track=id
    const trackPathMatch = window.location.pathname.match(/\/radio\/track\/([^/]+)/);
    const searchTrackId = new URLSearchParams(window.location.search).get('track');
    const trackIdToOpen = (trackPathMatch && trackPathMatch[1]) || searchTrackId;

    if (trackIdToOpen) {
      openTrackPage(trackIdToOpen);
    } else {
      // Загрузка начальных данных
      loadStations();
      loadTracks();
    }

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

      feedPlayerState.audio.pause();
      feedPlayerState.audio.src = '';
      feedPlayerState.isPlaying = false;

      trackPageState.audio.pause();
      trackPageState.audio.src = '';
      trackPageState.isPlaying = false;

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
        feedPlayerState.audio.pause();
        trackPageState.audio.pause();
        window.RadioClient._mounted = false;
      }
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
