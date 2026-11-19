// public/quick-switcher.js
// Модуль глобального быстрого поиска статей (Quick Switcher / Command Palette)
// Вызывается по комбинациям Ctrl+K, Cmd+K, Ctrl+P, Cmd+P из любого места сайта.

(function () {
  'use strict';

  let overlayEl = null;
  let modalEl = null;
  let inputEl = null;
  let resultsEl = null;
  let clearBtnEl = null;

  let isOpen = false;
  let currentResults = [];
  let selectedIndex = 0;
  let debounceTimer = null;
  let abortController = null;

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

  function formatDate(val) {
    if (!val) return '';
    try {
      const d = new Date(val);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    } catch (_) {
      return '';
    }
  }

  function navigateToArticle(slug) {
    if (!slug) return;
    close();

    // 1. Публичный SPA сайт
    if (window.PublicSite && typeof window.PublicSite.navigateTo === 'function') {
      window.PublicSite.navigateTo('/antropedia/' + encodeURIComponent(slug));
      return;
    }

    // 2. Админ-панель AllTell
    if (window.spaRouter && typeof window.spaRouter.navigateTo === 'function') {
      window.spaRouter.navigateTo('/admin-panel/antropedia/' + encodeURIComponent(slug));
      return;
    }

    // 3. Fallback
    window.location.href = '/antropedia/' + encodeURIComponent(slug);
  }

  function ensureMarkup() {
    if (overlayEl) return;

    overlayEl = document.createElement('div');
    overlayEl.className = 'qs-overlay';
    overlayEl.setAttribute('role', 'dialog');
    overlayEl.setAttribute('aria-modal', 'true');
    overlayEl.setAttribute('aria-label', 'Быстрый поиск статей');

    overlayEl.innerHTML = `
      <div class="qs-modal">
        <div class="qs-search-row">
          <i class="fas fa-search qs-search-icon" aria-hidden="true"></i>
          <input type="text" class="qs-input" placeholder="Поиск статей... (@автор, «фраза», #тег)" autocomplete="off" spellcheck="false" />
          <button type="button" class="qs-clear-btn" title="Очистить" hidden><i class="fas fa-times"></i></button>
          <span class="qs-badge">ESC</span>
        </div>
        <div class="qs-results" role="listbox">
          <div class="qs-empty">Начните вводить название, автора или тему статьи...</div>
        </div>
        <div class="qs-footer">
          <div class="qs-shortcuts">
            <span class="qs-shortcut"><kbd class="qs-key">↑</kbd><kbd class="qs-key">↓</kbd> выбор</span>
            <span class="qs-shortcut"><kbd class="qs-key">↵</kbd> открыть</span>
            <span class="qs-shortcut"><kbd class="qs-key">ESC</kbd> закрыть</span>
          </div>
          <span>Antropedia Quick Search</span>
        </div>
      </div>
    `;

    document.body.appendChild(overlayEl);

    modalEl = overlayEl.querySelector('.qs-modal');
    inputEl = overlayEl.querySelector('.qs-input');
    resultsEl = overlayEl.querySelector('.qs-results');
    clearBtnEl = overlayEl.querySelector('.qs-clear-btn');

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
      }, 120);
    });

    // Клавиатурная навигация внутри диалога
    overlayEl.addEventListener('keydown', onModalKeyDown);
  }

  function onModalKeyDown(e) {
    if (!isOpen) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      close();
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
        navigateToArticle(currentResults[selectedIndex].slug);
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

  async function search(query) {
    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();

    const token = getToken();
    const endpoint = token ? '/api/articles/browse' : '/api/public/articles';
    const params = new URLSearchParams({ limit: '8' });
    if (query) params.set('q', query);

    resultsEl.innerHTML = `<div class="qs-loading"><i class="fas fa-circle-notch"></i> Поиск...</div>`;

    try {
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(`${endpoint}?${params.toString()}`, {
        headers,
        signal: abortController.signal
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const items = json.data || [];
      renderResults(items, query);
    } catch (err) {
      if (err.name === 'AbortError') return;
      resultsEl.innerHTML = `<div class="qs-empty">Ошибка загрузки: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderResults(items, query) {
    currentResults = items;
    selectedIndex = 0;

    if (!items || items.length === 0) {
      resultsEl.innerHTML = query
        ? `<div class="qs-empty">По запросу <b>«${escapeHtml(query)}»</b> ничего не найдено</div>`
        : `<div class="qs-empty">Начните вводить название, автора или тему статьи...</div>`;
      return;
    }

    resultsEl.innerHTML = items.map((item, idx) => {
      const title = escapeHtml(item.title || item.slug);
      const author = item.author ? escapeHtml(item.author.display_name || item.author.username || '') : '';
      const date = formatDate(item.created_at);
      const server = item.server ? `<span class="qs-item-server">${escapeHtml(item.server)}</span>` : '';

      // Сниппет контекста с подсветкой ключевых слов FTS5
      let snippetHtml = '';
      if (item.search_snippet) {
        const safeSnippet = escapeHtml(item.search_snippet)
          .replace(/&lt;mark&gt;/g, '<mark>')
          .replace(/&lt;\/mark&gt;/g, '</mark>');
        snippetHtml = `<div class="qs-item-snippet">…${safeSnippet}…</div>`;
      } else if (item.excerpt) {
        snippetHtml = `<div class="qs-item-snippet">${escapeHtml(item.excerpt)}</div>`;
      }

      return `
        <div class="qs-item ${idx === 0 ? 'is-selected' : ''}" data-slug="${escapeHtml(item.slug)}" role="option" aria-selected="${idx === 0}">
          <i class="fas fa-file-alt qs-item-icon" aria-hidden="true"></i>
          <div class="qs-item-body">
            <div class="qs-item-head">
              <span class="qs-item-title">${title}</span>
              ${server}
            </div>
            ${snippetHtml}
            <div class="qs-item-meta">
              ${author ? `<span><i class="fas fa-user"></i> ${author}</span>` : ''}
              ${date ? `<span><i class="fas fa-calendar"></i> ${date}</span>` : ''}
              ${item.tags && item.tags.length ? `<span><i class="fas fa-hashtag"></i> ${escapeHtml(item.tags.slice(0, 3).join(', '))}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Привязываем клики по результатам
    resultsEl.querySelectorAll('.qs-item').forEach((item, idx) => {
      item.addEventListener('click', () => {
        navigateToArticle(item.dataset.slug);
      });
      item.addEventListener('mouseenter', () => {
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
  // Защищён от русской раскладки (e.code === 'KeyK' / 'KeyP')
  function onGlobalKeyDown(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;

    const isK = e.code === 'KeyK' || e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'л';
    const isP = e.code === 'KeyP' || e.key.toLowerCase() === 'p' || e.key.toLowerCase() === 'з';

    if (!isK && !isP) return;

    // Особый случай для редактора статей:
    // Если фокус в поле ввода (textarea) и ВЫДЕЛЕН текст, Ctrl+K используется для вставки ссылки
    const ae = document.activeElement;
    if (isK && ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) {
      if (typeof ae.selectionStart === 'number' && ae.selectionStart !== ae.selectionEnd) {
        // Выделен текст — пусть редактор отформатирует ссылку
        return;
      }
    }

    // Во всех остальных случаях — открываем глобальный Quick Switcher
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
    search
  };
})();
