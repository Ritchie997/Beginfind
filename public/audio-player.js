// audio-player.js — фирменный аудиоплеер для Antropedia (статьи) и AllTell (публикации)
(function () {
  'use strict';

  const activePlayers = new Set();

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
  }

  function getFormatBadge(url, explicitFormat) {
    if (explicitFormat) return String(explicitFormat).toUpperCase();
    const m = String(url || '').match(/\.([a-z0-9]+)(?:[?#]|$)/i);
    return m ? m[1].toUpperCase() : 'AUDIO';
  }

  class CustomAudioPlayer {
    constructor(element, options = {}) {
      this.el = element;
      this.options = options;
      this.tracks = options.tracks || (options.src ? [{
        url: options.src,
        title: options.title || '',
        artist: options.artist || '',
        format: options.format || ''
      }] : []);

      this.currentIndex = 0;
      this.audio = new Audio();
      this.audio.preload = 'metadata';
      this.isPlaying = false;
      this.isSeeking = false;
      this.isLooping = false;

      this.render();
      this.bindAudioEvents();
      this.bindUIEvents();
      activePlayers.add(this);

      if (this.tracks.length > 0) {
        this.loadTrack(0, false);
      }
    }

    currentTrack() {
      return this.tracks[this.currentIndex] || null;
    }

    render() {
      const track = this.currentTrack() || {};
      const hasMultiple = this.tracks.length > 1;

      this.el.classList.add('alltell-audio-player');
      this.el.innerHTML = `
        <div class="audio-player-main">
          <button type="button" class="audio-control-btn audio-play-btn" title="Воспроизвести / Пауза" aria-label="Воспроизвести">
            <i class="fas fa-play"></i>
          </button>
          <div class="audio-body">
            <div class="audio-header">
              <div class="audio-meta">
                <span class="audio-title">${escapeHtml(track.title || 'Аудиозапись')}</span>
                ${track.artist ? `<span class="audio-artist">${escapeHtml(track.artist)}</span>` : ''}
              </div>
              <span class="audio-badge">${escapeHtml(getFormatBadge(track.url, track.format))}</span>
            </div>
            <div class="audio-progress-wrap" role="slider" aria-label="Перемотка" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
              <div class="audio-progress-bg">
                <div class="audio-progress-buffered"></div>
                <div class="audio-progress-fill">
                  <div class="audio-progress-thumb"></div>
                </div>
              </div>
            </div>
            <div class="audio-footer">
              <div class="audio-time">
                <span class="audio-time-current">00:00</span>
                <span class="audio-time-divider">/</span>
                <span class="audio-time-duration">--:--</span>
              </div>
              <div class="audio-tools">
                <button type="button" class="audio-tool-btn audio-loop-btn" title="Повтор трека">
                  <i class="fas fa-repeat"></i>
                </button>
                <div class="audio-volume-wrap">
                  <button type="button" class="audio-tool-btn audio-mute-btn" title="Звук">
                    <i class="fas fa-volume-high"></i>
                  </button>
                  <input type="range" class="audio-volume-slider" min="0" max="1" step="0.05" value="1" title="Громкость">
                </div>
                ${track.url ? `<a class="audio-tool-btn audio-download-btn" href="${escapeAttr(track.url)}" download title="Скачать трек"><i class="fas fa-download"></i></a>` : ''}
              </div>
            </div>
          </div>
        </div>
        ${hasMultiple ? `
          <div class="audio-playlist">
            <div class="audio-playlist-header">
              <i class="fas fa-list-ul"></i> Список треков (${this.tracks.length})
            </div>
            <ul class="audio-playlist-list">
              ${this.tracks.map((t, idx) => `
                <li class="audio-playlist-item${idx === 0 ? ' is-active' : ''}" data-index="${idx}">
                  <span class="audio-playlist-num">${idx + 1}</span>
                  <div class="audio-playlist-info">
                    <span class="audio-playlist-title">${escapeHtml(t.title || `Трек ${idx + 1}`)}</span>
                    ${t.artist ? `<span class="audio-playlist-artist">${escapeHtml(t.artist)}</span>` : ''}
                  </div>
                  <span class="audio-playlist-badge">${escapeHtml(getFormatBadge(t.url, t.format))}</span>
                </li>
              `).join('')}
            </ul>
          </div>
        ` : ''}
      `;

      // Cache DOM references
      this.playBtn = this.el.querySelector('.audio-play-btn');
      this.titleEl = this.el.querySelector('.audio-title');
      this.artistEl = this.el.querySelector('.audio-artist');
      this.badgeEl = this.el.querySelector('.audio-badge');
      this.progressWrap = this.el.querySelector('.audio-progress-wrap');
      this.progressFill = this.el.querySelector('.audio-progress-fill');
      this.progressBuffered = this.el.querySelector('.audio-progress-buffered');
      this.timeCurrent = this.el.querySelector('.audio-time-current');
      this.timeDuration = this.el.querySelector('.audio-time-duration');
      this.loopBtn = this.el.querySelector('.audio-loop-btn');
      this.muteBtn = this.el.querySelector('.audio-mute-btn');
      this.volumeSlider = this.el.querySelector('.audio-volume-slider');
      this.downloadBtn = this.el.querySelector('.audio-download-btn');
      this.playlistItems = this.el.querySelectorAll('.audio-playlist-item');
    }

    loadTrack(index, autoPlay = true) {
      if (index < 0 || index >= this.tracks.length) return;
      this.currentIndex = index;
      const track = this.tracks[index];
      if (!track || !track.url) return;

      this.audio.src = track.url;
      this.audio.load();

      if (this.titleEl) this.titleEl.textContent = track.title || 'Аудиозапись';
      if (this.artistEl) {
        this.artistEl.textContent = track.artist || '';
        this.artistEl.style.display = track.artist ? '' : 'none';
      }
      if (this.badgeEl) this.badgeEl.textContent = getFormatBadge(track.url, track.format);
      if (this.downloadBtn) this.downloadBtn.href = track.url;

      if (this.progressFill) this.progressFill.style.width = '0%';
      if (this.timeCurrent) this.timeCurrent.textContent = '00:00';
      if (this.timeDuration) this.timeDuration.textContent = track.duration ? formatTime(track.duration) : '--:--';

      if (this.playlistItems) {
        this.playlistItems.forEach((it, idx) => {
          it.classList.toggle('is-active', idx === index);
        });
      }

      if (autoPlay) {
        this.play();
      }
    }

    play() {
      // Pause all other players
      for (const p of activePlayers) {
        if (p !== this && p.isPlaying) {
          p.pause();
        }
      }

      const promise = this.audio.play();
      if (promise && promise.catch) {
        promise.catch((err) => {
          console.warn('AllTellAudioPlayer play prevented:', err);
          this.isPlaying = false;
          this.updatePlayState();
        });
      }
      this.isPlaying = true;
      this.updatePlayState();
    }

    pause() {
      this.audio.pause();
      this.isPlaying = false;
      this.updatePlayState();
    }

    togglePlay() {
      if (this.isPlaying) {
        this.pause();
      } else {
        this.play();
      }
    }

    updatePlayState() {
      if (!this.playBtn) return;
      const icon = this.playBtn.querySelector('i');
      if (icon) {
        icon.className = this.isPlaying ? 'fas fa-pause' : 'fas fa-play';
      }
      this.playBtn.setAttribute('aria-label', this.isPlaying ? 'Пауза' : 'Воспроизвести');
      this.el.classList.toggle('is-playing', this.isPlaying);
    }

    bindAudioEvents() {
      this.audio.addEventListener('timeupdate', () => {
        if (this.isSeeking) return;
        const current = this.audio.currentTime || 0;
        const duration = this.audio.duration || 0;
        if (this.timeCurrent) this.timeCurrent.textContent = formatTime(current);
        if (duration > 0 && this.progressFill) {
          const pct = Math.min(100, Math.max(0, (current / duration) * 100));
          this.progressFill.style.width = `${pct}%`;
        }
      });

      this.audio.addEventListener('durationchange', () => {
        if (Number.isFinite(this.audio.duration) && this.timeDuration) {
          this.timeDuration.textContent = formatTime(this.audio.duration);
        }
      });

      this.audio.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(this.audio.duration) && this.timeDuration) {
          this.timeDuration.textContent = formatTime(this.audio.duration);
        }
      });

      this.audio.addEventListener('progress', () => {
        if (this.audio.buffered && this.audio.buffered.length > 0 && this.audio.duration) {
          const bufferedEnd = this.audio.buffered.end(this.audio.buffered.length - 1);
          const pct = Math.min(100, (bufferedEnd / this.audio.duration) * 100);
          if (this.progressBuffered) this.progressBuffered.style.width = `${pct}%`;
        }
      });

      this.audio.addEventListener('ended', () => {
        if (this.isLooping) {
          this.audio.currentTime = 0;
          this.play();
          return;
        }
        if (this.currentIndex < this.tracks.length - 1) {
          this.loadTrack(this.currentIndex + 1, true);
        } else {
          this.pause();
          this.audio.currentTime = 0;
          if (this.progressFill) this.progressFill.style.width = '0%';
          if (this.timeCurrent) this.timeCurrent.textContent = '00:00';
        }
      });

      this.audio.addEventListener('play', () => {
        this.isPlaying = true;
        this.updatePlayState();
      });

      this.audio.addEventListener('pause', () => {
        this.isPlaying = false;
        this.updatePlayState();
      });
    }

    bindUIEvents() {
      this.playBtn?.addEventListener('click', () => this.togglePlay());

      // Seek handling
      const handleSeek = (e) => {
        if (!this.progressWrap) return;
        const rect = this.progressWrap.getBoundingClientRect();
        const clientX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        if (this.audio.duration) {
          this.audio.currentTime = ratio * this.audio.duration;
        }
        if (this.progressFill) {
          this.progressFill.style.width = `${ratio * 100}%`;
        }
      };

      this.progressWrap?.addEventListener('mousedown', (e) => {
        this.isSeeking = true;
        handleSeek(e);
        const onMouseMove = (ev) => handleSeek(ev);
        const onMouseUp = () => {
          this.isSeeking = false;
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        };
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });

      this.progressWrap?.addEventListener('touchstart', (e) => {
        this.isSeeking = true;
        handleSeek(e);
        const onTouchMove = (ev) => handleSeek(ev);
        const onTouchEnd = () => {
          this.isSeeking = false;
          window.removeEventListener('touchmove', onTouchMove);
          window.removeEventListener('touchend', onTouchEnd);
        };
        window.addEventListener('touchmove', onTouchMove, { passive: true });
        window.addEventListener('touchend', onTouchEnd);
      }, { passive: true });

      // Loop
      this.loopBtn?.addEventListener('click', () => {
        this.isLooping = !this.isLooping;
        this.loopBtn.classList.toggle('is-active', this.isLooping);
        this.loopBtn.title = this.isLooping ? 'Повтор включён' : 'Повтор трека';
      });

      // Volume
      this.volumeSlider?.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this.audio.volume = val;
        this.audio.muted = (val === 0);
        this.updateVolumeIcon();
      });

      this.muteBtn?.addEventListener('click', () => {
        this.audio.muted = !this.audio.muted;
        this.updateVolumeIcon();
      });

      // Playlist item clicks
      this.el.querySelector('.audio-playlist')?.addEventListener('click', (e) => {
        const item = e.target.closest('.audio-playlist-item');
        if (item && item.dataset.index) {
          const idx = parseInt(item.dataset.index, 10);
          if (idx === this.currentIndex) {
            this.togglePlay();
          } else {
            this.loadTrack(idx, true);
          }
        }
      });
    }

    updateVolumeIcon() {
      if (!this.muteBtn) return;
      const icon = this.muteBtn.querySelector('i');
      if (!icon) return;
      if (this.audio.muted || this.audio.volume === 0) {
        icon.className = 'fas fa-volume-xmark';
      } else if (this.audio.volume < 0.5) {
        icon.className = 'fas fa-volume-low';
      } else {
        icon.className = 'fas fa-volume-high';
      }
    }

    destroy() {
      this.pause();
      this.audio.src = '';
      activePlayers.delete(this);
      this.el.innerHTML = '';
    }
  }

  // Публичный API
  window.AllTellAudio = {
    create(element, options) {
      if (!element) return null;
      return new CustomAudioPlayer(element, options);
    },

    initAll(container = document) {
      const players = [];
      const nodes = container.querySelectorAll('[data-audio-player]:not([data-audio-initialized])');
      nodes.forEach((el) => {
        el.setAttribute('data-audio-initialized', 'true');
        let options = {};
        try {
          const raw = el.getAttribute('data-audio-config');
          if (raw) options = JSON.parse(raw);
        } catch (_) {}
        if (!options.src && el.dataset.audioSrc) {
          options.src = el.dataset.audioSrc;
          options.title = el.dataset.audioTitle || '';
          options.artist = el.dataset.audioArtist || '';
        }
        players.push(new CustomAudioPlayer(el, options));
      });
      return players;
    },

    formatTime,
    getFormatBadge
  };

  // Автоинициализация при загрузке документа
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.AllTellAudio.initAll());
  } else {
    setTimeout(() => window.AllTellAudio.initAll(), 0);
  }
})();
