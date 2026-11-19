// public/quick-switcher.js
// Модуль глобального быстрого поиска по всей платформе AllTell
// Объединяет статьи Antropedia, работы Галереи, франшизы/посты AllTell и треки/станции Радио.
// Вызывается по комбинациям Ctrl+K, Cmd+K, Ctrl+P, Cmd+P или клику на строку поиска в шапке.

(function () {
  'use strict';

  const CATEGORIES = [
    { id: 'all', label: 'Все', icon: 'fas fa-layer-group' },
    { id: 'articles', label: 'Статьи', icon: 'fas fa-book-open' },
    { id: 'gallery', label: 'Галерея', icon: 'fas fa-palette' },
    { id: 'alltell', label: 'AllTell', icon: 'fas fa-server' },
    { id: 'radio', label: 'Радио', icon: 'fas fa-music' }
  ];

  let overlayEl = null;
  let modalEl = null;
  let inputEl = null;
  let resultsEl = null;
  let clearBtnEl = null;
  let categoriesEl = null;

  let isOpen = false;
  let activeCategory = 'all';
  let currentResults = [];
  let selectedIndex = 0;
  let debounceTimer = null;
  let abortController = null;
  let lastQuery = '';

  function getToken() {
    if (window.authManager && typeof window.authManager.getToken === 'function') {
      const t = window.authManager.getToken();
      if (t) return t;
    }
    return localStorage.getItem('alltell_auth_token') || localStorage.getItem('authToken') || localStorage.getItem('token') || '';
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function navigateToItem(item) {
    if (!item) return;
    close();

    // 1. Статья Antropedia
    if (item.type === 'article') {
      const slug = item.slug || item.id;
      if (window.PublicSite && typeof window.PublicSite.navigateTo === 'function') {
        window.PublicSite.navigateTo('/antropedia/' + encodeURIComponent(slug));
        return;
      }
      if (window.spaRouter && typeof window.spaRouter.navigateTo === 'function') {
        window.spaRouter.navigateTo('/admin-panel/antropedia/' + encodeURIComponent(slug));
        return;
      }
      window.location.href = '/antropedia/' + encodeURIComponent(slug);
      return;
    }

    // 2. Галерея
    if (item.type === 'gallery') {
      const workId = item.workId || item.id;
      if (window.PublicSite && typeof window.PublicSite.navigateTo === 'function') {
        window.PublicSite.navigateTo('/site/gallery.html?work=' + encodeURIComponent(workId));
        return;
      }
      if (window.spaRouter && typeof window.spaRouter.navigateTo === 'function') {
        window.spaRouter.navigateTo('/gallery');
        setTimeout(() => {
          window.galleryViewer?.openWork(workId);
        }, 150);
        return;
      }
      window.location.href = '/site/gallery.html?work=' + encodeURIComponent(workId);
      return;
    }

    // 3. AllTell (Франшиза или публикация)
    if (item.type === 'alltell') {
      const targetUrl = item.url || (item.franchiseId ? `/alltell?franchise=${item.franchiseId}` : '/alltell?view=catalog');
      if (window.PublicSite && typeof window.PublicSite.navigateTo === 'function') {
        window.PublicSite.navigateTo(targetUrl);
        return;
      }
      window.location.href = targetUrl;
      return;
    }

    // 4. Радио (Трек или станция)
    if (item.type === 'radio') {
      const targetUrl = item.url || (item.trackId ? `/radio?track=${item.trackId}` : '/radio');
      if (window.PublicSite && typeof window.PublicSite.navigateTo === 'function') {
        window.PublicSite.navigateTo(targetUrl);
        return;
      }
      window.location.href = targetUrl;
      return;
    }

    // Запасной переход по URL
    if (item.url) {
      if (window.PublicSite && typeof window.PublicSite.navigateTo === 'function' && item.url.startsWith('/')) {
        window.PublicSite.navigateTo(item.url);
      } else {
        window.location.href = item.url;
      }
    }
  }

  function ensureMarkup() {
    if (overlayEl) return;

    overlayEl = document.createElement('div');
    overlayEl.className = 'qs-overlay';
    overlayEl.setAttribute('role', 'dialog');
    overlayEl.setAttribute('aria-modal', 'true');
    overlayEl.setAttribute('aria-label', 'Глобальный поиск AllTell');

    const catButtons = CATEGORIES.map((cat) => `
      <button type="button" class="qs-cat-btn ${cat.id === activeCategory ? 'is-active' : ''}" data-cat="${cat.id}">
        <i class="${cat.icon}" aria-hidden="true"></i>
        <span>${cat.label}</span>
        <span class="qs-cat-count" data-count-for="${cat.id}" hidden>0</span>
      </button>
    `).join('');

    overlayEl.innerHTML = `
      <div class="qs-modal">
        <div class="qs-search-row">
          <i class="fas fa-search qs-search-icon" aria-hidden="true"></i>
          <input type="text" class="qs-input" placeholder="Поиск по статьям, галерее, AllTell и радио..." autocomplete="off" spellcheck="false" />
          <button type="button" class="qs-clear-btn" title="Очистить" hidden><i class="fas fa-times"></i></button>
          <span class="qs-badge">ESC</span>
        </div>
        <div class="qs-categories">
          ${catButtons}
        </div>
        <div class="qs-results" role="listbox">
          <div class="qs-empty">Начните вводить запрос (название статьи, арт, франшизу или трек)...</div>
        </div>
        <div class="qs-footer">
          <div class="qs-shortcuts">
            <span class="qs-shortcut"><kbd class="qs-key">Tab</kbd> категория</span>
            <span class="qs-shortcut"><kbd class="qs-key">↑</kbd><kbd class="qs-key">↓</kbd> выбор</span>
            <span class="qs-shortcut"><kbd class="qs-key">↵</kbd> открыть</span>
            <span class="qs-shortcut"><kbd class="qs-key">ESC</kbd> закрыть</span>
          </div>
          <span>Глобальный поиск AllTell</span>
        </div>
      </div>
    `;

    document.body.appendChild(overlayEl);

    modalEl = overlayEl.querySelector('.qs-modal');
    inputEl = overlayEl.querySelector('.qs-input');
    resultsEl = overlayEl.querySelector('.qs-results');
    clearBtnEl = overlayEl.querySelector('.qs-clear-btn');
    categoriesEl = overlayEl.querySelector('.qs-categories');

    // Клик по фону вне окна закрывает окно
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) close();
    });

    // Очистка ввода
    clearBtnEl.addEventListener('click', () => {
      inputEl.value = '';
      clearBtnEl.hidden = true;
      inputEl.focus();
      search('');
    });

    // Обработчик ввода
    inputEl.addEventListener('input', () => {
      clearBtnEl.hidden = !inputEl.value;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        search(inputEl.value.trim());
      }, 140);
    });

    // Переключение категорий по клику на кнопки
    categoriesEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.qs-cat-btn');
      if (!btn) return;
      const cat = btn.dataset.cat;
      if (cat && cat !== activeCategory) {
        setCategory(cat);
      }
    });

    // Клавиатурная навигация внутри диалога
    overlayEl.addEventListener('keydown', onModalKeyDown);
  }

  function setCategory(cat) {
    activeCategory = cat;
    if (categoriesEl) {
      categoriesEl.querySelectorAll('.qs-cat-btn').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.cat === activeCategory);
      });
    }
    if (inputEl) {
      search(inputEl.value.trim());
      inputEl.focus();
    }
  }

  function cycleCategory(forward = true) {
    const ids = CATEGORIES.map((c) => c.id);
    const curIdx = ids.indexOf(activeCategory);
    const nextIdx = forward
      ? (curIdx + 1) % ids.length
      : (curIdx - 1 + ids.length) % ids.length;
    setCategory(ids[nextIdx]);
  }

  function onModalKeyDown(e) {
    if (!isOpen) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      cycleCategory(!e.shiftKey);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (currentResults.length > 0) {
        selectedIndex = (selectedIndex + 1) % currentResults.length;
        updateSelection();
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (currentResults.length > 0) {
        selectedIndex = (selectedIndex - 1 + currentResults.length) % currentResults.length;
        updateSelection();
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (currentResults.length > 0 && currentResults[selectedIndex]) {
        navigateToItem(currentResults[selectedIndex]);
      }
      return;
    }
  }

  function updateSelection() {
    const items = resultsEl.querySelectorAll('.qs-item');
    items.forEach((item, idx) => {
      const isSel = idx === selectedIndex;
      item.classList.toggle('is-selected', isSel);
      item.setAttribute('aria-selected', isSel ? 'true' : 'false');
      if (isSel) {
        item.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function updateCategoryCounts(counts) {
    if (!categoriesEl || !counts) return;
    CATEGORIES.forEach((cat) => {
      const badge = categoriesEl.querySelector(`[data-count-for="${cat.id}"]`);
      if (badge) {
        const count = counts[cat.id] ?? 0;
        if (count > 0 && lastQuery) {
          badge.textContent = String(count);
          badge.hidden = false;
        } else {
          badge.hidden = true;
        }
      }
    });
  }

  async function search(query) {
    lastQuery = query;
    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();

    if (!query) {
      currentResults = [];
      selectedIndex = 0;
      resultsEl.innerHTML = `<div class="qs-empty">Начните вводить запрос (название статьи, арт, франшизу или трек)...</div>`;
      updateCategoryCounts(null);
      return;
    }

    const token = getToken();
    const endpoint = '/api/global-search';
    const params = new URLSearchParams({
      q: query,
      category: activeCategory,
      limit: '20'
    });

    resultsEl.innerHTML = `<div class="qs-loading"><i class="fas fa-circle-notch fa-spin"></i> Поиск по платформе...</div>`;

    try {
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(`${endpoint}?${params.toString()}`, {
        headers,
        signal: abortController.signal
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const items = json.results || [];
      const counts = json.counts || null;
      renderResults(items, query, counts);
    } catch (err) {
      if (err.name === 'AbortError') return;
      resultsEl.innerHTML = `<div class="qs-empty">Ошибка загрузки: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderResults(items, query, counts) {
    currentResults = items;
    selectedIndex = 0;
    updateCategoryCounts(counts);

    if (!items || items.length === 0) {
      resultsEl.innerHTML = query
        ? `<div class="qs-empty">По запросу <b>«${escapeHtml(query)}»</b> в разделе «${escapeHtml(CATEGORIES.find(c => c.id === activeCategory)?.label || 'Все')}» ничего не найдено</div>`
        : `<div class="qs-empty">Начните вводить запрос...</div>`;
      return;
    }

    resultsEl.innerHTML = items.map((item, idx) => {
      const title = escapeHtml(item.title);
      const subtitle = escapeHtml(item.subtitle || '');
      const badge = escapeHtml(item.badge || 'Платформа');
      const icon = escapeHtml(item.icon || 'fas fa-search');

      let thumbHtml = '';
      if (item.image) {
        thumbHtml = `<div class="qs-item-thumb"><img src="${escapeHtml(item.image)}" alt="" onerror="this.parentElement.innerHTML='<i class=\\'${icon}\\'></i>';"></div>`;
      } else {
        thumbHtml = `<div class="qs-item-thumb is-icon qs-thumb-${item.type}"><i class="${icon}"></i></div>`;
      }

      let snippetHtml = '';
      if (item.snippet) {
        const safeSnippet = escapeHtml(item.snippet)
          .replace(/&lt;mark&gt;/g, '<mark>')
          .replace(/&lt;\/mark&gt;/g, '</mark>');
        snippetHtml = `<div class="qs-item-snippet">…${safeSnippet}…</div>`;
      }

      return `
        <div class="qs-item ${idx === 0 ? 'is-selected' : ''}" data-idx="${idx}" role="option" aria-selected="${idx === 0}">
          ${thumbHtml}
          <div class="qs-item-body">
            <div class="qs-item-head">
              <span class="qs-item-title">${title}</span>
              <span class="qs-item-badge qs-badge-${item.type}">${badge}</span>
            </div>
            ${subtitle ? `<div class="qs-item-meta">${subtitle}</div>` : ''}
            ${snippetHtml}
          </div>
        </div>
      `;
    }).join('');

    // Привязываем клики по результатам
    resultsEl.querySelectorAll('.qs-item').forEach((elem) => {
      const idx = parseInt(elem.dataset.idx, 10);
      elem.addEventListener('click', () => {
        if (currentResults[idx]) navigateToItem(currentResults[idx]);
      });
      elem.addEventListener('mouseenter', () => {
        selectedIndex = idx;
        updateSelection();
      });
    });
  }

  function open(initialQuery = '') {
    ensureMarkup();
    isOpen = true;
    overlayEl.classList.add('is-open');
    inputEl.value = initialQuery;
    clearBtnEl.hidden = !initialQuery;
    selectedIndex = 0;
    setTimeout(() => {
      inputEl.focus();
      inputEl.select();
    }, 30);
    search(initialQuery);
  }

  function close() {
    if (!isOpen || !overlayEl) return;
    isOpen = false;
    overlayEl.classList.remove('is-open');
    if (abortController) {
      abortController.abort();
    }
  }

  function toggle(initialQuery = '') {
    if (isOpen) close();
    else open(initialQuery);
  }

  // Глобальный перехватчик горячих клавиш: Ctrl+K / Cmd+K / Ctrl+P / Cmd+P
  function onGlobalKeyDown(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;

    const isK = e.code === 'KeyK' || e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'л';
    const isP = e.code === 'KeyP' || e.key.toLowerCase() === 'p' || e.key.toLowerCase() === 'з';

    if (!isK && !isP) return;

    // В редакторе статей выделенный текст + Ctrl+K служит для добавления ссылки
    const ae = document.activeElement;
    if (isK && ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) {
      if (typeof ae.selectionStart === 'number' && ae.selectionStart !== ae.selectionEnd) {
        return;
      }
    }

    e.preventDefault();
    e.stopPropagation();
    toggle();
  }

  document.addEventListener('keydown', onGlobalKeyDown, false);

  // Клик по иконке поиска в шапке любого экрана также открывает Quick Switcher
  document.addEventListener('click', (e) => {
    const icon = e.target.closest('.site-search i.fa-search');
    if (icon) {
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  });

  window.QuickSwitcher = {
    open,
    close,
    toggle,
    search,
    setCategory
  };
})();
