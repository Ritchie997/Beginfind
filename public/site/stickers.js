(function () {
  'use strict';

  var TOKEN_KEY = 'alltell_auth_token';
  var picker = null;
  var pickerTrigger = null;
  var pickerSelect = null;
  var subscribedPacks = null;
  var favoriteStickers = null;
  var activeTab = null;

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

  function onPickerScrollOrResize() {
    if (picker) positionPicker();
  }

  function closePicker() {
    if (picker) picker.remove();
    if (pickerTrigger) pickerTrigger.classList.remove('active');
    picker = null;
    pickerTrigger = null;
    pickerSelect = null;
    document.removeEventListener('click', onOutsideClick);
    document.removeEventListener('keydown', onPickerKeydown);
    window.removeEventListener('resize', onPickerScrollOrResize);
    window.removeEventListener('scroll', onPickerScrollOrResize, true);
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

  function isMobilePickerLayout() {
    return window.matchMedia('(max-width: 640px)').matches;
  }

  function positionPicker() {
    if (!picker || !pickerTrigger) return;
    if (isMobilePickerLayout()) {
      picker.style.left = '';
      picker.style.top = '';
      return;
    }

    var rect = pickerTrigger.getBoundingClientRect();
    var vv = window.visualViewport;
    var viewportWidth = vv ? vv.width : window.innerWidth;
    var viewportHeight = vv ? vv.height : window.innerHeight;
    var viewportLeft = vv ? vv.offsetLeft : 0;
    var viewportTop = vv ? vv.offsetTop : 0;

    var width = picker.offsetWidth || 380;
    var left = rect.right - width;
    if (left < viewportLeft + 8) left = viewportLeft + 8;
    if (left + width > viewportLeft + viewportWidth - 8) left = viewportLeft + viewportWidth - width - 8;

    var height = Math.min(480, picker.scrollHeight || 480);
    var top = rect.top - height - 8;
    if (top < viewportTop + 8) top = rect.bottom + 8;
    if (top + height > viewportTop + viewportHeight - 8) top = Math.max(viewportTop + 8, viewportTop + viewportHeight - height - 8);

    picker.style.left = left + 'px';
    picker.style.top = top + 'px';
  }

  function showPickerMessage(message, error) {
    if (!picker) return;
    var body = picker.querySelector('.antropedia-sticker-picker-body, .pub-sticker-picker-body');
    body.replaceChildren(element('div', error ? 'pub-sticker-error' : 'antropedia-sticker-picker-empty pub-sticker-empty', message));
  }

  function renderPicker() {
    if (!picker) return;
    var body = picker.querySelector('.antropedia-sticker-picker-body, .pub-sticker-picker-body');
    var packs = (subscribedPacks || []).filter(function (pack) {
      return Array.isArray(pack.stickers) && pack.stickers.length;
    });
    var favorites = favoriteStickers || [];
    var tabs = picker.querySelector('.antropedia-sticker-picker-tabs, .pub-sticker-picker-tabs');
    var subtitle = picker.querySelector('.antropedia-sticker-picker-subtitle, .pub-sticker-picker-subtitle');
    var validTabs = ['favorites'].concat(packs.map(function (pack) { return String(pack.slug); }));
    if (validTabs.indexOf(activeTab) === -1) activeTab = favorites.length ? 'favorites' : (packs[0] && String(packs[0].slug));

    tabs.replaceChildren();
    var favoriteTab = element('button', 'antropedia-sticker-picker-tab antropedia-sticker-picker-tab-fav pub-sticker-picker-tab pub-sticker-picker-tab-fav' + (activeTab === 'favorites' ? ' active' : ''));
    favoriteTab.type = 'button';
    favoriteTab.title = 'Избранное';
    favoriteTab.innerHTML = '<i class="fas fa-star" aria-hidden="true"></i>';
    favoriteTab.addEventListener('click', function () {
      activeTab = 'favorites';
      renderPicker();
    });
    tabs.appendChild(favoriteTab);
    packs.forEach(function (pack) {
      var tab = element('button', 'antropedia-sticker-picker-tab pub-sticker-picker-tab' + (activeTab === String(pack.slug) ? ' active' : ''));
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
    var groupTitle = activePack ? (activePack.description ? (activePack.title + ' — ' + activePack.description) : (activePack.title || activePack.slug)) : (activeFavorites.length ? 'Избранное' : '');
    subtitle.textContent = groupTitle;
    body.replaceChildren();
    var grid = element('div', 'antropedia-sticker-picker-grid pub-sticker-grid');
    activeStickers.forEach(function (sticker) {
      var src = safeImage(sticker.fileUrl || sticker.url);
      if (!src) return;
      var shortcode = ':' + sticker.packSlug + ':' + sticker.alias + ':';
      var button = element('button', 'antropedia-sticker-picker-item pub-sticker-item');
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
    else body.appendChild(element('div', 'antropedia-sticker-picker-empty pub-sticker-empty', packs.length ? 'В этом разделе пока нет стикеров.' : 'Добавьте набор в магазине, чтобы использовать стикеры.'));
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
    picker = element('div', 'antropedia-sticker-picker pub-sticker-picker');
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', 'Выбор стикера');

    var header = element('div', 'antropedia-sticker-picker-header pub-sticker-picker-heading');
    header.appendChild(element('span', null, 'Стикеры'));

    var links = element('span', 'antropedia-sticker-picker-links');
    var manageLink = element('a', null, 'Управление наборами');
    manageLink.href = '/stickers';
    manageLink.setAttribute('data-nav', '/stickers');
    manageLink.addEventListener('click', function (e) {
      e.preventDefault();
      closePicker();
      window.location.href = '/stickers';
    });
    links.appendChild(manageLink);
    links.appendChild(document.createTextNode(' · '));

    var storeLink = element('a', null, 'Магазин наборов');
    storeLink.href = '#';
    storeLink.setAttribute('data-role', 'open-store');
    storeLink.addEventListener('click', function (e) {
      e.preventDefault();
      closePicker();
      openStore();
    });
    links.appendChild(storeLink);
    header.appendChild(links);

    picker.appendChild(header);
    picker.appendChild(element('div', 'antropedia-sticker-picker-tabs pub-sticker-picker-tabs'));
    picker.appendChild(element('div', 'antropedia-sticker-picker-subtitle pub-sticker-picker-subtitle'));
    picker.appendChild(element('div', 'antropedia-sticker-picker-body pub-sticker-picker-body'));
    document.body.appendChild(picker);
    trigger.classList.add('active');
    document.addEventListener('click', onOutsideClick);
    document.addEventListener('keydown', onPickerKeydown);
    window.addEventListener('resize', onPickerScrollOrResize);
    window.addEventListener('scroll', onPickerScrollOrResize, true);
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

  function openStore() {
    closePicker();
    if (window.stickerStore && typeof window.stickerStore.open === 'function') {
      window.stickerStore.open(function () {
        subscribedPacks = null;
        favoriteStickers = null;
        if (picker && pickerTrigger) {
          loadSubscribed().then(renderPicker);
        }
      });
      return;
    }
    var script = document.createElement('script');
    script.src = '/sticker-store.js';
    script.onload = function () {
      if (window.stickerStore && typeof window.stickerStore.open === 'function') {
        window.stickerStore.open(function () {
          subscribedPacks = null;
          favoriteStickers = null;
          if (picker && pickerTrigger) {
            loadSubscribed().then(renderPicker);
          }
        });
      }
    };
    document.head.appendChild(script);
  }

  window.PublicStickerPicker = {
    open: openPicker,
    openStore: openStore
  };
})();
