(function () {
  'use strict';

  function hasSession() {
    return !!(window.authManager && window.authManager.isAuthenticated());
  }

  function token() {
    return hasSession() ? window.authManager.getToken() : null;
  }

  function publicGalleryPath(endpoint, method) {
    if (method !== 'GET' || !/^\/api\/gallery\/(?:works(?:\/[^/?]+(?:\/(?:likes|reactions|comments))?)?|tags)(?:[/?]|$)/.test(endpoint)) {
      return endpoint;
    }
    return endpoint.replace('/api/gallery/', '/api/public/gallery/');
  }

  async function request(endpoint, method, data, signal) {
    const accessToken = token();
    const path = accessToken ? endpoint : publicGalleryPath(endpoint, method);
    const isPublicRead = path.startsWith('/api/public/gallery/') || path === '/api/public/articles-index';
    if (!accessToken && !isPublicRead) {
      return { success: false, error: 'Для этого действия необходимо войти в аккаунт.' };
    }

    const headers = {};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (data != null && !(data instanceof FormData)) headers['Content-Type'] = 'application/json';
    const options = { method, headers, signal };
    if (data instanceof FormData) options.body = data;
    else if (data != null) options.body = JSON.stringify(data);

    try {
      const response = await fetch(path, options);
      const result = await response.json();
      if (response.status === 401 && accessToken) window.authManager.logout();
      return {
        success: response.ok,
        data: result,
        status: response.status,
        error: result && result.error
      };
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      console.error('Ошибка запроса галереи:', error);
      return { success: false, error: 'Не удалось связаться с сервером.' };
    }
  }

  const client = {
    makeAuthenticatedRequest(endpoint, method = 'GET', data = null) {
      return request(endpoint, method, data);
    },
    async getGalleryWorks(filters = {}, limit = 30, offset = 0) {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      Object.entries(filters).forEach(([key, value]) => {
        if (value != null && value !== '') params.set(key, String(value));
      });
      return request(`/api/gallery/works?${params}`, 'GET');
    },
    getGalleryWork(id) {
      return request(`/api/gallery/works/${encodeURIComponent(id)}`, 'GET');
    },
    createGalleryWork(data) {
      return request('/api/gallery/works', 'POST', data);
    },
    updateGalleryWork(id, data) {
      return request(`/api/gallery/works/${encodeURIComponent(id)}`, 'PUT', data);
    },
    deleteGalleryWork(id) {
      return request(`/api/gallery/works/${encodeURIComponent(id)}`, 'DELETE');
    },
    recordGalleryView(id) {
      return request(`/api/gallery/works/${encodeURIComponent(id)}/view`, 'POST', {});
    },
    getGalleryTags() {
      return request('/api/gallery/tags', 'GET');
    },
    getGalleryWorksForArticle(slug) {
      return request(`/api/gallery/by-article/${encodeURIComponent(slug)}`, 'GET');
    },
    async uploadGalleryImages(workId, pageId, files, signal) {
      const formData = new FormData();
      files.forEach((file) => formData.append('images', file));
      const query = pageId ? `?pageId=${encodeURIComponent(pageId)}` : '';
      return request(`/api/gallery/works/${encodeURIComponent(workId)}/images${query}`, 'POST', formData, signal);
    },
    getServers() {
      return request('/api/servers', 'GET');
    },
    searchUsers(query) {
      return request(`/api/users/search?q=${encodeURIComponent(query)}`, 'GET');
    },
    getSubscribedStickerPacks() {
      return request('/api/stickers/subscribed', 'GET');
    },
    getStickerPack(id) {
      return request(`/api/stickers/packs/${encodeURIComponent(id)}`, 'GET');
    },
    getFavoriteStickers() {
      return request('/api/stickers/favorites', 'GET');
    },
    addFavoriteSticker(id) {
      return request(`/api/stickers/stickers/${encodeURIComponent(id)}/favorite`, 'POST', {});
    },
    removeFavoriteSticker(id) {
      return request(`/api/stickers/stickers/${encodeURIComponent(id)}/favorite`, 'DELETE');
    },
    getStickerCatalog(query = '') {
      const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
      return request(`/api/stickers/catalog${suffix}`, 'GET');
    },
    subscribeStickerPack(id) {
      return request(`/api/stickers/packs/${encodeURIComponent(id)}/subscribe`, 'POST', {});
    },
    unsubscribeStickerPack(id) {
      return request(`/api/stickers/packs/${encodeURIComponent(id)}/subscribe`, 'DELETE');
    }
  };

  window.apiClient = client;

  if (typeof window.showMessage !== 'function') {
    window.showMessage = function (text, type) {
      const previous = document.getElementById('message-container');
      if (previous) previous.remove();
      const toast = document.createElement('div');
      toast.id = 'message-container';
      toast.className = `toast toast-${type === 'error' ? 'error' : type === 'success' ? 'success' : 'info'}`;
      toast.textContent = text;
      document.body.appendChild(toast);
      window.setTimeout(() => toast.remove(), 5000);
    };
  }

  if (typeof window.avatarHtml !== 'function') {
    function avatarSrcSet(url) {
      const match = String(url || '').match(/^(\/uploads\/avatar\/[1-9][0-9]*\/)\d+\.webp(\?.*)?$/);
      if (!match) return '';
      return [104, 208, 312].map((size, index) =>
        `${match[1]}${size}.webp${match[2] || ''} ${index + 1}x`
      ).join(', ');
    }

    window.avatarHtml = function ({ name, avatar } = {}, size = 32, className = '') {
      const letter = String(name || '?').trim().charAt(0).toUpperCase() || '?';
      const safeLetter = letter.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
      const safeAvatar = String(avatar || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
      const cls = `user-ava${className ? ` ${className}` : ''}`;
      const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px;`;
      const srcSet = avatarSrcSet(avatar);
      return avatar
        ? `<span class="${cls} has-image" style="${style}" data-initial="${safeLetter}"><img src="${safeAvatar}"${srcSet ? ` srcset="${srcSet}"` : ''} alt="" loading="lazy" decoding="async" onerror="this.parentElement.classList.remove('has-image');this.parentElement.textContent=this.parentElement.dataset.initial"></span>`
        : `<span class="${cls}" style="${style}">${safeLetter}</span>`;
    };
  }

  window.SiteGallery = {
    init() {
      const root = document.getElementById('galleryPage');
      const manager = window.galleryManager;
      if (!root || !manager) return null;

      const uploadButton = document.getElementById('galleryUploadBtn');
      const localSearch = document.getElementById('gallerySearch');
      const sortSelect = document.getElementById('gallerySort');
      const headerSearch = document.getElementById('siteSearchInput') || document.querySelector('.site-search input');
      const params = new URLSearchParams(window.location.search);
      localSearch.value = params.get('q') || '';
      if (sortSelect && params.has('sort')) sortSelect.value = params.get('sort');
      const previousSearchPlaceholder = headerSearch && headerSearch.placeholder;
      if (headerSearch) {
        headerSearch.placeholder = 'Поиск по галерее...';
        headerSearch.value = localSearch.value;
      }

      const requireLogin = (event) => {
        if (hasSession()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        window.showModalLogin('login');
      };
      const onHeaderInput = () => {
        if (!localSearch || localSearch.value === headerSearch.value) return;
        localSearch.value = headerSearch.value;
        localSearch.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const onLocalInput = () => {
        if (headerSearch && headerSearch.value !== localSearch.value) headerSearch.value = localSearch.value;
      };
      const onHeaderKeydown = (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        onHeaderInput();
      };
      const onProtectedInteraction = (event) => {
        if (hasSession()) return;
        const target = event.target;
        if (target.closest(
          '.gv-engagement [data-gv="like"], .gv-engagement .antropedia-reaction-add, ' +
          '.gv-engagement .antropedia-reaction-pill, .gv-comments [data-role="submit"], ' +
          '.gv-comments [data-sticker-picker-trigger], .gv-comments .antropedia-comment-reply-btn, ' +
          '.gv-comments .antropedia-comment-delete, .gv-comments .antropedia-reaction-add, ' +
          '.gv-comments .antropedia-reaction-pill'
        )) {
          event.preventDefault();
          event.stopImmediatePropagation();
          window.showModalLogin('login');
        }
      };
      const onProtectedSubmit = (event) => {
        if (hasSession() || !event.target.closest('.gv-comments form')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        window.showModalLogin('login');
      };

      uploadButton?.addEventListener('click', requireLogin, true);
      document.getElementById('galleryMineBtn')?.addEventListener('click', requireLogin, true);
      headerSearch?.addEventListener('input', onHeaderInput);
      headerSearch?.addEventListener('keydown', onHeaderKeydown);
      localSearch?.addEventListener('input', onLocalInput);
      document.addEventListener('click', onProtectedInteraction, true);
      document.addEventListener('submit', onProtectedSubmit, true);

      const ready = manager.init();
      const cleanup = function () {
        uploadButton?.removeEventListener('click', requireLogin, true);
        document.getElementById('galleryMineBtn')?.removeEventListener('click', requireLogin, true);
        headerSearch?.removeEventListener('input', onHeaderInput);
        headerSearch?.removeEventListener('keydown', onHeaderKeydown);
        if (headerSearch && headerSearch.placeholder === 'Поиск по галерее...') {
          headerSearch.placeholder = previousSearchPlaceholder;
        }
        localSearch?.removeEventListener('input', onLocalInput);
        document.removeEventListener('click', onProtectedInteraction, true);
        document.removeEventListener('submit', onProtectedSubmit, true);
        manager.cleanup();
        if (window.galleryViewer && window.galleryViewer.isOpen()) window.galleryViewer.close();
      };
      cleanup.ready = ready;
      return cleanup;
    }
  };
})();
