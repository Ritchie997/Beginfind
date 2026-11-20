// radio-global-player.js — глобальный аудиоплеер AllTell, сохраняющий воспроизведение радио и музыки
// при переходе по любым публичным разделам (Antropedia, AllTell, Галерея, Профиль) и в Админ-панель.
(function () {
  'use strict';

  // Защита синглтона: не пересоздавать плеер и не сбрасывать аудио при повторных вызовах скрипта
  if (window.alltellGlobalAudio) {
    if (typeof window.alltellGlobalAudio.syncBar === 'function') {
      window.alltellGlobalAudio.syncBar();
    }
    return;
  }

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

  let isAudioLeader = false;
  let isPageUnloading = false;
  let remoteLeaderTabId = null;

  const state = {
    mode: null, // 'radio' | 'track'
    isPlaying: false,
    station: null,
    currentSlot: null,
    track: null,
    playlist: [],
    currentIndex: -1,
    currentTime: 0,
    duration: 0,
    volume: 0.9,
    muted: false,
    isLoop: false,
    isTimeshift: false,
    timeshiftDeltaSec: 0,
    savedAt: 0
  };

  const listeners = new Set();

  function notifyListeners() {
    listeners.forEach((fn) => {
      try { fn(state); } catch (e) { console.error(e); }
    });
  }

  function notify() {
    notifyListeners();
    updateMediaSession();
    updateBarUI();
    updateProgressUI();
    saveState();
  }

  function getSerializableState() {
    return {
      mode: state.mode,
      isPlaying: isAudioLeader ? (!audio.paused && state.isPlaying) : state.isPlaying,
      station: state.station,
      currentSlot: state.currentSlot,
      track: state.track,
      playlist: state.playlist,
      currentIndex: state.currentIndex,
      currentTime: isAudioLeader ? (audio.currentTime || 0) : (state.currentTime || 0),
      duration: isAudioLeader ? (audio.duration || 0) : (state.duration || 0),
      volume: state.volume,
      muted: state.muted,
      isLoop: state.isLoop,
      isTimeshift: Boolean(state.isTimeshift),
      timeshiftDeltaSec: Number(state.timeshiftDeltaSec) || 0,
      savedAt: Date.now(),
      leaderTabId: isAudioLeader ? tabId : remoteLeaderTabId
    };
  }

  function applyState(data) {
    if (!data || !data.mode) return;
    state.mode = data.mode;
    state.isPlaying = Boolean(data.isPlaying);
    state.station = data.station || null;
    state.currentSlot = data.currentSlot || null;
    state.track = data.track || null;
    state.playlist = Array.isArray(data.playlist) ? data.playlist : [];
    state.currentIndex = data.currentIndex !== undefined ? data.currentIndex : -1;
    state.currentTime = Number.isFinite(data.currentTime) ? data.currentTime : 0;
    state.duration = Number.isFinite(data.duration) ? data.duration : 0;
    state.isTimeshift = Boolean(data.isTimeshift);
    state.timeshiftDeltaSec = Number(data.timeshiftDeltaSec) || 0;
    if (data.volume !== undefined) state.volume = Math.max(0, Math.min(1, data.volume));
    if (data.muted !== undefined) state.muted = Boolean(data.muted);
    if (data.isLoop !== undefined) {
      state.isLoop = Boolean(data.isLoop);
      if (audio) audio.loop = state.isLoop;
    }

    if (!isAudioLeader) {
      audio.volume = state.volume;
      audio.muted = state.muted;
    }
    updateMediaSession();
    updateBarUI();
    updateProgressUI();
    notifyListeners();
  }

  function saveState() {
    if (!state.mode) {
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
      return;
    }
    const data = getSerializableState();
    // При выгрузке страницы лидером сохраняем статус активного воспроизведения
    if (isPageUnloading && isAudioLeader) {
      data.isPlaying = true;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (_) {}
  }

  function announcePlay() {
    if (broadcast) {
      broadcast.postMessage({ type: 'PLAY_START', tabId, state: getSerializableState() });
    }
  }

  function announceState() {
    if (broadcast) {
      broadcast.postMessage({ type: 'STATE_UPDATE', tabId, state: getSerializableState() });
    }
  }

  // Прием сообщений от других вкладок браузера
  if (broadcast) {
    broadcast.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'QUERY_LEADER') {
        if (isAudioLeader && state.isPlaying && !audio.paused) {
          broadcast.postMessage({
            type: 'LEADER_ACK',
            tabId,
            state: getSerializableState()
          });
        }
      } else if (msg.type === 'LEADER_ACK') {
        if (msg.tabId !== tabId) {
          remoteLeaderTabId = msg.tabId;
          isAudioLeader = false;
          if (!audio.paused) {
            audio.pause();
          }
          applyState(msg.state);
        }
      } else if (msg.type === 'PLAY_START') {
        if (msg.tabId !== tabId) {
          remoteLeaderTabId = msg.tabId;
          if (isAudioLeader || !audio.paused) {
            audio.pause();
            isAudioLeader = false;
          }
          applyState(msg.state);
        }
      } else if (msg.type === 'STATE_UPDATE') {
        if (msg.tabId !== tabId && !isAudioLeader) {
          remoteLeaderTabId = msg.tabId;
          applyState(msg.state);
        }
      } else if (msg.type === 'CMD_PAUSE') {
        if (isAudioLeader) {
          pause();
        }
      } else if (msg.type === 'CMD_RESUME') {
        if (isAudioLeader) {
          resume();
        }
      } else if (msg.type === 'CMD_SEEK') {
        if (isAudioLeader && Number.isFinite(msg.ratio)) {
          seek(msg.ratio);
        }
      } else if (msg.type === 'CMD_GO_LIVE') {
        if (isAudioLeader) {
          goLive();
        }
      } else if (msg.type === 'CMD_STOP') {
        stop();
      } else if (msg.type === 'CMD_TRACK_AT') {
        if (isAudioLeader && Number.isFinite(msg.index)) {
          playTrackAt(msg.index);
        }
      } else if (msg.type === 'CMD_PLAY_NEXT') {
        if (isAudioLeader) {
          playNext();
        }
      } else if (msg.type === 'CMD_PLAY_PREV') {
        if (isAudioLeader) {
          playPrev();
        }
      } else if (msg.type === 'CMD_SET_LOOP') {
        setLoop(msg.isLoop);
      } else if (msg.type === 'CMD_SET_MUTE') {
        state.muted = Boolean(msg.muted);
        if (audio) audio.muted = state.muted;
        updateBarUI();
        notify();
      } else if (msg.type === 'LEADER_LEAVING') {
        if (msg.tabId === remoteLeaderTabId) {
          remoteLeaderTabId = null;
          if (msg.state) {
            state.currentTime = msg.state.currentTime || state.currentTime;
            state.isPlaying = false;
            updateBarUI();
            notifyListeners();
          }
        }
      }
    };
  }

  // Синхронизация через storage event на случай вкладок без BroadcastChannel
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && !isAudioLeader) {
      try {
        const data = JSON.parse(e.newValue);
        if (data) applyState(data);
      } catch (_) {}
    }
  });

  // Защита от сброса воспроизведения при перезагрузке страницы
  window.addEventListener('beforeunload', () => {
    isPageUnloading = true;
    if (isAudioLeader) {
      saveState();
      if (broadcast) {
        broadcast.postMessage({ type: 'LEADER_LEAVING', tabId, state: getSerializableState() });
      }
    }
  });

  window.addEventListener('pagehide', () => {
    isPageUnloading = true;
    if (isAudioLeader) {
      saveState();
    }
  });

  // Привязка событий HTML5 Audio
  audio.addEventListener('play', () => {
    isAudioLeader = true;
    remoteLeaderTabId = null;
    state.isPlaying = true;
    updateMediaSession();
    updateBarUI();
    announcePlay();
    notify();
  });

  audio.addEventListener('pause', () => {
    // Если пауза произошла из-за выгрузки вкладки, не сбрасываем состояние в localStorage
    if (isPageUnloading) return;
    state.isPlaying = false;
    updateMediaSession();
    updateBarUI();
    announceState();
    notify();
  });

  function handleDetectedDuration() {
    const d = audio.duration;
    if (Number.isFinite(d) && d > 0) {
      state.duration = d;
      updateProgressUI();

      // Если у текущего трека в базе была нулевая длительность (00:00) — обновляем интерфейс и сервер
      const trackId = (state.mode === 'track' && state.track)
        ? state.track.id
        : (state.currentSlot ? (state.currentSlot.trackId || state.currentSlot.track_id) : null);

      if (trackId && ((state.track && Number(state.track.duration) <= 0) || (state.currentSlot && Number(state.currentSlot.duration) <= 0))) {
        const durSec = Math.round(d);
        if (state.track) state.track.duration = durSec;
        if (state.currentSlot) state.currentSlot.duration = durSec;
        document.querySelectorAll(`[data-track-duration-id="${trackId}"]`).forEach((el) => {
          el.textContent = formatTime(durSec);
        });
        const trackPageDur = document.getElementById('trackPageTotalDuration');
        if (trackPageDur) trackPageDur.textContent = formatTime(durSec);

        fetch(`/api/radio/tracks/${trackId}/duration`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ duration: durSec })
        }).catch(() => {});
      }
    }
  }

  audio.addEventListener('loadedmetadata', handleDetectedDuration);
  audio.addEventListener('durationchange', handleDetectedDuration);

  audio.addEventListener('timeupdate', () => {
    state.currentTime = audio.currentTime || 0;
    state.duration = audio.duration || state.duration;
    if (audio.duration && (!state.track || !state.track.duration || state.track.duration <= 0)) {
      handleDetectedDuration();
    }
    updateProgressUI();
  });

  audio.addEventListener('seeked', () => {
    state.currentTime = audio.currentTime || 0;
    updateProgressUI();
  });

  audio.addEventListener('error', () => {
    // Не реагируем, если у аудио нет src, плеер не играет или ошибка вызвана сбросом источника
    if (!audio.src || !state.isPlaying || state.mode !== 'radio' || !state.station) return;
    const errCode = audio.error ? audio.error.code : 0;
    if (errCode === 4 && (!audio.currentSrc || audio.currentSrc === window.location.href)) return;

    console.warn('[GlobalRadio] Audio element error:', audio.error);
    if (syncRetryCount < MAX_SYNC_RETRIES) {
      syncRetryCount++;
      const backoff = Math.min(10000, 1500 * Math.pow(1.5, syncRetryCount));
      scheduleLiveSync(state.station, backoff);
    } else {
      console.warn('[GlobalRadio] Max live sync retries reached, pausing');
      state.isPlaying = false;
      resetAudioElement();
      updateBarUI();
      notify();
    }
  });

  audio.addEventListener('ended', () => {
    if (state.isLoop) {
      // Зацикливание включенного трека/слота: повторяем текущую дорожку с начала
      audio.currentTime = 0;
      audio.play().then(() => {
        state.isPlaying = true;
        updateMediaSession();
        updateBarUI();
        updateProgressUI();
        notify();
        announcePlay();
      }).catch(() => {
        state.isPlaying = false;
        updateBarUI();
        notify();
      });
      return;
    }

    if (state.mode === 'radio') {
      // В режиме радио проверяем плановое время окончания слота в эфире
      if (state.station) {
        const curSlot = state.currentSlot;
        const endMs = curSlot ? new Date(curSlot.endTime || curSlot.end_time).getTime() : 0;
        const nowMs = Date.now();
        const diffMs = endMs - nowMs;

        // Если аудиофайл закончился, но до планового окончания слота в сетке ещё осталось время (> 1200 мс) —
        // НЕ перескакиваем через треки раньше времени! Ждём планового времени переключения слота на сервере.
        if (diffMs > 1200) {
          scheduleLiveSync(state.station, diffMs);
          return;
        }

        // Плановое время окончания слота наступило — переходим к следующему слоту сетки
        const finishedId = curSlot ? curSlot.id : null;
        syncRadioStationLive(state.station, true, finishedId);
      }
    } else if (state.currentIndex >= 0 && state.currentIndex < state.playlist.length - 1) {
      playTrackAt(state.currentIndex + 1);
    } else {
      state.isPlaying = false;
      updateMediaSession();
      updateBarUI();
      notify();
      announceState();
    }
  });

  // Интеграция MediaSession API для бесперебойной работы в фоне и системных медиа-клавиш
  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      if (state.mode === 'radio') {
        const title = state.currentSlot ? state.currentSlot.title : (state.station ? state.station.name : 'Радио эфир');
        const artist = state.station ? `Волна «${state.station.name}» (${state.station.frequency} FM)` : 'AllTell Radio';
        const album = state.station ? `Ведущий: ${state.station.owner_name}` : 'Прямой эфир AllTell';
        const artwork = state.station && state.station.avatar_url
          ? [{ src: state.station.avatar_url, sizes: '512x512', type: 'image/png' }]
          : [];

        navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork });
      } else if (state.mode === 'track' && state.track) {
        const title = state.track.title || 'Аудиозапись';
        const artist = state.track.author_name || 'AllTell';
        const album = state.track.type === 'podcast' ? 'Подкасты AllTell' : state.track.type === 'speech' ? 'Слова' : 'Музыка AllTell';
        const artwork = state.track.cover_url
          ? [{ src: state.track.cover_url, sizes: '512x512', type: 'image/png' }]
          : [];

        navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork });
      } else {
        navigator.mediaSession.metadata = null;
      }

      navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
    } catch (_) {}
  }

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => resume());
      navigator.mediaSession.setActionHandler('pause', () => pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
      navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined && Number.isFinite(details.seekTime)) {
          const dur = audio.duration || (state.track ? state.track.duration : (state.currentSlot ? state.currentSlot.duration : 0));
          if (dur > 0) {
            seek(details.seekTime / dur);
          }
        }
      });
    } catch (_) {}
  }

  // Надежное выставление смещения времени для живого радиоэфира
  function applyAudioOffset(targetOffset) {
    const offset = Math.max(0, Number(targetOffset) || 0);

    const setTime = () => {
      try {
        const dur = audio.duration || 0;
        const safeOffset = (dur > 0 && offset >= dur) ? (dur > 5 ? (offset % dur) : 0) : offset;
        if (Math.abs((audio.currentTime || 0) - safeOffset) > 1.5) {
          audio.currentTime = safeOffset;
        }
      } catch (_) {}
    };

    if (audio.readyState >= 1) {
      setTime();
    } else {
      const onReady = () => {
        audio.removeEventListener('loadedmetadata', onReady);
        audio.removeEventListener('canplay', onReady);
        setTime();
      };
      audio.addEventListener('loadedmetadata', onReady, { once: true });
      audio.addEventListener('canplay', onReady, { once: true });
    }
  }

  // ===== Синхронизация прямого эфира радиостанции =====
  let isSyncingLive = false;
  let syncLiveTimer = null;
  let syncRetryCount = 0;
  const MAX_SYNC_RETRIES = 5;

  function cancelLiveSync() {
    if (syncLiveTimer) {
      clearTimeout(syncLiveTimer);
      syncLiveTimer = null;
    }
  }

  function scheduleLiveSync(station, delayMs = 2000) {
    cancelLiveSync();
    if (!station || state.mode !== 'radio') return;
    const delay = Math.max(1000, delayMs);
    syncLiveTimer = setTimeout(() => {
      syncLiveTimer = null;
      if (state.mode === 'radio' && state.station && String(state.station.id) === String(station.id)) {
        syncRadioStationLive(station, state.isPlaying);
      }
    }, delay);
  }

  function resetAudioElement() {
    audio.pause();
    audio.removeAttribute('src');
    try {
      audio.load();
    } catch (_) {}
  }

  async function syncRadioStationLive(station, autoPlay = true, finishedSlotId = null) {
    if (!station || !station.id) return;
    if (isSyncingLive) return;
    isSyncingLive = true;

    try {
      let url = `/api/radio/stations/${station.id}/live`;
      if (finishedSlotId) {
        url += `?finished_slot_id=${encodeURIComponent(finishedSlotId)}`;
      }
      const res = await fetch(url);
      if (!res.ok) {
        cancelLiveSync();
        if (res.status === 404) {
          console.warn(`[GlobalRadio] Station ${station.id} not found (404), stopping live`);
          state.station = null;
          state.currentSlot = null;
          state.isPlaying = false;
          resetAudioElement();
          updateBarUI();
          notify();
          try {
            localStorage.removeItem(STORAGE_KEY);
          } catch (_) {}
        }
        return;
      }
      const live = await res.json();

      // Если за время запроса пользователь переключил режим или станцию
      if (state.mode !== 'radio' || (state.station && String(state.station.id) !== String(station.id))) {
        return;
      }

      state.mode = 'radio';
      state.station = station;

      // Если эфир выключен владельцем станции (offline)
      if (live.broadcastStatus === 'offline') {
        state.currentSlot = null;
        state.isPlaying = false;
        resetAudioElement();
        cancelLiveSync();
        updateMediaSession();
        updateBarUI();
        notify();
        return;
      }

      // Если эфир запланирован на будущее (scheduled)
      if (live.broadcastStatus === 'scheduled') {
        state.currentSlot = null;
        state.isPlaying = false;
        resetAudioElement();
        updateMediaSession();
        updateBarUI();
        notify();
        if (live.scheduledStartTime) {
          const startMs = new Date(live.scheduledStartTime).getTime();
          const nowMs = live.serverTime ? new Date(live.serverTime).getTime() : Date.now();
          const delay = Math.max(2000, Math.min(30000, startMs - nowMs));
          scheduleLiveSync(station, delay);
        }
        return;
      }

      let targetSlot = live.currentSlot;
      let targetOffset = live.offset || 0;

      // Если слот, вернувшийся с сервера, это тот самый слот, который только что завершился
      if (state.currentSlot && targetSlot && state.currentSlot.id === targetSlot.id && audio.ended) {
        const slotEndMs = targetSlot.endTime ? new Date(targetSlot.endTime).getTime() : (targetSlot.end_time ? new Date(targetSlot.end_time).getTime() : 0);
        const serverNowMs = live.serverTime ? new Date(live.serverTime).getTime() : Date.now();
        const diffMs = slotEndMs - serverNowMs;

        // Если плановое время слота ещё не наступило в настенных часах — не перепрыгиваем через трек!
        if (diffMs > 1200) {
          scheduleLiveSync(station, diffMs);
          return;
        }

        if (live.nextSlots && live.nextSlots.length > 0 && live.nextSlots[0].audioUrl) {
          targetSlot = live.nextSlots[0];
          targetOffset = 0;
        } else {
          // Ждем завершения слота на сервере с безопасным интервалом (минимум 2 секунды)
          if (syncRetryCount < MAX_SYNC_RETRIES) {
            syncRetryCount++;
            scheduleLiveSync(station, 2000);
          }
          return;
        }
      }

      // Если текущего слота нет (стык треков), но есть следующий слот в очереди эфира
      if (!targetSlot && live.nextSlots && live.nextSlots.length > 0 && live.nextSlots[0].audioUrl) {
        targetSlot = live.nextSlots[0];
        targetOffset = 0;
      }

      state.currentSlot = targetSlot;

      if (targetSlot && targetSlot.audioUrl) {
        syncRetryCount = 0;
        cancelLiveSync();
        updateMediaSession();
        updateBarUI();
        notify();

        const currentSrc = audio.src || '';
        const isSameSrc = currentSrc === targetSlot.audioUrl || currentSrc.endsWith(targetSlot.audioUrl);
        if (!isSameSrc) {
          audio.src = targetSlot.audioUrl;
        } else if (audio.ended) {
          audio.currentTime = 0;
        }
        audio.loop = Boolean(state.isLoop);
        applyAudioOffset(targetOffset);

        if (autoPlay) {
          isAudioLeader = true;
          remoteLeaderTabId = null;
          audio.play().then(() => {
            state.isPlaying = true;
            updateMediaSession();
            updateBarUI();
            notify();
            announcePlay();
          }).catch(() => {
            state.isPlaying = false;
            updateMediaSession();
            updateBarUI();
            notify();
            // Разблокировка автовоспроизведения при первом клике или нажатии клавиши
            const unlock = () => {
              document.removeEventListener('pointerdown', unlock);
              document.removeEventListener('keydown', unlock);
              if (state.mode === 'radio' && state.station) {
                syncRadioStationLive(state.station, true);
              } else {
                audio.play().then(() => {
                  state.isPlaying = true;
                  updateMediaSession();
                  updateBarUI();
                  notify();
                  announcePlay();
                }).catch(() => {});
              }
            };
            document.addEventListener('pointerdown', unlock, { once: true });
            document.addEventListener('keydown', unlock, { once: true });
          });
        } else {
          state.isPlaying = false;
          updateBarUI();
          notify();
        }
      } else {
        // На станции нет активного слота в данный момент (эфир молчит или пуст)
        state.currentSlot = null;
        state.isPlaying = false;
        resetAudioElement();
        updateMediaSession();
        updateBarUI();
        notify();

        // Безопасное планирование проверки:
        // Если есть следующий слот, опрашиваем к моменту его старта (не чаще раза в 2 секунды)
        if (live.nextSlots && live.nextSlots.length > 0) {
          const nextSlot = live.nextSlots[0];
          let delayMs = 5000;
          if (nextSlot.startTime) {
            const startMs = new Date(nextSlot.startTime).getTime();
            const nowMs = live.serverTime ? new Date(live.serverTime).getTime() : Date.now();
            const diff = startMs - nowMs;
            if (diff > 0) {
              delayMs = Math.min(30000, Math.max(2000, diff));
            }
          }
          scheduleLiveSync(station, delayMs);
        } else if (station.fallback_mode === 'loop') {
          // Если зациклена, но слотов нет вообще — опрашиваем раз в 10 секунд
          scheduleLiveSync(station, 10000);
        } else {
          cancelLiveSync();
        }
      }
    } catch (e) {
      console.error('[GlobalRadio] Sync error:', e);
      if (syncRetryCount < MAX_SYNC_RETRIES) {
        syncRetryCount++;
        scheduleLiveSync(station, 5000);
      } else {
        cancelLiveSync();
      }
    } finally {
      isSyncingLive = false;
    }
  }

  function playRadio(station, slot = null, offset = 0, isTimeshift = false) {
    cancelLiveSync();
    syncRetryCount = 0;
    isAudioLeader = true;
    remoteLeaderTabId = null;
    state.mode = 'radio';
    state.station = station;
    state.currentSlot = slot;
    state.track = null;
    state.isTimeshift = Boolean(isTimeshift);
    if (!state.isTimeshift) {
      state.timeshiftDeltaSec = 0;
    }

    if (slot && slot.audioUrl) {
      const currentSrc = audio.src || '';
      const isSameSrc = currentSrc === slot.audioUrl || currentSrc.endsWith(slot.audioUrl);
      if (!isSameSrc) {
        audio.src = slot.audioUrl;
      }
      audio.loop = Boolean(state.isLoop);
      applyAudioOffset(offset);

      audio.play().then(() => {
        state.isPlaying = true;
        updateMediaSession();
        updateBarUI();
        notify();
        announcePlay();
      }).catch(() => {
        state.isPlaying = false;
        updateBarUI();
        notify();
        // Разблокировка автовоспроизведения при клике
        const unlock = () => {
          document.removeEventListener('pointerdown', unlock);
          document.removeEventListener('keydown', unlock);
          if (state.mode === 'radio' && state.station) {
            syncRadioStationLive(state.station, true);
          }
        };
        document.addEventListener('pointerdown', unlock, { once: true });
        document.addEventListener('keydown', unlock, { once: true });
      });
    } else {
      syncRadioStationLive(station, true);
    }
  }

  function playTrack(track, playlist = [], index = -1) {
    if (!track) return;
    cancelLiveSync();
    syncRetryCount = 0;
    isAudioLeader = true;
    remoteLeaderTabId = null;

    const isSameTrack = state.mode === 'track' && state.track && state.track.id === track.id;
    const currentSrc = audio.src || '';
    const isSameSrc = isSameTrack && (currentSrc === track.audio_url || currentSrc.endsWith(track.audio_url));

    state.mode = 'track';
    state.track = track;
    state.station = null;
    state.currentSlot = null;
    state.isTimeshift = false;
    state.timeshiftDeltaSec = 0;
    state.playlist = playlist && playlist.length ? playlist : [track];
    state.currentIndex = index >= 0 ? index : state.playlist.findIndex((t) => t.id === track.id);

    if (!isSameSrc) {
      audio.src = track.audio_url;
      audio.currentTime = 0;
    }
    audio.loop = Boolean(state.isLoop);

    audio.play().then(() => {
      state.isPlaying = true;
      updateMediaSession();
      updateBarUI();
      notify();
      announcePlay();
    }).catch(() => {
      state.isPlaying = false;
      updateBarUI();
      notify();
    });
  }

  function playTrackAt(index) {
    if (index >= 0 && index < state.playlist.length) {
      if (isAudioLeader) {
        playTrack(state.playlist[index], state.playlist, index);
      } else if (broadcast) {
        broadcast.postMessage({ type: 'CMD_TRACK_AT', index });
      }
    }
  }

  function playNext() {
    if (!isAudioLeader && broadcast) {
      broadcast.postMessage({ type: 'CMD_PLAY_NEXT' });
      return;
    }
    if (state.mode === 'radio') {
      if (window.RadioClient && typeof window.RadioClient.skipSlot === 'function') {
        window.RadioClient.skipSlot();
      } else if (state.station) {
        syncRadioStationLive(state.station, true);
      }
      return;
    }
    if (state.playlist && state.playlist.length > 0) {
      if (state.currentIndex >= 0 && state.currentIndex < state.playlist.length - 1) {
        playTrackAt(state.currentIndex + 1);
      } else if (state.isLoop || state.playlist.length > 1) {
        playTrackAt(0);
      } else {
        seek(0);
      }
    }
  }

  function playPrev() {
    if (!isAudioLeader && broadcast) {
      broadcast.postMessage({ type: 'CMD_PLAY_PREV' });
      return;
    }
    const cur = isAudioLeader ? (audio.currentTime || 0) : (state.currentTime || 0);
    if (cur > 3) {
      seek(0);
      return;
    }
    if (state.mode === 'radio') {
      if (window.RadioClient && typeof window.RadioClient.prevSlot === 'function') {
        window.RadioClient.prevSlot();
      } else {
        seek(0);
      }
      return;
    }
    if (state.playlist && state.playlist.length > 0) {
      if (state.currentIndex > 0) {
        playTrackAt(state.currentIndex - 1);
      } else if (state.isLoop || state.playlist.length > 1) {
        playTrackAt(state.playlist.length - 1);
      } else {
        seek(0);
      }
    } else {
      seek(0);
    }
  }

  function toggleLoop() {
    setLoop(!state.isLoop);
  }

  function setLoop(val) {
    state.isLoop = Boolean(val);
    if (audio) {
      audio.loop = state.isLoop;
    }
    if (!isAudioLeader && broadcast) {
      broadcast.postMessage({ type: 'CMD_SET_LOOP', isLoop: state.isLoop });
    }
    if (domBar && domBar.loopBtn) {
      domBar.loopBtn.classList.toggle('is-active', state.isLoop);
      domBar.loopBtn.title = state.isLoop ? 'Зацикливание включено (нажмите, чтобы выключить)' : 'Зациклить';
    }
    notify();
    announceState();
  }

  function pause() {
    cancelLiveSync();
    if (isAudioLeader) {
      audio.pause();
      state.isPlaying = false;
      updateMediaSession();
      updateBarUI();
      notify();
      announceState();
    } else if (broadcast) {
      broadcast.postMessage({ type: 'CMD_PAUSE' });
      state.isPlaying = false;
      updateBarUI();
      notifyListeners();
    }
  }

  function resume() {
    isAudioLeader = true;
    remoteLeaderTabId = null;

    if (state.mode === 'radio') {
      // Если слушатель не в таймшифте, разжатие паузы возвращает в текущий живой эфир на актуальное время
      if (!state.isTimeshift && state.station) {
        syncRadioStationLive(state.station, true);
        return;
      }

      if (state.currentSlot && state.currentSlot.audioUrl) {
        const currentSrc = audio.src || '';
        const isSameSrc = currentSrc === state.currentSlot.audioUrl || currentSrc.endsWith(state.currentSlot.audioUrl);
        if (!isSameSrc) {
          audio.src = state.currentSlot.audioUrl;
        }
        audio.loop = Boolean(state.isLoop);
        audio.play().then(() => {
          state.isPlaying = true;
          updateMediaSession();
          updateBarUI();
          notify();
          announcePlay();
        }).catch(() => {});
      } else if (state.station) {
        syncRadioStationLive(state.station, true);
      }
    } else if (state.mode === 'track' && state.track) {
      if (state.track.audio_url) {
        const currentSrc = audio.src || '';
        const isSameSrc = currentSrc === state.track.audio_url || currentSrc.endsWith(state.track.audio_url);
        if (!isSameSrc) {
          audio.src = state.track.audio_url;
          audio.currentTime = state.currentTime || 0;
        }
        audio.loop = Boolean(state.isLoop);
        audio.play().then(() => {
          state.isPlaying = true;
          updateMediaSession();
          updateBarUI();
          notify();
          announcePlay();
        }).catch(() => {});
      }
    }
  }

  function seek(ratio) {
    if (isAudioLeader) {
      const dur = audio.duration || (state.track ? state.track.duration : (state.currentSlot ? state.currentSlot.duration : 0));
      if (dur > 0 && Number.isFinite(ratio)) {
        const targetTime = Math.max(0, Math.min(dur, ratio * dur));

        if (state.mode === 'radio') {
          // Если мы в радио-режиме, проверяем позицию относительно реального живого времени
          if (state.currentSlot && state.currentSlot.startTime) {
            const startMs = new Date(state.currentSlot.startTime).getTime();
            const nowMs = Date.now();
            const liveOffset = Math.max(0, (nowMs - startMs) / 1000);
            if (targetTime < liveOffset - 2.5) {
              state.isTimeshift = true;
              state.timeshiftDeltaSec = Math.round(liveOffset - targetTime);
            } else {
              state.isTimeshift = false;
              state.timeshiftDeltaSec = 0;
            }
          } else if (targetTime < (audio.currentTime || 0) - 2) {
            state.isTimeshift = true;
          }
        }

        audio.currentTime = targetTime;
        state.currentTime = targetTime;
        updateProgressUI();
        updateBarUI();
        notify();
        announceState();
      }
    } else if (broadcast) {
      broadcast.postMessage({ type: 'CMD_SEEK', ratio });
    }
  }

  function goLive() {
    state.isTimeshift = false;
    state.timeshiftDeltaSec = 0;
    if (isAudioLeader) {
      if (state.mode === 'radio' && state.station) {
        syncRadioStationLive(state.station, true);
      }
    } else if (broadcast) {
      broadcast.postMessage({ type: 'CMD_GO_LIVE' });
    }
    updateBarUI();
    notify();
  }

  function setVolume(val) {
    state.volume = Math.max(0, Math.min(1, val));
    audio.volume = state.volume;
    saveState();
  }

  function toggleMute() {
    state.muted = !state.muted;
    audio.muted = state.muted;
    if (broadcast) {
      broadcast.postMessage({ type: 'CMD_SET_MUTE', muted: state.muted });
    }
    updateBarUI();
    saveState();
    notify();
  }

  function stop() {
    cancelLiveSync();
    resetAudioElement();
    state.mode = null;
    state.isPlaying = false;
    state.station = null;
    state.track = null;
    state.currentSlot = null;
    state.playlist = [];
    state.currentIndex = -1;
    isAudioLeader = false;
    remoteLeaderTabId = null;
    if (domBar && domBar.bar) domBar.bar.hidden = true;
    const bar = document.getElementById('alltellGlobalAudioBar');
    if (bar) bar.hidden = true;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
    if (broadcast) {
      broadcast.postMessage({ type: 'CMD_STOP' });
    }
    updateMediaSession();
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
                <button type="button" class="alltell-global-live-btn" id="globalAudioGoLiveBtn" title="Вернуться в прямой эфир" style="display:none;">
                  <i class="fas fa-tower-broadcast"></i> <span>В ЭФИР</span>
                </button>
                <a href="/radio" class="alltell-global-audio-title" id="globalAudioTitle">Эфир AllTell</a>
              </div>
              <div class="alltell-global-audio-sub" id="globalAudioSub">Вещание активно</div>
            </div>
          </div>
          <div class="alltell-global-audio-center">
            <div class="alltell-global-controls-row">
              <button type="button" class="alltell-global-audio-btn" id="globalAudioPrevBtn" title="Предыдущий трек" aria-label="Предыдущий трек"><i class="fas fa-backward-step"></i></button>
              <button type="button" class="alltell-global-audio-btn alltell-global-play-btn" id="globalAudioPlayBtn" title="Воспроизведение" aria-label="Воспроизведение"><i class="fas fa-play"></i></button>
              <button type="button" class="alltell-global-audio-btn" id="globalAudioNextBtn" title="Следующий трек" aria-label="Следующий трек"><i class="fas fa-forward-step"></i></button>
              <button type="button" class="alltell-global-audio-btn" id="globalAudioLoopBtn" title="Зациклить" aria-label="Зациклить"><i class="fas fa-repeat"></i></button>
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
      goLiveBtn: bar.querySelector('#globalAudioGoLiveBtn'),
      title: bar.querySelector('#globalAudioTitle'),
      sub: bar.querySelector('#globalAudioSub'),
      prevBtn: bar.querySelector('#globalAudioPrevBtn'),
      playBtn: bar.querySelector('#globalAudioPlayBtn'),
      nextBtn: bar.querySelector('#globalAudioNextBtn'),
      loopBtn: bar.querySelector('#globalAudioLoopBtn'),
      timeCurrent: bar.querySelector('#globalAudioTimeCurrent'),
      timeDuration: bar.querySelector('#globalAudioTimeDuration'),
      progressFill: bar.querySelector('#globalAudioProgressFill'),
      progressBar: bar.querySelector('#globalAudioProgressBar'),
      muteBtn: bar.querySelector('#globalAudioMuteBtn'),
      volSlider: bar.querySelector('#globalAudioVolumeSlider'),
      radioLink: bar.querySelector('#globalAudioRadioLink'),
      closeBtn: bar.querySelector('#globalAudioCloseBtn')
    };

    domBar.goLiveBtn?.addEventListener('click', () => {
      goLive();
    });

    domBar.playBtn?.addEventListener('click', () => {
      if (state.isPlaying) pause();
      else resume();
    });

    domBar.prevBtn?.addEventListener('click', () => {
      playPrev();
    });

    domBar.nextBtn?.addEventListener('click', () => {
      playNext();
    });

    domBar.loopBtn?.addEventListener('click', () => {
      toggleLoop();
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
    const cur = isAudioLeader ? (audio.currentTime || 0) : (state.currentTime || 0);
    const dur = isAudioLeader
      ? (audio.duration || (state.track ? state.track.duration : (state.currentSlot ? state.currentSlot.duration : 0)))
      : (state.duration || (state.track ? state.track.duration : (state.currentSlot ? state.currentSlot.duration : 0)));

    if (domBar) {
      if (domBar.timeCurrent) domBar.timeCurrent.textContent = formatTime(cur);
      if (domBar.timeDuration) domBar.timeDuration.textContent = formatTime(dur);
      if (domBar.progressFill && dur > 0) {
        const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
        domBar.progressFill.style.width = `${pct}%`;
      }
    }

    // Обновляем эфирную деку, если элемент присутствует в документе
    const deckFill = document.getElementById('deckProgressFill');
    const deckCur = document.getElementById('deckTimeCurrent');
    const deckRem = document.getElementById('deckTimeRemaining');
    if (deckFill || deckCur || deckRem) {
      if (deckCur) deckCur.textContent = formatTime(cur);
      if (deckRem) {
        const rem = Math.max(0, dur - cur);
        deckRem.textContent = rem > 0 ? `-${formatTime(rem)}` : formatTime(dur);
      }
      if (deckFill && dur > 0) {
        const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
        deckFill.style.width = `${pct}%`;
      }
    }

    // Обновляем прогресс на странице отдельного трека
    const trackFill = document.getElementById('trackPageProgressFill');
    const trackCur = document.getElementById('trackPageCurrentTime');
    const trackDur = document.getElementById('trackPageTotalDuration');
    if (trackFill || trackCur || trackDur) {
      if (trackCur) trackCur.textContent = formatTime(cur);
      if (trackDur) trackDur.textContent = formatTime(dur);
      if (trackFill && dur > 0) {
        trackFill.style.width = `${Math.min(100, Math.max(0, (cur / dur) * 100))}%`;
      }
    }
  }

  function updateBarUI() {
    ensureBarDom();
    if (!domBar || !domBar.bar) return;

    if (!state.mode) {
      domBar.bar.hidden = true;
      return;
    }

    // Проверяем: если находимся на странице /radio, активна вкладка "Эфир" с декой
    // и играет именно радио-станция, нижняя полоса убирается.
    // Если же пользователь переключился на "Медиатеку", "Моё", "Сетку вещания",
    // открыл отдельный трек или играет обычная музыкальная дорожка, нижний бар всегда виден!
    const tabLive = document.getElementById('tabContentLive');
    const isLiveDeckVisible = Boolean(tabLive && !tabLive.hidden && tabLive.style.display !== 'none');
    const isRadioPage = (window.location.pathname === '/radio') || window.location.pathname.startsWith('/radio');
    const isRadioPageWithDeck = isRadioPage && isLiveDeckVisible;
    const shouldShow = Boolean(state.mode && !isRadioPageWithDeck);
    domBar.bar.hidden = !shouldShow;

    if (state.mode === 'radio') {
      const needsSync = Boolean(state.isTimeshift || !state.isPlaying);
      if (domBar.goLiveBtn) {
        domBar.goLiveBtn.style.display = 'inline-flex';
        domBar.goLiveBtn.classList.toggle('is-needs-sync', needsSync);
        domBar.goLiveBtn.innerHTML = needsSync 
          ? '<i class="fas fa-rotate"></i> <span>Восстановить эфир</span>' 
          : '<i class="fas fa-tower-broadcast"></i> <span>В эфире</span>';
        domBar.goLiveBtn.title = needsSync 
          ? 'Отставание или пауза. Нажмите, чтобы мгновенно восстановить прямой эфир станции' 
          : 'Прямой эфир (синхронизировано)';
      }

      if (state.isTimeshift) {
        if (domBar.badge) {
          domBar.badge.textContent = '⏳ ТАЙМШИФТ';
          domBar.badge.classList.add('is-timeshift');
        }
        if (domBar.title) {
          domBar.title.textContent = state.currentSlot ? state.currentSlot.title : (state.station ? state.station.name : 'Радио эфир');
          domBar.title.href = '/radio';
        }
        if (domBar.sub) {
          const lagStr = state.timeshiftDeltaSec > 0 ? ` (-${formatTime(state.timeshiftDeltaSec)})` : '';
          domBar.sub.textContent = `Таймшифт${lagStr} • Нажмите «Восстановить эфир» для прямого вещания`;
        }
      } else {
        if (domBar.badge) {
          domBar.badge.textContent = `${state.station ? state.station.frequency : '---'} FM`;
          domBar.badge.classList.remove('is-timeshift');
        }
        if (domBar.title) {
          domBar.title.textContent = state.currentSlot ? state.currentSlot.title : (state.station ? state.station.name : 'Радио эфир');
          domBar.title.href = '/radio';
        }
        if (domBar.sub) {
          domBar.sub.textContent = state.station ? `Волна «${state.station.name}» • Ведущий: ${state.station.owner_name}` : 'Прямой эфир AllTell';
        }
      }
      if (domBar.icon) {
        if (state.station && state.station.avatar_url) {
          domBar.icon.innerHTML = `<img src="${escapeHtml(state.station.avatar_url)}" alt="">`;
        } else {
          domBar.icon.innerHTML = `<i class="fas fa-tower-broadcast"></i>`;
        }
      }
    } else {
      // Режим трека
      if (domBar.badge) domBar.badge.classList.remove('is-timeshift');
      if (domBar.goLiveBtn) domBar.goLiveBtn.style.display = 'none';
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
    }

    if (domBar.loopBtn) {
      domBar.loopBtn.classList.toggle('is-active', Boolean(state.isLoop));
      domBar.loopBtn.title = state.isLoop ? 'Зацикливание включено (нажмите, чтобы выключить)' : 'Зациклить';
    }

    if (domBar.muteBtn) {
      domBar.muteBtn.classList.toggle('is-active', Boolean(state.muted));
      domBar.muteBtn.classList.toggle('is-muted', Boolean(state.muted));
      domBar.muteBtn.innerHTML = state.muted ? '<i class="fas fa-volume-xmark"></i>' : '<i class="fas fa-volume-high"></i>';
      domBar.muteBtn.title = state.muted ? 'Включить звук' : 'Выключить звук';
      domBar.muteBtn.setAttribute('aria-label', state.muted ? 'Включить звук' : 'Выключить звук');
    }

    if (domBar.volSlider) {
      domBar.volSlider.value = state.muted ? 0 : state.volume;
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

      const elapsedMs = Date.now() - (saved.savedAt || 0);
      if (elapsedMs > 60 * 60 * 1000) return;

      state.mode = saved.mode;
      state.station = saved.station;
      state.currentSlot = saved.currentSlot;
      state.track = saved.track;
      state.playlist = saved.playlist || [];
      state.currentIndex = saved.currentIndex || -1;
      state.currentTime = saved.currentTime || 0;
      state.duration = saved.duration || 0;
      state.volume = saved.volume !== undefined ? saved.volume : 0.9;
      state.muted = Boolean(saved.muted);
      state.isLoop = Boolean(saved.isLoop);
      state.isTimeshift = Boolean(saved.isTimeshift);
      state.timeshiftDeltaSec = Number(saved.timeshiftDeltaSec) || 0;
      audio.volume = state.volume;
      audio.muted = state.muted;
      audio.loop = state.isLoop;

      ensureBarDom();

      // Если в другой вкладке уже играет этот звук, ведомо подключаемся к ней
      if (remoteLeaderTabId && remoteLeaderTabId !== tabId) {
        state.isPlaying = Boolean(saved.isPlaying);
        updateBarUI();
        updateProgressUI();
        notifyListeners();
        return;
      }

      if (saved.isPlaying) {
        isAudioLeader = true;
        if (state.mode === 'radio' && state.station) {
          syncRadioStationLive(state.station, true);
        } else if (state.track && state.track.audio_url) {
          audio.src = state.track.audio_url;
          audio.currentTime = saved.currentTime || 0;
          audio.play().then(() => {
            state.isPlaying = true;
            updateMediaSession();
            updateBarUI();
            notify();
            announcePlay();
          }).catch(() => {
            state.isPlaying = false;
            updateBarUI();
            notify();
            const unlock = () => {
              document.removeEventListener('pointerdown', unlock);
              document.removeEventListener('keydown', unlock);
              audio.play().then(() => {
                state.isPlaying = true;
                updateMediaSession();
                updateBarUI();
                notify();
                announcePlay();
              }).catch(() => {});
            };
            document.addEventListener('pointerdown', unlock, { once: true });
            document.addEventListener('keydown', unlock, { once: true });
          });
        }
      } else {
        // На паузе: сохраняем готовность трека и оставляем бар видимым с кнопкой Play
        state.isPlaying = false;
        if (state.mode === 'track' && state.track && state.track.audio_url) {
          audio.src = state.track.audio_url;
          audio.currentTime = saved.currentTime || 0;
        } else if (state.mode === 'radio' && state.station) {
          syncRadioStationLive(state.station, false);
        }
        updateBarUI();
        updateProgressUI();
        notifyListeners();
      }
    } catch (e) {
      console.error('[GlobalRadio] Restore error:', e);
    }
  }

  function initPlayer() {
    ensureBarDom();
    if (broadcast) {
      broadcast.postMessage({ type: 'QUERY_LEADER', tabId });
      setTimeout(() => {
        if (!remoteLeaderTabId) {
          tryRestorePlayback();
        }
      }, 80);
    } else {
      tryRestorePlayback();
    }
  }

  // Экспорт синглтона в window
  window.AllTellGlobalRadio = {
    audio,
    getState: () => ({ ...state }),
    playRadio,
    playTrack,
    playTrackAt,
    playNext,
    playPrev,
    toggleLoop,
    setLoop,
    pause,
    resume,
    seek,
    goLive,
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
    document.addEventListener('DOMContentLoaded', initPlayer);
  } else {
    initPlayer();
  }
})();
