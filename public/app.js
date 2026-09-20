// app.js - Global application functions and utilities

// Global shared functions
window.showMessage = function(text, type = 'info') {
  // Remove any existing message containers
  const existingMessage = document.getElementById('message-container');
  if (existingMessage) {
    existingMessage.remove();
  }

  // Общий компонент тоста (.toast/.toast-success/.toast-error/.toast-info) —
  // см. "TOAST COMPONENT" в global-styles.css, тот же, что и у
  // showUsersToast/showPendingToast (spa-router.js). Раньше цвет собирался
  // через style.cssText с зашитым hex (#dc3545/#28a745/#007bff). Этот тост —
  // сам себе контейнер (создаётся и удаляется точечно, а не копится в общем
  // .toast-container), поэтому позиционирование остаётся инлайном.
  const messageContainer = document.createElement('div');
  messageContainer.id = 'message-container';
  messageContainer.className = `toast toast-${type === 'error' ? 'error' : type === 'success' ? 'success' : 'info'}`;
  messageContainer.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 10001;
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  `;
  messageContainer.textContent = text;

  document.body.appendChild(messageContainer);

  // Remove message after 5 seconds
  setTimeout(() => {
    if (messageContainer.parentNode) {
      messageContainer.remove();
    }
  }, 5000);
};

// Function to update user info in UI
window.updateUserInfo = function() {
  try {
    const currentUser = authManager.getCurrentUser();
    if (currentUser && (currentUser.username || currentUser.display_name)) {
      // Update displayed username (prefer display_name)
      const usernameDisplay = document.querySelector('.username-display');
      if (usernameDisplay) {
        usernameDisplay.textContent = currentUser.display_name || currentUser.username;
      }

      // Update avatar (using first letter of display_name)
      const userAvatar = document.querySelector('.user-avatar');
      if (userAvatar) {
        const name = currentUser.display_name || currentUser.username;
        userAvatar.textContent = name.charAt(0).toUpperCase();
      }
    }
  } catch (error) {
    console.error('Error updating user info:', error);
  }
};

// Improved API Client with error handling and caching
class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl || this.getBaseUrl();
    this.cache = new Map(); // Simple cache for fetched templates
  }

  // Function to determine correct baseUrl
  getBaseUrl() {
    // Check if using DuckDNS domain
    if (window.location.hostname.includes('duckdns.org')) {
      // Use current host (DuckDNS domain)
      return window.location.protocol + '//' + window.location.host;
    } else {
      // If using IP address, use it as is
      return window.location.protocol + '//' + window.location.host;
    }
  }

  // Add caching for templates to improve performance
  async getCachedTemplate(templatePath) {
    const cacheKey = `template_${templatePath}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached) {
      // Return cached template if available and not too old (5 minutes)
      if (Date.now() - cached.timestamp < 5 * 60 * 1000) {
        return cached.data;
      } else {
        // Remove expired cache
        this.cache.delete(cacheKey);
      }
    }

    // Fetch new template if not cached or expired
    const response = await fetch(templatePath);
    const html = await response.text();

    // Store in cache
    this.cache.set(cacheKey, {
      data: html,
      timestamp: Date.now()
    });

    return html;
  }

  // Enhanced error handling with automatic token refresh
  async makeAuthenticatedRequest(endpoint, method = 'GET', data = null) {
    // Check authentication via authManager
    if (!authManager || !authManager.isAuthenticated()) {
      return { success: false, error: 'Authentication required. Please log in.' };
    }

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authManager.getToken()}`
      },
    };

    if (data && (method === 'POST' || method === 'PUT')) {
      options.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, options);

      // 401 = токен отсутствует/просрочен/невалиден — реальная проблема
      // аутентификации, разлогиниваем. 403 = пользователь опознан, но
      // конкретное действие ему запрещено (например, аудит-лог сервера
      // доступен только его админам) — это обычная ошибка запроса, а не
      // повод выкидывать на экран входа.
      if (response.status === 401) {
        authManager.logout();
        return { success: false, error: 'Authentication required. Please log in.' };
      }

      const result = await response.json();
      return { success: response.ok, data: result, status: response.status, error: result && result.error };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Methods for articles
  async getArticles(since = null) {
    const endpoint = since ? `/api/articles?since=${since}` : '/api/articles';
    return this.makeAuthenticatedRequest(endpoint);
  }

  async getArticle(id) {
    return this.makeAuthenticatedRequest(`/api/articles/${id}`);
  }

  // Засчитать просмотр статьи текущим пользователем (один на пользователя —
  // см. src/services/social-store.js) — вызывается из читалки Ibripedia
  // сразу после открытия статьи, не из редактора.
  async recordArticleView(id) {
    return this.makeAuthenticatedRequest(`/api/articles/${id}/view`, 'POST');
  }

  async createArticle(articleData) {
    return this.makeAuthenticatedRequest('/api/articles', 'POST', articleData);
  }

  async updateArticle(id, articleData) {
    return this.makeAuthenticatedRequest(`/api/articles/${id}`, 'PUT', articleData);
  }

  async deleteArticle(id) {
    return this.makeAuthenticatedRequest(`/api/articles/${id}`, 'DELETE');
  }

  // Витрина статей (Ibripedia) — поиск + фильтры + сортировка + постраничная
  // подгрузка, см. GET /api/articles/browse. filters — любое подмножество
  // {q, tag, server, locked, dateFrom, dateTo, sort}; tag принимает массив
  // (склеивается через запятую) или готовую CSV-строку.
  async getArticlesBrowse(filters = {}, limit = 24, offset = 0) {
    const params = new URLSearchParams({ limit, offset });
    Object.entries(filters).forEach(([key, value]) => {
      if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return;
      params.set(key, Array.isArray(value) ? value.join(',') : value);
    });
    return this.makeAuthenticatedRequest(`/api/articles/browse?${params.toString()}`);
  }

  // Search articles method
  async searchArticles(query, limit = 50, offset = 0) {
    const params = new URLSearchParams({
      q: query,
      limit: limit,
      offset: offset
    });
    const result = await this.makeAuthenticatedRequest(`/api/search-articles?${params.toString()}`);

    if (result.success && result.data && Array.isArray(result.data.data)) {
      return {
        success: true,
        data: result.data
      };
    } else if (result.success && Array.isArray(result.data)) {
      return {
        success: true,
        data: {
          data: result.data,
          total: result.data.length,
          limit: limit,
          offset: offset,
          query: query
        }
      };
    } else if (result.success && result.data && result.data.data) {
      return result;
    } else {
      return result;
    }
  }

  // Закладки статей (Ibripedia) — привязаны к профилю (req.user.id на
  // сервере, см. src/routes/bookmarks.routes.js). slug опционален — без
  // него отдаёт все закладки текущего пользователя по всем статьям.
  async getBookmarks(slug = null) {
    const endpoint = slug ? `/api/bookmarks?slug=${encodeURIComponent(slug)}` : '/api/bookmarks';
    return this.makeAuthenticatedRequest(endpoint);
  }

  async createBookmark(data) {
    return this.makeAuthenticatedRequest('/api/bookmarks', 'POST', data);
  }

  async updateBookmark(id, data) {
    return this.makeAuthenticatedRequest(`/api/bookmarks/${id}`, 'PUT', data);
  }

  async deleteBookmark(id) {
    return this.makeAuthenticatedRequest(`/api/bookmarks/${id}`, 'DELETE');
  }

  // Лайки и комментарии статей (Ibripedia) — см. панель под статьёй в
  // public/ibripedia.js и src/routes/articles.routes.js.
  async getArticleLikes(slug) {
    return this.makeAuthenticatedRequest(`/api/articles/${slug}/likes`);
  }

  async toggleArticleLike(slug) {
    return this.makeAuthenticatedRequest(`/api/articles/${slug}/likes/toggle`, 'POST');
  }

  async getArticleComments(slug) {
    return this.makeAuthenticatedRequest(`/api/articles/${slug}/comments`);
  }

  // parentId — ответ на комментарий (см. "Ответить" в public/ibripedia.js);
  // без него — обычный комментарий верхнего уровня.
  async addArticleComment(slug, content, parentId = null) {
    return this.makeAuthenticatedRequest(`/api/articles/${slug}/comments`, 'POST', { content, parentId });
  }

  async deleteArticleComment(slug, commentId) {
    return this.makeAuthenticatedRequest(`/api/articles/${slug}/comments/${commentId}`, 'DELETE');
  }

  // Реакции эмодзи/стикером — на статью целиком и на отдельный комментарий
  // (см. панель реакций рядом с лайком/под комментарием в ibripedia.js).
  async getArticleReactions(slug) {
    return this.makeAuthenticatedRequest(`/api/articles/${slug}/reactions`);
  }

  async toggleArticleReaction(slug, shortcode) {
    return this.makeAuthenticatedRequest(`/api/articles/${slug}/reactions/toggle`, 'POST', { shortcode });
  }

  async toggleCommentReaction(slug, commentId, shortcode) {
    return this.makeAuthenticatedRequest(`/api/articles/${slug}/comments/${commentId}/reactions/toggle`, 'POST', { shortcode });
  }

  // Наборы стикеров (см. src/routes/stickers.routes.js) — вкладка "Стикеры"
  // в public/stickers-manager.js и пикер стикеров в комментариях Ibripedia.
  async getMyStickerPacks() {
    return this.makeAuthenticatedRequest('/api/stickers/mine');
  }

  // Наборы конкретного пользователя — вкладка "Наборы стикеров" в его
  // профиле (public/views/profile.html); себе видно всё, чужому — только
  // одобренное (см. GET /api/stickers/by-user/:userId).
  async getStickerPacksByUser(userId) {
    return this.makeAuthenticatedRequest(`/api/stickers/by-user/${userId}`);
  }

  async getStickerPack(packId) {
    return this.makeAuthenticatedRequest(`/api/stickers/packs/${packId}`);
  }

  async getStickerCatalog(q = '') {
    const endpoint = q ? `/api/stickers/catalog?q=${encodeURIComponent(q)}` : '/api/stickers/catalog';
    return this.makeAuthenticatedRequest(endpoint);
  }

  async getSubscribedStickerPacks() {
    return this.makeAuthenticatedRequest('/api/stickers/subscribed');
  }

  async createStickerPack(title, description) {
    return this.makeAuthenticatedRequest('/api/stickers/packs', 'POST', { title, description });
  }

  async renameStickerPack(packId, title, description) {
    return this.makeAuthenticatedRequest(`/api/stickers/packs/${packId}`, 'PUT', { title, description });
  }

  // Избранные стикеры (звёздочка в пикере, см. src/routes/stickers.routes.js).
  async getFavoriteStickers() {
    return this.makeAuthenticatedRequest('/api/stickers/favorites');
  }

  async addFavoriteSticker(stickerId) {
    return this.makeAuthenticatedRequest(`/api/stickers/stickers/${stickerId}/favorite`, 'POST');
  }

  async removeFavoriteSticker(stickerId) {
    return this.makeAuthenticatedRequest(`/api/stickers/stickers/${stickerId}/favorite`, 'DELETE');
  }

  async deleteStickerPack(packId) {
    return this.makeAuthenticatedRequest(`/api/stickers/packs/${packId}`, 'DELETE');
  }

  async deleteSticker(stickerId) {
    return this.makeAuthenticatedRequest(`/api/stickers/stickers/${stickerId}`, 'DELETE');
  }

  async subscribeStickerPack(packId) {
    return this.makeAuthenticatedRequest(`/api/stickers/packs/${packId}/subscribe`, 'POST');
  }

  async unsubscribeStickerPack(packId) {
    return this.makeAuthenticatedRequest(`/api/stickers/packs/${packId}/subscribe`, 'DELETE');
  }

  // Публикация набора — отдельный шаг после создания: черновик уходит на
  // модерацию (publish) или возвращается из неё обратно в черновики
  // (unpublish). См. жизненный цикл в src/services/stickers-store.js.
  async publishStickerPack(packId) {
    return this.makeAuthenticatedRequest(`/api/stickers/packs/${packId}/publish`, 'POST');
  }

  async unpublishStickerPack(packId) {
    return this.makeAuthenticatedRequest(`/api/stickers/packs/${packId}/unpublish`, 'POST');
  }

  async resubmitStickerPack(packId) {
    return this.makeAuthenticatedRequest(`/api/stickers/packs/${packId}/resubmit`, 'POST');
  }

  async getPendingStickerPacks() {
    return this.makeAuthenticatedRequest('/api/stickers/pending');
  }

  async approveStickerPack(packId) {
    return this.makeAuthenticatedRequest(`/api/stickers/packs/${packId}/approve`, 'POST');
  }

  async rejectStickerPack(packId, reason) {
    return this.makeAuthenticatedRequest(`/api/stickers/packs/${packId}/reject`, 'POST', { reason });
  }

  // Отозвать уже одобренный набор ЧУЖОГО автора (модератор/владелец над
  // автором ниже по иерархии — см. POST .../revoke в src/routes/stickers.routes.js).
  async revokeStickerPack(packId, reason) {
    return this.makeAuthenticatedRequest(`/api/stickers/packs/${packId}/revoke`, 'POST', { reason });
  }

  // Загрузка файла стикера — как uploadImage, но своё поле формы и эндпоинт.
  async uploadSticker(packId, file, alias) {
    return this.postStickerFile(`/api/stickers/packs/${packId}/stickers`, file, alias);
  }

  // Коллаборации (см. src/routes/stickers.routes.js): чужой одобренный набор
  // -> свои стикеры в "черновик коллаборации" -> предложить автору; автор
  // принимает (стикеры вливаются, предложивший становится соавтором) или
  // отклоняет (всё удаляется).
  async uploadCollabSticker(packId, file, alias) {
    return this.postStickerFile(`/api/stickers/packs/${packId}/collab/stickers`, file, alias);
  }

  // Общая часть загрузки файла стикера (как uploadImage, но своё поле формы):
  // multipart с файлом и именем стикера на указанный эндпоинт.
  async postStickerFile(endpoint, file, alias) {
    if (!authManager || !authManager.isAuthenticated()) {
      return { success: false, error: 'Authentication required. Please log in.' };
    }

    const formData = new FormData();
    formData.append('sticker', file);
    formData.append('alias', alias);

    const options = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authManager.getToken()}`
      },
      body: formData
    };

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, options);

      if (response.status === 401) {
        authManager.logout();
        return { success: false, error: 'Authentication required. Please log in.' };
      }

      const result = await response.json();
      return { success: response.ok, data: result, status: response.status, error: result && result.error };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async deleteCollabSticker(stickerId) {
    return this.makeAuthenticatedRequest(`/api/stickers/collab/stickers/${stickerId}`, 'DELETE');
  }

  async submitStickerCollab(packId, message) {
    return this.makeAuthenticatedRequest(`/api/stickers/packs/${packId}/collab/submit`, 'POST', { message });
  }

  async cancelStickerCollab(requestId) {
    return this.makeAuthenticatedRequest(`/api/stickers/collab/${requestId}/cancel`, 'POST');
  }

  async getIncomingStickerCollabs() {
    return this.makeAuthenticatedRequest('/api/stickers/collab/incoming');
  }

  async getMyStickerCollabs() {
    return this.makeAuthenticatedRequest('/api/stickers/collab/outgoing');
  }

  async acceptStickerCollab(requestId) {
    return this.makeAuthenticatedRequest(`/api/stickers/collab/${requestId}/accept`, 'POST');
  }

  async declineStickerCollab(requestId) {
    return this.makeAuthenticatedRequest(`/api/stickers/collab/${requestId}/decline`, 'POST');
  }

  // Глобальный список всех тегов без дублей: [{tag, count}] — вкладка "Теги"
  // и подсказки фильтра Ibripedia (см. GET /api/tags в articles.routes.js).
  async getTags() {
    return this.makeAuthenticatedRequest('/api/tags');
  }

  // Сменить цвет тега на собственный (#rrggbb) — один цвет на тег во всей
  // системе (граф связей, вкладка "Теги"), см. PUT /api/tags/color.
  async setTagColor(tag, color) {
    return this.makeAuthenticatedRequest('/api/tags/color', 'PUT', { tag, color });
  }

  // Methods for roles
  async getRoles() {
    return this.makeAuthenticatedRequest('/api/roles');
  }

  async createRole(name, code) {
    return this.makeAuthenticatedRequest('/api/roles', 'POST', { name, code });
  }

  async deleteRole(id) {
    return this.makeAuthenticatedRequest(`/api/roles/${id}`, 'DELETE');
  }

  // Methods for messages
  async getMessages() {
    return this.makeAuthenticatedRequest('/api/messages');
  }

  async createMessage(sender, content) {
    return this.makeAuthenticatedRequest('/api/messages', 'POST', { sender, content });
  }

  // Сводка дашборда: пользователи, сообщения (мессенджер + комментарии
  // Ibripedia) и свежие события для ленты активности
  async getDashboardSummary() {
    return this.makeAuthenticatedRequest('/api/dashboard-summary');
  }

  // Method for uploading images
  async uploadImage(file) {
    if (!authManager || !authManager.isAuthenticated()) {
      return { success: false, error: 'Authentication required. Please log in.' };
    }

    const formData = new FormData();
    formData.append('image', file);

    const options = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authManager.getToken()}`
      },
      body: formData
    };

    try {
      const response = await fetch(`${this.baseUrl}/api/upload-image`, options);

      if (response.status === 401) {
        authManager.logout();
        return { success: false, error: 'Authentication required. Please log in.' };
      }

      const result = await response.json();
      return { success: response.ok, data: result, status: response.status, error: result && result.error };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Methods for servers
  async getServers() {
    return this.makeAuthenticatedRequest('/api/servers');
  }

  async getServer(serverId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}`);
  }

  async createServer(serverData) {
    return this.makeAuthenticatedRequest('/api/servers', 'POST', serverData);
  }

  async updateServer(serverId, serverData) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}`, 'PUT', serverData);
  }

  async deleteServer(serverId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}`, 'DELETE');
  }

  async getServerUsers(serverId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/users`);
  }

  async addServerUser(serverId, userId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/users/${userId}`, 'POST', {});
  }

  async removeServerUser(serverId, userId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/users/${userId}`, 'DELETE');
  }

  async getServerRoles(serverId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/roles`);
  }

  async createServerRole(serverId, roleData) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/roles`, 'POST', roleData);
  }

  async updateServerRole(serverId, roleId, roleData) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/roles/${roleId}`, 'PUT', roleData);
  }

  async deleteServerRole(serverId, roleId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/roles/${roleId}`, 'DELETE');
  }

  async assignRoleToUser(serverId, userId, roleId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/users/${userId}/roles/${roleId}`, 'POST', {});
  }

  async removeRoleFromUser(serverId, userId, roleId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/users/${userId}/roles/${roleId}`, 'DELETE');
  }

  // Смена владельца сервера — root only (см. PUT /api/servers/:serverId/owner)
  async changeServerOwner(serverId, newOwnerId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/owner`, 'PUT', { newOwnerId });
  }

  // Список всех пользователей для выбора нового владельца — root only
  // (см. GET /api/users в src/routes/servers.routes.js)
  async getAllUsersForOwnerTransfer() {
    return this.makeAuthenticatedRequest('/api/users');
  }

  // Каналы сервера (см. GET/POST/PUT/DELETE /api/servers/:id/channels)
  async getServerChannels(serverId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/channels`);
  }

  async createServerChannel(serverId, channelData) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/channels`, 'POST', channelData);
  }

  async updateServerChannel(serverId, channelId, channelData) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/channels/${channelId}`, 'PUT', channelData);
  }

  async deleteServerChannel(serverId, channelId) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/channels/${channelId}`, 'DELETE');
  }

  // Поиск пользователей по имени (см. GET /api/users/search) — используется
  // в модалке "Добавить участника" вместо ручного ввода ID.
  async searchUsers(query) {
    return this.makeAuthenticatedRequest(`/api/users/search?q=${encodeURIComponent(query)}`);
  }

  // Журнал действий сервера (см. GET /api/servers/:id/audit-log)
  async getServerAuditLog(serverId, limit = 50) {
    return this.makeAuthenticatedRequest(`/api/servers/${serverId}/audit-log?limit=${limit}`);
  }

  // Profile methods
  async getProfile() {
    return this.makeAuthenticatedRequest('/api/profile', 'GET');
  }

  async getObserverStatus() {
    return this.makeAuthenticatedRequest('/api/profile/observer-status');
  }
}

// Create global instance of the improved API client
const apiClient = new ApiClient();

// Global utility functions
window.apiClient = apiClient;
window.showMessage = showMessage;
window.updateUserInfo = updateUserInfo;

// Skeleton screens generator
window.createSkeletonScreen = function(className) {
  const skeleton = document.createElement('div');
  skeleton.className = `skeleton ${className}`;
  skeleton.innerHTML = `
    <div class="skeleton-line"></div>
    <div class="skeleton-line"></div>
    <div class="skeleton-line short"></div>
  `;
  return skeleton;
};

// Debounce function for auto-saving settings
window.debounce = function(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

// Ripple effect for buttons
window.initRippleEffect = function() {
  document.addEventListener('click', function(e) {
    if (e.target.closest('.btn')) {
      const button = e.target.closest('.btn');
      
      // Don't create ripple if button is too small
      if (button.offsetWidth < 40 || button.offsetHeight < 40) return;
      
      const circle = document.createElement('span');
      const diameter = Math.max(button.clientWidth, button.clientHeight);
      const radius = diameter / 2;

      const rect = button.getBoundingClientRect();

      circle.style.width = circle.style.height = `${diameter}px`;
      circle.style.left = `${e.clientX - rect.left - radius}px`;
      circle.style.top = `${e.clientY - rect.top - radius}px`;
      circle.classList.add('ripple');

      const existingRipple = button.querySelector('.ripple');
      if (existingRipple) {
        existingRipple.remove();
      }

      button.appendChild(circle);

      setTimeout(() => {
        circle.remove();
      }, 600);
    }
  });
};

// Initialize animations on page load
window.initPageAnimations = function() {
  // Add page-content class to main content areas
  const mainContent = document.querySelector('.main-content');
  if (mainContent) {
    mainContent.classList.add('page-content');
  }

  // Add stagger animation to list items
  const lists = document.querySelectorAll('.article-item, .server-card-item, .activity-item');
  lists.forEach((item, index) => {
    item.style.animationDelay = `${index * 0.05}s`;
    item.classList.add('stagger-item');
  });

  // Initialize ripple effect
  window.initRippleEffect();
};

// Add tooltip functionality
window.initTooltips = function() {
  document.addEventListener('mouseover', function(e) {
    const tooltip = e.target.closest('[data-tooltip]');
    if (tooltip) {
      // Tooltip styles are handled by CSS
    }
  });
};

// Initialize everything when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    window.initPageAnimations();
    window.initTooltips();
    window.initRootSidebarVisibility();
    window.initLogoutHandler();
    window.checkApprovedStatus();
    window.updateUserInfo();
    window.initMaintenanceBanner();
    window.initNotificationBadges();
  });
} else {
  window.initPageAnimations();
  window.initTooltips();
  window.initRootSidebarVisibility();
  window.initLogoutHandler();
  window.checkApprovedStatus();
  window.updateUserInfo();
  window.initMaintenanceBanner();
  window.initNotificationBadges();
}

// Показать пункты «Заявки», «Пользователи» и «Настройки» по правам роли.
// «Настройки» — всегда только владелец (is_root); «Заявки»/«Пользователи»
// открываются владельцу или админу, чья роль включает соответствующее
// право (manage_pending_users / view_users_tab — см. каталог ролей во
// вкладке «Пользователи» и src/middleware/auth.js:PERMISSION_KEYS).
window.initRootSidebarVisibility = function() {
  try {
    const user = authManager.getUser();
    if (!user) return;
    const perms = user.permissions || {};

    const show = (id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = '';
    };

    if (user.is_root) { show('sidebar-settings'); show('sidebar-group-system'); }
    if (user.is_root || perms.manage_pending_users) show('sidebar-pending-users');
    if (user.is_root || perms.view_users_tab) show('sidebar-users-list');
  } catch (e) {
    console.error('Error in initRootSidebarVisibility:', e);
  }
};

// Напоминание владельцу, что включён режим техобслуживания — сам он
// заходит на сайт как обычно (см. maintenanceGate/isMaintenanceBlockedForCurrentUser),
// поэтому легко забыть выключить режим, ушедший в фоне блокировать всех
// остальных. Показываем только владельцу — остальных вместо этого баннера
// встречает полноэкранная заглушка (showMaintenanceBlocker в auth-system.js).
window.initMaintenanceBanner = async function() {
  try {
    const user = authManager.getUser();
    if (!user || !user.is_root) return;
    if (typeof checkMaintenanceStatus !== 'function') return;

    const status = await checkMaintenanceStatus();
    const existing = document.getElementById('maintenance-owner-banner');
    if (!status.enabled) {
      existing?.remove();
      return;
    }
    if (existing) return; // уже показан

    const banner = document.createElement('div');
    banner.id = 'maintenance-owner-banner';
    banner.style.cssText = `
      position: sticky; top: 0; z-index: 500; padding: 8px 16px;
      background: var(--yellow, #faa81a); color: #1a1a1a; font-size: 13px;
      font-weight: 600; text-align: center;
    `;
    banner.textContent = '🛠️ Режим техобслуживания включён — сайт недоступен всем, кроме вас. Выключить: Настройки → «Режим технического обслуживания».';
    document.body.prepend(banner);
  } catch (e) {
    console.error('Error in initMaintenanceBanner:', e);
  }
};

// Бейджи "N ждёт решения" на пунктах бокового меню — GET /api/notifications/summary
// сам решает, что именно показывать этому пользователю (владелец видит обе
// категории всегда; админ — только те, где у его роли есть право
// manage_pending_users/moderate_stickers; поле для категории без права в
// ответе просто отсутствует, см. src/routes/notifications.routes.js). Здесь
// только рисуем то, что пришло — никакой отдельной проверки прав на клиенте
// нет и не нужно.
//
// Тост при УВЕЛИЧЕНИИ числа (не при каждой проверке — иначе он бы всплывал
// заново каждые пару минут, пока заявка просто лежит необработанной)
// сравнивается с последним увиденным значением в localStorage; на первом
// же запуске (значения ещё нет) тост не показываем — иначе внезапно
// "уведомили" бы о недельной давности бэклоге при первом открытии панели.
const NOTIF_BADGE_TARGETS = {
  pendingUsers: { elementId: 'sidebar-pending-users', seenKey: 'beginfind_notif_seen_users', toastText: (n) => `Новая заявка на регистрацию (всего ${n})` },
  pendingStickerPacks: { elementId: 'sidebar-stickers', seenKey: 'beginfind_notif_seen_stickers', toastText: (n) => `Новый набор стикеров на модерации (всего ${n})` },
  // Предложения коллабораций на СВОИ наборы — приходят всем авторам, а не
  // только модераторам; бейдж у пункта "Стикеры" общий с модерацией (см.
  // суммирование по elementId в refreshNotificationBadges).
  incomingStickerCollabs: { elementId: 'sidebar-stickers', seenKey: 'beginfind_notif_seen_sticker_collabs', toastText: (n) => `Новое предложение коллаборации для вашего набора стикеров (всего ${n})` }
};

function renderNavBadge(elementId, count) {
  const el = document.getElementById(elementId);
  if (!el) return;
  let badge = el.querySelector('.nav-badge');
  if (!count) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'nav-badge';
    el.appendChild(badge);
  }
  badge.textContent = count > 99 ? '99+' : String(count);
}

async function refreshNotificationBadges() {
  try {
    const res = await fetch('/api/notifications/summary', {
      headers: { 'Authorization': `Bearer ${authManager.getToken()}` }
    });
    if (!res.ok) return;
    const summary = await res.json();

    // Несколько категорий могут делить один пункт меню (см. sidebar-stickers) —
    // считаем сумму по элементу и рисуем бейдж один раз после цикла.
    const totals = {};

    Object.entries(NOTIF_BADGE_TARGETS).forEach(([key, target]) => {
      const count = summary[key];
      totals[target.elementId] = (totals[target.elementId] || 0) + (count || 0);
      if (count === undefined) {
        // Категория не пришла в ответе — этому пользователю она не видна
        // (нет права даже на просмотр) — её вклада в бейдж нет.
        return;
      }

      const seen = parseInt(localStorage.getItem(target.seenKey), 10);
      if (Number.isFinite(seen) && count > seen && typeof window.showMessage === 'function') {
        window.showMessage(target.toastText(count), 'info');
      }
      localStorage.setItem(target.seenKey, String(count));
    });

    Object.entries(totals).forEach(([elementId, total]) => renderNavBadge(elementId, total));
  } catch (e) {
    console.error('Error refreshing notification badges:', e);
  }
}

window.initNotificationBadges = function() {
  const user = authManager.getUser();
  if (!user) return;
  refreshNotificationBadges();
  if (!window._notifBadgePoll) {
    window._notifBadgePoll = setInterval(refreshNotificationBadges, 2 * 60 * 1000);
  }
};

// Обработчик кнопки «Выход» и dropdown меню пользователя
window.initLogoutHandler = function() {
  const userInfo = document.getElementById('user-info');
  const userDropdown = document.getElementById('user-dropdown');
  const logoutBtn = document.getElementById('logout-btn');
  const profileBtn = document.getElementById('profile-btn');

  // Показываем/скрываем dropdown при клике на аватар/имя
  if (userInfo && userDropdown) {
    userInfo.addEventListener('click', function(e) {
      e.stopPropagation();
      userDropdown.classList.toggle('show');
    });

    // Закрываем dropdown при клике вне его
    document.addEventListener('click', function(e) {
      if (!userInfo.contains(e.target)) {
        userDropdown.classList.remove('show');
      }
    });
  }

  // Обработчик пункта "Мой профиль" — открывает /profile/:id текущего
  // пользователя (см. spa-router.js: loadProfile).
  if (profileBtn) {
    profileBtn.addEventListener('click', function(e) {
      e.preventDefault();
      if (userDropdown) userDropdown.classList.remove('show');
      const me = authManager.getUser();
      if (me && me.id != null && window.spaRouter) {
        window.spaRouter.navigateTo(`/profile/${me.id}`);
      }
    });
  }

  // Обработчик для кнопки выхода
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function(e) {
      e.preventDefault();
      authManager.logout();
      if (userDropdown) userDropdown.classList.remove('show');
      window.location.href = '/';
    });
  }
};

// Проверка статуса approved — блокировка для pending/rejected
window.checkApprovedStatus = function() {
  try {
    const user = authManager.getUser();
    if (!user) return;

    if (user.status && user.status !== 'approved') {
      showStatusBlocker(user.status, user.rejection_reason);
    }
  } catch (e) {
    console.error('Error in checkApprovedStatus:', e);
  }
};