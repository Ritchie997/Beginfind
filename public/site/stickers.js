(function () {
  'use strict';

  var TOKEN_KEY = 'alltell_auth_token';
  var picker = null;
  var pickerTrigger = null;
  var pickerSelect = null;
  var subscribedPacks = null;
  var favoriteStickers = null;
  var activeTab = null;
  var storeOverlay = null;
  var storeSearchTimer = null;

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (error) { return ''; }
  }

  function login() {
    if (typeof window.showModalLogin === 'function') window.showModalLogin('login');
    else window.location.href = '/admin-panel';
  }

  async function request(path, options) {
    var headers = Object.assign({}, options && options.headers, { Authorization: 'Bearer ' + token() });
    if (options && options.body) headers['Content-Type'] = 'application/json';
    var response = await fetch(path, Object.assign({}, options, { headers: headers }));
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || 'Ошибка запроса (' + response.status + ')');
    return data;
  }

  function safeImage(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    var src = value.trim();
    if (src.indexOf('/uploads/') === 0) return src;
    try {
      var url = new URL(src, window.location.origin);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
    } catch (error) {
      return '';
    }
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function closePicker() {
    if (picker) picker.remove();
    if (pickerTrigger) pickerTrigger.classList.remove('active');
    picker = null;
    pickerTrigger = null;
    pickerSelect = null;
    document.removeEventListener('click', onOutsideClick);
    document.removeEventListener('keydown', onPickerKeydown);
  }

  function onOutsideClick(event) {
    if (!picker) return;
    var path = event.composedPath ? event.composedPath() : [];
    var insidePicker = path.indexOf(picker) !== -1 || picker.contains(event.target);
    var onTrigger = pickerTrigger &&
      (event.target === pickerTrigger || pickerTrigger.contains(event.target) || path.indexOf(pickerTrigger) !== -1);
    if (!insidePicker && !onTrigger) closePicker();
  }

  function onPickerKeydown(event) {
    if (event.key === 'Escape') closePicker();
  }

  function positionPicker() {
    if (!picker || !pickerTrigger) return;
    var rect = pickerTrigger.getBoundingClientRect();
    var width = Math.min(360, window.innerWidth - 24);
    picker.style.width = width + 'px';
    picker.style.left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)) + 'px';
    var height = Math.min(picker.offsetHeight || 360, window.innerHeight - 24);
    picker.style.top = rect.top - height - 8 >= 12 ? (rect.top - height - 8) + 'px' : Math.min(rect.bottom + 8, window.innerHeight - height - 12) + 'px';
  }

  function showPickerMessage(message, error) {
    if (!picker) return;
    var body = picker.querySelector('.pub-sticker-picker-body');
    body.replaceChildren(element('p', error ? 'pub-sticker-error' : 'pub-sticker-empty', message));
  }

  function renderPicker() {
    if (!picker) return;
    var body = picker.querySelector('.pub-sticker-picker-body');
    var packs = (subscribedPacks || []).filter(function (pack) {
      return Array.isArray(pack.stickers) && pack.stickers.length;
    });
    var favorites = favoriteStickers || [];
    var tabs = picker.querySelector('.pub-sticker-picker-tabs');
    var subtitle = picker.querySelector('.pub-sticker-picker-subtitle');
    var validTabs = ['favorites'].concat(packs.map(function (pack) { return String(pack.slug); }));
    if (validTabs.indexOf(activeTab) === -1) activeTab = favorites.length ? 'favorites' : (packs[0] && String(packs[0].slug));

    tabs.replaceChildren();
    var favoriteTab = element('button', 'pub-sticker-picker-tab pub-sticker-picker-tab-fav' + (activeTab === 'favorites' ? ' active' : ''), '★');
    favoriteTab.type = 'button';
    favoriteTab.title = 'Избранное';
    favoriteTab.addEventListener('click', function () {
      activeTab = 'favorites';
      renderPicker();
    });
    tabs.appendChild(favoriteTab);
    packs.forEach(function (pack) {
      var tab = element('button', 'pub-sticker-picker-tab' + (activeTab === String(pack.slug) ? ' active' : ''));
      tab.type = 'button';
      tab.title = pack.title || pack.slug;
      var firstImage = safeImage(pack.stickers[0].fileUrl || pack.stickers[0].url);
      if (firstImage) {
        var image = document.createElement('img');
        image.src = firstImage;
        image.alt = '';
        tab.appendChild(image);
      }
      tab.addEventListener('click', function () {
        activeTab = String(pack.slug);
        renderPicker();
      });
      tabs.appendChild(tab);
    });

    var activePack = packs.find(function (pack) { return String(pack.slug) === activeTab; });
    var activeFavorites = activeTab === 'favorites' ? favorites : [];
    var activeStickers = activePack ? activePack.stickers.map(function (sticker) {
      return Object.assign({}, sticker, { packSlug: activePack.slug, packTitle: activePack.title });
    }) : activeFavorites;
    var groupTitle = activePack ? (activePack.title || activePack.slug) : (activeFavorites.length ? 'Избранное' : '');
    subtitle.textContent = groupTitle;
    body.replaceChildren();
    var grid = element('div', 'pub-sticker-grid');
    activeStickers.forEach(function (sticker) {
      var src = safeImage(sticker.fileUrl || sticker.url);
      if (!src) return;
      var shortcode = ':' + sticker.packSlug + ':' + sticker.alias + ':';
      var button = element('button', 'pub-sticker-item');
      button.type = 'button';
      button.title = sticker.alias || sticker.packTitle || 'Стикер';
      var image = document.createElement('img');
      image.src = src;
      image.alt = sticker.alias || '';
      image.loading = 'lazy';
      button.appendChild(image);
      button.addEventListener('click', function () {
        if (pickerSelect) pickerSelect(shortcode, src);
        closePicker();
      });
      grid.appendChild(button);
    });
    if (grid.childNodes.length) body.appendChild(grid);
    else body.appendChild(element('p', 'pub-sticker-empty', packs.length ? 'В этом разделе пока нет стикеров.' : 'Добавьте набор в магазине, чтобы использовать стикеры.'));
    positionPicker();
  }

  async function loadSubscribed() {
    if (subscribedPacks && favoriteStickers) return subscribedPacks;
    var values = await Promise.all([
      request('/api/stickers/subscribed'),
      request('/api/stickers/favorites')
    ]);
    if (!Array.isArray(values[0]) || !Array.isArray(values[1])) throw new Error('Сервер вернул неверный список стикеров');
    subscribedPacks = values[0];
    favoriteStickers = values[1];
    return subscribedPacks;
  }

  function createPicker(trigger, onSelect) {
    closePicker();
    pickerTrigger = trigger;
    pickerSelect = onSelect;
    picker = element('div', 'pub-sticker-picker');
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', 'Выбор стикера');

    var heading = element('div', 'pub-sticker-picker-heading');
    heading.appendChild(element('strong', null, 'Стикеры'));
    var storeButton = element('button', 'pub-sticker-store-open', 'Магазин наборов');
    storeButton.type = 'button';
    storeButton.addEventListener('click', function () {
      closePicker();
      openStore();
    });
    heading.appendChild(storeButton);
    picker.appendChild(heading);
    picker.appendChild(element('div', 'pub-sticker-picker-tabs'));
    picker.appendChild(element('div', 'pub-sticker-picker-subtitle'));
    picker.appendChild(element('div', 'pub-sticker-picker-body'));
    document.body.appendChild(picker);
    trigger.classList.add('active');
    document.addEventListener('click', onOutsideClick);
    document.addEventListener('keydown', onPickerKeydown);
    showPickerMessage('Загружаем стикеры…');
    positionPicker();
    loadSubscribed().then(renderPicker).catch(function (error) {
      subscribedPacks = null;
      showPickerMessage(error.message || 'Не удалось загрузить стикеры', true);
    });
  }

  function openPicker(trigger, onSelect) {
    if (!token()) {
      login();
      return;
    }
    if (pickerTrigger === trigger) {
      closePicker();
      return;
    }
    createPicker(trigger, onSelect);
  }

  function ensureStore() {
    if (storeOverlay) return storeOverlay;
    storeOverlay = element('div', 'pub-sticker-store-overlay');
    storeOverlay.hidden = true;
    var dialog = element('div', 'pub-sticker-store');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Магазин наборов стикеров');
    var heading = element('div', 'pub-sticker-store-heading');
    heading.appendChild(element('h2', null, 'Магазин наборов'));
    var close = element('button', 'pub-sticker-store-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Закрыть');
    close.addEventListener('click', function () { storeOverlay.hidden = true; });
    heading.appendChild(close);
    var search = element('input', 'pub-sticker-store-search');
    search.type = 'search';
    search.placeholder = 'Поиск наборов…';
    search.setAttribute('aria-label', 'Поиск наборов');
    var results = element('div', 'pub-sticker-store-results');
    dialog.append(heading, search, results);
    storeOverlay.appendChild(dialog);
    storeOverlay.addEventListener('click', function (event) {
      if (event.target === storeOverlay) storeOverlay.hidden = true;
    });
    search.addEventListener('input', function () {
      clearTimeout(storeSearchTimer);
      storeSearchTimer = setTimeout(function () { loadCatalog(search.value, results); }, 250);
    });
    document.body.appendChild(storeOverlay);
    storeOverlay._search = search;
    storeOverlay._results = results;
    return storeOverlay;
  }

  function renderCatalog(packs, results) {
    results.replaceChildren();
    if (!packs.length) {
      results.appendChild(element('p', 'pub-sticker-empty', 'Наборы не найдены.'));
      return;
    }
    packs.forEach(function (pack) {
      var card = element('article', 'pub-sticker-catalog-card');
      var info = element('div', 'pub-sticker-catalog-info');
      info.appendChild(element('strong', null, pack.title || 'Набор'));
      if (pack.description) info.appendChild(element('span', null, pack.description));
      var preview = element('div', 'pub-sticker-catalog-preview');
      (pack.stickers || []).slice(0, 3).forEach(function (sticker) {
        var src = safeImage(sticker.fileUrl || sticker.url);
        if (!src) return;
        var image = document.createElement('img');
        image.src = src;
        image.alt = '';
        image.loading = 'lazy';
        preview.appendChild(image);
      });
      var action = element('button', 'btn btn-sm ' + (pack.subscribed ? 'btn-secondary' : 'btn-primary'), pack.subscribed ? 'Убрать' : 'Добавить');
      action.type = 'button';
      action.addEventListener('click', async function () {
        action.disabled = true;
        try {
          await request('/api/stickers/packs/' + encodeURIComponent(pack.id) + '/subscribe', { method: pack.subscribed ? 'DELETE' : 'POST' });
          pack.subscribed = !pack.subscribed;
          subscribedPacks = null;
          favoriteStickers = null;
          renderCatalog(packs, results);
          if (picker && pickerTrigger) {
            await loadSubscribed();
            renderPicker();
          }
        } catch (error) {
          action.disabled = false;
          card.appendChild(element('p', 'pub-sticker-error', error.message || 'Не удалось изменить набор'));
        }
      });
      card.append(info, preview, action);
      results.appendChild(card);
    });
  }

  async function loadCatalog(query, results) {
    results.replaceChildren(element('p', 'pub-sticker-empty', 'Загружаем наборы…'));
    try {
      var path = '/api/stickers/catalog' + (query ? '?q=' + encodeURIComponent(query) : '');
      var packs = await request(path);
      if (!Array.isArray(packs)) throw new Error('Сервер вернул неверный список наборов');
      renderCatalog(packs, results);
    } catch (error) {
      results.replaceChildren(element('p', 'pub-sticker-error', error.message || 'Не удалось загрузить наборы'));
    }
  }

  function openStore() {
    if (!token()) {
      login();
      return;
    }
    var overlay = ensureStore();
    overlay.hidden = false;
    overlay._search.value = '';
    loadCatalog('', overlay._results);
  }

  window.PublicStickerPicker = {
    open: openPicker,
    openStore: openStore
  };
})();
