// image-lightbox.js — Единый универсальный просмотрщик изображений (Lightbox)
// для AllTell, Antropedia, публичных статей и обращений.
// Полная поддержка мобильных жестов (горизонтальный свайп, вертикальный свайп для
// закрытия, pinch-to-zoom, double-tap zoom), клавиатуры и десктопных мышей.

(function () {
  'use strict';

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function getDistance(t1, t2) {
    var dx = t1.clientX - t2.clientX;
    var dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function getMidpoint(t1, t2) {
    return {
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2
    };
  }

  var raf = (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function')
    ? window.requestAnimationFrame.bind(window)
    : function (cb) { return setTimeout(cb, 16); };

  var ImageClass = (typeof Image !== 'undefined')
    ? Image
    : ((typeof window !== 'undefined' && window.Image) ? window.Image : function () { return {}; });

  class ImageLightbox {
    constructor() {
      this.items = [];
      this.index = 0;
      this.isOpen = false;
      this.scale = 1;
      this.panX = 0;
      this.panY = 0;
      this.chromeVisible = true;
      this._hist = null;

      // Touch / gesture state
      this._touchState = {
        startX: 0,
        startY: 0,
        lastX: 0,
        lastY: 0,
        startTime: 0,
        isSwiping: false,
        isVertical: false,
        isHorizontal: false,
        isPinching: false,
        startPinchDist: 0,
        startScale: 1,
        lastTapTime: 0,
        lastTapX: 0,
        lastTapY: 0
      };

      // Mouse drag state when zoomed
      this._mouseDrag = {
        isDragging: false,
        startX: 0,
        startY: 0,
        startPanX: 0,
        startPanY: 0
      };

      this._boundKeyDown = this._onKeyDown.bind(this);
      this._ensureDom();
    }

    _ensureDom() {
      if (document.getElementById('imageLightboxModal')) return;

      // Гарантируем стили
      if (!document.querySelector('link[href*="image-lightbox.css"]')) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/image-lightbox.css';
        document.head.appendChild(link);
      }

      var el = document.createElement('div');
      el.id = 'imageLightboxModal';
      el.className = 'image-lightbox';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', 'Просмотр изображения');
      el.tabIndex = -1;

      el.innerHTML = `
        <div class="image-lightbox-backdrop" data-lb="backdrop"></div>
        <header class="image-lightbox-top" data-lb="top">
          <div class="image-lightbox-counter" data-lb="counter" aria-live="polite"></div>
          <div class="image-lightbox-actions">
            <button type="button" class="image-lightbox-btn" data-lb="zoom" aria-label="Изменить масштаб" title="Масштаб (двойной клик)">
              <i class="fas fa-magnifying-glass-plus" aria-hidden="true"></i>
            </button>
            <a class="image-lightbox-btn" data-lb="original" target="_blank" rel="noopener noreferrer" aria-label="Открыть оригинал" title="Открыть оригинал в новой вкладке">
              <i class="fas fa-up-right-from-square" aria-hidden="true"></i>
            </a>
            <a class="image-lightbox-btn" data-lb="download" download aria-label="Скачать" title="Скачать изображение">
              <i class="fas fa-download" aria-hidden="true"></i>
            </a>
            <button type="button" class="image-lightbox-btn image-lightbox-close" data-lb="close" aria-label="Закрыть" title="Закрыть (Esc или свайп вниз)">
              <i class="fas fa-xmark" aria-hidden="true"></i>
            </button>
          </div>
        </header>

        <div class="image-lightbox-stage" data-lb="stage">
          <div class="image-lightbox-spinner" data-lb="spinner" hidden>
            <i class="fas fa-spinner fa-spin" aria-hidden="true"></i>
          </div>
          <div class="image-lightbox-error" data-lb="error" hidden>
            <i class="fas fa-triangle-exclamation" aria-hidden="true"></i>
            <span>Не удалось загрузить изображение</span>
          </div>
          <div class="image-lightbox-slide" data-lb="slide">
            <img class="image-lightbox-img" data-lb="img" src="" alt="" draggable="false">
          </div>
        </div>

        <button type="button" class="image-lightbox-nav prev" data-lb="prev" aria-label="Предыдущее изображение" title="Назад (← или свайп вправо)">
          <i class="fas fa-chevron-left" aria-hidden="true"></i>
        </button>
        <button type="button" class="image-lightbox-nav next" data-lb="next" aria-label="Следующее изображение" title="Вперёд (→ или свайп влево)">
          <i class="fas fa-chevron-right" aria-hidden="true"></i>
        </button>

        <footer class="image-lightbox-bottom" data-lb="bottom" hidden>
          <div class="image-lightbox-caption" data-lb="caption"></div>
        </footer>
      `;

      document.body.appendChild(el);

      this.els = {
        root: el,
        backdrop: el.querySelector('[data-lb="backdrop"]'),
        top: el.querySelector('[data-lb="top"]'),
        counter: el.querySelector('[data-lb="counter"]'),
        zoomBtn: el.querySelector('[data-lb="zoom"]'),
        originalBtn: el.querySelector('[data-lb="original"]'),
        downloadBtn: el.querySelector('[data-lb="download"]'),
        closeBtn: el.querySelector('[data-lb="close"]'),
        stage: el.querySelector('[data-lb="stage"]'),
        slide: el.querySelector('[data-lb="slide"]'),
        img: el.querySelector('[data-lb="img"]'),
        spinner: el.querySelector('[data-lb="spinner"]'),
        error: el.querySelector('[data-lb="error"]'),
        prevBtn: el.querySelector('[data-lb="prev"]'),
        nextBtn: el.querySelector('[data-lb="next"]'),
        bottom: el.querySelector('[data-lb="bottom"]'),
        caption: el.querySelector('[data-lb="caption"]')
      };

      this._initEvents();
    }

    _initEvents() {
      var self = this;
      var els = this.els;

      // Кнопки управления
      els.closeBtn.addEventListener('click', function () { self.close(); });
      els.backdrop.addEventListener('click', function () { self.close(); });
      els.prevBtn.addEventListener('click', function () { self.step(-1); });
      els.nextBtn.addEventListener('click', function () { self.step(1); });
      els.zoomBtn.addEventListener('click', function () { self.toggleZoom(); });

      // Сенсорные жесты (Touch Events) для мобильных пользователей
      els.stage.addEventListener('touchstart', this._onTouchStart.bind(this), { passive: false });
      els.stage.addEventListener('touchmove', this._onTouchMove.bind(this), { passive: false });
      els.stage.addEventListener('touchend', this._onTouchEnd.bind(this), { passive: false });
      els.stage.addEventListener('touchcancel', this._onTouchEnd.bind(this), { passive: false });

      // Мышь: клик по изображению для зума / тогла контролов
      els.img.addEventListener('click', function (e) {
        if (self._touchState.isSwiping || self._touchState.isPinching) return;
        if (self.scale > 1) {
          self.resetZoom();
        } else {
          // Если клик по изображению без перетаскивания
          self.toggleChrome();
        }
      });

      // Перетаскивание мышью при увеличенном масштабе
      els.stage.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        if (self.scale > 1) {
          self._mouseDrag.isDragging = true;
          self._mouseDrag.startX = e.clientX;
          self._mouseDrag.startY = e.clientY;
          self._mouseDrag.startPanX = self.panX;
          self._mouseDrag.startPanY = self.panY;
          els.slide.classList.add('is-grabbing');
          e.preventDefault();
        }
      });

      window.addEventListener('mousemove', function (e) {
        if (!self._mouseDrag.isDragging) return;
        var dx = e.clientX - self._mouseDrag.startX;
        var dy = e.clientY - self._mouseDrag.startY;
        self.panX = self._mouseDrag.startPanX + dx;
        self.panY = self._mouseDrag.startPanY + dy;
        self._applyTransform(false);
      });

      window.addEventListener('mouseup', function () {
        if (self._mouseDrag.isDragging) {
          self._mouseDrag.isDragging = false;
          els.slide.classList.remove('is-grabbing');
        }
      });

      // Зум колесом мыши (с Ctrl или когда уже масштабировано)
      els.stage.addEventListener('wheel', function (e) {
        if (!self.isOpen) return;
        if (e.ctrlKey || self.scale > 1) {
          e.preventDefault();
          var delta = e.deltaY < 0 ? 0.25 : -0.25;
          self.setScale(self.scale + delta, e.clientX, e.clientY);
        }
      }, { passive: false });
    }

    _onTouchStart(e) {
      if (!this.isOpen) return;

      var touches = e.touches;
      var now = Date.now();
      var state = this._touchState;

      if (touches.length === 2) {
        // Pinch-to-zoom двумя пальцами
        state.isPinching = true;
        state.startPinchDist = getDistance(touches[0], touches[1]);
        state.startScale = this.scale;
        e.preventDefault();
        return;
      }

      if (touches.length === 1) {
        var t = touches[0];

        // Проверка double-tap
        var timeSinceLast = now - state.lastTapTime;
        var distFromLast = Math.hypot(t.clientX - state.lastTapX, t.clientY - state.lastTapY);

        if (timeSinceLast < 320 && distFromLast < 40) {
          e.preventDefault();
          state.lastTapTime = 0;
          this.toggleZoom(t.clientX, t.clientY);
          return;
        }

        state.lastTapTime = now;
        state.lastTapX = t.clientX;
        state.lastTapY = t.clientY;

        state.startX = t.clientX;
        state.startY = t.clientY;
        state.lastX = t.clientX;
        state.lastY = t.clientY;
        state.startTime = now;
        state.isSwiping = false;
        state.isVertical = false;
        state.isHorizontal = false;
      }
    }

    _onTouchMove(e) {
      if (!this.isOpen) return;

      var touches = e.touches;
      var state = this._touchState;

      // Pinch зум
      if (touches.length === 2 && state.isPinching) {
        e.preventDefault();
        var currentDist = getDistance(touches[0], touches[1]);
        if (state.startPinchDist > 0) {
          var ratio = currentDist / state.startPinchDist;
          var newScale = clamp(state.startScale * ratio, 0.8, 4.0);
          var mid = getMidpoint(touches[0], touches[1]);
          this.setScale(newScale, mid.x, mid.y, false);
        }
        return;
      }

      if (touches.length === 1) {
        var t = touches[0];
        var dx = t.clientX - state.startX;
        var dy = t.clientY - state.startY;

        // Если картинка увеличена — перетаскиваем её (Pan)
        if (this.scale > 1.05) {
          e.preventDefault();
          var stepX = t.clientX - state.lastX;
          var stepY = t.clientY - state.lastY;
          state.lastX = t.clientX;
          state.lastY = t.clientY;
          this.panX += stepX;
          this.panY += stepY;
          this._applyTransform(false);
          return;
        }

        state.lastX = t.clientX;
        state.lastY = t.clientY;

        // Если не масштабирована — определяем направление жеста
        if (!state.isSwiping) {
          if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
            state.isSwiping = true;
            if (Math.abs(dy) > Math.abs(dx)) {
              state.isVertical = true;
            } else {
              state.isHorizontal = true;
            }
          }
        }

        if (state.isVertical) {
          e.preventDefault();
          // Вертикальный свайп для закрытия: картинка следует за пальцем, фон плавно тускнеет
          var pullFactor = 1 - Math.min(0.25, Math.abs(dy) / 1000);
          this.els.slide.style.transition = 'none';
          this.els.slide.style.transform = `translate3d(0, ${dy}px, 0) scale(${pullFactor})`;
          var opacity = Math.max(0.2, 1 - Math.abs(dy) / 450);
          this.els.backdrop.style.opacity = String(opacity);
          var controlsAlpha = Math.max(0, 1 - Math.abs(dy) / 160);
          this.els.top.style.opacity = String(controlsAlpha);
          this.els.bottom.style.opacity = String(controlsAlpha);
        } else if (state.isHorizontal && this.items.length > 1) {
          e.preventDefault();
          // Горизонтальный свайп: небольшое смещение для тактильного отклика
          var resist = 0.55;
          this.els.slide.style.transition = 'none';
          this.els.slide.style.transform = `translate3d(${dx * resist}px, 0, 0)`;
        }
      }
    }

    _onTouchEnd(e) {
      if (!this.isOpen) return;

      var state = this._touchState;

      if (state.isPinching) {
        state.isPinching = false;
        if (this.scale < 1.05) {
          this.resetZoom();
        } else {
          this._applyTransform(true);
        }
        return;
      }

      if (state.isVertical) {
        var dy = state.lastY - state.startY;
        var dt = Date.now() - state.startTime;
        var velocity = Math.abs(dy) / Math.max(1, dt);

        // Если свайп достаточно длинный или резкий — закрываем
        if (Math.abs(dy) > 85 || (velocity > 0.4 && Math.abs(dy) > 40)) {
          var targetY = dy > 0 ? '120%' : '-120%';
          this.els.slide.style.transition = 'transform 0.22s ease-out, opacity 0.2s ease-out';
          this.els.slide.style.transform = `translate3d(0, ${targetY}, 0)`;
          this.els.backdrop.style.opacity = '0';
          var self = this;
          setTimeout(function () { self.close(); }, 200);
        } else {
          // Возврат на место с пружинящей анимацией
          this.els.slide.style.transition = 'transform 0.25s cubic-bezier(0.18, 0.9, 0.3, 1)';
          this.els.slide.style.transform = 'translate3d(0, 0, 0) scale(1)';
          this.els.backdrop.style.opacity = '1';
          this.els.top.style.opacity = '1';
          this.els.bottom.style.opacity = '1';
        }
        state.isVertical = false;
        state.isSwiping = false;
        return;
      }

      if (state.isHorizontal && this.items.length > 1) {
        var dx = state.lastX - state.startX;
        var dt2 = Date.now() - state.startTime;
        var velocityX = Math.abs(dx) / Math.max(1, dt2);

        if (dx < -45 || (velocityX > 0.35 && dx < -20)) {
          this.step(1);
        } else if (dx > 45 || (velocityX > 0.35 && dx > 20)) {
          this.step(-1);
        } else {
          this.els.slide.style.transition = 'transform 0.25s cubic-bezier(0.18, 0.9, 0.3, 1)';
          this.els.slide.style.transform = 'translate3d(0, 0, 0)';
        }
        state.isHorizontal = false;
        state.isSwiping = false;
        return;
      }

      state.isSwiping = false;
    }

    _applyTransform(animate) {
      if (animate) {
        this.els.slide.style.transition = 'transform 0.22s cubic-bezier(0.18, 0.9, 0.3, 1)';
      } else {
        this.els.slide.style.transition = 'none';
      }

      if (this.scale <= 1) {
        this.panX = 0;
        this.panY = 0;
        this.els.slide.style.transform = 'translate3d(0, 0, 0) scale(1)';
        this.els.slide.classList.remove('is-zoomed');
        var zoomIcon = this.els.zoomBtn ? this.els.zoomBtn.querySelector('i') : null;
        if (zoomIcon) zoomIcon.className = 'fas fa-magnifying-glass-plus';
      } else {
        // Ограничиваем сдвиг границами экрана
        var maxPanX = (window.innerWidth * (this.scale - 1)) / 2 + 50;
        var maxPanY = (window.innerHeight * (this.scale - 1)) / 2 + 50;
        this.panX = clamp(this.panX, -maxPanX, maxPanX);
        this.panY = clamp(this.panY, -maxPanY, maxPanY);

        this.els.slide.style.transform = `translate3d(${this.panX}px, ${this.panY}px, 0) scale(${this.scale})`;
        this.els.slide.classList.add('is-zoomed');
        var zoomIcon2 = this.els.zoomBtn ? this.els.zoomBtn.querySelector('i') : null;
        if (zoomIcon2) zoomIcon2.className = 'fas fa-magnifying-glass-minus';
      }
    }

    setScale(newScale, originX, originY, animate) {
      var prevScale = this.scale;
      this.scale = clamp(newScale, 1.0, 4.0);

      if (this.scale > 1 && originX !== undefined && originY !== undefined && prevScale !== this.scale) {
        if (this.els.stage && typeof this.els.stage.getBoundingClientRect === 'function') {
          var rect = this.els.stage.getBoundingClientRect();
          var cx = originX - (rect.left + rect.width / 2);
          var cy = originY - (rect.top + rect.height / 2);
          var factor = (this.scale - prevScale) / prevScale;
          this.panX -= cx * factor;
          this.panY -= cy * factor;
        }
      }

      this._applyTransform(animate !== false);
    }

    toggleZoom(originX, originY) {
      if (this.scale > 1.05) {
        this.resetZoom();
      } else {
        this.setScale(2.5, originX || window.innerWidth / 2, originY || window.innerHeight / 2, true);
      }
    }

    resetZoom() {
      this.scale = 1;
      this.panX = 0;
      this.panY = 0;
      this._applyTransform(true);
    }

    toggleChrome() {
      this.chromeVisible = !this.chromeVisible;
      this.els.root.classList.toggle('chrome-hidden', !this.chromeVisible);
    }

    /**
     * Открывает просмотрщик
     * @param {Array<string|object>|string} items - массив ссылок или объектов { src, alt, caption }
     * @param {number} [startIndex=0] - начальный индекс
     */
    open(items, startIndex) {
      this._ensureDom();

      var list = [];
      if (Array.isArray(items)) {
        list = items;
      } else if (typeof items === 'string' && items.trim()) {
        list = [items.trim()];
      } else if (items && typeof items === 'object' && items.src) {
        list = [items];
      }

      if (!list.length) return;

      this.items = list.map(function (item) {
        if (typeof item === 'string') {
          return { src: item, alt: '', caption: '' };
        }
        return {
          src: item.src || item.url || '',
          alt: item.alt || '',
          caption: item.caption || item.alt || ''
        };
      }).filter(function (item) { return Boolean(item.src); });

      if (!this.items.length) return;

      this.index = clamp(Number(startIndex) || 0, 0, this.items.length - 1);
      this.isOpen = true;
      this.chromeVisible = true;
      this.els.root.classList.remove('chrome-hidden');

      // Блокируем прокрутку основного сайта
      document.documentElement.classList.add('lightbox-locked');
      document.body.classList.add('lightbox-locked');

      this.els.root.hidden = false;
      // Триггер анимации появления
      var self = this;
      raf(function () {
        self.els.root.classList.add('is-open');
        self.els.backdrop.style.opacity = '1';
        self.els.top.style.opacity = '1';
        self.els.bottom.style.opacity = '1';
      });

      window.addEventListener('keydown', this._boundKeyDown);

      // Интеграция с modalHistory для поддержки аппаратной/жестовой кнопки "Назад" на Android
      if (window.modalHistory) {
        this._hist = window.modalHistory.open(function () {
          self.close({ fromHistory: true });
        });
      }

      this.showImage(this.index);
    }

    showImage(index) {
      if (!this.items.length) return;
      this.index = (index + this.items.length) % this.items.length;
      var item = this.items[this.index];
      var total = this.items.length;

      this.resetZoom();

      // Обновляем шапку
      this.els.counter.textContent = total > 1 ? `${this.index + 1} / ${total}` : '';
      this.els.counter.style.display = total > 1 ? 'block' : 'none';
      this.els.prevBtn.hidden = total <= 1;
      this.els.nextBtn.hidden = total <= 1;

      this.els.originalBtn.href = item.src;
      this.els.downloadBtn.href = item.src;

      // Нижняя подпись
      var cap = (item.caption || item.alt || '').trim();
      if (cap) {
        this.els.caption.textContent = cap;
        this.els.bottom.hidden = false;
      } else {
        this.els.bottom.hidden = true;
      }

      // Загрузка изображения
      var img = this.els.img;
      var spinner = this.els.spinner;
      var err = this.els.error;

      spinner.hidden = false;
      err.hidden = true;
      img.style.opacity = '0';

      var tempImg = new ImageClass();
      tempImg.onload = function () {
        spinner.hidden = true;
        err.hidden = true;
        img.src = item.src;
        img.alt = item.alt || '';
        img.style.opacity = '1';
      };
      tempImg.onerror = function () {
        spinner.hidden = true;
        err.hidden = false;
        img.style.opacity = '0';
      };
      tempImg.src = item.src;

      // Предзагрузка соседних изображений
      this._preloadAdjacent();
    }

    _preloadAdjacent() {
      if (this.items.length <= 1) return;
      var nextIdx = (this.index + 1) % this.items.length;
      var prevIdx = (this.index - 1 + this.items.length) % this.items.length;
      new ImageClass().src = this.items[nextIdx].src;
      new ImageClass().src = this.items[prevIdx].src;
    }

    step(delta) {
      if (this.items.length <= 1) return;
      var nextIndex = this.index + delta;
      var self = this;

      // Анимация слайда
      var outTranslate = delta > 0 ? '-30px' : '30px';
      var inTranslate = delta > 0 ? '30px' : '-30px';

      this.els.slide.style.transition = 'transform 0.16s ease-out, opacity 0.16s ease-out';
      this.els.slide.style.transform = `translate3d(${outTranslate}, 0, 0)`;
      this.els.slide.style.opacity = '0';

      setTimeout(function () {
        self.showImage(nextIndex);
        self.els.slide.style.transition = 'none';
        self.els.slide.style.transform = `translate3d(${inTranslate}, 0, 0)`;
        self.els.slide.style.opacity = '0';

        raf(function () {
          self.els.slide.style.transition = 'transform 0.22s cubic-bezier(0.18, 0.9, 0.3, 1), opacity 0.2s ease';
          self.els.slide.style.transform = 'translate3d(0, 0, 0)';
          self.els.slide.style.opacity = '1';
        });
      }, 150);
    }

    close(options) {
      if (!this.isOpen) return;
      var fromHistory = options && options.fromHistory;

      this.isOpen = false;
      this.resetZoom();

      document.documentElement.classList.remove('lightbox-locked');
      document.body.classList.remove('lightbox-locked');

      window.removeEventListener('keydown', this._boundKeyDown);

      if (this._hist && !fromHistory && window.modalHistory) {
        window.modalHistory.close(this._hist);
      }
      this._hist = null;

      var root = this.els.root;
      root.classList.remove('is-open');
      setTimeout(function () {
        root.hidden = true;
      }, 240);
    }

    _onKeyDown(e) {
      if (!this.isOpen) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.step(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.step(1);
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        this.setScale(this.scale + 0.5);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        this.setScale(this.scale - 0.5);
      } else if (e.key === '0') {
        e.preventDefault();
        this.resetZoom();
      } else if (e.key === 'Home') {
        e.preventDefault();
        this.showImage(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        this.showImage(this.items.length - 1);
      }
    }
  }

  // Экспортируем глобальный экземпляр
  window.ImageLightbox = ImageLightbox;
  window.imageLightbox = new ImageLightbox();
  window.lightbox = window.imageLightbox;
})();
