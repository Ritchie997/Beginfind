// radio-global-player.js — глобальный аудиоплеер AllTell, сохраняющий воспроизведение радио и музыки
// при переходе по любым публичным разделам (Antropedia, AllTell, Галерея, Профиль) и в Админ-панель.
(function () {
  'use strict';

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const totalSec = Math.floor(sec);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const pad = (n) => (n < 10 ? '0' : '') + n;
    return `${pad(m)}:${pad(s)}`;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
  }

  const STORAGE_KEY = 'alltell_global_radio_state';
  const tabId = 'tab_' + Math.random().toString(36).substring(2, 9);
  const broadcast = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('alltell_global_audio') : null;

  // Главный синглтон аудиоплеера
  const audio = new Audio();
  audio.preload = 'auto';

  const state = {
    mode: null, // 'radio' | 'track' | 'feed'
    isPlaying: false,
    station: null,
    currentSlot: null,
    track: null,
    playlist: [],
    currentIndex: -1,
    volume: 0.9,
    muted: false,
    isLoop: false,
    lastSaved: 0
  };

  const listeners = new Set();
  function notify() {
    listeners.forEach((fn) => {
      try { fn(state); } catch (e) { console.error(e); }
    });
    updateBarUI();
    saveState();
  }

  function saveState() {
    if (!state.mode) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const data = {
      mode: state.mode,
      isPlaying: state.isPlaying,
      station: state.station,
      currentSlot: state.currentSlot,
      track: state.track,
      playlist: state.playlist,
      currentIndex: state.currentIndex,
      currentTime: audio.currentTime || 0,
      duration: audio.duration || (state.track ? state.track.duration : 0),
      volume: state.volume,
      muted: state.muted,
      isLoop: state.isLoop,
      savedAt: Date.now()
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (_) {}
  }

  // Прием сообщений от других вкладок браузера (чтобы звук не двоился в разных вкладках)
  if (broadcast) {
    broadcast.onmessage = (event) => {
      const msg = event.data;
      if (msg && msg.type === 'PLAY_START' && msg.tabId !== tabId) {
        if (state.isPlaying) {
          audio.pause();
          state.isPlaying = false;
          notify();
        }
      }
    };
  }

  function announcePlay() {
    if (broadcast) {
      broadcast.postMessage({ type: 'PLAY_START', tabId });
    }
  }

  // Привязка событий HTML5 Audio
  audio.addEventListener('play', () => {
    state.isPlaying = true;
    updateBarUI();
    announcePlay();
    notify();
  });

  audio.addEventListener('pause', () => {
    state.isPlaying = false;
    updateBarUI();
    notify();
  });

  audio.addEventListener('timeupdate', () => {
    updateProgressUI();
  });

  audio.addEventListener('ended', () => {
    if (state.mode === 'radio') {
      // В режиме радио обновляем эфир
      if (state.station) {
        syncRadioStationLive(state.station, true);
      }
    } else if (state.isLoop) {
      audio.currentTime = 0;
      audio.play();
    } else if (state.currentIndex >= 0 && state.currentIndex < state.playlist.length - 1) {
      playTrackAt(state.currentIndex + 1);
    } else {
      state.isPlaying = false;
      updateBarUI();
      notify();
    }
  });

  // ===== Синхронизация радио прямого эфира =====
  async function syncRadioStationLive(station, autoPlay = true) {
    try {
      const res = await fetch(`/api/radio/stations/${station.id}/live`);
      if (!res.ok) return;
      const live = await res.json();

      state.mode = 'radio';
      state.station = station;
      state.currentSlot = live.currentSlot;

      if (live.currentSlot && live.currentSlot.audioUrl) {
        audio.src = live.currentSlot.audioUrl;
        const offset = live.offset || 0;
        audio.currentTime = offset;
        if (autoPlay) {
          audio.play().then(() => {
            state.isPlaying = true;
            notify();
          }).catch(() => {
            state.isPlaying = false;
            notify();
          });
        }
      } else {
        audio.pause();
        audio.src = '';
        state.isPlaying = false;
        notify();
      }
    } catch (e) {
      console.error('[GlobalRadio] Sync error:', e);
    }
  }

  function playRadio(station, slot = null, offset = 0) {
    state.mode = 'radio';
    state.station = station;
    state.currentSlot = slot;
    state.track = null;

    if (slot && slot.audioUrl) {
      audio.src = slot.audioUrl;
      audio.currentTime = offset || 0;
      audio.play().catch(() => {});
    } else {
      syncRadioStationLive(station, true);
    }
    notify();
  }

  function playTrack(track, playlist = [], index = -1) {
    state.mode = 'track';
    state.track = track;
    state.station = null;
    state.currentSlot = null;
    state.playlist = playlist && playlist.length ? playlist : [track];
    state.currentIndex = index >= 0 ? index : state.playlist.findIndex((t) => t.id === track.id);

    audio.src = track.audio_url;
    audio.currentTime = 0;
    audio.play().catch(() => {});
    notify();
  }

  function playTrackAt(index) {
    if (index >= 0 && index < state.playlist.length) {
      playTrack(state.playlist[index], state.playlist, index);
    }
  }

  function pause() {
    audio.pause();
    state.isPlaying = false;
    updateBarUI();
    notify();
  }

  function resume() {
    audio.play().catch(() => {});
  }

  function seek(ratio) {
    const dur = audio.duration || (state.track ? state.track.duration : 0);
    if (dur > 0) {
      audio.currentTime = ratio * dur;
    }
  }

  function setVolume(val) {
    state.volume = Math.max(0, Math.min(1, val));
    audio.volume = state.volume;
    saveState();
  }

  function toggleMute() {
    state.muted = !state.muted;
    audio.muted = state.muted;
    notify();
  }

  function stop() {
    audio.pause();
    audio.src = '';
    state.mode = null;
    state.isPlaying = false;
    state.station = null;
    state.track = null;
    state.currentSlot = null;
    state.playlist = [];
    state.currentIndex = -1;
    if (domBar && domBar.bar) domBar.bar.hidden = true;
    const bar = document.getElementById('alltellGlobalAudioBar');
    if (bar) bar.hidden = true;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
    notify();
  }

  // ===== Рендеринг глобальной панели на любой странице =====

  let domBar = null;

  function ensureBarDom() {
    if (domBar && document.getElementById('alltellGlobalAudioBar')) return domBar;

    let bar = document.getElementById('alltellGlobalAudioBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'alltellGlobalAudioBar';
      bar.className = 'alltell-global-audio-bar';
      bar.hidden = true;
      bar.innerHTML = `
        <div class="alltell-global-audio-inner">
          <div class="alltell-global-audio-info">
            <div class="alltell-global-audio-icon" id="globalAudioIcon">
              <i class="fas fa-tower-broadcast"></i>
            </div>
            <div class="alltell-global-audio-meta">
              <div class="alltell-global-audio-title-wrap">
                <span class="alltell-global-audio-badge" id="globalAudioBadge">FM</span>
                <a href="/radio" class="alltell-global-audio-title" id="globalAudioTitle">Эфир AllTell</a>
              </div>
              <div class="alltell-global-audio-sub" id="globalAudioSub">Вещание активно</div>
            </div>
          </div>
          <div class="alltell-global-audio-center">
            <div class="alltell-global-controls-row">
              <button type="button" class="alltell-global-audio-btn" id="globalAudioPrevBtn" title="Предыдущий"><i class="fas fa-backward-step"></i></button>
              <button type="button" class="alltell-global-audio-btn alltell-global-play-btn" id="globalAudioPlayBtn" title="Воспроизведение"><i class="fas fa-play"></i></button>
              <button type="button" class="alltell-global-audio-btn" id="globalAudioNextBtn" title="Следующий"><i class="fas fa-forward-step"></i></button>
            </div>
            <div class="alltell-global-progress-wrap">
              <span class="alltell-global-time" id="globalAudioTimeCurrent">00:00</span>
              <div class="alltell-global-progress-bar" id="globalAudioProgressBar">
                <div class="alltell-global-progress-fill" id="globalAudioProgressFill"></div>
              </div>
              <span class="alltell-global-time" id="globalAudioTimeDuration">00:00</span>
            </div>
          </div>
          <div class="alltell-global-audio-actions">
            <button type="button" class="alltell-global-tool-btn" id="globalAudioMuteBtn" title="Звук"><i class="fas fa-volume-high"></i></button>
            <input type="range" min="0" max="1" step="0.05" value="0.9" class="alltell-global-vol-slider" id="globalAudioVolumeSlider">
            <a href="/radio" class="alltell-global-link-btn" id="globalAudioRadioLink" title="Открыть раздел Радио">
              <i class="fas fa-radio"></i> <span>В Радио</span>
            </a>
            <button type="button" class="alltell-global-tool-btn alltell-global-close-btn" id="globalAudioCloseBtn" title="Закрыть плеер" aria-label="Закрыть плеер">
              <i class="fas fa-xmark"></i>
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(bar);
    }

    domBar = {
      bar,
      icon: bar.querySelector('#globalAudioIcon'),
      badge: bar.querySelector('#globalAudioBadge'),
      title: bar.querySelector('#globalAudioTitle'),
      sub: bar.querySelector('#globalAudioSub'),
      prevBtn: bar.querySelector('#globalAudioPrevBtn'),
      playBtn: bar.querySelector('#globalAudioPlayBtn'),
      nextBtn: bar.querySelector('#globalAudioNextBtn'),
      timeCurrent: bar.querySelector('#globalAudioTimeCurrent'),
      timeDuration: bar.querySelector('#globalAudioTimeDuration'),
      progressFill: bar.querySelector('#globalAudioProgressFill'),
      progressBar: bar.querySelector('#globalAudioProgressBar'),
      muteBtn: bar.querySelector('#globalAudioMuteBtn'),
      volSlider: bar.querySelector('#globalAudioVolumeSlider'),
      radioLink: bar.querySelector('#globalAudioRadioLink'),
      closeBtn: bar.querySelector('#globalAudioCloseBtn')
    };

    domBar.playBtn?.addEventListener('click', () => {
      if (state.isPlaying) pause();
      else resume();
    });

    domBar.prevBtn?.addEventListener('click', () => {
      if (state.currentIndex > 0) playTrackAt(state.currentIndex - 1);
    });

    domBar.nextBtn?.addEventListener('click', () => {
      if (state.currentIndex < state.playlist.length - 1) playTrackAt(state.currentIndex + 1);
    });

    domBar.progressBar?.addEventListener('click', (e) => {
      const rect = domBar.progressBar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      seek(ratio);
    });

    domBar.muteBtn?.addEventListener('click', toggleMute);
    domBar.volSlider?.addEventListener('input', (e) => setVolume(parseFloat(e.target.value)));
    domBar.closeBtn?.addEventListener('click', stop);

    return domBar;
  }

  function updateProgressUI() {
    if (!domBar) return;
    const cur = audio.currentTime || 0;
    const dur = audio.duration || (state.track ? state.track.duration : (state.currentSlot ? state.currentSlot.duration : 0));
    if (domBar.timeCurrent) domBar.timeCurrent.textContent = formatTime(cur);
    if (domBar.timeDuration) domBar.timeDuration.textContent = formatTime(dur);
    if (domBar.progressFill && dur > 0) {
      const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
      domBar.progressFill.style.width = `${pct}%`;
    }
  }

  function updateBarUI() {
    ensureBarDom();
    if (!domBar || !domBar.bar) return;

    if (!state.mode) {
      domBar.bar.hidden = true;
      return;
    }

    // Проверяем: если находимся на странице /radio и играет радио-дека,
    // нижняя глобальная панель скрывается, так как на экране уже видна большая дека.
    // На всех остальных страницах (или в режиме воспроизведения отдельного трека)
    // плеер остаётся виден как при воспроизведении, так и на паузе.
    // Скрывается он только при явном нажатии на кнопку закрытия (stop()).
    const isRadioPage = window.location.pathname === '/radio' || window.location.pathname.startsWith('/radio/track/');
    const shouldShow = Boolean(state.mode && !(isRadioPage && state.mode === 'radio'));
    domBar.bar.hidden = !shouldShow;

    if (state.mode === 'radio') {
      if (domBar.badge) domBar.badge.textContent = `${state.station ? state.station.frequency : '---'} FM`;
      if (domBar.title) {
        domBar.title.textContent = state.currentSlot ? state.currentSlot.title : (state.station ? state.station.name : 'Радио эфир');
        domBar.title.href = '/radio';
      }
      if (domBar.sub) {
        domBar.sub.textContent = state.station ? `Волна «${state.station.name}» • Ведущий: ${state.station.owner_name}` : 'Прямой эфир AllTell';
      }
      if (domBar.icon) {
        if (state.station && state.station.avatar_url) {
          domBar.icon.innerHTML = `<img src="${escapeHtml(state.station.avatar_url)}" alt="">`;
        } else {
          domBar.icon.innerHTML = `<i class="fas fa-tower-broadcast"></i>`;
        }
      }
      if (domBar.prevBtn) domBar.prevBtn.style.display = 'none';
      if (domBar.nextBtn) domBar.nextBtn.style.display = 'none';
    } else {
      // Режим трека
      const t = state.track;
      if (domBar.badge) domBar.badge.textContent = t ? String(t.format || 'MP3').toUpperCase() : 'ТРЕК';
      if (domBar.title) {
        domBar.title.textContent = t ? t.title : 'Аудиозапись';
        domBar.title.href = t ? `/radio/track/${t.id}` : '/radio';
      }
      if (domBar.sub) {
        domBar.sub.textContent = t ? `${t.author_name} • ${t.type === 'podcast' ? 'Подкаст' : t.type === 'speech' ? 'Слова' : 'Музыка'}` : 'Медиатека AllTell';
      }
      if (domBar.icon) {
        if (t && t.cover_url) {
          domBar.icon.innerHTML = `<img src="${escapeHtml(t.cover_url)}" alt="">`;
        } else {
          domBar.icon.innerHTML = `<i class="fas fa-music"></i>`;
        }
      }
      if (domBar.prevBtn) domBar.prevBtn.style.display = state.playlist.length > 1 ? 'inline-block' : 'none';
      if (domBar.nextBtn) domBar.nextBtn.style.display = state.playlist.length > 1 ? 'inline-block' : 'none';
    }

    if (domBar.playBtn) {
      domBar.playBtn.innerHTML = state.isPlaying ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
    }
  }

  // Восстановление воспроизведения из хранилища (при перезагрузке или переходе в /admin-panel)
  function tryRestorePlayback() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || !saved.mode) return;

      // Если сохранено менее 15 минут назад
      const elapsedMs = Date.now() - (saved.savedAt || 0);
      if (elapsedMs > 15 * 60 * 1000) return;

      state.mode = saved.mode;
      state.station = saved.station;
      state.currentSlot = saved.currentSlot;
      state.track = saved.track;
      state.playlist = saved.playlist || [];
      state.currentIndex = saved.currentIndex || -1;
      state.volume = saved.volume !== undefined ? saved.volume : 0.9;
      state.muted = Boolean(saved.muted);
      audio.volume = state.volume;
      audio.muted = state.muted;

      ensureBarDom();

      if (saved.isPlaying) {
        if (state.mode === 'radio' && state.station) {
          // Воспроизводим прямой эфир со свежим смещением
          syncRadioStationLive(state.station, true);
        } else if (state.track && state.track.audio_url) {
          audio.src = state.track.audio_url;
          audio.currentTime = saved.currentTime || 0;
          audio.play().then(() => {
            state.isPlaying = true;
            updateBarUI();
            notify();
          }).catch(() => {
            state.isPlaying = false;
            updateBarUI();
            // Если браузер заблокировал автовоспроизведение до первого клика
            const unlock = () => {
              audio.play().then(() => {
                state.isPlaying = true;
                updateBarUI();
                notify();
              }).catch(() => {});
            };
            document.addEventListener('pointerdown', unlock, { once: true });
          });
        }
      } else {
        // На паузе: сохраняем готовность трека и оставляем бар видимым с кнопкой Play
        state.isPlaying = false;
        if (state.track && state.track.audio_url) {
          audio.src = state.track.audio_url;
          audio.currentTime = saved.currentTime || 0;
        }
        updateBarUI();
      }
    } catch (e) {
      console.error('[GlobalRadio] Restore error:', e);
    }
  }

  // Экспорт синглтона в window
  window.AllTellGlobalRadio = {
    audio,
    getState: () => ({ ...state }),
    playRadio,
    playTrack,
    pause,
    resume,
    seek,
    setVolume,
    toggleMute,
    stop,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    syncBar: updateBarUI
  };

  // Автозапуск при инициализации страницы
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      ensureBarDom();
      tryRestorePlayback();
    });
  } else {
    ensureBarDom();
    tryRestorePlayback();
  }
})();
