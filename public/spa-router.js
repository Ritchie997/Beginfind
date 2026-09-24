// spa-router.js - Updated SPA router with proper partial loading

class SPARouter {
  constructor() {
    this.routes = {
      '/': this.loadDashboard,
      '/dashboard': this.loadDashboard,
      '/ibripedia': this.loadIbripedia,
      '/articles': this.loadArticles,
      '/tags': this.loadTags,
      '/stickers': this.loadStickers,
      '/servers': this.loadServers,
      '/pending-users': this.loadPendingUsers,
      '/users': this.loadUsersList,
      '/settings': this.loadSettings,
      '/profile': this.loadProfile
    };

    // id из "/profile/123" — единственный маршрут с динамическим сегментом,
    // поэтому отдельного mini-роутера не заводим (см. normalizePathForRouting
    // и navigateTo: /profile/:id сводится к ключу '/profile' + this.profileUserId).
    this.profileUserId = null;

    this.currentView = null;
    this.loading = false;
    this.templateCache = new Map(); // Cache for fetched templates
    this.currentDraftId = null; // Track the currently loaded draft ID

    // Экземпляры ChipField для формы статьи (Доступ для/Теги) —
    // создаются заново в initArticleChipFields() при каждом заходе на
    // страницу статей, т.к. разметка перезагружается через fetch партиала.
    this.rolesField = null;
    this.tagsField = null;

    // Состояние вкладки "Сервера": кэш списка (поиск/сортировка работают по
    // нему локально, без лишних запросов) и то, какой сервер сейчас открыт
    // в рабочей области (см. openServerWorkspace/closeServerWorkspace).
    this.serversCache = [];
    this.currentServerId = null;
    this.currentServerData = null; // { server, members, roles, isAdmin, isOwner, isRoot }
    this.currentServerWorkspaceTab = 'overview';
    this.assignRoleTargetUserId = null;
    this.roleEditorEditingId = null;
    this.channelEditorEditingId = null;
    this.currentAuditLog = [];

    this.init();
  }

  // Getter для editorManager, чтобы всегда получать актуальный экземпляр
  get editorManager() {
    return window.editorManager || null;
  }

  init() {
    // Check authentication before initializing router
    this.checkAuthBeforeInit();
  }

  // Check authentication before initialization
  async checkAuthBeforeInit() {
    // Check authentication immediately, but with protection against circular redirects
    if (!authManager || !authManager.isAuthenticated()) {
      // If user is not authenticated, show login form
      // and don't continue router initialization
      showModalLogin();
      return;
    }

    // If authenticated, continue initialization
    this.completeInit();
  }

  completeInit() {
    // Set up navigation handlers
    this.setupNavigation();
    this.setupHistoryHandling();

    // Load current route
    this.navigateTo(window.location.pathname);

    // Update user info display
    if (typeof updateUserInfo === 'function') updateUserInfo();
  }

  // Set up navigation handlers
  setupNavigation() {
    // Handler for clicks on navigation links/elements
    document.addEventListener('click', (e) => {
      // Check if click was on element with data-nav attribute (navigation)
      let navLink = e.target.closest('[data-nav]');
      if (navLink) {
        e.preventDefault();
        const route = navLink.getAttribute('data-nav');
        this.navigateTo(route);
        return;
      }

      // Also check sidebar menu items with onclick
      let sidebarItem = e.target.closest('.sidebar-item');
      if (sidebarItem) {
        e.preventDefault();

        // Get path from data-nav attribute or onclick
        let route = sidebarItem.getAttribute('data-nav');
        if (!route) {
          // Check onclick attribute if data-nav is not set
          const onclickAttr = sidebarItem.getAttribute('onclick');
          if (onclickAttr) {
            const match = onclickAttr.match(/window\.location\.href='([^']+)'/);
            if (match && match[1]) {
              route = match[1];
            }
          }
        }

        if (route) {
          this.navigateTo(route);
        }
      }
    });
  }

  // Set up browser history handling
  setupHistoryHandling() {
    // Handle browser back/forward buttons
    window.addEventListener('popstate', (event) => {
      this.navigateTo(window.location.pathname, false);
    });
  }

  // Main navigation function
  async navigateTo(path, updateHistory = true) {
    // If already loading a view, skip
    if (this.loading) return;

    this.loading = true;

    try {
      // Check authentication
      if (!authManager || !authManager.isAuthenticated()) {
        // Show login modal but don't redirect
        showModalLogin();
        this.loading = false;
        return;
      }

      // Normalize path for routing
      const normalizedPath = this.normalizePathForRouting(path);

      // Remove articles page class if we're navigating away from articles
      if (normalizedPath !== '/articles' && document.body.classList.contains('articles-page')) {
        document.body.classList.remove('articles-page');
      }

      // Find corresponding route handler (resolveRouteKey сводит "/profile/123"
      // к ключу '/profile' и запоминает id в this.profileUserId — сам
      // normalizedPath с id остаётся нетронутым для URL/истории)
      const routeKey = this.resolveRouteKey(normalizedPath);
      const routeHandler = this.routes[routeKey];

      if (routeHandler) {
        // Update active menu item
        this.updateActiveMenuItem(routeKey);

        // Call route handler
        await routeHandler.call(this);

        // Update URL if needed
        if (updateHistory) {
          history.pushState({}, '', normalizedPath);
        }

        // Update page title
        this.updatePageTitle(routeKey);
      } else {
        // If route not found, redirect to dashboard
        this.navigateTo('/dashboard');
      }
    } catch (error) {
      console.error('Navigation error:', error);
      // On error, we can display a message to the user
      showMessage('Ошибка при загрузке страницы', 'error');
    } finally {
      this.loading = false;
    }
  }

  // Helper function to normalize paths for routing
  normalizePathForRouting(path) {
    if (!path) return '/';

    // If it's a full URL, extract only the path
    if (path.startsWith('http')) {
      try {
        const url = new URL(path);
        path = url.pathname;
      } catch (e) {
        // If URL parsing fails, use as is
        console.warn('Could not parse URL for routing:', path);
      }
    }

    // Remove trailing slashes, except for root path
    if (path !== '/' && path.endsWith('/')) {
      path = path.slice(0, -1);
    }

    return path;
  }

  // "/profile/123" -> ключ маршрута '/profile' (this.routes хранит только
  // статические ключи), id сохраняется в this.profileUserId — loadProfile()
  // его читает. Без id (просто "/profile") — открываем свой профиль.
  // Возвращает нормализованный путь как есть, если это не /profile/:id —
  // сам URL (для history.pushState) в navigateTo не трогаем, меняем только
  // ключ поиска обработчика.
  resolveRouteKey(normalizedPath) {
    const profileMatch = normalizedPath.match(/^\/profile(?:\/(\d+))?$/);
    if (profileMatch) {
      this.profileUserId = profileMatch[1] || null;
      return '/profile';
    }
    return normalizedPath;
  }

  // Update active menu item
  updateActiveMenuItem(path) {
    // Remove active class from all items
    const allSidebarItems = document.querySelectorAll('.sidebar-item');
    allSidebarItems.forEach(item => {
      item.classList.remove('active');
    });

    // Normalize current path for comparison
    const normalizedCurrentPath = this.normalizePathForMenu(path);

    // Add active class to corresponding item
    allSidebarItems.forEach(item => {
      // Check both data-nav attribute and onclick for compatibility
      let navPath = item.getAttribute('data-nav');
      if (!navPath) {
        navPath = this.getOnclickPath(item);
      }

      if (navPath) {
        const normalizedNavPath = this.normalizePathForMenu(navPath);

        // Compare paths with various options
        if (normalizedNavPath === normalizedCurrentPath) {
          item.classList.add('active');
        }
      }
    });
  }

  // Helper function to normalize paths for menu
  normalizePathForMenu(path) {
    if (!path) return '';

    // If it's a full URL, extract only the path
    if (path.startsWith('http')) {
      try {
        const url = new URL(path);
        path = url.pathname;
      } catch (e) {
        // If URL parsing fails, use as is
        console.warn('Could not parse URL:', path);
      }
    }

    // Remove trailing slashes for comparison
    if (path.endsWith('/') && path.length > 1) {
      path = path.slice(0, -1);
    }

    // Return normalized path
    return path;
  }

  // Helper function to extract path from onclick attribute for compatibility
  getOnclickPath(item) {
    const onclickAttr = item.getAttribute('onclick');
    if (onclickAttr) {
      const pathMatch = onclickAttr.match(/window\.location\.href='([^']+)'/);
      if (pathMatch && pathMatch[1]) {
        return pathMatch[1];
      }
    }
    return null;
  }

  // Update page title
  updatePageTitle(path) {
    const titles = {
      '/': 'Аналитика - Админ-панель BeginFind',
      '/dashboard': 'Аналитика - Админ-панель BeginFind',
      '/ibripedia': 'Ibripedia - Админ-панель BeginFind',
      '/articles': 'Редактор - Админ-панель BeginFind',
      '/tags': 'Теги - Админ-панель BeginFind',
      '/servers': 'Сервера - Админ-панель BeginFind',
      '/pending-users': 'Заявки - Админ-панель BeginFind',
      '/users': 'Пользователи - Админ-панель BeginFind',
      '/settings': 'Настройки - Админ-панель BeginFind',
      '/profile': 'Профиль - Админ-панель BeginFind'
    };

    const titleElement = document.getElementById('page-title');
    if (titleElement) {
      titleElement.textContent = titles[path] || 'Админ-панель BeginFind';
    }

    document.title = titles[path] || 'Админ-панель BeginFind';
  }

  // Load dashboard content
  async loadDashboard() {
    this.showLoader();

    try {
      // Load partial HTML for dashboard with caching
      const html = await this.loadTemplate('/views/dashboard.html');

      // Set content to app container
      const appContent = document.getElementById('app-content');
      if (appContent) {
        appContent.innerHTML = html;

        // Update page title
        const titleElement = document.getElementById('page-title');
        if (titleElement) {
          titleElement.textContent = 'Дашборд';
        }
      }

      // Load dashboard stats
      await this.loadDashboardStats();

      // Note: Charts are now initialized in loadDashboardStats with real data

      // Граф связей статей — раньше был отдельной страницей /graph, теперь
      // живёт прямо на дашборде (initGraphPage универсален: ему достаточно
      // #graphContainer/#graphNodeCount в разметке, см. views/dashboard.html)
      await window.GraphView?.initGraphPage();
    } catch (error) {
      console.error('Error loading dashboard:', error);
      showMessage('Ошибка при загрузке дашборда', 'error');
    } finally {
      this.hideLoader();
    }
  }

  // Load Ibripedia (article browsing/showcase page)
  async loadIbripedia() {
    this.showLoader();

    try {
      const response = await fetch('/views/ibripedia.html');
      const html = await response.text();

      const appContent = document.getElementById('app-content');
      if (appContent) {
        appContent.innerHTML = html;

        const titleElement = document.getElementById('page-title');
        if (titleElement) titleElement.textContent = 'Ibripedia';
      }

      await window.ibripediaManager?.init();
    } catch (error) {
      console.error('Error loading Ibripedia:', error);
      showMessage('Ошибка при загрузке Ibripedia', 'error');
    } finally {
      this.hideLoader();
    }
  }

  // Load Stickers (sticker pack management: catalog/mine/moderation)
  async loadStickers() {
    this.showLoader();

    try {
      const response = await fetch('/views/stickers.html');
      const html = await response.text();

      const appContent = document.getElementById('app-content');
      if (appContent) {
        appContent.innerHTML = html;

        const titleElement = document.getElementById('page-title');
        if (titleElement) titleElement.textContent = 'Стикеры';
      }

      await window.stickersManager?.init();
    } catch (error) {
      console.error('Error loading stickers:', error);
      showMessage('Ошибка при загрузке стикеров', 'error');
    } finally {
      this.hideLoader();
    }
  }

  // Load articles content
  async loadArticles() {
    this.showLoader();

    try {
      // Load partial HTML for articles
      const response = await fetch('/views/articles.html');
      const html = await response.text();

      // Set content to app container
      const appContent = document.getElementById('app-content');
      if (appContent) {
        appContent.innerHTML = html;

        // Update page title
        const titleElement = document.getElementById('page-title');
        if (titleElement) {
          titleElement.textContent = 'Редактор';
        }

        // Add specific class to body for article page styles
        document.body.classList.add('articles-page');
        
        // Force reflow to ensure styles are applied
        void appContent.offsetWidth;
      }

      // Initialize articles page functionality
      await this.initArticlesPage();
    } catch (error) {
      console.error('Error loading articles:', error);
      showMessage('Ошибка при загрузке статей', 'error');
    } finally {
      this.hideLoader();
    }
  }

  // Load tags content — вкладка "Теги" (глобальный список тегов)
  async loadTags() {
    this.showLoader();

    try {
      const response = await fetch('/views/tags.html');
      const html = await response.text();

      const appContent = document.getElementById('app-content');
      if (appContent) {
        appContent.innerHTML = html;

        const titleElement = document.getElementById('page-title');
        if (titleElement) {
          titleElement.textContent = 'Теги';
        }
      }

      await this.initTagsPage();
    } catch (error) {
      console.error('Error loading tags:', error);
      showMessage('Ошибка при загрузке тегов', 'error');
    } finally {
      this.hideLoader();
    }
  }

  // Load servers content
  async loadServers() {
    this.showLoader();

    try {
      // Load partial HTML for servers
      const response = await fetch('/views/servers.html');
      const html = await response.text();

      // Set content to app container
      const appContent = document.getElementById('app-content');
      if (appContent) {
        appContent.innerHTML = html;

        // Update page title
        const titleElement = document.getElementById('page-title');
        if (titleElement) {
          titleElement.textContent = 'Сервера';
        }
      }

      // Initialize servers page functionality
      await this.initServersPage();
    } catch (error) {
      console.error('Error loading servers:', error);
      showMessage('Ошибка при загрузке серверов', 'error');
    } finally {
      this.hideLoader();
    }
  }

  // Load settings content
  async loadSettings() {
    // Настройки системы — только для владельца (см. auth.checkRoot на
    // соответствующих /api/system-settings маршрутах). Пункт меню и так
    // скрыт для остальных (см. initRootSidebarVisibility в app.js), но
    // прямой переход по /settings нужно перехватить и здесь.
    const currentUser = (typeof authManager !== 'undefined') ? authManager.getUser() : null;
    if (!currentUser || !currentUser.is_root) {
      showMessage('Настройки системы доступны только владельцу', 'error');
      this.navigateTo('/dashboard');
      return;
    }

    this.showLoader();

    try {
      // Load partial HTML for settings
      const response = await fetch('/views/settings.html');
      const html = await response.text();

      // Set content to app container
      const appContent = document.getElementById('app-content');
      if (appContent) {
        appContent.innerHTML = html;

        // Update page title
        const titleElement = document.getElementById('page-title');
        if (titleElement) {
          titleElement.textContent = 'Настройки';
        }
      }

      // Initialize settings page functionality
      await this.initSettingsPage();
    } catch (error) {
      console.error('Error loading settings:', error);
      showMessage('Ошибка при загрузке настроек', 'error');
    } finally {
      this.hideLoader();
    }
  }

  // Show loader with skeleton screens
  showLoader() {
    const appContent = document.getElementById('app-content');
    if (appContent) {
      // Use skeleton screens instead of plain "Loading..." text
      appContent.innerHTML = `
        <div style="padding: 20px;">
          <div class="skeleton" style="height: 30px; margin-bottom: 20px;"></div>
          <div class="skeleton" style="height: 100px; margin-bottom: 20px;"></div>
          <div class="skeleton" style="height: 100px; margin-bottom: 20px;"></div>
          <div class="skeleton" style="height: 100px;"></div>
        </div>
      `;
    }
  }

  // Hide loader
  hideLoader() {
    // Loading complete, nothing more to do
  }

  // Load template with caching
  async loadTemplate(templatePath) {
    const cacheKey = templatePath;
    const cached = this.templateCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) { // 5 minutes cache
      return cached.data;
    }

    try {
      const response = await fetch(templatePath);
      const html = await response.text();

      // Cache the template
      this.templateCache.set(cacheKey, {
        data: html,
        timestamp: Date.now()
      });

      return html;
    } catch (error) {
      console.error(`Error loading template ${templatePath}:`, error);
      throw error;
    }
  }

  // Initialize articles page with all functionality
  async initArticlesPage() {
    // Чиповые поля должны существовать до загрузки серверов —
    // им передаются варианты выбора сразу после создания.
    this.initArticleChipFields();
    this.resetArticleAuthorInfo();
    this.setupArticleAuthorsAdmin();

    // Load all required data
    await this.loadServersForArticles();

    // Initialize editor
    const editorMgr = this.editorManager; // Use getter to get current editorManager
    if (editorMgr) {
      editorMgr.initializeEditor();

      // Set up improved editor events
      this.setupImprovedEditorEvents();
    } else {
      // Fallback: Initialize editor directly if editorManager is not available
      // This ensures editor events are set up even if editorManager fails to initialize
      if (typeof EditorManager !== 'undefined') {
        const localEditorManager = new EditorManager();
        localEditorManager.initializeEditor();
        this.setupImprovedEditorEvents();
      } else {
        // Last resort: Set up basic editor functionality directly
        this.setupBasicEditorEvents();
      }
    }

    // Set up event listeners for article form
    this.setupArticleFormEvents();

    // Check for and offer to load draft
    this.checkAndOfferDraft();
  }

  // Создаёт экземпляры ChipField для Доступа/Тегов заново — вызывается
  // при каждом заходе на страницу статей, т.к. её разметка каждый раз
  // перезагружается через fetch партиала (см. loadTemplate/initArticlesPage),
  // поэтому старые DOM-узлы, на которые ссылались бы прежние экземпляры,
  // к этому моменту уже заменены новыми.
  initArticleChipFields() {
    const rolesRoot = document.getElementById('articleRolesField');
    this.rolesField = rolesRoot ? new ChipField(rolesRoot, {
      freeText: false,
      placeholder: 'Сначала выберите сервер...',
      emptyText: 'Нет ролей для этого сервера'
    }) : null;

    const tagsRoot = document.getElementById('articleTagsField');
    this.tagsField = tagsRoot ? new ChipField(tagsRoot, {
      freeText: true,
      placeholder: 'Введите тег и нажмите Enter...'
    }) : null;

    // Многослойность (см. article-layers.js на сервере) — значения ролей
    // здесь строки вида "system:7"/"server:3" (см. encodeRoleRef/decodeRoleRef),
    // объединяющие оба каталога сразу, не пересекается с this.rolesField
    // (тот — простой список id ролей сервера для обычного "закрыта/открыта").
    const layerRolesRoot = document.getElementById('articleLayerRolesField');
    this.layerRolesField = layerRolesRoot ? new ChipField(layerRolesRoot, {
      freeText: false,
      placeholder: 'Пусто — слой публичный...',
      emptyText: 'Сначала выберите сервер'
    }) : null;

    // Состояние многослойности формы — см. setLayersMode/renderArticleLayersList.
    this.articleLayersEnabled = false;
    this.articleLayers = []; // [{ roles: [{scope,id}], title, content }]
    this.activeLayerIndex = 0;
    // true по умолчанию — свежая форма ("создать статью") без слоёв, это и
    // есть достоверное состояние. editArticle() сбрасывает в false на время
    // запроса /articles/:id/layers и не даёт (см. collectArticleFormData)
    // сохранить layers, пока не получит достоверный ответ — см. там же.
    this._layersStateKnown = true;
    const hint = document.getElementById('articleLayerEditingHint');
    if (hint) { hint.hidden = true; hint.textContent = ''; }
    const panel = document.getElementById('articleLayersPanel');
    if (panel) panel.hidden = true;
    const toggle = document.getElementById('articleLayersToggle');
    if (toggle) toggle.checked = false;
    document.getElementById('articleLegacyAccessRow')?.removeAttribute('hidden');
    document.getElementById('articleLegacyRolesRow')?.removeAttribute('hidden');
  }

  // "system:7" -> {scope:'system', id:7}; невалидное — null.
  decodeRoleRef(value) {
    const m = /^(system|server):(\d+)$/.exec(String(value || ''));
    return m ? { scope: m[1], id: parseInt(m[2], 10) } : null;
  }

  encodeRoleRef(ref) {
    return `${ref.scope}:${ref.id}`;
  }

  // Варианты для "Доступ к выбранному слою" — оба каталога сразу: 🌐 общие
  // роли платформы (admin_roles, не зависят от сервера) и 🏠 роли ВЫБРАННОГО
  // сервера статьи (server_roles). Без сервера — только общие.
  async loadRoleCatalogForLayers(serverId) {
    if (!this.layerRolesField) return;
    const options = [];
    try {
      const adminRes = await apiClient.makeAuthenticatedRequest('/api/admin-roles');
      // GET /api/admin-roles отдаёт { roles: [...], permission_keys: [...] },
      // а не голый массив (см. auth.routes.js) — тот же формат, что и в
      // управлении ролями админки.
      if (adminRes.success && Array.isArray(adminRes.data?.roles)) {
        adminRes.data.roles.forEach((r) => options.push({ value: `system:${r.id}`, label: `🌐 ${r.name}` }));
      }
    } catch (e) { /* общий каталог просто не подгрузится в список вариантов */ }

    if (serverId) {
      try {
        const serverRes = await apiClient.makeAuthenticatedRequest(`/api/servers/${serverId}/roles`);
        if (serverRes.success && Array.isArray(serverRes.data)) {
          serverRes.data.forEach((r) => options.push({ value: `server:${r.id}`, label: `🏠 ${r.name}` }));
        }
      } catch (e) { /* роли сервера просто не подгрузятся */ }
    }

    this.layerRolesField.setOptions(options);
    this.layerRolesField.setPlaceholder(options.length ? 'Пусто — слой публичный...' : 'Сначала выберите сервер...');
  }

  // Снимает текущее состояние формы (заголовок/контент редактора/роли) в
  // this.articleLayers[this.activeLayerIndex] — вызывается ПЕРЕД тем, как
  // форма покажет другой слой (переключение/сохранение), иначе несохранённые
  // правки активного слоя потерялись бы молча.
  snapshotActiveLayer() {
    if (!this.articleLayersEnabled || !this.articleLayers[this.activeLayerIndex]) return;
    const editorMgr = this.editorManager;
    this.articleLayers[this.activeLayerIndex] = {
      roles: (this.layerRolesField?.getValues() || []).map((v) => this.decodeRoleRef(v)).filter(Boolean),
      public: !!document.getElementById('articleLayerPublicCheckbox')?.checked,
      title: document.getElementById('articleTitle')?.value || '',
      content: editorMgr ? editorMgr.doc : { version: 1, blocks: [] }
    };
  }

  // Показывает слой с данным индексом в форме (заголовок/редактор/роли) —
  // обратная операция к snapshotActiveLayer.
  loadLayerIntoForm(index) {
    const layer = this.articleLayers[index];
    if (!layer) return;
    this.activeLayerIndex = index;

    const titleInput = document.getElementById('articleTitle');
    if (titleInput) titleInput.value = layer.title || '';

    const editorMgr = this.editorManager;
    if (editorMgr) {
      editorMgr.doc = layer.content || { version: 1, blocks: [] };
      if (editorMgr.container) { editorMgr.renderAll(); editorMgr.scheduleRenderPreview?.(); }
    }

    this.layerRolesField?.setValues((layer.roles || []).map((r) => this.encodeRoleRef(r)));
    const publicCheckbox = document.getElementById('articleLayerPublicCheckbox');
    if (publicCheckbox) publicCheckbox.checked = !!layer.public;

    const hint = document.getElementById('articleLayerEditingHint');
    if (hint) hint.textContent = `(слой: ${layer.title || 'без названия'})`;

    this.renderArticleLayersList();
  }

  renderArticleLayersList() {
    const listEl = document.getElementById('articleLayersList');
    if (!listEl) return;
    const lastIndex = this.articleLayers.length - 1;
    listEl.innerHTML = this.articleLayers.map((l, i) => `
      <span class="article-layer-pill${i === this.activeLayerIndex ? ' active' : ''}" data-index="${i}">
        <button type="button" class="article-layer-pill-move" data-move="-1" data-index="${i}" title="Сделать публичнее (на уровень ниже)"${i === 0 ? ' disabled' : ''}><i class="fas fa-chevron-left"></i></button>
        <span class="article-layer-pill-title">${this.escapeHtml(l.title || 'Без названия')}</span>
        <button type="button" class="article-layer-pill-move" data-move="1" data-index="${i}" title="Сделать закрытее (на уровень выше)"${i === lastIndex ? ' disabled' : ''}><i class="fas fa-chevron-right"></i></button>
        ${this.articleLayers.length > 1 ? `<button type="button" class="article-layer-pill-remove" data-index="${i}" title="Удалить слой">&times;</button>` : ''}
      </span>
    `).join('');
  }

  // Ручная перестановка слоёв (меняет глубину — позиция в массиве и есть
  // уровень, см. article-layers.js на сервере) — меняет местами слой с
  // соседом. Безопасно с точки зрения прав уже сегодня: сервер (см.
  // mergeLayersUpdate) проверяет роли каждого присланного слоя независимо от
  // его позиции, а не только "новых по номеру", так что переставлять можно
  // свободно в пределах своей же доступной глубины.
  moveArticleLayer(index, direction) {
    const swapWith = index + direction;
    if (swapWith < 0 || swapWith >= this.articleLayers.length) return;
    this.snapshotActiveLayer();
    [this.articleLayers[index], this.articleLayers[swapWith]] = [this.articleLayers[swapWith], this.articleLayers[index]];
    if (this.activeLayerIndex === index) this.activeLayerIndex = swapWith;
    else if (this.activeLayerIndex === swapWith) this.activeLayerIndex = index;
    this.renderArticleLayersList();
  }

  // Включает/выключает многослойный режим формы. enabled=true в первый раз —
  // текущий заголовок/контент становится слоем 0 (публичным), ничего не
  // теряется; enabled=false — легаси-поля ("Статус статьи"/"Доступ для")
  // показываются обратно, this.articleLayers остаются в памяти на случай,
  // если пользователь включит режим обратно, не сохраняя.
  setLayersMode(enabled) {
    this.articleLayersEnabled = enabled;
    document.getElementById('articleLayersPanel').hidden = !enabled;
    document.getElementById('articleLegacyAccessRow').hidden = enabled;
    document.getElementById('articleLegacyRolesRow').hidden = enabled;
    document.getElementById('articleLayerEditingHint').hidden = !enabled;

    if (enabled) {
      if (!this.articleLayers.length) {
        // public: false — намеренно не отмечаем автоматически, хотя это
        // единственный слой и сейчас это неважно (сервер не блокирует статьи
        // из одного слоя). Если позже добавят слой с ролями выше, не помечая
        // этот публичным, сохранение статьи будет заблокировано — и это
        // единственная защита от "забыли настроить доступ базовому слою"
        // (см. articleLayerPublicCheckbox/findAmbiguousPublicLayer).
        this.articleLayers = [{
          roles: [],
          public: false,
          title: document.getElementById('articleTitle')?.value || '',
          content: this.editorManager ? this.editorManager.doc : { version: 1, blocks: [] }
        }];
        this.activeLayerIndex = 0;
      }
      this.loadRoleCatalogForLayers(document.getElementById('articleServer')?.value).then(() => {
        this.loadLayerIntoForm(this.activeLayerIndex);
      });
    } else {
      document.getElementById('articleLayerEditingHint').textContent = '';
    }
  }

  // Подгружает список ролей выбранного сервера в chip-field "Доступ для".
  // Возвращает промис — editArticle()/loadDraft() сначала дожидаются опций
  // (чтобы у чипов сразу были названия ролей, а не ID), и только потом
  // проставляют выбранные значения.
  async loadRolesForArticleField(serverId) {
    if (!this.rolesField) return;
    if (!serverId) {
      this.rolesField.setOptions([]);
      this.rolesField.setPlaceholder('Сначала выберите сервер...');
      return;
    }
    try {
      const result = await apiClient.makeAuthenticatedRequest(`/api/servers/${serverId}/roles`);
      if (result.success) {
        this.rolesField.setOptions(result.data.map((r) => ({ value: String(r.id), label: r.name })));
        this.rolesField.setPlaceholder('Выберите роли...');
      } else {
        showMessage(`Ошибка загрузки ролей сервера: ${result.error}`, 'error');
        this.rolesField.setOptions([]);
      }
    } catch (error) {
      showMessage(`Неожиданная ошибка загрузки ролей сервера: ${error.message}`, 'error');
      this.rolesField.setOptions([]);
    }
  }

  // Приводит блок "Автор" формы в состояние для создания новой статьи —
  // показывает текущего пользователя как будущего автора, скрывает
  // соавторов и галочку "добавить себя как соавтора" (она нужна только
  // при редактировании чужой статьи).
  resetArticleAuthorInfo() {
    const currentUser = authManager.getCurrentUser();
    const chip = document.getElementById('articleAuthorChip');
    if (chip) chip.textContent = currentUser?.display_name || currentUser?.username || 'Вы';

    const coAuthorsList = document.getElementById('coAuthorsList');
    if (coAuthorsList) {
      coAuthorsList.innerHTML = '';
      coAuthorsList.hidden = true;
    }

    const addAsCoauthorWrap = document.getElementById('addAsCoauthorWrap');
    if (addAsCoauthorWrap) addAsCoauthorWrap.hidden = true;

    // Создание новой статьи — управления авторами нет (автор — создатель).
    this.articleAuthorsAdmin = null;
    const authorsAdmin = document.getElementById('authorsAdmin');
    if (authorsAdmin) authorsAdmin.hidden = true;
  }

  // Заполняет блок "Автор" данными статьи при редактировании: имя автора
  // (не редактируется — см. комментарий у поля в articles.html), список
  // соавторов, и показывает галочку "добавить себя как соавтора", если
  // статью редактирует не её автор (см. PUT /api/articles/:id).
  // Владельцу (is_root) вместо этого открывается полноценное управление
  // авторами — см. initArticleAuthorsAdmin().
  renderArticleAuthorInfo(article) {
    const currentUser = authManager.getCurrentUser();
    if (currentUser && currentUser.is_root) {
      this.initArticleAuthorsAdmin(article);
      return;
    }

    const chip = document.getElementById('articleAuthorChip');
    if (chip) {
      chip.textContent = article.author ? article.author.display_name : (currentUser?.display_name || currentUser?.username || 'Вы');
    }

    const coAuthors = article.co_authors || [];
    const coAuthorsList = document.getElementById('coAuthorsList');
    if (coAuthorsList) {
      coAuthorsList.innerHTML = '';
      coAuthors.forEach((co) => {
        const chipEl = document.createElement('span');
        chipEl.className = 'author-chip';
        chipEl.textContent = co.display_name;
        coAuthorsList.appendChild(chipEl);
      });
      coAuthorsList.hidden = coAuthors.length === 0;
    }

    const isForeignArticle = !!(article.author && currentUser && article.author.id !== currentUser.id);
    const addAsCoauthorWrap = document.getElementById('addAsCoauthorWrap');
    if (addAsCoauthorWrap) addAsCoauthorWrap.hidden = !isForeignArticle;
    const checkbox = document.getElementById('addAsCoauthorCheckbox');
    if (checkbox) checkbox.checked = true;
  }

  // --- Управление авторами (только владелец) ---
  // Состояние — this.articleAuthorsAdmin = { author: {id, display_name}|null,
  // coAuthors: [{id, display_name}] }; null вне режима правки статьи
  // владельцем. Уходит на сервер вместе со статьёй (см. saveArticle →
  // collectArticleAuthorsPayload) и там принимается только от is_root
  // (parseOwnerAuthorFields в articles.routes.js).
  initArticleAuthorsAdmin(article) {
    this.articleAuthorsAdmin = {
      author: article.author ? { id: article.author.id, display_name: article.author.display_name } : null,
      coAuthors: (article.co_authors || []).map((c) => ({ id: c.id, display_name: c.display_name }))
    };

    // Автодобавление "себя как соавтора" тут не работает: владелец явно
    // задаёт итоговый список, сервер его берёт как есть.
    const addAsCoauthorWrap = document.getElementById('addAsCoauthorWrap');
    if (addAsCoauthorWrap) addAsCoauthorWrap.hidden = true;
    const authorsAdmin = document.getElementById('authorsAdmin');
    if (authorsAdmin) authorsAdmin.hidden = false;

    this.renderArticleAuthorsAdmin();
  }

  // Перерисовывает чипы автора/соавторов по состоянию. Основной автор — без
  // кнопок (его меняют через поиск, кнопка "Автор"), у соавторов — ↑ и ×.
  renderArticleAuthorsAdmin() {
    const state = this.articleAuthorsAdmin;
    if (!state) return;

    const chip = document.getElementById('articleAuthorChip');
    if (chip) chip.textContent = state.author ? state.author.display_name : '— (не назначен)';

    const list = document.getElementById('coAuthorsList');
    if (!list) return;
    list.innerHTML = '';
    state.coAuthors.forEach((co) => {
      const chipEl = document.createElement('span');
      chipEl.className = 'author-chip';
      chipEl.dataset.userId = String(co.id);
      chipEl.appendChild(document.createTextNode(co.display_name));

      const promoteBtn = document.createElement('button');
      promoteBtn.type = 'button';
      promoteBtn.className = 'author-chip-btn';
      promoteBtn.dataset.action = 'promote';
      promoteBtn.title = 'Сделать основным автором (прежний станет соавтором)';
      promoteBtn.textContent = '↑';

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'author-chip-btn';
      removeBtn.dataset.action = 'remove';
      removeBtn.title = 'Убрать из соавторов';
      removeBtn.textContent = '×';

      chipEl.append(promoteBtn, removeBtn);
      list.appendChild(chipEl);
    });
    list.hidden = state.coAuthors.length === 0;
  }

  setArticleAuthor(user) {
    const state = this.articleAuthorsAdmin;
    if (!state) return;
    state.coAuthors = state.coAuthors.filter((c) => c.id !== user.id);
    state.author = { id: user.id, display_name: user.display_name };
    this.renderArticleAuthorsAdmin();
  }

  addArticleCoAuthor(user) {
    const state = this.articleAuthorsAdmin;
    if (!state) return;
    if (state.author && state.author.id === user.id) {
      showMessage('Этот пользователь уже основной автор', 'warning');
      return;
    }
    if (state.coAuthors.some((c) => c.id === user.id)) return;
    state.coAuthors.push({ id: user.id, display_name: user.display_name });
    this.renderArticleAuthorsAdmin();
  }

  // ↑ на соавторе: он становится основным автором, прежний автор (если был)
  // переезжает в соавторы — обмен, а не потеря авторства.
  promoteArticleCoAuthor(userId) {
    const state = this.articleAuthorsAdmin;
    if (!state) return;
    const idx = state.coAuthors.findIndex((c) => c.id === userId);
    if (idx === -1) return;
    const [promoted] = state.coAuthors.splice(idx, 1);
    if (state.author && state.author.id) state.coAuthors.unshift(state.author);
    state.author = promoted;
    this.renderArticleAuthorsAdmin();
  }

  removeArticleCoAuthor(userId) {
    const state = this.articleAuthorsAdmin;
    if (!state) return;
    state.coAuthors = state.coAuthors.filter((c) => c.id !== userId);
    this.renderArticleAuthorsAdmin();
  }

  // Поле, отправляемое вместе со статьёй, — только пока владелец правит
  // существующую статью. author_id шлём, только если у статьи есть автор с
  // id (легаси без сопоставленного пользователя сервер "усыновит" сам).
  collectArticleAuthorsPayload() {
    const state = this.articleAuthorsAdmin;
    if (!state) return {};
    return {
      ...(state.author && state.author.id ? { author_id: state.author.id } : {}),
      co_author_ids: state.coAuthors.map((c) => c.id)
    };
  }

  hideArticleAuthorsDropdown() {
    const dropdown = document.getElementById('authorsAdminDropdown');
    if (dropdown) { dropdown.hidden = true; dropdown.innerHTML = ''; }
  }

  async runArticleAuthorsSearch() {
    const query = document.getElementById('authorsAdminSearch')?.value.trim() || '';
    const dropdown = document.getElementById('authorsAdminDropdown');
    if (!dropdown) return;
    if (!query) { this.hideArticleAuthorsDropdown(); return; }

    try {
      const result = await apiClient.searchUsers(query);
      // Пока запрос летел, поле могли очистить или уйти со страницы.
      if (!document.getElementById('authorsAdminSearch')?.value.trim()) return;
      const users = result.success && Array.isArray(result.data) ? result.data : [];

      dropdown.innerHTML = '';
      if (users.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'chip-field-dropdown-empty';
        empty.textContent = 'Никого не найдено';
        dropdown.appendChild(empty);
      } else {
        users.forEach((u) => {
          const name = u.display_name || u.username;
          const row = document.createElement('div');
          row.className = 'authors-admin-result';
          row.dataset.userId = String(u.id);
          row.dataset.name = name;

          const label = document.createElement('span');
          label.textContent = name;

          const actions = document.createElement('span');
          actions.className = 'authors-admin-result-actions';
          [['author', 'Автор', 'btn btn-primary btn-sm'], ['coauthor', 'Соавтор', 'btn btn-secondary btn-sm']].forEach(([action, text, cls]) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = cls;
            btn.dataset.action = action;
            btn.textContent = text;
            actions.appendChild(btn);
          });

          row.append(label, actions);
          dropdown.appendChild(row);
        });
      }
      dropdown.hidden = false;
    } catch (error) {
      this.hideArticleAuthorsDropdown();
    }
  }

  // Вешает обработчики управления авторами. Вызывается при каждой инициализации
  // страницы статей (партиал пересоздаётся), кроме клика вне выпадашки — он на
  // document и вешается один раз (по тому же приёму, что и у поиска участника).
  setupArticleAuthorsAdmin() {
    let debounce = null;
    document.getElementById('authorsAdminSearch')?.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this.runArticleAuthorsSearch(), 200);
    });

    document.getElementById('authorsAdminDropdown')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      const row = e.target.closest('.authors-admin-result');
      if (!btn || !row) return;
      const user = { id: parseInt(row.dataset.userId, 10), display_name: row.dataset.name };
      if (btn.dataset.action === 'author') this.setArticleAuthor(user);
      else this.addArticleCoAuthor(user);
      const input = document.getElementById('authorsAdminSearch');
      if (input) input.value = '';
      this.hideArticleAuthorsDropdown();
    });

    document.getElementById('coAuthorsList')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      const chipEl = e.target.closest('[data-user-id]');
      if (!btn || !chipEl || !this.articleAuthorsAdmin) return;
      const userId = parseInt(chipEl.dataset.userId, 10);
      if (btn.dataset.action === 'promote') this.promoteArticleCoAuthor(userId);
      else if (btn.dataset.action === 'remove') this.removeArticleCoAuthor(userId);
    });

    if (!this._articleAuthorsOutsideClickBound) {
      document.addEventListener('click', (e) => {
        const wrap = document.getElementById('authorsAdminSearch')?.closest('.authors-admin-search');
        if (wrap && !wrap.contains(e.target)) this.hideArticleAuthorsDropdown();
      });
      this._articleAuthorsOutsideClickBound = true;
    }
  }

  // Собирает данные формы статьи для отправки на сервер/сохранения черновика.
  // getValues() у чиповых полей сам "доливает" текст, набранный в поле, но
  // ещё не оформленный в чип явным действием — раньше такой текст молча
  // терялся при сохранении статьи (см. заголовок chip-field.js).
  collectArticleFormData() {
    const addAsCoauthorCheckbox = document.getElementById('addAsCoauthorCheckbox');
    // Многослойность — снимаем несохранённые правки активного слоя перед
    // сборкой (см. snapshotActiveLayer), иначе последний выбранный слой
    // ушёл бы на сервер со старым содержимым. layers шлём ТОЛЬКО массивом
    // {roles,title,content} — сервер сам сливает его со слоями выше
    // резолвнутого максимума текущего пользователя (см. mergeLayersUpdate
    // в src/services/article-layers.js), которых форма даже не видела.
    this.snapshotActiveLayer();
    const data = {
      title: document.getElementById('articleTitle').value,
      server: document.getElementById('articleServer').value,
      content: document.getElementById('articleContent').innerHTML,
      image: document.getElementById('articleImageFile')?.value || '',
      locked: document.getElementById('articleLocked')?.value === 'true',
      roles: this.rolesField ? this.rolesField.getValues() : [],
      tags: this.tagsField ? this.tagsField.getValues() : [],
      add_as_coauthor: addAsCoauthorCheckbox ? addAsCoauthorCheckbox.checked : true
    };

    // layers добавляем в payload, только если ДОСТОВЕРНО знаем реальное
    // состояние слоёв редактируемой статьи (см. this._layersStateKnown в
    // editArticle/clearArticleForm) — иначе, если, например, запрос
    // GET /articles/:id/layers не долетел, отправка layers:[] тихо стёрла бы
    // все слои статьи до одного. Не зная — просто не трогаем это поле:
    // сервер (PUT /api/articles/:id) не меняет layers, если ключа нет вовсе.
    if (this._layersStateKnown) {
      data.layers = this.articleLayersEnabled
        ? this.articleLayers.map((l) => ({ roles: l.roles, public: !!l.public, title: l.title, content: l.content }))
        : [];
      // Сервер эти два поля игнорирует (в PUT/POST /api/articles он читает
      // только известные ему поля) — они здесь только для черновика
      // (см. loadDraft), чтобы при восстановлении вернуть тот же слой
      // активным и правильное состояние переключателя "Многослойная статья",
      // а не только заголовок/текст ОДНОГО слоя, который был открыт в
      // момент "Черновик".
      data.layersEnabled = this.articleLayersEnabled;
      data.activeLayerIndex = this.activeLayerIndex;
    }
    return data;
  }

  // Set up basic editor events as a fallback
  setupBasicEditorEvents() {
    // Set up event listeners to update toolbar states when editor content changes
    const editor = document.getElementById('articleContent');
    if (editor) {
      // Add event listeners for updating toolbar states
      editor.addEventListener('keyup', this.updateToolbarUI.bind(this));
      editor.addEventListener('mouseup', this.updateToolbarUI.bind(this));
      editor.addEventListener('click', this.updateToolbarUI.bind(this));
      editor.addEventListener('input', this.updateToolbarUI.bind(this));
      editor.addEventListener('selectionchange', this.updateToolbarUI.bind(this));
    }
  }

  // Set up improved editor events
  setupImprovedEditorEvents() {
    // The editor manager handles all editor events now, so we don't need to set up our own
    // Just ensure the editor manager is properly initialized
    const editorMgr = this.editorManager; // Use getter
    if (editorMgr) {
      // The editor manager already handles toolbar events, formatting, and UI updates
      // We should only set up our own event listeners for editor content changes
      // but let editorManager handle toolbar button events
    }

    // Set up event listeners to update toolbar states when editor content changes
    // These will call our updateToolbarUI method which will use editorManager if available
    const editor = document.getElementById('articleContent');
    if (editor) {
      // Add event listeners for updating toolbar states
      editor.addEventListener('keyup', this.updateToolbarUI.bind(this));
      editor.addEventListener('mouseup', this.updateToolbarUI.bind(this));
      editor.addEventListener('click', this.updateToolbarUI.bind(this));
      editor.addEventListener('input', this.updateToolbarUI.bind(this));
      editor.addEventListener('selectionchange', this.updateToolbarUI.bind(this));
    }
  }

  // Setup toolbar event handlers

  // Apply formatting to editor content
  applyFormat(command) {
    // This method is now handled by editor-manager.js
    const editorMgr = this.editorManager; // Use getter
    if (editorMgr) {
      // Execute the command directly since formatText was removed
      document.execCommand(command, false, null);
      if (editorMgr.updateToolbarActiveStates) {
        editorMgr.updateToolbarActiveStates();
      }
      // Ensure editor has focus
      const editor = document.getElementById('articleContent');
      if (editor) {
        editor.focus();
      }
    } else {
      // Fallback implementation if editorManager is not available
      document.execCommand(command, false, null);
      this.updateToolbarUI(); // Use our own update method
      // Ensure editor has focus
      const editor = document.getElementById('articleContent');
      if (editor) {
        editor.focus();
      }
    }
  }

  // Update toolbar UI based on current selection
  updateToolbarUI() {
    // This method is now handled by editor-manager.js
    const editorMgr = this.editorManager; // Use getter
    if (editorMgr) {
      editorMgr.updateToolbarActiveStates();
    } else {
      // Fallback to direct implementation if editorManager is not available
      this.updateToolbarActiveStates();
    }
  }

  // Update toolbar active states based on current selection (for fallback implementation)
  updateToolbarActiveStates() {
    const toolbar = document.getElementById('toolbar');
    if (!toolbar) return;

    // Check formatting states using document.queryCommandState
    const boldActive = document.queryCommandState('bold');
    const italicActive = document.queryCommandState('italic');
    const underlineActive = document.queryCommandState('underline');
    const strikethroughActive = document.queryCommandState('strikeThrough');
    const unorderedListActive = document.queryCommandState('insertUnorderedList');
    const orderedListActive = document.queryCommandState('insertOrderedList');

    // Update buttons with data-command attributes based on current formatting state
    const boldBtn = toolbar.querySelector('[data-command="bold"]');
    const italicBtn = toolbar.querySelector('[data-command="italic"]');
    const underlineBtn = toolbar.querySelector('[data-command="underline"]');
    const strikethroughBtn = toolbar.querySelector('[data-command="strikeThrough"]');
    const listBtn = toolbar.querySelector('[data-command="insertUnorderedList"]');
    const orderedListBtn = toolbar.querySelector('[data-command="insertOrderedList"]');

    if (boldBtn) {
      boldBtn.classList.toggle('active', boldActive);
    }
    if (italicBtn) {
      italicBtn.classList.toggle('active', italicActive);
    }
    if (underlineBtn) {
      underlineBtn.classList.toggle('active', underlineActive);
    }
    if (strikethroughBtn) {
      strikethroughBtn.classList.toggle('active', strikethroughActive);
    }
    if (listBtn) {
      // Special handling for list buttons to ensure mutual exclusivity
      listBtn.classList.toggle('active', unorderedListActive && !orderedListActive);
    }
    if (orderedListBtn) {
      // Special handling for list buttons to ensure mutual exclusivity
      orderedListBtn.classList.toggle('active', orderedListActive && !unorderedListActive);
    }
  }

  // Set up article form events
  setupArticleFormEvents() {
    // Set up all button events using event delegation
    document.getElementById('add-tag-mobile-btn')?.addEventListener('click', () => this.tagsField?.commitTyped());
    document.getElementById('upload-image-btn')?.addEventListener('click', () => this.uploadImage());
    document.getElementById('saveArticleBtn')?.addEventListener('click', (e) => runExclusive(e.currentTarget, () => this.saveArticle()));
    document.getElementById('saveDraftBtn')?.addEventListener('click', () => this.saveDraft());
    document.getElementById('loadDraftBtn')?.addEventListener('click', () => {
      // Show the drafts manager
      document.getElementById('draftsManager').style.display = 'block';
      this.displayDrafts();
    });
    document.getElementById('resetArticleBtn')?.addEventListener('click', () => {
      this.resetArticle();
    });
    document.getElementById('closeDraftsManagerBtn')?.addEventListener('click', () => {
      // Hide the drafts manager
      document.getElementById('draftsManager').style.display = 'none';
    });
    document.getElementById('clearArticleFormBtn')?.addEventListener('click', () => this.clearArticleForm());
    document.getElementById('previewArticleBtn')?.addEventListener('click', () => this.previewArticle());
    document.getElementById('closePreviewBtn')?.addEventListener('click', () => this.closePreview());

    // Роли привязаны к серверу — при смене сервера сбрасываем выбранные
    // роли (они относятся к старому серверу) и грузим варианты нового.
    document.getElementById('articleServer')?.addEventListener('change', (e) => {
      if (this.rolesField) this.rolesField.setValues([]);
      this.loadRolesForArticleField(e.target.value);
      if (this.articleLayersEnabled) {
        this.layerRolesField?.setValues([]);
        this.loadRoleCatalogForLayers(e.target.value);
      }
    });

    // Многослойность (см. setLayersMode/renderArticleLayersList выше).
    document.getElementById('articleLayersToggle')?.addEventListener('change', (e) => {
      this.setLayersMode(e.target.checked);
    });
    document.getElementById('articleLayersAddBtn')?.addEventListener('click', () => {
      this.snapshotActiveLayer();
      this.articleLayers.push({ roles: [], public: false, title: '', content: { version: 1, blocks: [] } });
      this.loadLayerIntoForm(this.articleLayers.length - 1);
    });
    // Копия выбранного слоя (роли+заголовок+текст) как новый слой выше —
    // чтобы не набирать заново почти такой же текст следующего слоя.
    // Глубокая копия content (JSON.parse/stringify) — иначе оригинал и
    // дубликат делили бы один и тот же вложенный объект блоков, и правка
    // одного меняла бы другой молча.
    document.getElementById('articleLayersDuplicateBtn')?.addEventListener('click', () => {
      this.snapshotActiveLayer();
      const source = this.articleLayers[this.activeLayerIndex];
      if (!source) return;
      this.articleLayers.push({
        roles: source.roles.map((r) => ({ ...r })),
        public: !!source.public,
        title: source.title ? `${source.title} (копия)` : '',
        content: JSON.parse(JSON.stringify(source.content))
      });
      this.loadLayerIntoForm(this.articleLayers.length - 1);
    });
    document.getElementById('articleLayersList')?.addEventListener('click', (e) => {
      const moveBtn = e.target.closest('.article-layer-pill-move');
      if (moveBtn) {
        this.moveArticleLayer(parseInt(moveBtn.dataset.index, 10), parseInt(moveBtn.dataset.move, 10));
        return;
      }
      const removeBtn = e.target.closest('.article-layer-pill-remove');
      if (removeBtn) {
        const idx = parseInt(removeBtn.dataset.index, 10);
        if (this.articleLayers.length <= 1) return; // хотя бы один слой должен остаться
        this.articleLayers.splice(idx, 1);
        // Индекс активного слоя мог сместиться — выбираем ближайший.
        const nextIndex = Math.min(this.activeLayerIndex >= idx ? Math.max(0, this.activeLayerIndex - 1) : this.activeLayerIndex, this.articleLayers.length - 1);
        this.loadLayerIntoForm(nextIndex);
        return;
      }
      const pill = e.target.closest('.article-layer-pill');
      if (pill) {
        const idx = parseInt(pill.dataset.index, 10);
        if (idx === this.activeLayerIndex) return;
        this.snapshotActiveLayer();
        this.loadLayerIntoForm(idx);
      }
    });

    // Add beforeunload event listener to warn user about unsaved changes
    window.addEventListener('beforeunload', (e) => {
      // Слушатель живёт на window и переживает уход со страницы статей —
      // если формы в DOM уже нет, предупреждать и сохранять нечего.
      const titleEl = document.getElementById('articleTitle');
      const contentEl = document.getElementById('articleContent');
      if (!titleEl || !contentEl) return;

      // Check if there's content in the form that hasn't been saved
      const title = titleEl.value;
      const content = contentEl.innerHTML;

      // Открыта уже существующая статья (editArticle() пишет её id в
      // data-article-id кнопки сохранения). Черновик из неё не делаем: он не
      // помнит, что относится к статье, и после перезагрузки подставился бы
      // в режиме создания — "Опубликовать" породило бы дубликат статьи.
      // Сама статья на сервере при этом цела; несохранённые правки лишь
      // предупреждаем о потере.
      const isEditingExistingArticle = !!document.getElementById('saveArticleBtn')?.getAttribute('data-article-id');

      // If there's content, warn the user about potential data loss
      if (title.trim() || content.trim()) {
        // Черновик автосохраняется на выход только если в редакторе реально
        // есть содержимое — один заголовок без единого блока в редакторе
        // черновиком не считается (см. требование "если содержание статьи
        // пустое, мы не отправляем её в черновик при выходе"): иначе
        // checkAndOfferDraft() при следующем заходе на страницу подставлял
        // бы пустую "статью" из одного заголовка.
        if (content.trim() && !isEditingExistingArticle) {
          try {
            const articleData = {
              id: this.currentDraftId || 'draft_' + Date.now(), // Use current draft ID if editing, otherwise generate new ID
              ...this.collectArticleFormData(),
              description: '',
              timestamp: Date.now()
            };

            // Get existing drafts or initialize empty array
            let drafts = this.getDraftsFromStorage();

            // Check if we're updating an existing draft
            const existingDraftIndex = drafts.findIndex(draft => draft.id === this.currentDraftId);
            if (existingDraftIndex !== -1) {
              // Update existing draft
              drafts[existingDraftIndex] = articleData;
            } else {
              // Add new draft to the beginning of the array
              drafts.unshift(articleData);
            }

            // Save updated drafts array to localStorage
            localStorage.setItem('articleDrafts', JSON.stringify(drafts));

            // Update currentDraftId to the saved draft's ID
            this.currentDraftId = articleData.id;

            // Реальный черновик только что создан/обновлён — снимаем флаг
            // подавления автозагрузки (см. resetArticle()/suppressDraftAutoLoad()):
            // раз пользователь опять что-то пишет, следующий заход на
            // страницу снова должен предложить именно этот черновик.
            this.clearDraftAutoLoadSuppression();
          } catch (error) {
            console.error('Could not save draft before unload:', error);
          }
        }

        // Show a warning to the user
        e.preventDefault();
        e.returnValue = 'У вас есть несохраненные изменения. Вы уверены, что хотите покинуть страницу?';
      }
    });
  }

  // Initialize servers page
  async initServersPage() {
    this.setupServerFormEvents();
    await this.loadServersDirectory();
  }

  // makeAuthenticatedRequest всегда кладёт тело ответа сервера в result.data
  // (result.error существует только при сетевом сбое до получения ответа —
  // см. apiClient.makeAuthenticatedRequest в app.js), поэтому при
  // response.ok === false настоящий текст ошибки лежит в result.data.error.
  // Раньше весь блок "Сервера" читал именно result.error и почти всегда
  // показывал пользователю "undefined" вместо реальной причины отказа.
  serverApiError(result) {
    return (result && result.data && result.data.error) || (result && result.error) || 'Неизвестная ошибка';
  }

  // Аватар сервера — цвет и буква считаются на лету из названия, а не
  // хранятся в БД: в таблице servers нет колонки под иконку, так что поле
  // "Иконка" в старой форме создания сервера ничего не сохраняло — сервер
  // POST /api/servers всегда молча игнорировал его (см. src/routes/servers.routes.js).
  // Цвет привязан к названию (не к id), чтобы предпросмотр в модалке
  // "Создать сервер" — где id ещё не существует — совпадал с итоговым
  // цветом карточки после сохранения, без "прыжка" цвета при создании.
  serverAvatarPalette() {
    return ['#5865f2', '#eb459e', '#3ba55d', '#faa81a', '#00b0f4', '#ed4245', '#9b59b6', '#1abc9c'];
  }

  serverAvatarColorForName(name) {
    const str = (name || '').trim();
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    const palette = this.serverAvatarPalette();
    return palette[Math.abs(hash) % palette.length];
  }

  serverAvatarInitial(name) {
    return ((name || '').trim().charAt(0) || '?').toUpperCase();
  }

  serverAvatarHtml(server) {
    return `<div class="server-avatar" style="background: ${this.serverAvatarColorForName(server.name)};">${this.escapeHtml(this.serverAvatarInitial(server.name))}</div>`;
  }

  applyServerAvatar(el, server) {
    if (!el) return;
    el.style.background = this.serverAvatarColorForName(server.name);
    el.textContent = this.serverAvatarInitial(server.name);
  }

  // Живой предпросмотр аватара в модалке "Создать сервер" — обновляется по
  // вводу названия тем же расчётом цвета/буквы, что и итоговая карточка.
  updateCreateServerAvatarPreview() {
    const el = document.getElementById('create-server-avatar-preview');
    if (!el) return;
    const name = document.getElementById('server-name')?.value || '';
    el.style.background = this.serverAvatarColorForName(name);
    el.textContent = this.serverAvatarInitial(name);
  }

  // Set up toolbar/modal events for the servers page — the fragment is
  // re-fetched from /views/servers.html every time /servers is opened, so
  // it's safe to always (re)bind here.
  setupServerFormEvents() {
    document.getElementById('create-server-btn')?.addEventListener('click', () => this.showCreateServerModal());
    document.getElementById('create-server-empty-btn')?.addEventListener('click', () => this.showCreateServerModal());
    document.getElementById('create-server-confirm-btn')?.addEventListener('click', (e) => runExclusive(e.currentTarget, () => this.createServer()));
    document.getElementById('cancel-create-server-btn')?.addEventListener('click', () => this.hideCreateServerModal());
    document.getElementById('create-server-close-btn')?.addEventListener('click', () => this.hideCreateServerModal());
    document.getElementById('create-server-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'create-server-modal') this.hideCreateServerModal();
    });
    document.getElementById('server-name')?.addEventListener('input', () => this.updateCreateServerAvatarPreview());

    // Поиск/сортировка каталога — работают локально по уже загруженному
    // списку (this.serversCache), без обращений к серверу.
    let serversSearchDebounce = null;
    document.getElementById('servers-search-input')?.addEventListener('input', () => {
      clearTimeout(serversSearchDebounce);
      serversSearchDebounce = setTimeout(() => this.renderServersGrid(), 150);
    });
    document.getElementById('servers-sort-select')?.addEventListener('change', () => this.renderServersGrid());

    // Рабочая область открытого сервера
    document.getElementById('server-workspace-back-btn')?.addEventListener('click', () => this.closeServerWorkspace());
    document.getElementById('server-workspace-tabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-server-tab]');
      if (btn) this.switchServerWorkspaceTab(btn.dataset.serverTab);
    });

    // Модалка "Добавить участника"
    document.getElementById('add-member-confirm-btn')?.addEventListener('click', () => this.confirmAddMember());
    document.getElementById('add-member-cancel-btn')?.addEventListener('click', () => this.hideAddMemberModal());
    document.getElementById('add-member-close-btn')?.addEventListener('click', () => this.hideAddMemberModal());
    document.getElementById('add-member-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'add-member-modal') this.hideAddMemberModal();
    });
    let addMemberSearchDebounce = null;
    document.getElementById('add-member-search')?.addEventListener('input', () => {
      clearTimeout(addMemberSearchDebounce);
      addMemberSearchDebounce = setTimeout(() => this.runAddMemberSearch(), 200);
    });
    // На document, а не на сам инпут — чтобы клик мимо выпадашки её закрывал.
    // Вешается один раз за всё время жизни страницы (не при каждом заходе на
    // /servers, в отличие от остальных обработчиков этого метода): document
    // не пересоздаётся при повторной загрузке партиала, а add-member-search
    // внутри него ищем каждый раз заново через getElementById.
    if (!this._addMemberOutsideClickBound) {
      document.addEventListener('click', (e) => {
        const wrap = document.getElementById('add-member-search')?.closest('.servers-user-search');
        if (wrap && !wrap.contains(e.target)) this.hideAddMemberSearchDropdown();
      });
      this._addMemberOutsideClickBound = true;
    }

    // Модалка "Назначить роль" (id и методы с префиксом server- — см.
    // комментарий в servers.html про коллизию с users-list.html)
    document.getElementById('server-assign-role-confirm-btn')?.addEventListener('click', () => this.confirmServerAssignRole());
    document.getElementById('server-assign-role-cancel-btn')?.addEventListener('click', () => this.hideServerAssignRoleModal());
    document.getElementById('server-assign-role-close-btn')?.addEventListener('click', () => this.hideServerAssignRoleModal());
    document.getElementById('server-assign-role-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'server-assign-role-modal') this.hideServerAssignRoleModal();
    });

    // Модалка создания/редактирования роли
    document.getElementById('server-role-editor-save-btn')?.addEventListener('click', (e) => runExclusive(e.currentTarget, () => this.saveServerRoleEditor()));
    document.getElementById('server-role-editor-cancel-btn')?.addEventListener('click', () => this.hideServerRoleEditorModal());
    document.getElementById('server-role-editor-close-btn')?.addEventListener('click', () => this.hideServerRoleEditorModal());
    document.getElementById('server-role-editor-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'server-role-editor-modal') this.hideServerRoleEditorModal();
    });

    // Модалка смены владельца (root only)
    document.getElementById('change-owner-confirm-btn')?.addEventListener('click', () => this.confirmChangeOwner());
    document.getElementById('change-owner-cancel-btn')?.addEventListener('click', () => this.hideChangeOwnerModal());
    document.getElementById('change-owner-close-btn')?.addEventListener('click', () => this.hideChangeOwnerModal());
    document.getElementById('change-owner-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'change-owner-modal') this.hideChangeOwnerModal();
    });

    // Модалка создания/редактирования канала
    document.getElementById('channel-editor-save-btn')?.addEventListener('click', (e) => runExclusive(e.currentTarget, () => this.saveChannelEditor()));
    document.getElementById('channel-editor-cancel-btn')?.addEventListener('click', () => this.hideChannelEditorModal());
    document.getElementById('channel-editor-close-btn')?.addEventListener('click', () => this.hideChannelEditorModal());
    document.getElementById('channel-editor-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'channel-editor-modal') this.hideChannelEditorModal();
    });
  }

  // Show create server modal
  showCreateServerModal() {
    const modal = document.getElementById('create-server-modal');
    if (modal) modal.hidden = false;
    this.updateCreateServerAvatarPreview();
    document.getElementById('server-name')?.focus();
  }

  // Hide create server modal
  hideCreateServerModal() {
    const modal = document.getElementById('create-server-modal');
    if (modal) modal.hidden = true;
    document.getElementById('server-name').value = '';
    document.getElementById('server-description').value = '';
    this.updateCreateServerAvatarPreview();
  }

  // Create server
  async createServer() {
    const name = document.getElementById('server-name').value.trim();
    const description = document.getElementById('server-description').value.trim();

    if (!name) {
      showMessage('Название сервера обязательно', 'error');
      return;
    }

    try {
      const result = await apiClient.createServer({ name, description });

      if (result.success) {
        showMessage('Сервер успешно создан!', 'success');
        this.hideCreateServerModal();
        await this.loadServersDirectory();
      } else {
        showMessage(`Ошибка создания сервера: ${this.serverApiError(result)}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка при создании сервера: ${error.message}`, 'error');
    }
  }

  // Initialize settings page
  async initSettingsPage() {
    await this.setupSettingsFormEvents();
    // Initialize backup/cleanup panels after DOM update
    setTimeout(() => {
      if (typeof initBackupPage === 'function') {
        console.log('[SPA] Вызов initBackupPage');
        initBackupPage();
      } else {
        console.warn('[SPA] initBackupPage не найден');
      }
      if (typeof initCleanupPage === 'function') {
        console.log('[SPA] Вызов initCleanupPage');
        initCleanupPage();
      } else {
        console.warn('[SPA] initCleanupPage не найден');
      }
    }, 100);
  }

  // Additional methods for handling articles functionality
  // (These would be implementations of the methods mentioned in setupArticleFormEvents)
  // Теги/роли теперь ведёт ChipField (см. public/chip-field.js,
  // this.tagsField/this.rolesField) — старые addTag/
  // removeTag и весь чекбоксовый UI ролей отсюда убраны.

  selectCoverFromFile() {
    // Trigger the hidden file input
    const fileInput = document.getElementById('articleImageFileInput');
    fileInput.click();
  }

  handleCoverFileSelect(inputElement) {
    const file = inputElement.files[0];
    if (!file) {
      return;
    }

    // Validate file type
    if (!file.type.startsWith('image/')) {
      showMessage('Пожалуйста, выберите файл изображения', 'error');
      return;
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      showMessage('Размер файла превышает допустимый лимит (5MB)', 'error');
      return;
    }

    // Create a preview using object URL
    const previewImg = document.getElementById('articleCoverImagePreview');
    const previewContainer = document.getElementById('articleCoverPreview');
    const fileNameElement = document.getElementById('coverFileName');

    if (previewImg) {
        previewImg.src = URL.createObjectURL(file);
    }

    if (fileNameElement) {
        fileNameElement.textContent = file.name;
    }

    if (previewContainer) {
        previewContainer.style.display = 'flex';
    }

    // Upload the file
    this.uploadCoverFile(file);
  }

  async uploadCoverFile(file) {
    const formData = new FormData();
    formData.append('image', file); // Ключ 'image' должен совпадать с тем, что ждет сервер

    try {
        const response = await fetch('/api/upload-image', { // ИСПРАВЛЕНО: правильный URL для загрузки изображений
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authManager.getToken()}`
            },
            body: formData
        });

        // Проверяем Content-Type ответа
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const textResponse = await response.text();
            console.error('Server returned non-JSON response:', textResponse.substring(0, 500));
            throw new Error('Сервер вернул некорректный ответ (не JSON). Проверьте логи сервера.');
        }

        const result = await response.json();
        if (response.ok) {
            // Update the hidden input field with the uploaded URL
            document.getElementById('articleImageFile').value = result.url;

            // Update the image preview to use the uploaded URL
            document.getElementById('articleCoverImagePreview').src = result.url;

            showMessage('Обложка успешно загружена!', 'success');
        } else {
            throw new Error(result.error || 'Ошибка сервера');
        }
    } catch (error) {
        console.error('Upload error:', error);
        showMessage('Ошибка при загрузке изображения: ' + error.message, 'error');
    }
  }

  selectCoverFromUrl() {
    const url = prompt("Введите URL изображения для обложки:");
    if (!url) {
      return; // User cancelled
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (e) {
      showMessage('Пожалуйста, введите корректный URL изображения', 'error');
      return;
    }

    // Show image preview
    const previewImg = document.getElementById('articleCoverImagePreview');
    const previewContainer = document.getElementById('articleCoverPreview');
    const fileNameElement = document.getElementById('coverFileName');

    previewImg.src = url;
    fileNameElement.textContent = 'URL: ' + url.substring(0, 30) + (url.length > 30 ? '...' : '');
    previewContainer.style.display = 'flex';

    // Set the URL in the hidden input field for saving
    document.getElementById('articleImageFile').value = url;

    showMessage('Обложка установлена из URL!', 'success');
  }

  removeArticleCover() {
    const previewContainer = document.getElementById('articleCoverPreview');
    const fileInput = document.getElementById('articleImageFileInput');
    const hiddenInput = document.getElementById('articleImageFile');
    const fileNameElement = document.getElementById('coverFileName');

    previewContainer.style.display = 'none';
    fileInput.value = ''; // Clear the file input
    hiddenInput.value = '';
    fileNameElement.textContent = '';

    showMessage('Обложка удалена', 'info');
  }

  async uploadImage() {
    const fileInput = document.getElementById('articleCoverInput');
    if (!fileInput || !fileInput.files[0]) return;

    const formData = new FormData();
    formData.append('image', fileInput.files[0]);

    try {
        // ИСПРАВЛЕНО: Используем правильный URL для загрузки изображений
        const response = await fetch('/api/upload-image', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authManager.getToken()}`
            },
            body: formData
        });

        const text = await response.text(); // Сначала читаем как текст
        try {
            const result = JSON.parse(text); // Пытаемся превратить в JSON
            if (response.ok && result.url) {
                document.getElementById('articleImagePreview').src = result.url;
                showMessage('Обложка загружена!', 'success');
            } else {
                showMessage('Ошибка сервера: ' + (result.error || 'Неизвестно'), 'error');
            }
        } catch (jsonErr) {
            console.error("Сервер ответил HTML-кодом вместо JSON. Вот ответ:", text);
            showMessage("Критическая ошибка: сервер прислал HTML. Возможно, путь /api/upload-image не существует.", 'error');
        }
    } catch (error) {
        console.error('Upload catch:', error);
        showMessage('Ошибка загрузки: ' + error.message, 'error');
    }
  }

  async saveArticle() {
    // 1. Ищем кнопку именно в текущем контейнере
    const saveBtn = document.getElementById('saveArticleBtn');
    // ВАЖНО: берем ID, который туда записал ArticlesModule.editArticle
    const articleId = saveBtn ? saveBtn.getAttribute('data-article-id') : null;

    console.log("Пытаюсь сохранить статью. ID:", articleId); // Для отладки

    // Автор в тело запроса не входит — сервер сам проставляет его из токена
    // при создании и не даёт менять при редактировании (см. articleAuthor
    // в articles.html и PUT/POST /api/articles в articles.routes.js).
    // Исключение — владелец: его управление авторами (author_id/
    // co_author_ids) сервер принимает только от is_root; у остальных этого
    // состояния нет вовсе (см. collectArticleAuthorsPayload).
    const articleData = {
        ...this.collectArticleFormData(),
        ...(articleId ? this.collectArticleAuthorsPayload() : {}),
        description: ''
    };

    // 2. РЕШАЕМ: КУДА И КАК ШЛЕМ
    const method = articleId ? 'PUT' : 'POST';
    const url = articleId ? `/api/articles/${articleId}` : '/api/articles';

    try {
        const response = await fetch(url, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authManager.getToken()}`
            },
            body: JSON.stringify(articleData)
        });

        // Проверяем, не прислал ли сервер HTML вместо JSON
        const contentType = response.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            const text = await response.text();
            console.error("Сервер прислал не JSON:", text);
            throw new Error("Сервер вернул ошибку (HTML). Проверьте путь /api/articles");
        }

        const result = await response.json();
        if (response.ok) {
            showMessage(articleId ? 'Статья успешно обновлена!' : 'Статья создана!', 'success');
            // Clear all drafts from localStorage after successful save
            localStorage.removeItem('articleDrafts');
            this.currentDraftId = null; // Clear current draft ID after successful save
            this.navigateTo('/articles');
        } else {
            showMessage(`Ошибка: ${result.error || 'Неизвестная ошибка'}`, 'error');
        }
    } catch (error) {
        console.error('Save error:', error);
        showMessage('Ошибка при сохранении: ' + error.message, 'error');
    }
  }

  clearArticleForm() {
    document.getElementById('articleTitle').value = '';
    document.getElementById('articleContent').innerHTML = '';
    if (this.tagsField) this.tagsField.setValues([]);
    document.getElementById('articleImageFile').value = '';
    document.getElementById('articleImageFileInput').value = '';
    document.getElementById('articleCoverPreview').style.display = 'none';
    document.getElementById('coverFileName').textContent = '';

    // Reset article status and trigger UI update
    const lockedSelect = document.getElementById('articleLocked');
    lockedSelect.value = 'false'; // Reset article status to unlocked (open)
    // Trigger change event to update UI
    const lockedChangeEvent = new Event('change', { bubbles: true });
    lockedSelect.dispatchEvent(lockedChangeEvent);

    // Reset server field and trigger any related UI updates (сбросит и роли —
    // см. обработчик 'change' в setupArticleFormEvents)
    const serverSelect = document.getElementById('articleServer');
    serverSelect.value = ''; // Reset server field to default (empty/"No server")
    const serverChangeEvent = new Event('change', { bubbles: true });
    serverSelect.dispatchEvent(serverChangeEvent);

    this.resetArticleAuthorInfo();

    // Многослойность — сброс к пустому одиночному состоянию (см.
    // initArticleChipFields, та же исходная форма).
    this.articleLayersEnabled = false;
    this.articleLayers = [];
    this.activeLayerIndex = 0;
    this._layersStateKnown = true;
    document.getElementById('articleLayersToggle').checked = false;
    document.getElementById('articleLayersPanel').hidden = true;
    document.getElementById('articleLegacyAccessRow').hidden = false;
    document.getElementById('articleLegacyRolesRow').hidden = false;
    const layerHint = document.getElementById('articleLayerEditingHint');
    if (layerHint) { layerHint.hidden = true; layerHint.textContent = ''; }
    this.layerRolesField?.setValues([]);
    const publicCheckboxReset = document.getElementById('articleLayerPublicCheckbox');
    if (publicCheckboxReset) publicCheckboxReset.checked = false;

    document.getElementById('draftsManager').style.display = 'none';
    this.currentDraftId = null; // Clear current draft ID

    // Reset to create mode
    document.getElementById('article-form-title').textContent = 'Создать новую статью';
    document.getElementById('saveArticleBtn').textContent = 'Опубликовать';
    document.getElementById('saveArticleBtn').removeAttribute('data-article-id');
  }

  saveDraft() {
    // Check if form is empty before saving
    const title = document.getElementById('articleTitle').value;
    const content = document.getElementById('articleContent').innerHTML;

    // If form is empty, don't save a draft
    if (!title.trim() && !content.trim()) {
      showMessage('Невозможно сохранить черновик: форма пуста', 'warning');
      return;
    }

    try {
      // Get all article data from the form
      const articleData = {
        id: this.currentDraftId || 'draft_' + Date.now(), // Use current draft ID if editing, otherwise generate new ID
        ...this.collectArticleFormData(),
        description: '',
        timestamp: Date.now() // Add timestamp for when draft was saved
      };

      // Get existing drafts or initialize empty array
      const drafts = this.getDraftsFromStorage();

      // Check if we're updating an existing draft
      const existingDraftIndex = drafts.findIndex(draft => draft.id === this.currentDraftId);
      if (existingDraftIndex !== -1) {
        // Update existing draft
        drafts[existingDraftIndex] = articleData;
      } else {
        // Add new draft to the beginning of the array
        drafts.unshift(articleData);
      }

      // Save updated drafts array to localStorage
      localStorage.setItem('articleDrafts', JSON.stringify(drafts));

      // Update currentDraftId to the saved draft's ID
      this.currentDraftId = articleData.id;

      // Пользователь явно сохранил черновик — снимаем возможный флаг
      // подавления автозагрузки от предыдущего "Сбросить" (см.
      // suppressDraftAutoLoad()/checkAndOfferDraft()).
      this.clearDraftAutoLoadSuppression();

      // Show success message
      showMessage('Черновик успешно сохранен в локальное хранилище', 'success');
    } catch (error) {
      console.error('Error saving draft:', error);
      showMessage('Ошибка при сохранении черновика: ' + error.message, 'error');
    }
  }

  // Get drafts from localStorage
  getDraftsFromStorage() {
    try {
      const draftsData = localStorage.getItem('articleDrafts');
      if (draftsData) {
        return JSON.parse(draftsData);
      }
    } catch (error) {
      console.error('Error loading drafts from storage:', error);
    }
    return [];
  }

  // --- Флаг "не предлагать черновик автоматически" — выставляется
  // resetArticle() и снимается любым действием, означающим, что пользователь
  // снова осознанно работает с черновиком (saveDraft(), автосохранение на
  // выход с непустым контентом, ручная loadDraft()). Отдельный ключ в
  // localStorage, а не поле на this — должен пережить закрытие вкладки и
  // повторный заход на страницу, то же самое, ради чего сами черновики
  // лежат в localStorage, а не просто в памяти.
  isDraftAutoLoadSuppressed() {
    return localStorage.getItem('articleDraftAutoLoadSuppressed') === '1';
  }

  suppressDraftAutoLoad() {
    try {
      localStorage.setItem('articleDraftAutoLoadSuppressed', '1');
    } catch (error) {
      console.error('Could not set draft auto-load suppression flag:', error);
    }
  }

  clearDraftAutoLoadSuppression() {
    try {
      localStorage.removeItem('articleDraftAutoLoadSuppressed');
    } catch (error) {
      console.error('Could not clear draft auto-load suppression flag:', error);
    }
  }

  // Load draft from localStorage if it exists
  loadDraft(draftId) {
    try {
      const drafts = this.getDraftsFromStorage();
      const draft = drafts.find(d => d.id === draftId);

      if (draft) {
        // Populate the form with draft data
        document.getElementById('articleTitle').value = draft.title || '';

        // Handle server selection
        if (draft.server) {
          document.getElementById('articleServer').value = draft.server;
        }

        document.getElementById('articleContent').innerHTML = draft.content || '';

        // Handle image
        if (draft.image) {
          document.getElementById('articleImageFile').value = draft.image;

          // Restore cover image preview
          const previewImg = document.getElementById('articleCoverImagePreview');
          const previewContainer = document.getElementById('articleCoverPreview');
          const fileNameElement = document.getElementById('coverFileName');

          if (previewImg) {
            previewImg.src = draft.image;
          }

          if (fileNameElement) {
            // Extract filename from image path for display
            try {
              const imageUrl = new URL(draft.image);
              const pathname = imageUrl.pathname;
              const filename = pathname.split('/').pop();
              if (filename && filename.length > 0) {
                fileNameElement.textContent = filename;
              } else {
                fileNameElement.textContent = 'URL: ' + draft.image.substring(0, 30) + (draft.image.length > 30 ? '...' : '');
              }
            } catch (e) {
              // If it's not a valid URL, just use the string
              fileNameElement.textContent = draft.image.substring(0, 30) + (draft.image.length > 30 ? '...' : '');
            }
          }

          if (previewContainer) {
            previewContainer.style.display = 'flex';
          }
        }

        // Handle locked status
        if (draft.locked !== undefined) {
          document.getElementById('articleLocked').value = draft.locked ? 'true' : 'false';
        }

        // Handle roles — сначала грузим варианты для сервера черновика (чтобы
        // чипы сразу показывали названия, а не ID), потом проставляем значения.
        if (this.rolesField) {
          const roleValues = Array.isArray(draft.roles) ? draft.roles.map(String) : [];
          if (draft.server) {
            this.loadRolesForArticleField(draft.server).then(() => this.rolesField.setValues(roleValues));
          } else {
            this.rolesField.setOptions([]);
            this.rolesField.setValues(roleValues);
          }
        }

        // Handle tags
        if (this.tagsField) this.tagsField.setValues(Array.isArray(draft.tags) ? draft.tags : []);

        // Многослойность — восстанавливаем весь стек слоёв и переключатель
        // (см. layersEnabled/activeLayerIndex в collectArticleFormData), а
        // не только заголовок/текст того одного слоя, что был открыт в
        // момент "Черновик" (раньше остальные слои молча терялись при
        // восстановлении черновика). Черновику доверяем полностью — это не
        // серверная статья, откуда что-то могло не долететь, а то, что сам
        // же пользователь сохранил в этом браузере.
        this.articleLayers = Array.isArray(draft.layers)
          ? draft.layers.map((l) => ({
              roles: Array.isArray(l.roles) ? l.roles : [],
              public: !!l.public,
              title: l.title || '',
              content: l.content || { version: 1, blocks: [] }
            }))
          : [];
        this.activeLayerIndex = Number.isInteger(draft.activeLayerIndex)
          && draft.activeLayerIndex >= 0 && draft.activeLayerIndex < this.articleLayers.length
          ? draft.activeLayerIndex
          : 0;
        this._layersStateKnown = true;
        const layersEnabled = !!draft.layersEnabled && this.articleLayers.length > 0;
        document.getElementById('articleLayersToggle').checked = layersEnabled;
        this.setLayersMode(layersEnabled);

        this.resetArticleAuthorInfo();

        // Set the current draft ID to enable overwriting
        this.currentDraftId = draftId;

        // Пользователь явно загрузил черновик (сам или через checkAndOfferDraft
        // при заходе на страницу) — снимаем возможный флаг подавления
        // автозагрузки, оставшийся от предыдущего "Сбросить".
        this.clearDraftAutoLoadSuppression();

        // Show a message to the user
        const timestamp = new Date(draft.timestamp).toLocaleString();
        showMessage(`Загружен черновик "${draft.title || 'Без названия'}", сохраненный ${timestamp}`, 'info');

        return true;
      }
      return false;
    } catch (error) {
      console.error('Error loading draft:', error);
      showMessage('Ошибка при загрузке черновика', 'error');
      return false;
    }
  }

  // Check for and load draft if form is empty
  checkAndOfferDraft() {
    // Пользователь недавно нажал "Сбросить" — это осознанный выбор начать с
    // чистого листа, а не просто "форма сейчас пустая" (см. requirement
    // "если пользователь нажал сбросить статью... черновик не откроется,
    // даже если пользователь ничего не заполнял"). Флаг снимается сам, как
    // только появится новый реальный черновик (saveDraft()/beforeunload с
    // непустым контентом) или пользователь сам откроет черновик из списка
    // (loadDraft()) — до тех пор автоподстановка молчит.
    if (this.isDraftAutoLoadSuppressed()) return;

    // Check if there's a draft in localStorage
    const drafts = this.getDraftsFromStorage();
    if (drafts && drafts.length > 0) {
      try {
        // Check if the current form is empty
        const title = document.getElementById('articleTitle').value;
        const content = document.getElementById('articleContent').innerHTML;

        // If form is empty or nearly empty, load the most recent draft
        if (!title.trim() && !content.trim()) {
          const latestDraft = drafts[0]; // Most recent draft
          this.loadDraft(latestDraft.id);
        }
      } catch (error) {
        console.error('Error checking draft:', error);
      }
    }
  }

  // Reset article form to empty state
  resetArticle() {
    if (confirm('Вы уверены, что хотите сбросить все данные формы?')) {
      // Clear all form fields
      document.getElementById('articleTitle').value = '';
      document.getElementById('articleContent').innerHTML = '';
      if (this.tagsField) this.tagsField.setValues([]);
      document.getElementById('articleImageFile').value = '';
      document.getElementById('articleImageFileInput').value = '';
      document.getElementById('articleCoverPreview').style.display = 'none';
      document.getElementById('coverFileName').textContent = '';

      // Reset article status and trigger UI update
      const lockedSelect = document.getElementById('articleLocked');
      lockedSelect.value = 'false'; // Reset article status to unlocked (open)
      // Trigger change event to update UI
      const lockedChangeEvent = new Event('change', { bubbles: true });
      lockedSelect.dispatchEvent(lockedChangeEvent);

      // Reset server field and trigger any related UI updates (сбросит и роли —
      // см. обработчик 'change' в setupArticleFormEvents)
      const serverSelect = document.getElementById('articleServer');
      serverSelect.value = ''; // Reset server field to default (empty/"No server")
      const serverChangeEvent = new Event('change', { bubbles: true });
      serverSelect.dispatchEvent(serverChangeEvent);

      this.resetArticleAuthorInfo();

      // Reset form title and save button
      document.getElementById('article-form-title').textContent = 'Создать новую статью';
      document.getElementById('saveArticleBtn').textContent = 'Опубликовать';
      document.getElementById('saveArticleBtn').removeAttribute('data-article-id');

      // Hide drafts manager
      document.getElementById('draftsManager').style.display = 'none';

      // "Сбросить" — осознанный выбор начать заново, а не просто очистка
      // полей: то, что сейчас было в редакторе (свой ли черновик, свежий,
      // или подставленный автозагрузкой при заходе на страницу), не должно
      // ни попасть в черновик само (см. requirement "если пользователь
      // писал статью, а потом нажал сбросить, статья не отправляется в
      // черновик"), ни всплыть заново при следующем заходе на страницу
      // (requirement "черновик не откроется, даже если пользователь ничего
      // не заполнял"). Поэтому удаляем сам сохранённый черновик с этим ID
      // из localStorage — недостаточно было бы просто забыть currentDraftId,
      // запись осталась бы лежать в articleDrafts и её всё равно предложил
      // бы checkAndOfferDraft() при следующем открытии страницы.
      if (this.currentDraftId) {
        try {
          const drafts = this.getDraftsFromStorage().filter((draft) => draft.id !== this.currentDraftId);
          localStorage.setItem('articleDrafts', JSON.stringify(drafts));
        } catch (error) {
          console.error('Could not remove draft on reset:', error);
        }
      }

      // Клавиша подавления автозагрузки — на случай, если в хранилище
      // остался ещё какой-то ДРУГОЙ черновик (не тот, что был открыт сейчас):
      // после явного "Сбросить" его тоже не нужно подсовывать молча.
      this.suppressDraftAutoLoad();

      // Clear current draft ID
      this.currentDraftId = null;

      showMessage('Форма сброшена до пустого состояния', 'info');
    }
  }

  // Display drafts in the drafts manager
  displayDrafts() {
    const draftsList = document.getElementById('draftsList');
    if (!draftsList) return;

    const drafts = this.getDraftsFromStorage();

    if (drafts.length === 0) {
      draftsList.innerHTML = '<div style="color: var(--header-secondary); padding: 10px; text-align: center;">Нет сохраненных черновиков</div>';
      return;
    }

    // Create HTML for each draft
    let draftsHtml = '';
    drafts.forEach((draft, index) => {
      const timestamp = new Date(draft.timestamp).toLocaleString();
      const title = draft.title || 'Без названия';

      draftsHtml += `
        <div class="draft-item" style="display: flex; justify-content: space-between; align-items: center; padding: 8px; border-bottom: 1px solid var(--background-accent);">
          <div style="flex: 1; cursor: pointer;" onclick="spaRouter.loadDraft('${draft.id}')">
            <div style="font-weight: bold; color: var(--text-normal);">${title}</div>
            <div style="font-size: 0.8em; color: var(--header-secondary);">${timestamp}</div>
          </div>
          <button class="btn btn-danger" style="padding: 4px 8px; margin-left: 8px;"
            onclick="spaRouter.deleteDraft('${draft.id}', event)">Удалить</button>
        </div>
      `;
    });

    draftsList.innerHTML = draftsHtml;
  }

  // Delete a specific draft
  deleteDraft(draftId, event) {
    event.stopPropagation(); // Prevent the click from loading the draft

    if (!confirm('Вы уверены, что хотите удалить этот черновик?')) {
      return;
    }

    try {
      let drafts = this.getDraftsFromStorage();
      drafts = drafts.filter(draft => draft.id !== draftId);

      // Save updated drafts array to localStorage
      localStorage.setItem('articleDrafts', JSON.stringify(drafts));

      // Update the display
      this.displayDrafts();
      showMessage('Черновик удален', 'success');
    } catch (error) {
      console.error('Error deleting draft:', error);
      showMessage('Ошибка при удалении черновика', 'error');
    }
  }

  previewArticle() {
    const title = document.getElementById('articleTitle').value;
    const author = document.getElementById('articleAuthorChip')?.textContent || '';
    const content = document.getElementById('articleContent').innerHTML;

    if (!title && !content) {
      showMessage('Пожалуйста, заполните заголовок и содержание статьи', 'error');
      return;
    }

    const previewContent = document.getElementById('previewContent');

    // Build preview content
    let previewHTML = '';

    // Add title
    if (title) {
      previewHTML += `<h1 style="color: #dcddde; margin: 10px 0;">${title}</h1>`;
    }

    // Add author if available
    if (author) {
      previewHTML += `<p style="color: #b9bbbe; margin: 8px 0; font-size: 0.9em;">Автор: ${author}</p>`;
    }

    // Add article preview image if available
    const articleImageValue = document.getElementById('articleImageFile')?.value;
    if (articleImageValue) {
      const imageUrl = this.getImageUrl(articleImageValue);
      if (imageUrl) {
        previewHTML += `<img src="${imageUrl}" alt="Превью статьи" style="max-width: 100%; border-radius: 4px; margin: 10px 0;">`;
      }
    }

    // Add content
    if (content) {
      previewHTML += `<div style="margin-top: 15px;">${content}</div>`;
    }

    previewContent.innerHTML = previewHTML;

    // Show the preview overlay
    const previewOverlay = document.getElementById('articlePreview');
    previewOverlay.classList.add('show');

    // Ensure spoiler functionality works in preview
    setTimeout(() => {
      // Initialize spoiler functionality for the preview content
      const spoilers = previewContent.querySelectorAll('mark[data-type="spoiler"]');
      spoilers.forEach(spoiler => {
        // Remove any existing event listeners to avoid duplicates
        spoiler.onclick = null;
        // Add click functionality to toggle revealed class
        spoiler.addEventListener('click', function(e) {
          e.stopPropagation();
          this.classList.toggle('revealed');
        });
      });
    }, 100); // Small delay to ensure DOM is updated
  }

  closePreview() {
    const previewOverlay = document.getElementById('articlePreview');
    previewOverlay.classList.remove('show');
  }

  // Edit article functionality
  async editArticle(articleId) {
    try {
      const result = await apiClient.getArticle(articleId);
      if (!result.success) {
        showMessage(`Ошибка загрузки статьи: ${result.error}`, 'error');
        return;
      }
      const article = result.data;

      // Иерархия: нижестоящий не правит статьи вышестоящих (сервер всё равно
      // вернёт 403 на сохранение — см. canEditArticle в articles.routes.js).
      if (article.can_edit === false) {
        showMessage('Недостаточно прав для редактирования этой статьи: автор выше вас по иерархии', 'error');
        return;
      }

      // Populate the form with article data
      const titleInput = document.getElementById('articleTitle');
      const serverSelect = document.getElementById('articleServer');
      const lockedSelect = document.getElementById('articleLocked');
      const imageFileInput = document.getElementById('articleImageFile');

      if (titleInput) titleInput.value = article.title || '';

      // API отдаёт уже разрешённое имя сервера (см. formatArticleResponse в
      // articles.routes.js), а не его id — ищем совпадающий по подписи option,
      // чтобы восстановить id для <select> и для подгрузки ролей сервера.
      let serverForRoles = '';
      if (serverSelect) {
        if (article.server) {
          let found = false;
          for (let i = 0; i < serverSelect.options.length; i++) {
            if (serverSelect.options[i].textContent === article.server) {
              serverSelect.value = serverSelect.options[i].value;
              serverForRoles = serverSelect.options[i].value;
              found = true;
              break;
            }
          }
          if (!found) {
            serverSelect.value = article.server;
            serverForRoles = article.server;
          }
        } else {
          serverSelect.value = '';
        }
      }

      if (lockedSelect) lockedSelect.value = article.locked ? 'true' : 'false';

      // Роли — сначала грузим варианты для сервера статьи, и только потом
      // проставляем значения, иначе чипы временно покажут ID вместо названий
      // (см. ChipField._labelFor в chip-field.js).
      if (this.rolesField) {
        if (serverForRoles) {
          await this.loadRolesForArticleField(serverForRoles);
        } else {
          this.rolesField.setOptions([]);
        }
        this.rolesField.setValues((article.roles || []).map(String));
      }

      if (this.tagsField) this.tagsField.setValues(article.tags || []);

      this.renderArticleAuthorInfo(article);

      if (imageFileInput) imageFileInput.value = article.image || '';

      // Show cover preview if image exists
      if (article.image) {
        const previewImg = document.getElementById('articleCoverImagePreview');
        const previewContainer = document.getElementById('articleCoverPreview');
        const fileNameElement = document.getElementById('coverFileName');

        if (previewImg) previewImg.src = article.image;
        // Показываем только имя файла или короткую версию URL
        if (fileNameElement) {
          try {
            const imageUrl = new URL(article.image);
            const pathname = imageUrl.pathname;
            const filename = pathname.split('/').pop();
            fileNameElement.textContent = (filename && filename.length > 0)
              ? filename
              : 'URL: ' + article.image.substring(0, 30) + (article.image.length > 30 ? '...' : '');
          } catch (e) {
            // Если URL некорректный, просто покажем начало строки
            fileNameElement.textContent = 'URL: ' + article.image.substring(0, 30) + (article.image.length > 30 ? '...' : '');
          }
        }
        if (previewContainer) previewContainer.style.display = 'flex';
      }

      // Set content in editor
      const editor = document.getElementById('articleContent');
      if (editor) editor.innerHTML = article.content || '';

      // Многослойность — грузим достоверное состояние слоёв ЭТОЙ статьи
      // отдельным запросом (GET /articles/:id уже отдал только резолвнутый
      // под нас слой, не весь стек). Пока запрос не завершился успешно,
      // collectArticleFormData() не станет трогать layers при сохранении
      // (см. this._layersStateKnown) — так правка статьи, слоёв которой мы
      // не увидели из-за сетевой ошибки, не сотрёт их молча.
      this._layersStateKnown = false;
      try {
        const layersRes = await apiClient.makeAuthenticatedRequest(`/api/articles/${articleId}/layers`);
        if (layersRes.success && layersRes.data) {
          this._layersStateKnown = true;
          const usingLayers = !!layersRes.data.usingLayers;
          this.articleLayers = (layersRes.data.layers || []).map((l) => ({
            roles: Array.isArray(l.roles) ? l.roles : [],
            public: !!l.public,
            title: l.title || '',
            content: l.content || { version: 1, blocks: [] }
          }));
          this.activeLayerIndex = this.articleLayers.length ? this.articleLayers.length - 1 : 0;
          const toggle = document.getElementById('articleLayersToggle');
          if (toggle) toggle.checked = usingLayers;
          this.setLayersMode(usingLayers);
        } else {
          showMessage('Не удалось загрузить слои статьи — сохранение временно заблокирует их изменение', 'warning');
        }
      } catch (e) {
        showMessage('Не удалось загрузить слои статьи — сохранение временно заблокирует их изменение', 'warning');
      }

      // Update form title and save button text
      const formTitle = document.getElementById('article-form-title');
      const saveBtn = document.getElementById('saveArticleBtn');

      if (formTitle) formTitle.textContent = 'Редактировать статью';
      if (saveBtn) {
        saveBtn.textContent = 'Обновить статью';
        saveBtn.setAttribute('data-article-id', articleId);
      }

      // Hide the drafts manager and clear current draft ID when editing an article
      document.getElementById('draftsManager').style.display = 'none';
      this.currentDraftId = null; // Clear current draft ID when editing existing article

      // Scroll to form
      const formContainer = document.querySelector('.form-container');
      if (formContainer) {
        formContainer.scrollIntoView({ behavior: 'smooth' });
      }
    } catch (error) {
      console.error('Error editing article:', error);
      showMessage('Ошибка при загрузке статьи для редактирования', 'error');
    }
  }

  // Additional helper methods...
  getImageUrl(imagePath) {
    if (!imagePath) return null;

    // If it's already a full URL (external image), return as is
    if (imagePath.startsWith('http')) {
      return imagePath;
    }

    // If path already includes /uploads/, form full URL
    if (imagePath.includes('uploads')) {
      if (imagePath.startsWith('/')) {
        return `${window.location.origin}${imagePath}`;
      } else {
        return `${window.location.origin}/${imagePath}`;
      }
    }

    // If it's just a filename or path without /uploads/, add /uploads/
    if (!imagePath.startsWith('/')) {
      return `${window.location.origin}/uploads/${imagePath}`;
    } else {
      // If starts with / but not with /uploads/, add uploads
      if (!imagePath.startsWith('/uploads/')) {
        return `${window.location.origin}/uploads${imagePath}`;
      } else {
        return `${window.location.origin}${imagePath}`;
      }
    }
  }

  // Methods for loading data for articles page
  async loadServersForArticles() {
    try {
      const result = await apiClient.makeAuthenticatedRequest('/api/servers');
      if (result.success) {
        const serverSelect = document.getElementById('articleServer');
        if (serverSelect) {
          const currentServerValue = serverSelect.value;

          // Clear list except first "None" option
          serverSelect.innerHTML = '<option value="">Нет</option>';

          // Add servers from API
          result.data.forEach(server => {
            const option = document.createElement('option');
            option.value = server.id;
            option.textContent = server.name;
            serverSelect.appendChild(option);
          });

          // Restore selected value
          serverSelect.value = currentServerValue;
        }
      } else {
        showMessage(`Ошибка загрузки серверов: ${result.error}`, 'error');
      }
    } catch (error) {
      showMessage(`Неожиданная ошибка загрузки серверов: ${error.message}`, 'error');
    }
  }

  // === Вкладка "Теги" — глобальный список тегов ===

  async initTagsPage() {
    await this.loadTagsList();
    // Поиск по названию — фильтрация на клиенте: список уже целиком загружен.
    document.getElementById('tagsSearchInput')?.addEventListener('input', (e) => {
      this.renderTagsGrid(e.target.value);
    });

    // Модалка "Цвет тега" — тот же паттерн close/cancel/overlay-click, что и
    // у модалок вкладки "Сервера" (см. setupServerFormEvents).
    document.getElementById('tag-color-modal-save-btn')?.addEventListener('click', () => this.saveTagColorModal());
    document.getElementById('tag-color-modal-cancel-btn')?.addEventListener('click', () => this.hideTagColorModal());
    document.getElementById('tag-color-modal-close-btn')?.addEventListener('click', () => this.hideTagColorModal());
    document.getElementById('tag-color-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'tag-color-modal') this.hideTagColorModal();
    });
    document.getElementById('tag-color-modal-picker')?.addEventListener('input', (e) => this.setTagColorModalValue(e.target.value));
    document.getElementById('tag-color-modal-hex')?.addEventListener('input', (e) => this.setTagColorModalValue(e.target.value, { fromHexField: true }));
    document.getElementById('tag-color-modal-hex')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.saveTagColorModal(); }
    });
  }

  async loadTagsList() {
    const loadingEl = document.getElementById('tagsLoading');
    const emptyEl = document.getElementById('tagsEmpty');
    const gridEl = document.getElementById('tagsContainer');
    if (loadingEl) loadingEl.hidden = false;
    if (emptyEl) emptyEl.hidden = true;
    if (gridEl) gridEl.hidden = true;

    try {
      const result = await apiClient.getTags();
      if (result.success) {
        // Дубли исключены уже на сервере (см. collectTags в articles-store.js);
        // повторная свёртка по нижнему регистру здесь — страховка на случай
        // рассинхрона, "строго без дублей" не должно зависеть от одного слоя.
        const seen = new Map();
        (Array.isArray(result.data) ? result.data : []).forEach((item) => {
          const key = String(item.tag).toLowerCase();
          if (!seen.has(key)) seen.set(key, { tag: item.tag, count: item.count || 0, color: item.color || '#5865f2' });
        });
        // Алфавитный порядок — список приходит с сервера в произвольном
        // порядке (см. collectTags в articles-store.js), сортируем на клиенте.
        this.tagsCache = [...seen.values()].sort((a, b) => a.tag.localeCompare(b.tag, 'ru'));
        this.renderTagsGrid(document.getElementById('tagsSearchInput')?.value || '');
      } else {
        if (loadingEl) loadingEl.hidden = true;
        showMessage(`Ошибка загрузки тегов: ${result.error}`, 'error');
      }
    } catch (error) {
      if (loadingEl) loadingEl.hidden = true;
      showMessage(`Неожиданная ошибка загрузки тегов: ${error.message}`, 'error');
    }
  }

  renderTagsGrid(filterText = '') {
    const loadingEl = document.getElementById('tagsLoading');
    const emptyEl = document.getElementById('tagsEmpty');
    const gridEl = document.getElementById('tagsContainer');
    const countEl = document.getElementById('tagsCount');
    if (!gridEl) return;

    const all = this.tagsCache || [];
    const plural = (n, one, few, many) => {
      const m10 = n % 10;
      const m100 = n % 100;
      if (m10 === 1 && m100 !== 11) return one;
      if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
      return many;
    };
    if (countEl) countEl.textContent = all.length === 0 ? '' : `Всего тегов: ${all.length}`;

    if (loadingEl) loadingEl.hidden = true;

    if (all.length === 0) {
      gridEl.hidden = true;
      gridEl.innerHTML = '';
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;

    const q = String(filterText || '').trim().toLowerCase().replace(/^#/, '');
    const filtered = q ? all.filter((t) => t.tag.toLowerCase().includes(q)) : all;

    gridEl.hidden = false;
    if (filtered.length === 0) {
      gridEl.innerHTML = `<div class="tags-no-results">Ничего не найдено по запросу «${this.escapeHtml(filterText)}»</div>`;
      return;
    }

    // Цвет тега — один на тег во всей системе (граф связей красит узлы им же).
    // Плитка = кнопка "показать статьи с тегом" + круглый переключатель цвета,
    // открывающий модалку #tag-color-modal (см. showTagColorModal ниже).
    gridEl.innerHTML = filtered.map((t) => `
      <div class="tag-card" data-tag="${this.escapeHtml(t.tag)}">
        <button type="button" class="tag-card-main" data-open-tag title="Показать статьи с тегом «${this.escapeHtml(t.tag)}»">
          <span class="tag-card-icon" style="background:${t.color}26;color:${t.color}"><i class="fas fa-hashtag"></i></span>
          <span class="tag-card-body">
            <span class="tag-card-name">${this.escapeHtml(t.tag)}</span>
            <span class="tag-card-meta">${t.count} ${plural(t.count, 'статья', 'статьи', 'статей')}</span>
          </span>
        </button>
        <button type="button" class="tag-card-color" data-open-tag-color="${this.escapeHtml(t.tag)}" title="Изменить цвет тега «${this.escapeHtml(t.tag)}»" aria-label="Изменить цвет тега «${this.escapeHtml(t.tag)}»">
          <span class="tag-card-swatch" style="background:${t.color}"></span>
        </button>
      </div>
    `).join('');

    gridEl.querySelectorAll('[data-open-tag]').forEach((btn) => {
      btn.addEventListener('click', () => this.openTagInIbripedia(btn.closest('.tag-card').dataset.tag));
    });
    gridEl.querySelectorAll('[data-open-tag-color]').forEach((btn) => {
      btn.addEventListener('click', () => this.showTagColorModal(btn.dataset.openTagColor));
    });
  }

  paintTagCard(card, color) {
    if (!card) return;
    const icon = card.querySelector('.tag-card-icon');
    if (icon) { icon.style.background = `${color}26`; icon.style.color = color; }
    const swatch = card.querySelector('.tag-card-swatch');
    if (swatch) swatch.style.background = color;
  }

  // Клик по тегу — витрина Ibripedia с уже включённым фильтром по нему.
  async openTagInIbripedia(tag) {
    await this.navigateTo('/ibripedia');
    window.ibripediaManager?.filterByTag(tag);
  }

  // === Модалка "Цвет тега" — тот же .modal-overlay/.modal-box, что у
  // модалок вкладки "Сервера" (см. комментарий в tags.html). Два способа
  // задать цвет, синхронизированные друг с другом: нативный <input
  // type="color"> (основной) и HEX-поле (точное значение), плюс готовые
  // пресеты — та же палитра, что у аватаров серверов (serverAvatarPalette).

  // "#RRGGBB"/"RRGGBB"/"RGB" -> "#rrggbb" в нижнем регистре, null если не хекс.
  normalizeHexColor(value) {
    const v = String(value || '').trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v.toLowerCase()}`;
    if (/^[0-9a-fA-F]{3}$/.test(v)) return `#${v.toLowerCase().split('').map((c) => c + c).join('')}`;
    return null;
  }

  showTagColorModal(tag) {
    const item = (this.tagsCache || []).find((t) => t.tag === tag);
    if (!item) return;
    this._tagColorModalTag = tag;

    document.getElementById('tag-color-modal-name').textContent = `#${item.tag}`;
    this.renderTagColorModalPresets();
    this.setTagColorModalValue(item.color);

    const modal = document.getElementById('tag-color-modal');
    if (modal) modal.hidden = false;
    document.getElementById('tag-color-modal-hex')?.focus();
  }

  hideTagColorModal() {
    const modal = document.getElementById('tag-color-modal');
    if (modal) modal.hidden = true;
    this._tagColorModalTag = null;
  }

  renderTagColorModalPresets() {
    const wrap = document.getElementById('tag-color-modal-presets');
    if (!wrap) return;
    wrap.innerHTML = this.serverAvatarPalette().map((c) =>
      `<button type="button" class="tag-color-modal-preset" data-preset-color="${c}" style="background:${c}" title="${c}" aria-label="${c}"></button>`
    ).join('');
    wrap.querySelectorAll('[data-preset-color]').forEach((btn) => {
      btn.addEventListener('click', () => this.setTagColorModalValue(btn.dataset.presetColor));
    });
  }

  // Общая точка входа для пикера/HEX-поля/пресетов — красит превью и
  // подсвечивает совпавший пресет. fromHexField: true — вызов из СОБСТВЕННОГО
  // input-обработчика HEX-поля: его же value руками не трогаем (иначе на
  // полпути к 6-значному коду normalizeHexColor успевает принять честные 3
  // символа за короткую HEX-запись "#rgb" и подменяет то, что человек ещё
  // печатает, — цвет "портился" посреди набора, см. баг с "#ff8800" на
  // выходе дававший "#ffff88").
  setTagColorModalValue(color, { fromHexField = false } = {}) {
    const normalized = this.normalizeHexColor(color);
    const hexInput = document.getElementById('tag-color-modal-hex');
    const pickerInput = document.getElementById('tag-color-modal-picker');
    const icon = document.getElementById('tag-color-modal-icon');

    if (hexInput) {
      if (!fromHexField) hexInput.value = normalized || color || '';
      hexInput.classList.toggle('invalid', fromHexField && !normalized);
    }
    if (!normalized) return; // невалидный HEX (например, ещё не дописан) — превью/пикер не трогаем
    if (pickerInput) pickerInput.value = normalized;
    if (icon) { icon.style.background = `${normalized}26`; icon.style.color = normalized; }
    document.querySelectorAll('.tag-color-modal-preset').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.presetColor.toLowerCase() === normalized);
    });
  }

  async saveTagColorModal() {
    const tag = this._tagColorModalTag;
    if (!tag) return;
    const hexInput = document.getElementById('tag-color-modal-hex');
    const color = this.normalizeHexColor(hexInput?.value);
    if (!color) {
      hexInput?.classList.add('invalid');
      showMessage('Некорректный HEX-код цвета', 'error');
      return;
    }

    try {
      const result = await apiClient.setTagColor(tag, color);
      if (!result.success) throw new Error(result.data?.error || result.error || 'не удалось сохранить цвет');
      const finalColor = result.data.color || color;
      const item = (this.tagsCache || []).find((t) => t.tag === tag);
      if (item) item.color = finalColor;
      const card = document.getElementById('tagsContainer')?.querySelector(`.tag-card[data-tag="${CSS.escape(tag)}"]`);
      this.paintTagCard(card, finalColor);
      showMessage(`Цвет тега «${tag}» обновлён`, 'success');
      this.hideTagColorModal();
    } catch (error) {
      showMessage(`Ошибка смены цвета: ${error.message}`, 'error');
    }
  }

  // === Server management — каталог + рабочая область открытого сервера ===

  async loadServersDirectory() {
    const loadingEl = document.getElementById('servers-loading');
    const gridEl = document.getElementById('servers-grid');
    const emptyEl = document.getElementById('servers-empty');
    if (loadingEl) loadingEl.hidden = false;
    if (gridEl) gridEl.hidden = true;
    if (emptyEl) emptyEl.hidden = true;

    try {
      const result = await apiClient.getServers();
      if (result.success) {
        this.serversCache = Array.isArray(result.data) ? result.data : [];
        this.renderServersGrid();
      } else {
        showMessage(`Ошибка загрузки серверов: ${this.serverApiError(result)}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка при загрузке серверов: ${error.message}`, 'error');
    } finally {
      if (loadingEl) loadingEl.hidden = true;
    }
  }

  renderServersGrid() {
    const gridEl = document.getElementById('servers-grid');
    const emptyEl = document.getElementById('servers-empty');
    const statsEl = document.getElementById('servers-stats');
    const countEl = document.getElementById('servers-count');
    if (!gridEl) return;

    const query = (document.getElementById('servers-search-input')?.value || '').trim().toLowerCase();
    const sort = document.getElementById('servers-sort-select')?.value || 'created_desc';

    let list = this.serversCache.slice();
    if (query) {
      list = list.filter(s =>
        (s.name || '').toLowerCase().includes(query) ||
        (s.description || '').toLowerCase().includes(query) ||
        (s.owner_username || '').toLowerCase().includes(query)
      );
    }

    list.sort((a, b) => {
      switch (sort) {
        case 'created_asc': return new Date(a.created_at) - new Date(b.created_at);
        case 'name_asc': return (a.name || '').localeCompare(b.name || '', 'ru');
        case 'members_desc': return (b.user_count || 0) - (a.user_count || 0);
        case 'created_desc':
        default: return new Date(b.created_at) - new Date(a.created_at);
      }
    });

    // Сводка — по полному списку (без учёта поиска), чтобы не прыгала при вводе
    if (statsEl) {
      const totalServers = this.serversCache.length;
      const totalMembers = this.serversCache.reduce((sum, s) => sum + (s.user_count || 0), 0);
      statsEl.innerHTML = `
        <span class="servers-stat-chip"><i class="fas fa-server"></i> Серверов: <strong>${totalServers}</strong></span>
        <span class="servers-stat-chip"><i class="fas fa-users"></i> Всего участников: <strong>${totalMembers}</strong></span>
      `;
    }
    if (countEl) {
      countEl.textContent = query ? `Найдено: ${list.length} из ${this.serversCache.length}` : '';
    }

    if (this.serversCache.length === 0) {
      gridEl.hidden = true;
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    gridEl.hidden = false;

    if (list.length === 0) {
      gridEl.innerHTML = `<div class="servers-empty" style="grid-column: 1 / -1;"><i class="fas fa-magnifying-glass"></i><h3>Ничего не найдено</h3><p>Попробуйте другой запрос.</p></div>`;
      return;
    }

    const me = authManager.getUser() || {};
    gridEl.innerHTML = list.map(server => {
      const isOwner = server.owner_id === me.id;
      const canDelete = isOwner || me.is_root;
      return `
        <div class="servers-card" onclick="spaRouter.openServerWorkspace(${server.id})">
          <div class="servers-card-top">
            ${this.serverAvatarHtml(server)}
            <div class="servers-card-title-wrap">
              <h3 class="servers-card-title">${this.escapeHtml(server.name)}</h3>
              <div class="servers-card-owner">${isOwner ? '<span class="servers-card-owner-badge"><i class="fas fa-crown"></i> Вы владелец</span>' : `Владелец: ${this.escapeHtml(server.owner_username || 'N/A')}`}</div>
            </div>
          </div>
          <div class="servers-card-desc">${this.escapeHtml(server.description || 'Без описания')}</div>
          <div class="servers-card-meta">
            <span><i class="fas fa-users"></i> ${server.user_count || 0}</span>
            <span><i class="fas fa-calendar"></i> ${new Date(server.created_at).toLocaleDateString('ru-RU')}</span>
            <span><i class="fas fa-hashtag"></i> ${server.id}</span>
            ${canDelete ? `<button class="server-role-chip-remove servers-card-delete-btn" title="Удалить сервер" onclick="event.stopPropagation(); spaRouter.deleteServer(${server.id})"><i class="fas fa-trash"></i></button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  // Загружает сервер+участников+роли и обновляет и состояние, и шапку
  // рабочей области — общая часть открытия сервера (openServerWorkspace) и
  // обновления уже открытого (refreshServerWorkspace).
  async loadServerWorkspaceData(serverId) {
    const [serverResult, membersResult, rolesResult, channelsResult] = await Promise.all([
      apiClient.getServer(serverId),
      apiClient.getServerUsers(serverId),
      apiClient.getServerRoles(serverId),
      apiClient.getServerChannels(serverId)
    ]);

    if (!serverResult.success) {
      throw new Error(this.serverApiError(serverResult));
    }

    const server = serverResult.data;
    const members = membersResult.success ? membersResult.data : [];
    const roles = rolesResult.success ? rolesResult.data : [];
    const channels = channelsResult.success ? channelsResult.data : [];
    const me = authManager.getUser() || {};

    // "Администратор сервера" — фактическое назначение системной роли admin
    // (см. isAdminOnServer в src/services/server-permissions.js) ЛИБО
    // владелец системы (is_root): на бэкенде root администрирует любой
    // сервер (см. isServerAdmin в src/routes/servers.routes.js), даже не
    // будучи его участником. Другие админ-роли системы (Ведущий и т.п.)
    // такого доступа не получают.
    const myMembership = members.find(m => m.id === me.id);
    const isAdmin = !!me.is_root || !!(myMembership && myMembership.roles && myMembership.roles.some(r => r.name === 'admin' && r.type === 'system'));
    const isOwner = server.owner_id === me.id;

    this.currentServerId = serverId;
    this.currentServerData = { server, members, roles, channels, isAdmin, isOwner, isRoot: !!me.is_root };

    this.applyServerAvatar(document.getElementById('server-workspace-avatar'), server);
    document.getElementById('server-workspace-name').textContent = server.name;
    document.getElementById('server-workspace-description').textContent = server.description || 'Без описания';
    document.getElementById('server-workspace-meta').innerHTML = `
      ${isOwner ? '<span class="servers-card-owner-badge"><i class="fas fa-crown"></i> Вы владелец</span>' : ''}
      <span class="servers-stat-chip"><i class="fas fa-user"></i> Владелец: ${this.escapeHtml(server.owner_username || 'N/A')}</span>
      <span class="servers-stat-chip"><i class="fas fa-users"></i> ${members.length} участников</span>
      <span class="servers-stat-chip"><i class="fas fa-calendar"></i> ${new Date(server.created_at).toLocaleString('ru-RU')}</span>
    `;
  }

  // ВАЖНО: здесь нельзя использовать this.showLoader()/hideLoader() — это
  // не локальный спиннер, а полная замена #app-content на скелетон-заглушку
  // (см. showLoader ниже в файле), рассчитанная на переход между вкладками
  // (сразу вслед за ней всегда идёт appContent.innerHTML = <новый партиал>).
  // Здесь партиал не перезагружается — сервер открывается ВНУТРИ уже
  // загруженной страницы /servers, так что showLoader() стирал разметку
  // рабочей области (#server-workspace-name и т.д.), из-за чего следующая
  // же строка падала с "Cannot set properties of null", а hideLoader()
  // ничего не делает — скелетон оставался висеть на экране навсегда.
  async openServerWorkspace(serverId) {
    document.getElementById('servers-directory').hidden = true;
    document.getElementById('server-workspace').hidden = false;
    document.getElementById('server-workspace-name').textContent = 'Загрузка…';
    document.getElementById('server-workspace-description').textContent = '';
    document.getElementById('server-workspace-meta').innerHTML = '';
    document.getElementById('server-workspace-body').innerHTML = '<p style="color: var(--text-muted); padding: 10px 0;">Загрузка данных сервера…</p>';
    window.scrollTo({ top: 0, behavior: 'smooth' });

    try {
      await this.loadServerWorkspaceData(serverId);
      this.currentServerWorkspaceTab = 'overview';
      document.querySelectorAll('#server-workspace-tabs [data-server-tab]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.serverTab === 'overview');
      });
      this.renderServerWorkspaceTab();
    } catch (error) {
      document.getElementById('server-workspace-name').textContent = 'Не удалось открыть сервер';
      document.getElementById('server-workspace-body').innerHTML = `<div class="server-permission-note"><i class="fas fa-triangle-exclamation"></i> ${this.escapeHtml(error.message)}</div>`;
      showMessage(`Ошибка загрузки сервера: ${error.message}`, 'error');
    }
  }

  closeServerWorkspace() {
    document.getElementById('server-workspace').hidden = true;
    document.getElementById('servers-directory').hidden = false;
    this.currentServerId = null;
    this.currentServerData = null;
    // Число участников на карточках могло измениться, пока сервер был открыт
    this.loadServersDirectory();
  }

  async refreshServerWorkspace() {
    if (!this.currentServerId) return;
    try {
      await this.loadServerWorkspaceData(this.currentServerId);
      this.renderServerWorkspaceTab();
    } catch (error) {
      showMessage(`Ошибка обновления: ${error.message}`, 'error');
    }
  }

  switchServerWorkspaceTab(tab) {
    this.currentServerWorkspaceTab = tab;
    document.querySelectorAll('#server-workspace-tabs [data-server-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.serverTab === tab);
    });
    this.renderServerWorkspaceTab();
  }

  renderServerWorkspaceTab() {
    const body = document.getElementById('server-workspace-body');
    if (!body || !this.currentServerData) return;
    switch (this.currentServerWorkspaceTab) {
      case 'members': body.innerHTML = this.renderServerMembersTab(); break;
      case 'roles': body.innerHTML = this.renderServerRolesTab(); break;
      case 'channels': body.innerHTML = this.renderServerChannelsTab(); break;
      case 'log': this.loadAndRenderAuditLogTab(); break;
      case 'settings': body.innerHTML = this.renderServerSettingsTab(); break;
      case 'overview':
      default: body.innerHTML = this.renderServerOverviewTab(); break;
    }
    body.querySelectorAll('textarea[data-autogrow]').forEach(el => this.autoGrowTextarea(el));
  }

  // --- Вкладка "Журнал" ---
  // В отличие от остальных вкладок, не рендерится синхронно из
  // this.currentServerData — журнал грузится отдельным запросом только когда
  // вкладку реально открыли (незачем тащить его при каждом открытии
  // сервера, если пользователь на неё может ни разу не зайти), и доступен
  // только администраторам сервера (см. GET /servers/:id/audit-log).
  async loadAndRenderAuditLogTab() {
    const body = document.getElementById('server-workspace-body');
    if (!body) return;
    body.innerHTML = '<p style="color: var(--text-muted); padding: 10px 0;">Загрузка журнала…</p>';

    try {
      const result = await apiClient.getServerAuditLog(this.currentServerId);
      // Пока запрос летал, могли уйти с вкладки или со страницы вовсе
      if (this.currentServerWorkspaceTab !== 'log' || !document.getElementById('server-workspace-body')) return;

      if (!result.success) {
        body.innerHTML = `<div class="server-permission-note"><i class="fas fa-circle-info"></i> ${this.escapeHtml(this.serverApiError(result))}</div>`;
        return;
      }
      this.currentAuditLog = Array.isArray(result.data) ? result.data : [];
      body.innerHTML = this.renderServerAuditLogTab();
    } catch (error) {
      if (this.currentServerWorkspaceTab !== 'log') return;
      body.innerHTML = `<div class="server-permission-note"><i class="fas fa-triangle-exclamation"></i> ${this.escapeHtml(error.message)}</div>`;
    }
  }

  auditActionLabel(action) {
    const labels = {
      server_created: 'создал сервер',
      server_updated: 'изменил настройки сервера',
      server_deleted: 'удалил сервер',
      role_created: 'создал роль',
      role_updated: 'изменил роль',
      role_deleted: 'удалил роль',
      member_added: 'добавил участника',
      member_removed: 'удалил участника',
      role_assigned: 'назначил роль',
      role_unassigned: 'снял роль',
      channel_created: 'создал канал',
      channel_updated: 'изменил канал',
      channel_deleted: 'удалил канал',
      owner_changed: 'сменил владельца'
    };
    return labels[action] || action;
  }

  auditDetailsText(action, details) {
    if (!details) return '';
    switch (action) {
      case 'server_created':
      case 'server_updated':
      case 'server_deleted':
      case 'channel_created':
      case 'channel_updated':
      case 'channel_deleted':
      case 'role_created':
      case 'role_updated':
      case 'role_deleted':
        return details.name ? `«${details.name}»` : '';
      case 'member_added':
      case 'member_removed':
        return details.self ? '(сам себя)' : `ID ${details.targetUserId}`;
      case 'role_assigned':
      case 'role_unassigned':
        return `пользователю ID ${details.targetUserId}`;
      case 'owner_changed':
        return details.newOwnerUsername ? `на ${details.newOwnerUsername}` : '';
      default:
        return '';
    }
  }

  renderServerAuditLogTab() {
    const entries = this.currentAuditLog || [];

    const rows = entries.length === 0
      ? `<tr class="server-empty-row"><td colspan="3">Журнал пуст — действия на сервере появятся здесь</td></tr>`
      : entries.map(entry => `
          <tr>
            <td data-label="Когда" style="white-space: nowrap; color: var(--text-muted); font-size: 12px;">${new Date(entry.created_at).toLocaleString('ru-RU')}</td>
            <td data-label="Кто" class="cell-primary"><strong>${this.escapeHtml(entry.actor_username || `ID ${entry.actor_id}`)}</strong></td>
            <td data-label="Действие">${this.escapeHtml(this.auditActionLabel(entry.action))} ${this.escapeHtml(this.auditDetailsText(entry.action, entry.details))}</td>
          </tr>
        `).join('');

    return `
      <div class="server-section-toolbar">
        <h3 class="server-section-title">Журнал действий (${entries.length})</h3>
      </div>
      <div class="table-container table-cards table-cards-list">
        <table>
          <thead><tr><th>Когда</th><th>Кто</th><th>Действие</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  // --- Вкладка "Обзор" ---
  renderServerOverviewTab() {
    const { members, roles, channels } = this.currentServerData;
    const customRoles = roles.filter(r => r.role_type === 'custom').length;
    const admins = members.filter(m => m.roles && m.roles.some(r => r.name === 'admin' && r.type === 'system')).length;
    return `
      <div class="server-stats-grid">
        <div class="server-stat-tile"><div class="server-stat-tile-value">${members.length}</div><div class="server-stat-tile-label">Участников</div></div>
        <div class="server-stat-tile"><div class="server-stat-tile-value">${roles.length}</div><div class="server-stat-tile-label">Ролей (${customRoles} своих)</div></div>
        <div class="server-stat-tile"><div class="server-stat-tile-value">${channels.length}</div><div class="server-stat-tile-label">Каналов</div></div>
        <div class="server-stat-tile"><div class="server-stat-tile-value">${admins}</div><div class="server-stat-tile-label">Администраторов</div></div>
      </div>
      <p style="color: var(--text-muted); font-size: 13px; line-height: 1.5; margin: 0;">
        Роли этого сервера используются в редакторе статей: поле «Доступ для» ограничивает закрытую статью выбранными ролями именно этого сервера.
      </p>
    `;
  }

  // --- Вкладка "Участники" ---
  renderServerMembersTab() {
    const { server, members, isAdmin } = this.currentServerData;
    const me = authManager.getUser() || {};
    const amMember = members.some(m => m.id === me.id);

    const rows = members.length === 0
      ? `<tr class="server-empty-row"><td colspan="4">Нет участников</td></tr>`
      : members.map(member => {
          const isMemberOwner = member.id === server.owner_id;
          const isSelf = member.id === me.id;
          const rolesHtml = (member.roles && member.roles.length > 0)
            ? member.roles.map(role => `
                <span class="server-role-chip" style="background: ${role.type === 'system' ? '#5865f2' : '#eb459e'};">
                  ${this.escapeHtml(role.name)}
                  ${isAdmin ? `<button class="server-role-chip-remove" title="Снять роль" onclick="spaRouter.removeMemberRole(${member.id}, ${role.id})"><i class="fas fa-xmark"></i></button>` : ''}
                </span>
              `).join('')
            : '<span style="color: var(--text-muted); font-size: 12px;">Нет ролей</span>';

          let actions = '<span style="color: var(--text-muted); font-size: 12px;">Владелец</span>';
          if (!isMemberOwner && isAdmin) {
            actions = `
              <button class="btn btn-secondary btn-sm" onclick="spaRouter.showServerAssignRoleModal(${member.id})">Роль</button>
              <button class="btn btn-danger btn-sm" onclick="spaRouter.removeMember(${member.id})">Удалить</button>
            `;
          } else if (!isMemberOwner && isSelf) {
            actions = `<button class="btn btn-danger btn-sm" onclick="spaRouter.removeMember(${member.id})">Покинуть</button>`;
          }

          return `
            <tr>
              <td data-label="ID">${member.id}</td>
              <td data-label="Пользователь" class="cell-primary"><strong>${this.escapeHtml(member.display_name)}</strong>${isSelf ? ' <span style="color: var(--text-muted); font-size: 11px;">(вы)</span>' : ''}</td>
              <td data-label="Роли"><div class="cell-chips">${rolesHtml}</div></td>
              <td data-label="Действия" class="cell-actions">${actions}</td>
            </tr>
          `;
        }).join('');

    return `
      ${!isAdmin ? `<div class="server-permission-note"><i class="fas fa-circle-info"></i> Добавлять участников, назначать и снимать роли может только администратор этого сервера — вы видите список в режиме просмотра.</div>` : ''}
      <div class="server-section-toolbar">
        <h3 class="server-section-title">Участники (${members.length})</h3>
        <div class="btn-group">
          ${isAdmin ? `<button class="btn btn-primary btn-sm" onclick="spaRouter.showAddMemberModal()"><i class="fas fa-user-plus"></i> Добавить по ID</button>` : ''}
          ${!amMember ? `<button class="btn btn-success btn-sm" onclick="spaRouter.joinCurrentServer()"><i class="fas fa-right-to-bracket"></i> Вступить</button>` : ''}
        </div>
      </div>
      <div class="table-container table-cards">
        <table>
          <thead><tr><th>ID</th><th>Пользователь</th><th>Роли</th><th>Действия</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  async joinCurrentServer() {
    const me = authManager.getUser() || {};
    if (!me.id || !this.currentServerId) return;
    try {
      const result = await apiClient.addServerUser(this.currentServerId, me.id);
      if (result.success) {
        showMessage('Вы вступили в сервер', 'success');
        await this.refreshServerWorkspace();
      } else {
        showMessage(`Не удалось вступить: ${this.serverApiError(result)}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  showAddMemberModal() {
    document.getElementById('new-member-id').value = '';
    document.getElementById('add-member-search').value = '';
    this.hideAddMemberSearchDropdown();
    document.getElementById('add-member-modal').hidden = false;
    document.getElementById('add-member-search')?.focus();
  }
  hideAddMemberModal() {
    document.getElementById('add-member-modal').hidden = true;
  }

  // Поиск пользователя по имени (см. GET /api/users/search) — сначала
  // пробуем найти по имени, ручной ввод ID остаётся резервным вариантом на
  // случай, если поиск ничего не нашёл (например, для ещё не подтверждённых
  // пользователей — поиск ищет только среди approved).
  hideAddMemberSearchDropdown() {
    const dropdown = document.getElementById('add-member-search-dropdown');
    if (dropdown) { dropdown.hidden = true; dropdown.innerHTML = ''; }
  }
  async runAddMemberSearch() {
    const query = document.getElementById('add-member-search')?.value.trim() || '';
    const dropdown = document.getElementById('add-member-search-dropdown');
    if (!dropdown) return;

    if (!query) {
      this.hideAddMemberSearchDropdown();
      return;
    }

    try {
      const result = await apiClient.searchUsers(query);
      const users = result.success && Array.isArray(result.data) ? result.data : [];

      if (users.length === 0) {
        dropdown.innerHTML = `<div class="chip-field-dropdown-empty">Никого не найдено</div>`;
      } else {
        dropdown.innerHTML = users.map(u => `
          <div class="chip-field-dropdown-item" data-user-id="${u.id}" data-username="${this.escapeHtml(u.display_name)}">${this.escapeHtml(u.display_name)} <span style="color: var(--text-muted);">(ID ${u.id})</span></div>
        `).join('');
        dropdown.querySelectorAll('[data-user-id]').forEach(item => {
          item.addEventListener('click', () => {
            document.getElementById('new-member-id').value = item.dataset.userId;
            document.getElementById('add-member-search').value = item.dataset.username;
            this.hideAddMemberSearchDropdown();
          });
        });
      }
      dropdown.hidden = false;
    } catch (error) {
      this.hideAddMemberSearchDropdown();
    }
  }

  async confirmAddMember() {
    const userId = document.getElementById('new-member-id').value.trim();
    if (!userId) {
      showMessage('Введите ID пользователя', 'error');
      return;
    }
    try {
      const result = await apiClient.addServerUser(this.currentServerId, userId);
      if (result.success) {
        showMessage('Пользователь добавлен', 'success');
        this.hideAddMemberModal();
        await this.refreshServerWorkspace();
      } else {
        showMessage(`Ошибка добавления: ${this.serverApiError(result)}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  async removeMember(userId) {
    const member = (this.currentServerData?.members || []).find(m => m.id === userId);
    const label = member ? member.display_name : `ID ${userId}`;
    const isSelf = (authManager.getUser() || {}).id === userId;
    if (!confirm(isSelf ? 'Покинуть этот сервер?' : `Удалить участника «${label}» с сервера?`)) return;

    try {
      const result = await apiClient.removeServerUser(this.currentServerId, userId);
      if (result.success) {
        showMessage(isSelf ? 'Вы покинули сервер' : 'Участник удалён', 'success');
        await this.refreshServerWorkspace();
      } else {
        showMessage(`Ошибка удаления: ${this.serverApiError(result)}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  // Названы с префиксом Server — SPARouter.prototype.showAssignRoleModal/
  // confirmAssignRole (без префикса) уже заняты каталогом АДМИНСКИХ ролей
  // (вкладка "Пользователи", см. ниже в этом файле) — при совпадении имени
  // метода в прототипе остаётся только объявленный позже, так что без
  // переименования кнопка "Роль" здесь тянула бы за собой чужую модалку
  // (#assign-role-modal из views/users-list.html), которой нет в DOM на
  // странице /servers.
  showServerAssignRoleModal(userId) {
    const member = (this.currentServerData?.members || []).find(m => m.id === userId);
    this.assignRoleTargetUserId = userId;
    document.getElementById('server-assign-role-target-hint').textContent = member ? `Пользователь: ${member.display_name} (ID ${userId})` : `ID пользователя: ${userId}`;

    const roles = this.currentServerData?.roles || [];
    const select = document.getElementById('server-assign-role-select');
    select.innerHTML = roles.map(r => `<option value="${r.id}">${this.escapeHtml(r.name)} (уровень ${r.hierarchy_level}${r.role_type === 'system' ? ', системная' : ''})</option>`).join('');
    document.getElementById('server-assign-role-modal').hidden = false;
  }
  hideServerAssignRoleModal() {
    document.getElementById('server-assign-role-modal').hidden = true;
    this.assignRoleTargetUserId = null;
  }
  async confirmServerAssignRole() {
    const roleId = document.getElementById('server-assign-role-select').value;
    if (!roleId || !this.assignRoleTargetUserId) return;
    try {
      const result = await apiClient.assignRoleToUser(this.currentServerId, this.assignRoleTargetUserId, roleId);
      if (result.success) {
        showMessage('Роль назначена', 'success');
        this.hideServerAssignRoleModal();
        await this.refreshServerWorkspace();
      } else {
        showMessage(`Ошибка назначения роли: ${this.serverApiError(result)}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  async removeMemberRole(userId, roleId) {
    try {
      const result = await apiClient.removeRoleFromUser(this.currentServerId, userId, roleId);
      if (result.success) {
        showMessage('Роль снята', 'success');
        await this.refreshServerWorkspace();
      } else {
        showMessage(`Ошибка: ${this.serverApiError(result)}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  // --- Вкладка "Роли" ---
  renderServerRolesTab() {
    const { roles, isAdmin } = this.currentServerData;
    const permLabels = {
      read_messages: 'Чтение сообщений',
      send_messages: 'Отправка сообщений',
      manage_channels: 'Управление каналами',
      manage_roles: 'Управление ролями',
      ban_users: 'Блокировка пользователей'
    };

    const rows = roles.length === 0 ? `<tr class="server-empty-row"><td colspan="5">Нет ролей</td></tr>` : roles.map(role => {
      const permsText = Object.entries(permLabels)
        .filter(([key]) => role.permissions && role.permissions[key])
        .map(([, label]) => label)
        .join(', ') || '—';

      const typeText = role.role_type === 'system' ? 'Системная' : 'Пользовательская';
      const typeColor = role.role_type === 'system' ? '#5865f2' : '#eb459e';

      let actions = '<span style="color: var(--text-muted); font-size: 12px;">Нельзя изменить</span>';
      if (role.role_type === 'custom' && isAdmin) {
        actions = `
          <button class="btn btn-secondary btn-sm" onclick="spaRouter.showServerRoleEditorModal(${role.id})">Изменить</button>
          <button class="btn btn-danger btn-sm" onclick="spaRouter.deleteServerRole(${role.id})">Удалить</button>
        `;
      }

      return `
        <tr>
          <td data-label="Название" class="cell-primary"><strong>${this.escapeHtml(role.name)}</strong></td>
          <td data-label="Тип"><span class="role-tag" style="background: ${typeColor};">${typeText}</span></td>
          <td data-label="Уровень">${role.hierarchy_level}</td>
          <td data-label="Права" style="font-size: 12px; color: var(--text-muted);">${permsText}</td>
          <td data-label="Действия" class="cell-actions">${actions}</td>
        </tr>
      `;
    }).join('');

    return `
      ${!isAdmin ? `<div class="server-permission-note"><i class="fas fa-circle-info"></i> Создавать и изменять роли может только администратор этого сервера.</div>` : ''}
      <div class="server-section-toolbar">
        <h3 class="server-section-title">Роли (${roles.length})</h3>
        ${isAdmin ? `<button class="btn btn-primary btn-sm" onclick="spaRouter.showServerRoleEditorModal()"><i class="fas fa-plus"></i> Создать роль</button>` : ''}
      </div>
      <div class="table-container table-cards">
        <table>
          <thead><tr><th>Название</th><th>Тип</th><th>Уровень</th><th>Права</th><th>Действия</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  // Названы с префиксом Server — то же обоснование, что и у
  // showServerAssignRoleModal выше: showRoleEditorModal/saveRoleEditor без
  // префикса уже заняты каталогом административных ролей.
  showServerRoleEditorModal(roleId) {
    const role = roleId ? (this.currentServerData?.roles || []).find(r => r.id === roleId) : null;
    this.roleEditorEditingId = role ? role.id : null;
    document.getElementById('server-role-editor-title').textContent = role ? 'Изменить роль' : 'Создать роль';
    document.getElementById('server-role-editor-name').value = role ? role.name : '';
    document.getElementById('server-role-editor-hierarchy').value = role ? role.hierarchy_level : 0;
    const perms = (role && role.permissions) || {};
    ['read_messages', 'send_messages', 'manage_channels', 'manage_roles', 'ban_users'].forEach(key => {
      const el = document.getElementById(`server-role-editor-perm-${key}`);
      if (el) el.checked = !!perms[key];
    });
    document.getElementById('server-role-editor-modal').hidden = false;
  }
  hideServerRoleEditorModal() {
    document.getElementById('server-role-editor-modal').hidden = true;
    this.roleEditorEditingId = null;
  }
  async saveServerRoleEditor() {
    const name = document.getElementById('server-role-editor-name').value.trim();
    const hierarchy_level = parseInt(document.getElementById('server-role-editor-hierarchy').value, 10) || 0;
    if (!name) {
      showMessage('Название роли обязательно', 'error');
      return;
    }
    const permissions = {};
    ['read_messages', 'send_messages', 'manage_channels', 'manage_roles', 'ban_users'].forEach(key => {
      permissions[key] = !!document.getElementById(`server-role-editor-perm-${key}`)?.checked;
    });

    try {
      const result = this.roleEditorEditingId
        ? await apiClient.updateServerRole(this.currentServerId, this.roleEditorEditingId, { name, hierarchy_level, permissions })
        : await apiClient.createServerRole(this.currentServerId, { name, hierarchy_level, permissions });

      if (result.success) {
        showMessage(this.roleEditorEditingId ? 'Роль обновлена' : 'Роль создана', 'success');
        this.hideServerRoleEditorModal();
        await this.refreshServerWorkspace();
      } else {
        showMessage(`Ошибка сохранения роли: ${this.serverApiError(result)}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  // Переименован из deleteRole(serverId, roleId) — то же имя метода уже
  // занято каталогом административных ролей (SPARouter.prototype.deleteRole
  // ниже в этом файле, вкладка "Пользователи"): при одинаковом имени в
  // прототипе остаётся только объявленный позже, поэтому кнопка "Удалить"
  // у пользовательской роли сервера на самом деле вызывала DELETE
  // /api/admin-roles/:id с параметрами (serverId, roleName) вместо DELETE
  // /api/servers/:serverId/roles/:roleId — здесь эта путаница устранена.
  async deleteServerRole(roleId) {
    const role = (this.currentServerData?.roles || []).find(r => r.id === roleId);
    const roleName = role ? role.name : `#${roleId}`;
    if (!confirm(`Удалить роль «${roleName}»? Действие необратимо.`)) return;

    try {
      const result = await apiClient.deleteServerRole(this.currentServerId, roleId);
      if (result.success) {
        showMessage('Роль удалена', 'success');
        await this.refreshServerWorkspace();
      } else {
        showMessage(`Ошибка удаления роли: ${this.serverApiError(result)}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  // --- Вкладка "Каналы" ---
  // Таблица server_channels и её каскадное удаление вместе с сервером
  // существовали и раньше (см. deleteServer в server-system-logic.js), но
  // без единого маршрута/UI — управлять каналами было нечем. Сами
  // сообщения внутри канала (server_messages) в этой панели не выводятся —
  // канал здесь только именует раздел, честно об этом сказано в модалке.
  renderServerChannelsTab() {
    const { channels, isAdmin } = this.currentServerData;
    const typeIcon = (t) => t === 'voice' ? 'fa-volume-high' : 'fa-hashtag';
    const typeLabel = (t) => t === 'voice' ? 'Голосовой' : 'Текстовый';

    const rows = channels.length === 0 ? `<tr class="server-empty-row"><td colspan="4">Нет каналов</td></tr>` : channels.map(channel => `
      <tr>
        <td data-label="Название" class="cell-primary"><i class="fas ${typeIcon(channel.channel_type)}" style="color: var(--text-muted); margin-right: 6px;"></i><strong>${this.escapeHtml(channel.name)}</strong></td>
        <td data-label="Тип">${typeLabel(channel.channel_type)}</td>
        <td data-label="Описание" style="color: var(--text-muted); font-size: 13px;">${this.escapeHtml(channel.description || '—')}</td>
        <td data-label="Действия" class="cell-actions">
          ${isAdmin ? `
            <button class="btn btn-secondary btn-sm" onclick="spaRouter.showChannelEditorModal(${channel.id})">Изменить</button>
            <button class="btn btn-danger btn-sm" onclick="spaRouter.deleteServerChannel(${channel.id})">Удалить</button>
          ` : '<span style="color: var(--text-muted); font-size: 12px;">—</span>'}
        </td>
      </tr>
    `).join('');

    return `
      ${!isAdmin ? `<div class="server-permission-note"><i class="fas fa-circle-info"></i> Создавать и изменять каналы может только администратор этого сервера.</div>` : ''}
      <div class="server-section-toolbar">
        <h3 class="server-section-title">Каналы (${channels.length})</h3>
        ${isAdmin ? `<button class="btn btn-primary btn-sm" onclick="spaRouter.showChannelEditorModal()"><i class="fas fa-plus"></i> Создать канал</button>` : ''}
      </div>
      <div class="table-container table-cards">
        <table>
          <thead><tr><th>Название</th><th>Тип</th><th>Описание</th><th>Действия</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  showChannelEditorModal(channelId) {
    const channel = channelId ? (this.currentServerData?.channels || []).find(c => c.id === channelId) : null;
    this.channelEditorEditingId = channel ? channel.id : null;
    document.getElementById('channel-editor-title').textContent = channel ? 'Изменить канал' : 'Создать канал';
    document.getElementById('channel-editor-name').value = channel ? channel.name : '';
    document.getElementById('channel-editor-type').value = channel ? channel.channel_type : 'text';
    document.getElementById('channel-editor-description').value = channel ? (channel.description || '') : '';
    document.getElementById('channel-editor-modal').hidden = false;
  }
  hideChannelEditorModal() {
    document.getElementById('channel-editor-modal').hidden = true;
    this.channelEditorEditingId = null;
  }
  async saveChannelEditor() {
    const name = document.getElementById('channel-editor-name').value.trim();
    const channel_type = document.getElementById('channel-editor-type').value;
    const description = document.getElementById('channel-editor-description').value.trim();
    if (!name) {
      showMessage('Название канала обязательно', 'error');
      return;
    }

    try {
      const result = this.channelEditorEditingId
        ? await apiClient.updateServerChannel(this.currentServerId, this.channelEditorEditingId, { name, channel_type, description })
        : await apiClient.createServerChannel(this.currentServerId, { name, channel_type, description });

      if (result.success) {
        showMessage(this.channelEditorEditingId ? 'Канал обновлён' : 'Канал создан', 'success');
        this.hideChannelEditorModal();
        await this.refreshServerWorkspace();
      } else {
        showMessage(`Ошибка сохранения канала: ${this.serverApiError(result)}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  async deleteServerChannel(channelId) {
    const channel = (this.currentServerData?.channels || []).find(c => c.id === channelId);
    if (!confirm(`Удалить канал «${channel ? channel.name : '#' + channelId}»?`)) return;

    try {
      const result = await apiClient.deleteServerChannel(this.currentServerId, channelId);
      if (result.success) {
        showMessage('Канал удалён', 'success');
        await this.refreshServerWorkspace();
      } else {
        showMessage(`Ошибка удаления канала: ${this.serverApiError(result)}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  // --- Вкладка "Настройки" ---
  renderServerSettingsTab() {
    const { server, isOwner, isRoot } = this.currentServerData;
    const canEdit = isOwner || isRoot; // PUT /servers/:id — владелец сервера или root (см. бэкенд)
    const canDelete = isOwner || isRoot; // DELETE /servers/:id — владелец или root

    return `
      <div class="server-settings">
      ${!canEdit ? `<div class="server-permission-note"><i class="fas fa-circle-info"></i> Изменять настройки сервера может только его владелец.</div>` : ''}
      <div class="form-group" style="margin-bottom: 18px;">
        <label class="form-label" for="server-settings-name">Название сервера</label>
        <input type="text" id="server-settings-name" class="form-input" value="${this.escapeHtml(server.name)}" maxlength="100" ${canEdit ? '' : 'disabled'}>
      </div>
      <div class="form-group" style="margin-bottom: 18px;">
        <label class="form-label" for="server-settings-description">Описание</label>
        <textarea id="server-settings-description" class="form-input server-settings-textarea" rows="3" maxlength="500" data-autogrow oninput="spaRouter.autoGrowTextarea(this)" ${canEdit ? '' : 'disabled'}>${this.escapeHtml(server.description || '')}</textarea>
      </div>
      ${canEdit ? `<div class="server-settings-actions"><button class="btn btn-primary" onclick="spaRouter.saveServerSettings()"><i class="fas fa-floppy-disk"></i> Сохранить изменения</button></div>` : ''}

      ${isRoot ? `
        <div style="margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--background-accent);">
          <h4 class="server-section-title" style="margin-bottom: 10px;">Владение</h4>
          <p style="color: var(--text-muted); font-size: 13px; margin: 0 0 10px;">Доступно только владельцу системы.</p>
          <div class="server-settings-actions"><button class="btn btn-secondary btn-sm" onclick="spaRouter.showChangeOwnerModal()"><i class="fas fa-user-shield"></i> Передать другому пользователю</button></div>
        </div>
      ` : ''}

      ${canDelete ? `
        <div class="server-danger-zone">
          <h4>Опасная зона</h4>
          <p>Удаление сервера безвозвратно сотрёт его роли, участников и каналы.</p>
          <button class="btn btn-danger" onclick="spaRouter.deleteServer(${server.id}, true)"><i class="fas fa-trash"></i> Удалить сервер</button>
        </div>
      ` : ''}
      </div>
    `;
  }

  // Подгоняет высоту textarea под текст — на мобильном у textarea нет
  // ручки resize, и описание сервера (до 500 символов) приходилось листать
  // внутри трёх строк. Вызывается на input и после рендера вкладки.
  autoGrowTextarea(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }

  async saveServerSettings() {
    const name = document.getElementById('server-settings-name').value.trim();
    const description = document.getElementById('server-settings-description').value.trim();
    if (!name) {
      showMessage('Название сервера обязательно', 'error');
      return;
    }
    try {
      const result = await apiClient.updateServer(this.currentServerId, { name, description });
      if (result.success) {
        showMessage('Сервер обновлён', 'success');
        await this.refreshServerWorkspace();
      } else {
        showMessage(`Ошибка обновления: ${this.serverApiError(result)}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  async deleteServer(serverId, fromWorkspace = false) {
    if (!confirm('Вы уверены, что хотите удалить этот сервер? Это действие нельзя отменить!')) return;

    try {
      const result = await apiClient.deleteServer(serverId);
      if (result.success) {
        showMessage('Сервер удалён', 'success');
        if (fromWorkspace) {
          this.closeServerWorkspace(); // само перезагрузит каталог
        } else {
          await this.loadServersDirectory();
        }
      } else {
        showMessage(`Ошибка удаления: ${this.serverApiError(result)}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  // --- Смена владельца сервера (root only) ---
  async showChangeOwnerModal() {
    try {
      const result = await apiClient.getAllUsersForOwnerTransfer();
      // GET /api/users (root only) сам оборачивает ответ в {success, data},
      // а makeAuthenticatedRequest оборачивает его ещё раз — поэтому список
      // пользователей лежит в result.data.data, а не в result.data.
      const users = (result.success && result.data && Array.isArray(result.data.data)) ? result.data.data : [];
      const select = document.getElementById('change-owner-select');
      select.innerHTML = users.map(u => `<option value="${u.id}">${this.escapeHtml(u.display_name || u.username)} (ID ${u.id})</option>`).join('');
      document.getElementById('change-owner-modal').hidden = false;
    } catch (error) {
      showMessage(`Ошибка загрузки пользователей: ${error.message}`, 'error');
    }
  }
  hideChangeOwnerModal() {
    document.getElementById('change-owner-modal').hidden = true;
  }
  async confirmChangeOwner() {
    const newOwnerId = document.getElementById('change-owner-select').value;
    if (!newOwnerId) return;
    try {
      const result = await apiClient.changeServerOwner(this.currentServerId, parseInt(newOwnerId, 10));
      if (result.success) {
        showMessage('Владелец сервера изменён', 'success');
        this.hideChangeOwnerModal();
        await this.refreshServerWorkspace();
      } else {
        showMessage(`Ошибка: ${this.serverApiError(result)}`, 'error');
      }
    } catch (error) {
      showMessage(`Ошибка: ${error.message}`, 'error');
    }
  }

  // Helper method to escape HTML
  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Settings methods — сохраняются на сервере (GET/PUT /api/system-settings,
  // доступны только владельцу), а не в localStorage: раньше "Настройки" были
  // просто заглушкой, ничего не менявшей на сервере ни для кого, кроме
  // браузера того, кто их открыл.
  async saveSettings() {
    const settings = {
      maxFileSize: document.getElementById('maxFileSize')?.value,
      allowRegistration: document.getElementById('allowRegistration')?.checked,
      sessionDurationHours: document.getElementById('sessionDurationHours')?.value
    };

    try {
      const res = await fetch('/api/system-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка сохранения настроек');
      showMessage('Настройки успешно сохранены!', 'success');
    } catch (error) {
      showMessage(`Ошибка сохранения настроек: ${error.message}`, 'error');
    }
  }

  // Режим техобслуживания — отдельная кнопка/запрос, а не часть общего
  // autoSaveInputs: включение затрагивает вообще всех остальных пользователей
  // сайта немедленно, такое действие не должно срабатывать тихо по дебаунсу
  // от одного клика по чекбоксу — только явным сохранением, с подтверждением
  // при включении.
  async saveMaintenanceSettings() {
    const maintenanceMode = document.getElementById('maintenanceMode')?.checked;
    const maintenanceMessage = document.getElementById('maintenanceMessage')?.value;

    if (maintenanceMode && !confirm('Включить режим техобслуживания?\n\nВсе, кроме вас, немедленно потеряют доступ к сайту (увидят это сообщение вместо панели).')) {
      return;
    }

    try {
      const res = await fetch('/api/system-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maintenanceMode, maintenanceMessage })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка сохранения');
      showMessage(maintenanceMode ? 'Режим техобслуживания включён' : 'Режим техобслуживания выключен', maintenanceMode ? 'error' : 'success');
    } catch (error) {
      showMessage(`Ошибка сохранения: ${error.message}`, 'error');
    }
  }

  async resetSettings() {
    if (!confirm('Вы уверены, что хотите сбросить все настройки к значениям по умолчанию?')) return;

    try {
      const res = await fetch('/api/system-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxFileSize: 5,
          allowRegistration: true,
          sessionDurationHours: 8,
          maintenanceMode: false,
          maintenanceMessage: 'Сайт временно на техническом обслуживании. Загляните чуть позже.'
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка сброса настроек');
      await this.initSettingsForm();
      showMessage('Настройки сброшены к значениям по умолчанию!', 'success');
    } catch (error) {
      showMessage(`Ошибка сброса настроек: ${error.message}`, 'error');
    }
  }

  // Initialize settings form with values loaded from the server
  async initSettingsForm() {
    try {
      const res = await fetch('/api/system-settings');
      if (!res.ok) throw new Error('Не удалось загрузить настройки');
      const data = await res.json();
      const settings = data.settings || {};

      if (settings.maxFileSize != null) document.getElementById('maxFileSize').value = settings.maxFileSize;
      if (settings.allowRegistration !== undefined) document.getElementById('allowRegistration').checked = settings.allowRegistration;
      if (settings.sessionDurationHours != null) document.getElementById('sessionDurationHours').value = settings.sessionDurationHours;
      if (settings.maintenanceMode !== undefined) document.getElementById('maintenanceMode').checked = settings.maintenanceMode;
      if (settings.maintenanceMessage != null) document.getElementById('maintenanceMessage').value = settings.maintenanceMessage;
    } catch (error) {
      showMessage(`Ошибка загрузки настроек: ${error.message}`, 'error');
    }
  }

  // Set up settings form events with auto-save
  async setupSettingsFormEvents() {
    // Initialize form with values from the server
    await this.initSettingsForm();

    // Set up auto-save for simple settings
    const autoSaveInputs = ['maxFileSize', 'allowRegistration', 'sessionDurationHours'];

    autoSaveInputs.forEach(inputId => {
      const element = document.getElementById(inputId);
      if (element) {
        // For checkboxes, listen to change event
        if (element.type === 'checkbox') {
          element.addEventListener('change', debounce(() => {
            this.saveSettings();
          }, 500));
        } else {
          // For other inputs, use input event with debounce
          element.addEventListener('input', debounce(() => {
            this.saveSettings();
          }, 1000)); // Wait 1 second after user stops typing
        }
      }
    });

    // Explicit save button
    document.getElementById('save-settings-btn')?.addEventListener('click', () => this.saveSettings());
    document.getElementById('reset-settings-btn')?.addEventListener('click', () => this.resetSettings());
    document.getElementById('save-maintenance-settings-btn')?.addEventListener('click', () => this.saveMaintenanceSettings());
  }

  // Dashboard stats with real data and weekly activity
  async loadDashboardStats() {
    try {
      // Load articles count and recent articles
      const articlesResult = await apiClient.getArticles();
      let articlesData = [];
      if (articlesResult.success) {
        const totalArticles = document.getElementById('total-articles');
        if (totalArticles) totalArticles.textContent = articlesResult.data.length;
        articlesData = articlesResult.data;
        this.renderTrendBadge('trend-articles', this.countToday(articlesData));
      } else {
        console.error('Error loading articles count:', articlesResult.error);
      }

      // Load servers count
      let serversData = [];
      try {
        const serversResult = await apiClient.makeAuthenticatedRequest('/api/servers');
        if (serversResult.success) {
          serversData = serversResult.data;
          const totalServers = document.getElementById('total-servers');
          if (totalServers) totalServers.textContent = serversData.length;
        } else {
          console.error('Error loading servers count:', serversResult.error);
        }
      } catch (error) {
        console.error('Error loading servers count:', error);
      }

      // Пользователи, сообщения мессенджера и комментарии статей Ibripedia —
      // одной сводкой с сервера (см. dashboard-stats.js); заодно приходят
      // свежие события для ленты активности.
      let summary = null;
      try {
        const summaryResult = await apiClient.getDashboardSummary();
        if (summaryResult.success) {
          summary = summaryResult.data;
          const totalUsers = document.getElementById('total-users');
          if (totalUsers) totalUsers.textContent = summary.users.total;
          this.renderTrendBadge('trend-users', summary.users.trend);
          const totalMessages = document.getElementById('total-messages');
          if (totalMessages) totalMessages.textContent = summary.messages.total;
          this.renderTrendBadge('trend-messages', summary.messages.trend);

          // Комментарии — своя статистика: всего, прирост и охват (в скольких статьях есть обсуждение)
          const totalComments = document.getElementById('total-comments');
          if (totalComments) totalComments.textContent = summary.comments.total;
          this.renderTrendBadge('trend-comments', summary.comments.trend);
          const commentsArticles = document.getElementById('comments-articles');
          if (commentsArticles) {
            const n = summary.comments.articles;
            const one = n % 10 === 1 && n % 100 !== 11;
            commentsArticles.textContent = n ? `в ${n} ${one ? 'статье' : 'статьях'}` : '';
          }
        } else {
          console.error('Error loading dashboard summary:', summaryResult.data?.error || summaryResult.error);
        }
      } catch (error) {
        console.error('Error loading dashboard summary:', error);
      }

      // Load tags count
      const tagsResult = await apiClient.getTags();
      if (tagsResult.success) {
        const totalTags = document.getElementById('total-tags');
        if (totalTags) totalTags.textContent = tagsResult.data.length;
      } else {
        console.error('Error loading tags count:', tagsResult.error);
      }

      // Load activity list with recent items
      this.loadActivityList({ articles: articlesData, servers: serversData, summary });

      // Initialize charts with real data
      this.initDashboardChartsWithData(articlesData, summary);
    } catch (error) {
      console.error('Unexpected error loading dashboard stats:', error);
    }
  }

  // Сколько элементов создано СЕГОДНЯ — календарный день по UTC, та же зона,
  // что и у дат на сервере (см. TODAY_CUTOFF_SQL в dashboard-stats.js) — для
  // бейджа "▲+N" в сводке. Раньше здесь считалось за последние 7 дней — на
  // небольшой базе, где почти вся активность свежая, бейдж почти всегда
  // совпадал с общим количеством статей и выглядел как ложный "не считается".
  countToday(items, dateField = 'created_at') {
    const todayUtc = new Date().toISOString().slice(0, 10);
    return items.filter(item => {
      const d = new Date(item[dateField]);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === todayUtc;
    }).length;
  }

  // Рисует бейдж "+N" рядом со значением метрики; при отсутствии прироста бейдж не показываем
  renderTrendBadge(elementId, delta) {
    const el = document.getElementById(elementId);
    if (!el) return;
    if (!delta) {
      el.textContent = '';
      el.title = '';
      return;
    }
    el.textContent = `▲+${delta}`;
    el.classList.add('stat-chip-trend-up');
    el.title = `+${delta} за последние 7 дней`;
  }

  // Значения из SQLite (CURRENT_TIMESTAMP, "2026-09-12 14:53:28") — это UTC без
  // указания зоны: new Date() разобрал бы их как локальное время и сдвинул
  // "N мин. назад" на величину часового пояса. ISO-строки (статьи, сводка
  // дашборда) уже с зоной и идут как есть.
  parseDbDate(value) {
    if (!value) return new Date(NaN);
    const s = String(value);
    return new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  }

  // Лента "Последняя активность": новые статьи, серверы, регистрации,
  // комментарии в Ibripedia и сообщения. Записи, у которых есть куда
  // перейти, кликабельны (см. openActivityTarget): статья/комментарий —
  // в Ibripedia, сервер — во вкладку "Сервера", пользователь — в профиль.
  // Сообщение мессенджера открывать некуда — остаётся обычной строкой.
  loadActivityList({ articles = [], servers = [], summary = null } = {}) {
    const activityList = document.getElementById('activity-list');
    if (!activityList) return;

    const clip = (text, max = 100) => {
      const t = String(text || '').replace(/\s+/g, ' ').trim();
      return t.length > max ? `${t.slice(0, max)}...` : t;
    };
    const newest = (items, dateOf, limit) => items
      .map((item) => ({ item, time: dateOf(item) }))
      .filter(({ time }) => !Number.isNaN(time.getTime()))
      .sort((a, b) => b.time - a.time)
      .slice(0, limit);

    const activities = [];

    newest(articles, (a) => this.parseDbDate(a.created_at), 5).forEach(({ item: article, time }) => {
      activities.push({
        time,
        icon: '📝',
        title: `Добавлена статья: ${article.title}`,
        description: clip(article.excerpt) || 'Новая статья опубликована',
        target: { action: 'article', slug: article.slug || article.id },
        hint: 'Открыть статью в Ibripedia'
      });
    });

    newest(servers, (s) => this.parseDbDate(s.created_at), 5).forEach(({ item: server, time }) => {
      activities.push({
        time,
        icon: '🌐',
        title: `Создан сервер: ${server.name}`,
        description: clip(server.description) || 'Новый сервер',
        target: { action: 'server', name: server.name },
        hint: 'Открыть во вкладке «Сервера»'
      });
    });

    const recent = (summary && summary.recent) || {};

    (recent.users || []).forEach((user) => {
      activities.push({
        time: this.parseDbDate(user.createdAt),
        icon: '👤',
        title: `Зарегистрирован пользователь: ${user.name}`,
        description: '',
        target: { action: 'user', id: user.id },
        hint: 'Открыть профиль'
      });
    });

    (recent.comments || []).forEach((comment) => {
      activities.push({
        time: this.parseDbDate(comment.createdAt),
        icon: '🗨️',
        title: `${comment.authorName} прокомментировал(а) «${comment.articleTitle}»`,
        description: clip(comment.content),
        target: { action: 'article', slug: comment.slug, jumpToComments: '1' },
        hint: 'Открыть комментарии в Ibripedia'
      });
    });

    (recent.messages || []).forEach((message) => {
      activities.push({
        time: this.parseDbDate(message.createdAt),
        icon: '💬',
        title: `Новое сообщение от ${message.sender}`,
        description: clip(message.content),
        target: null
      });
    });

    const shown = activities
      .filter((a) => !Number.isNaN(a.time.getTime()))
      .sort((a, b) => b.time - a.time)
      .slice(0, 10);

    if (shown.length === 0) {
      activityList.innerHTML = '<li class="activity-item"><div class="activity-description">Нет недавней активности</div></li>';
      return;
    }

    activityList.innerHTML = shown.map((activity) => {
      const clickable = activity.target
        ? ` activity-item-clickable" role="link" tabindex="0" title="${this.escapeHtml(activity.hint)}"`
          + Object.entries(activity.target).map(([k, v]) => ` data-${k === 'jumpToComments' ? 'jump-to-comments' : k}="${this.escapeHtml(String(v))}"`).join('')
        : '"';
      return `
        <li class="activity-item${clickable}>
          <div class="activity-header">
            <span class="activity-title-text">${activity.icon} ${this.escapeHtml(activity.title)}</span>
            <span class="activity-time">${this.getTimeAgo(activity.time)}</span>
          </div>
          ${activity.description ? `<div class="activity-description">${this.escapeHtml(activity.description)}</div>` : ''}
        </li>`;
    }).join('');

    // Делегирование: список перерисовывается целиком, а обработчик вешается
    // один раз на сам <ul> (он живёт, пока открыт дашборд).
    if (!activityList.dataset.bound) {
      activityList.dataset.bound = 'true';
      const open = (event) => {
        const item = event.target.closest('.activity-item-clickable');
        if (item) this.openActivityTarget(item.dataset);
      };
      activityList.addEventListener('click', open);
      activityList.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open(event);
        }
      });
    }
  }

  // Переход по клику на запись ленты (data-* атрибуты записи, см. loadActivityList)
  async openActivityTarget(data) {
    switch (data.action) {
      case 'article':
        return this.openIbripediaArticle(data.slug, { jumpToComments: data.jumpToComments === '1' });
      case 'server':
        return this.openServerByName(data.name);
      case 'user':
        return this.navigateTo(`/profile/${data.id}`);
      default:
        return undefined;
    }
  }

  // Открывает статью в Ibripedia (опционально — сразу на комментариях).
  async openIbripediaArticle(slug, { jumpToComments = false } = {}) {
    if (!slug) return;
    await this.navigateTo('/ibripedia');
    await window.ibripediaManager?.openArticleView(slug, { jumpToComments });
  }

  // Открывает вкладку "Сервера" с названием сервера в строке поиска —
  // каталог сразу фильтруется до нужной карточки.
  async openServerByName(name) {
    await this.navigateTo('/servers');
    const input = document.getElementById('servers-search-input');
    if (input && name) {
      input.value = name;
      this.renderServersGrid();
    }
  }

  // Helper function to format time ago
  getTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    
    if (seconds < 60) return 'Только что';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} мин. назад`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч. назад`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)} дн. назад`;
    
    return date.toLocaleDateString('ru-RU');
  }

  // Initialize dashboard charts with real data
  initDashboardChartsWithData(articlesData, summary = null) {
    // Статьи — силуэт активности за текущую неделю (пн-вс)
    this.renderSparkline('articlesSparkline', this.calculateWeeklyActivity(articlesData));
    // Сообщения мессенджера — последние 7 суток, по дням
    this.renderSparkline('messagesSparkline', summary?.messages?.daily || []);
  }

  // Компактный спарклайн внутри плашки — без осей, легенды и точек
  renderSparkline(canvasId, data) {
    if (typeof Chart === 'undefined') return;
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    // Destroy existing chart if it exists
    if (ctx.chartInstance) {
      ctx.chartInstance.destroy();
    }

    ctx.chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map((_, i) => i + 1),
        datasets: [{
          data,
          borderColor: 'rgb(88, 101, 242)',
          backgroundColor: 'rgba(88, 101, 242, 0.15)',
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.35,
          fill: true
        }]
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false }
        },
        scales: {
          x: { display: false },
          y: { display: false, beginAtZero: true }
        }
      }
    });
  }

  // Calculate weekly activity from articles data
  calculateWeeklyActivity(articlesData) {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Adjust for Monday start
    
    // Get Monday of current week
    const monday = new Date(now);
    monday.setDate(now.getDate() - mondayOffset);
    monday.setHours(0, 0, 0, 0);

    // Initialize array for 7 days
    const dailyCounts = [0, 0, 0, 0, 0, 0, 0];

    // Count articles per day
    articlesData.forEach(article => {
      const articleDate = new Date(article.created_at);
      if (articleDate >= monday) {
        const dayIndex = Math.floor((articleDate - monday) / (1000 * 60 * 60 * 24));
        if (dayIndex >= 0 && dayIndex < 7) {
          dailyCounts[dayIndex]++;
        }
      }
    });

    return dailyCounts;
  }

}

// Global router instance
let spaRouter = null;

// Владелец (is_root) проходит и во время техобслуживания — все остальные
// (в т.ч. только что успешно вошедшие: /api/login открыт даже в
// техобслуживание, см. src/middleware/maintenance.js, иначе владельцу
// самому было бы некуда войти) видят заглушку вместо панели.
function isMaintenanceBlockedForCurrentUser(maintenance) {
  if (!maintenance || !maintenance.enabled) return false;
  const user = authManager && authManager.isAuthenticated() ? authManager.getUser() : null;
  return !(user && user.is_root);
}

// Initialize router after DOM is fully loaded
document.addEventListener('DOMContentLoaded', async () => {
  const maintenance = typeof checkMaintenanceStatus === 'function' ? await checkMaintenanceStatus() : { enabled: false };

  if (isMaintenanceBlockedForCurrentUser(maintenance)) {
    showMaintenanceBlocker(maintenance.message);
  } else if (authManager && authManager.isAuthenticated()) {
    // Create router instance only if authenticated
    spaRouter = new SPARouter();
  } else {
    // If not authenticated, show login form
    showModalLogin();
  }

  if (typeof startMaintenancePolling === 'function') startMaintenancePolling();
});

// Check on auth status change
let authChangeInProgress = false;

window.addEventListener('authChanged', async () => {
  if (authChangeInProgress) return; // Prevent circular calls
  authChangeInProgress = true;

  try {
    // Small delay for full status change
    await new Promise(resolve => setTimeout(resolve, 100));

    const maintenance = typeof checkMaintenanceStatus === 'function' ? await checkMaintenanceStatus() : { enabled: false };

    if (isMaintenanceBlockedForCurrentUser(maintenance)) {
      // Успешный логин во время техобслуживания (не владельцем) — /api/login
      // пропускает кого угодно, но панель ему всё равно не откроем: показываем
      // ту же заглушку, что видел бы неавторизованный посетитель.
      spaRouter = null;
      showMaintenanceBlocker(maintenance.message);
    } else if (authManager && authManager.isAuthenticated() && !spaRouter) {
      // If user logged in and router not created yet
      hideMaintenanceBlocker();
      spaRouter = new SPARouter();
    } else if (authManager && !authManager.isAuthenticated() && spaRouter) {
      // If user logged out, remove router
      spaRouter = null;
      // Show login form
      showModalLogin();
    }
  } finally {
    authChangeInProgress = false;
  }
});

// Debounce function for auto-saving settings
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Export methods for global use
window.spaRouter = {
  // async + await (не просто "вызвать и забыть") — вызывающий код (graph-view.js,
  // ibripedia.js) переходит на страницу редактора, а затем сразу открывает
  // конкретную статью через editArticle(); без ожидания реальной навигации
  // (fetch партиала, инициализация формы/редактора) editArticle() запускался
  // бы до того, как нужные элементы формы вообще появятся в DOM.
  navigateTo: async (path) => {
    if (spaRouter) {
      await spaRouter.navigateTo(path);
    }
  },

  saveArticle: () => {
    if (spaRouter) {
      spaRouter.saveArticle();
    }
  },

  previewArticle: () => {
    if (spaRouter) {
      spaRouter.previewArticle();
    }
  },

  closePreview: () => {
    if (spaRouter) {
      spaRouter.closePreview();
    }
  },

  clearArticleForm: () => {
    if (spaRouter) {
      spaRouter.clearArticleForm();
    }
  },

  uploadImage: async () => {
    if (spaRouter) {
      await spaRouter.uploadImage();
    }
  },

  selectCoverFromFile: () => {
    if (spaRouter) {
      spaRouter.selectCoverFromFile();
    }
  },

  handleCoverFileSelect: (inputElement) => {
    if (spaRouter) {
      spaRouter.handleCoverFileSelect(inputElement);
    }
  },

  selectCoverFromUrl: () => {
    if (spaRouter) {
      spaRouter.selectCoverFromUrl();
    }
  },

  removeArticleCover: () => {
    if (spaRouter) {
      spaRouter.removeArticleCover();
    }
  },

  editArticle: async (articleId) => {
    if (spaRouter) {
      await spaRouter.editArticle(articleId);
    }
  }
};

// ========================================
// ЗАЯВКИ НА ДОСТУП (root-only)
// ========================================

SPARouter.prototype.loadPendingUsers = async function() {
  this.showLoader();

  try {
    const response = await fetch('/views/pending-users.html');
    const html = await response.text();

    const appContent = document.getElementById('app-content');
    if (appContent) {
      appContent.innerHTML = html;
      const titleElement = document.getElementById('page-title');
      if (titleElement) titleElement.textContent = 'Заявки на доступ';
    }

    await this.renderPendingUsers();
  } catch (error) {
    console.error('Error loading pending users:', error);
    showMessage('Ошибка при загрузке заявок', 'error');
  } finally {
    this.hideLoader();
  }
};

SPARouter.prototype.renderPendingUsers = async function() {
  const loadingEl = document.getElementById('pending-loading');
  const emptyEl = document.getElementById('pending-empty');
  const tableEl = document.getElementById('pending-table');
  const tbodyEl = document.getElementById('pending-tbody');
  const statsEl = document.getElementById('pending-stats');
  const countEl = document.getElementById('pending-count');

  if (loadingEl) loadingEl.style.display = 'block';
  if (emptyEl) emptyEl.style.display = 'none';
  if (tableEl) tableEl.style.display = 'none';
  if (statsEl) statsEl.style.display = 'none';

  try {
    const res = await fetch('/api/pending-users');
    if (!res.ok) {
      throw new Error('Не удалось загрузить заявки');
    }
    const data = await res.json();
    const users = data.users || [];

    if (loadingEl) loadingEl.style.display = 'none';

    if (users.length === 0) {
      if (emptyEl) emptyEl.style.display = 'block';
    } else {
      if (statsEl) statsEl.style.display = 'block';
      if (countEl) countEl.textContent = users.length;
      if (tableEl) tableEl.style.display = 'block';

      // Строка и ячейки больше не несут своих инлайн-стилей — .table-container
      // уже стилизует table/th/td/tr, включая hover (см. "ENHANCED TABLE
      // STYLES" в global-styles.css), а кнопки — канонические .btn-success/
      // .btn-danger вместо зашитых #28a745/#dc3545.
      tbodyEl.innerHTML = '';
      users.forEach(user => {
        const tr = document.createElement('tr');

        const date = user.created_at ? new Date(user.created_at).toLocaleString('ru-RU') : '—';

        tr.innerHTML = `
          <td>${user.display_name || user.username}</td>
          <td style="font-family: monospace; color: var(--text-muted);">${user.username}</td>
          <td style="font-size: 13px; color: var(--text-muted);">${date}</td>
          <td class="text-right">
            <button class="btn btn-success btn-sm btn-approve" data-id="${user.id}" data-name="${user.display_name || user.username}"><i class="fas fa-check"></i> Подтвердить</button>
            <button class="btn btn-danger btn-sm btn-reject" data-id="${user.id}" data-name="${user.display_name || user.username}"><i class="fas fa-xmark"></i> Отклонить</button>
          </td>
        `;
        tbodyEl.appendChild(tr);
      });

      // Обработчики кнопок
      tbodyEl.querySelectorAll('.btn-approve').forEach(btn => {
        btn.addEventListener('click', () => this.showApproveModal(btn.dataset.id, btn.dataset.name));
      });
      tbodyEl.querySelectorAll('.btn-reject').forEach(btn => {
        btn.addEventListener('click', () => this.showRejectModal(btn.dataset.id, btn.dataset.name));
      });
    }
  } catch (error) {
    if (loadingEl) loadingEl.style.display = 'none';
    showMessage(error.message || 'Ошибка загрузки заявок', 'error');
  }
};

SPARouter.prototype.showApproveModal = function(userId, userName) {
  const modal = document.getElementById('approve-modal');
  const textEl = document.getElementById('approve-modal-text');
  if (textEl) textEl.textContent = `Пользователь «${userName}» получит полный доступ к админ-панели.`;
  if (modal) modal.style.display = 'flex';

  document.getElementById('approve-confirm-btn').onclick = async () => {
    const btn = document.getElementById('approve-confirm-btn');
    btn.disabled = true;
    btn.textContent = 'Обработка...';

    try {
      const res = await fetch(`/api/pending-users/${userId}/approve`, { method: 'PUT' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Ошибка подтверждения');
      }
      modal.style.display = 'none';
      this.showPendingToast(`Пользователь «${userName}» одобрен`, 'success');
      await this.renderPendingUsers();
    } catch (error) {
      this.showPendingToast(error.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Подтвердить';
    }
  };

  document.getElementById('approve-cancel-btn').onclick = () => {
    modal.style.display = 'none';
  };
};

SPARouter.prototype.showRejectModal = function(userId, userName) {
  const modal = document.getElementById('reject-modal');
  const reasonInput = document.getElementById('reject-reason');
  if (reasonInput) reasonInput.value = '';
  if (modal) modal.style.display = 'flex';

  document.getElementById('reject-confirm-btn').onclick = async () => {
    const btn = document.getElementById('reject-confirm-btn');
    const reason = document.getElementById('reject-reason').value;
    btn.disabled = true;
    btn.textContent = 'Обработка...';

    try {
      const res = await fetch(`/api/pending-users/${userId}/reject`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || undefined })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Ошибка отклонения');
      }
      modal.style.display = 'none';
      this.showPendingToast(`Заявка «${userName}» отклонена`, 'success');
      await this.renderPendingUsers();
    } catch (error) {
      this.showPendingToast(error.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Отклонить';
    }
  };

  document.getElementById('reject-cancel-btn').onclick = () => {
    modal.style.display = 'none';
  };
};

SPARouter.prototype.showPendingToast = function(message, type = 'success') {
  const container = document.getElementById('pending-toast-container');
  if (!container) return;

  // Общий компонент тоста (.toast/.toast-success/.toast-error) — см. "TOAST
  // COMPONENT" в global-styles.css, тот же, что и showUsersToast.
  const toast = document.createElement('div');
  toast.className = `toast toast-${type === 'error' ? 'error' : 'success'}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
};

// ========================================
// ПОЛЬЗОВАТЕЛИ — вкладка "Пользователи". Список читает GET /api/all-users
// (уже отсортирован: владелец → админы по убыванию уровня роли → остальные
// — см. auth.getAllUsers на сервере). Роль назначается из каталога
// admin_roles (GET /api/admin-roles) — выпадающий список вместо голого
// числа, само число (level) задаётся при редактировании роли, не
// пользователя. Кнопки действий рендерятся по правам ТЕКУЩЕГО пользователя
// (authManager.getUser().permissions) — это только подсказка интерфейса,
// сервер каждое действие всё равно проверяет заново (см. checkPermission/
// assertCanManage в src/middleware/auth.js).
// ========================================

const PERMISSION_LABELS = {
  view_users_tab: 'Видеть вкладку «Пользователи»',
  manage_pending_users: 'Одобрять/отклонять заявки на регистрацию',
  manage_admin_roles: 'Выдавать/менять роли другим пользователям',
  block_users: 'Блокировать пользователей',
  rename_users: 'Переименовывать пользователей',
  mute_users: 'Временно мутить пользователей',
  moderate_stickers: 'Подтверждать/отклонять наборы стикеров'
};

SPARouter.prototype.loadUsersList = async function() {
  this.showLoader();

  try {
    const response = await fetch('/views/users-list.html');
    const html = await response.text();

    const appContent = document.getElementById('app-content');
    if (appContent) {
      appContent.innerHTML = html;
      const titleElement = document.getElementById('page-title');
      if (titleElement) titleElement.textContent = 'Пользователи';
    }

    const me = authManager.getUser() || {};
    const canManageRoleCatalog = !!(me.is_root || me.is_role_manager);
    document.getElementById('roles-panel').style.display = canManageRoleCatalog ? 'block' : 'none';
    document.getElementById('create-role-btn')?.addEventListener('click', () => this.showRoleEditorModal());

    await this.loadRolesCache();
    await this.renderUsersList();
    if (canManageRoleCatalog) await this.renderRolesPanel();
  } catch (error) {
    console.error('Error loading users list:', error);
    showMessage('Ошибка при загрузке списка пользователей', 'error');
  } finally {
    this.hideLoader();
  }
};

// Кэш каталога ролей — используется и списком пользователей (подписи),
// и модалкой назначения роли (выпадающий список).
SPARouter.prototype.loadRolesCache = async function() {
  try {
    const res = await fetch('/api/admin-roles');
    const data = await res.json();
    this.rolesCache = data.roles || [];
  } catch (error) {
    this.rolesCache = [];
  }
};

// Цвета — через уже существующие токены (var(--yellow)/--blurple/--green/
// --red из :root в global-styles.css), а не зашитые hex: тот же жёлтый, что
// и у .btn-warning, тот же blurple, что и у .btn-primary, и т.д. — раньше
// тут был свой набор чуть отличающихся оттенков (#f5b642 вместо --yellow,
// #f59e0b вместо тоже --yellow, и т.д.).
SPARouter.prototype.roleLabelForUser = function(user) {
  if (user.is_root) return { text: 'Владелец', color: 'var(--yellow)' };
  if (user.role_name) return { text: user.role_name, color: 'var(--blurple)' };
  return { text: 'Пользователь', color: 'var(--text-muted)' };
};

SPARouter.prototype.statusLabelForUser = function(user) {
  const map = {
    approved: { text: 'Подтверждён', color: 'var(--green)' },
    pending: { text: 'Ожидает', color: 'var(--yellow)' },
    rejected: { text: 'Отклонён', color: 'var(--red)' },
    blocked: { text: 'Заблокирован', color: 'var(--red)' }
  };
  const base = map[user.status] || { text: user.status || '—', color: 'var(--text-muted)' };
  if (this.isMuted(user)) {
    const until = new Date(user.muted_until).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return { text: `${base.text} · 🔇 до ${until}`, color: 'var(--yellow)' };
  }
  return base;
};

SPARouter.prototype.isMuted = function(user) {
  return !!(user.muted_until && new Date(user.muted_until).getTime() > Date.now());
};

SPARouter.prototype.renderUsersList = async function() {
  const loadingEl = document.getElementById('users-loading');
  const emptyEl = document.getElementById('users-empty');
  const tableEl = document.getElementById('users-table');
  const tbodyEl = document.getElementById('users-tbody');
  const statsEl = document.getElementById('users-stats');

  if (loadingEl) loadingEl.style.display = 'block';
  if (emptyEl) emptyEl.style.display = 'none';
  if (tableEl) tableEl.style.display = 'none';
  if (statsEl) statsEl.style.display = 'none';

  const me = authManager.getUser() || {};
  const myPerms = me.permissions || {};
  const can = (key) => !!(me.is_root || myPerms[key]);

  try {
    const res = await fetch('/api/all-users');
    if (!res.ok) throw new Error('Не удалось загрузить пользователей');
    const data = await res.json();
    const users = data.users || [];

    if (loadingEl) loadingEl.style.display = 'none';

    if (users.length === 0) {
      if (emptyEl) emptyEl.style.display = 'block';
      return;
    }

    if (statsEl) statsEl.style.display = 'grid';
    const totalEl = document.getElementById('users-count-total');
    const adminsEl = document.getElementById('users-count-admins');
    const blockedEl = document.getElementById('users-count-blocked');
    const mutedEl = document.getElementById('users-count-muted');
    if (totalEl) totalEl.textContent = users.length;
    if (adminsEl) adminsEl.textContent = users.filter(u => u.role_name && !u.is_root).length;
    if (blockedEl) blockedEl.textContent = users.filter(u => u.status === 'blocked').length;
    if (mutedEl) mutedEl.textContent = users.filter(u => this.isMuted(u)).length;

    if (tableEl) tableEl.style.display = 'block';
    tbodyEl.innerHTML = '';

    users.forEach(user => {
      const tr = document.createElement('tr');
      // Раньше подсветка строки при наведении делалась вручную (onmouseenter/
      // leave + инлайн-фон) — убрано в пользу глобального tr:hover
      // (global-styles.css), тот же эффект, что и в таблицах на вкладке
      // "Сервера", без лишнего JS на каждую строку.

      const role = this.roleLabelForUser(user);
      const status = this.statusLabelForUser(user);
      const date = user.created_at ? new Date(user.created_at).toLocaleString('ru-RU') : '—';
      const displayName = this.escapeHtml(user.display_name || user.username);
      const username = this.escapeHtml(user.username);
      const muted = this.isMuted(user);

      // Владельца через панель никто не трогает — действий для его строки нет
      // (роль назначается только через scripts/make-owner.js в терминале).
      let actionsHtml = '<span style="color: var(--text-muted);">—</span>';
      if (!user.is_root) {
        const buttons = [];
        if (can('manage_admin_roles')) {
          buttons.push(`<button class="btn btn-primary btn-sm btn-assign-role" data-id="${user.id}" data-name="${displayName}" data-role-id="${user.admin_role_id || ''}">${user.role_name ? 'Изменить роль' : 'Сделать админом'}</button>`);
        }
        if (can('rename_users')) {
          buttons.push(`<button class="btn btn-secondary btn-sm btn-rename-user" data-id="${user.id}" data-name="${displayName}" data-username="${username}">Переименовать</button>`);
        }
        if (can('mute_users')) {
          buttons.push(muted
            ? `<button class="btn btn-success btn-sm btn-unmute-user" data-id="${user.id}" data-name="${displayName}">Снять мут</button>`
            : `<button class="btn btn-warning btn-sm btn-mute-user" data-id="${user.id}" data-name="${displayName}">Мут</button>`);
        }
        if (can('block_users')) {
          buttons.push(user.status === 'blocked'
            ? `<button class="btn btn-success btn-sm btn-unblock-user" data-id="${user.id}" data-name="${displayName}">Разблокировать</button>`
            : (user.status === 'approved'
              ? `<button class="btn btn-danger btn-sm btn-block-user" data-id="${user.id}" data-name="${displayName}">Заблокировать</button>`
              : ''));
        }
        if (me.is_root) {
          buttons.push(user.is_role_manager
            ? `<button class="users-btn-star btn-revoke-role-manager" data-id="${user.id}" data-name="${displayName}" title="Снять статус доверенного администратора">★ доверенный</button>`
            : `<button class="users-btn-ghost btn-grant-role-manager" data-id="${user.id}" data-name="${displayName}" title="Назначить доверенным администратором (право редактировать роли)">☆ сделать доверенным</button>`);
        }
        actionsHtml = buttons.join(' ') || '<span style="color: var(--text-muted);">—</span>';
      }

      // data-label на каждой ячейке — используется только на мобильной
      // раскладке (общий компонент .table-cards в global-styles.css), где
      // таблица превращается в список карточек и подписи колонок берутся
      // отсюда через CSS content: attr(data-label), т.к. <thead> скрыт.
      // cell-primary — заголовок карточки (без подписи), cell-actions —
      // строка кнопок внизу.
      tr.innerHTML = `
        <td data-label="Имя" class="cell-primary"><span class="users-name-link profile-link" data-id="${user.id}" title="Открыть профиль">${displayName}</span></td>
        <td data-label="Логин" style="color: var(--text-muted); font-family: monospace;">${username}</td>
        <td data-label="Роль"><span class="users-role-pill" style="background: ${role.color};">${role.text}</span></td>
        <td data-label="Статус"><span class="users-status-pill" style="background: ${status.color};">${status.text}</span></td>
        <td data-label="Регистрация" style="color: var(--text-muted); font-size: 13px;">${date}</td>
        <td data-label="Действия" class="cell-actions"><div class="users-actions-cell">${actionsHtml}</div></td>
      `;
      tbodyEl.appendChild(tr);
    });

    tbodyEl.querySelectorAll('.profile-link').forEach(el => {
      el.addEventListener('click', () => window.spaRouter.navigateTo(`/profile/${el.dataset.id}`));
    });
    tbodyEl.querySelectorAll('.btn-assign-role').forEach(btn => {
      btn.addEventListener('click', () => this.showAssignRoleModal(btn.dataset.id, btn.dataset.name, btn.dataset.roleId));
    });
    tbodyEl.querySelectorAll('.btn-rename-user').forEach(btn => {
      btn.addEventListener('click', () => this.showRenameModal(btn.dataset.id, btn.dataset.name, btn.dataset.username));
    });
    tbodyEl.querySelectorAll('.btn-mute-user').forEach(btn => {
      btn.addEventListener('click', () => this.showMuteUserModal(btn.dataset.id, btn.dataset.name));
    });
    tbodyEl.querySelectorAll('.btn-unmute-user').forEach(btn => {
      btn.addEventListener('click', () => this.unmuteUser(btn.dataset.id, btn.dataset.name));
    });
    tbodyEl.querySelectorAll('.btn-block-user').forEach(btn => {
      btn.addEventListener('click', () => this.showBlockUserModal(btn.dataset.id, btn.dataset.name));
    });
    tbodyEl.querySelectorAll('.btn-unblock-user').forEach(btn => {
      btn.addEventListener('click', () => this.unblockUser(btn.dataset.id, btn.dataset.name));
    });
    tbodyEl.querySelectorAll('.btn-grant-role-manager').forEach(btn => {
      btn.addEventListener('click', () => this.setRoleManager(btn.dataset.id, btn.dataset.name, true));
    });
    tbodyEl.querySelectorAll('.btn-revoke-role-manager').forEach(btn => {
      btn.addEventListener('click', () => this.setRoleManager(btn.dataset.id, btn.dataset.name, false));
    });
  } catch (error) {
    if (loadingEl) loadingEl.style.display = 'none';
    this.showUsersToast(error.message || 'Ошибка загрузки пользователей', 'error');
  }
};

SPARouter.prototype.showAssignRoleModal = function(userId, userName, currentRoleId) {
  const modal = document.getElementById('assign-role-modal');
  const titleEl = document.getElementById('assign-role-modal-title');
  const select = document.getElementById('assign-role-select');
  if (titleEl) titleEl.textContent = `Роль администратора — «${userName}»`;

  select.innerHTML = '<option value="">— Без роли (обычный пользователь) —</option>';
  (this.rolesCache || [])
    // Автомигрированные роли-заглушки ("Мигрированный ранг N", см.
    // migrateLegacyAdminLevels) не предлагаем при выборе — они не для
    // назначения новым людям, только чтобы не потерять прежний ранг тех,
    // кому он уже был выдан. Текущую роль пользователя всё равно
    // показываем, даже если это заглушка — иначе список выглядел бы так,
    // будто у него роли нет вовсе.
    .filter(role => !role.name.startsWith('Мигрированный ранг') || String(role.id) === String(currentRoleId))
    .forEach(role => {
      const opt = document.createElement('option');
      opt.value = role.id;
      opt.textContent = role.name;
      select.appendChild(opt);
    });
  select.value = currentRoleId || '';
  if (modal) modal.style.display = 'flex';

  document.getElementById('assign-role-confirm-btn').onclick = async () => {
    const btn = document.getElementById('assign-role-confirm-btn');
    const roleId = select.value || null;
    btn.disabled = true;
    btn.textContent = 'Сохранение...';
    try {
      const res = await fetch(`/api/users/${userId}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: roleId ? Number(roleId) : null })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка сохранения роли');
      modal.style.display = 'none';
      this.showUsersToast(roleId ? `«${userName}»: роль обновлена` : `«${userName}»: роль снята`, 'success');
      await this.renderUsersList();
    } catch (error) {
      this.showUsersToast(error.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Сохранить';
    }
  };

  document.getElementById('assign-role-cancel-btn').onclick = () => {
    modal.style.display = 'none';
  };
  document.getElementById('assign-role-close-btn').onclick = () => {
    modal.style.display = 'none';
  };
};

SPARouter.prototype.showRenameModal = function(userId, userName, username) {
  const modal = document.getElementById('rename-modal');
  const nameInput = document.getElementById('rename-display-name-input');
  const usernameInput = document.getElementById('rename-username-input');
  if (nameInput) nameInput.value = userName;
  if (usernameInput) usernameInput.value = username;
  if (modal) modal.style.display = 'flex';

  document.getElementById('rename-confirm-btn').onclick = async () => {
    const btn = document.getElementById('rename-confirm-btn');
    const display_name = nameInput.value.trim();
    const newUsername = usernameInput.value.trim();
    if (!display_name) {
      this.showUsersToast('Имя не может быть пустым', 'error');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Сохранение...';
    try {
      const res = await fetch(`/api/users/${userId}/rename`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name, username: newUsername })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка переименования');
      modal.style.display = 'none';
      this.showUsersToast('Пользователь переименован', 'success');
      await this.renderUsersList();
    } catch (error) {
      this.showUsersToast(error.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Сохранить';
    }
  };

  document.getElementById('rename-cancel-btn').onclick = () => {
    modal.style.display = 'none';
  };
  document.getElementById('rename-close-btn').onclick = () => {
    modal.style.display = 'none';
  };
};

SPARouter.prototype.showBlockUserModal = function(userId, userName) {
  const modal = document.getElementById('block-user-modal');
  const reasonInput = document.getElementById('block-user-reason');
  if (reasonInput) reasonInput.value = '';
  if (modal) modal.style.display = 'flex';

  document.getElementById('block-user-confirm-btn').onclick = async () => {
    const btn = document.getElementById('block-user-confirm-btn');
    const reason = reasonInput.value.trim();
    btn.disabled = true;
    btn.textContent = 'Обработка...';
    try {
      const res = await fetch(`/api/users/${userId}/block`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || undefined })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка блокировки');
      modal.style.display = 'none';
      this.showUsersToast(`«${userName}» заблокирован`, 'success');
      await this.renderUsersList();
    } catch (error) {
      this.showUsersToast(error.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Заблокировать';
    }
  };

  document.getElementById('block-user-cancel-btn').onclick = () => {
    modal.style.display = 'none';
  };
  document.getElementById('block-user-close-btn').onclick = () => {
    modal.style.display = 'none';
  };
};

SPARouter.prototype.unblockUser = async function(userId, userName) {
  try {
    const res = await fetch(`/api/users/${userId}/unblock`, { method: 'PUT' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка разблокировки');
    this.showUsersToast(`«${userName}» разблокирован`, 'success');
    await this.renderUsersList();
  } catch (error) {
    this.showUsersToast(error.message, 'error');
  }
};

SPARouter.prototype.showMuteUserModal = function(userId, userName) {
  const modal = document.getElementById('mute-user-modal');
  const minutesInput = document.getElementById('mute-user-minutes');
  const reasonInput = document.getElementById('mute-user-reason');
  if (minutesInput) minutesInput.value = 60;
  if (reasonInput) reasonInput.value = '';
  if (modal) modal.style.display = 'flex';

  document.getElementById('mute-user-confirm-btn').onclick = async () => {
    const btn = document.getElementById('mute-user-confirm-btn');
    const minutes = Number(minutesInput.value);
    const reason = reasonInput.value.trim();
    if (!Number.isFinite(minutes) || minutes <= 0) {
      this.showUsersToast('Длительность должна быть положительным числом минут', 'error');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Обработка...';
    try {
      const res = await fetch(`/api/users/${userId}/mute`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes, reason: reason || undefined })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка мута');
      modal.style.display = 'none';
      this.showUsersToast(`«${userName}» замучен на ${minutes} мин.`, 'success');
      await this.renderUsersList();
    } catch (error) {
      this.showUsersToast(error.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Замутить';
    }
  };

  document.getElementById('mute-user-cancel-btn').onclick = () => {
    modal.style.display = 'none';
  };
  document.getElementById('mute-user-close-btn').onclick = () => {
    modal.style.display = 'none';
  };
};

SPARouter.prototype.unmuteUser = async function(userId, userName) {
  try {
    const res = await fetch(`/api/users/${userId}/unmute`, { method: 'PUT' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка снятия мута');
    this.showUsersToast(`Мут «${userName}» снят`, 'success');
    await this.renderUsersList();
  } catch (error) {
    this.showUsersToast(error.message, 'error');
  }
};

SPARouter.prototype.setRoleManager = async function(userId, userName, enabled) {
  if (enabled && !confirm(`Сделать «${userName}» доверенным администратором? Он сможет редактировать каталог ролей (создавать/переименовывать роли, включать/выключать им права). Этот статус уникален — если он уже был у кого-то другого, тот его потеряет.`)) return;
  try {
    const res = await fetch(`/api/users/${userId}/role-manager`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка изменения статуса');
    this.showUsersToast(enabled ? `«${userName}» теперь доверенный администратор` : `«${userName}»: статус доверенного администратора снят`, 'success');
    await this.renderUsersList();
  } catch (error) {
    this.showUsersToast(error.message, 'error');
  }
};

// ========================================
// РОЛИ АДМИНОВ — каталог (admin_roles). Видно и редактируемо только
// владельцу и "доверенному админу" (is_role_manager) — см. checkRoleManager.
// ========================================

SPARouter.prototype.renderRolesPanel = async function() {
  const listEl = document.getElementById('roles-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  (this.rolesCache || []).forEach(role => {
    const card = document.createElement('div');
    card.className = 'users-role-card';

    const enabledPerms = Object.entries(role.permissions || {}).filter(([, v]) => v).map(([k]) => PERMISSION_LABELS[k] || k);

    card.innerHTML = `
      <div>
        <div class="users-role-card-name">${this.escapeHtml(role.name)}</div>
        <div class="users-role-card-perms">${enabledPerms.length ? enabledPerms.join(', ') : 'Без дополнительных прав'}</div>
      </div>
      <div class="users-role-card-actions">
        <button class="btn btn-secondary btn-sm btn-edit-role" data-id="${role.id}">Изменить</button>
        <button class="btn btn-danger btn-sm btn-delete-role" data-id="${role.id}" data-name="${this.escapeHtml(role.name)}">Удалить</button>
      </div>
    `;
    listEl.appendChild(card);
  });

  listEl.querySelectorAll('.btn-edit-role').forEach(btn => {
    btn.addEventListener('click', () => {
      const role = (this.rolesCache || []).find(r => String(r.id) === btn.dataset.id);
      if (role) this.showRoleEditorModal(role);
    });
  });
  listEl.querySelectorAll('.btn-delete-role').forEach(btn => {
    btn.addEventListener('click', () => this.deleteRole(btn.dataset.id, btn.dataset.name));
  });
};

SPARouter.prototype.showRoleEditorModal = function(role) {
  const modal = document.getElementById('role-editor-modal');
  const titleEl = document.getElementById('role-editor-title');
  const nameInput = document.getElementById('role-editor-name');
  const levelInput = document.getElementById('role-editor-level');
  const permsContainer = document.getElementById('role-editor-permissions');

  titleEl.textContent = role ? `Роль: ${role.name}` : 'Новая роль';
  nameInput.value = role ? role.name : '';
  levelInput.value = role ? role.level : 10;

  permsContainer.innerHTML = '';
  Object.entries(PERMISSION_LABELS).forEach(([key, label]) => {
    const id = `role-perm-${key}`;
    const checked = role && role.permissions && role.permissions[key];
    const row = document.createElement('label');
    row.innerHTML = `<input type="checkbox" id="${id}" data-perm-key="${key}" ${checked ? 'checked' : ''}> ${label}`;
    permsContainer.appendChild(row);
  });

  if (modal) modal.style.display = 'flex';

  document.getElementById('role-editor-confirm-btn').onclick = async () => {
    const btn = document.getElementById('role-editor-confirm-btn');
    const name = nameInput.value.trim();
    const level = Number(levelInput.value);
    if (!name) { this.showUsersToast('Название роли обязательно', 'error'); return; }
    if (!Number.isInteger(level) || level < 0) { this.showUsersToast('Уровень должен быть целым числом ≥ 0', 'error'); return; }

    const permissions = {};
    permsContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      permissions[cb.dataset.permKey] = cb.checked;
    });

    btn.disabled = true;
    btn.textContent = 'Сохранение...';
    try {
      const url = role ? `/api/admin-roles/${role.id}` : '/api/admin-roles';
      const res = await fetch(url, {
        method: role ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, level, permissions })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка сохранения роли');
      modal.style.display = 'none';
      this.showUsersToast(role ? 'Роль обновлена' : 'Роль создана', 'success');
      await this.loadRolesCache();
      await this.renderRolesPanel();
      await this.renderUsersList();
    } catch (error) {
      this.showUsersToast(error.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Сохранить';
    }
  };

  document.getElementById('role-editor-cancel-btn').onclick = () => {
    modal.style.display = 'none';
  };
  document.getElementById('role-editor-close-btn').onclick = () => {
    modal.style.display = 'none';
  };
};

SPARouter.prototype.deleteRole = async function(roleId, roleName) {
  if (!confirm(`Удалить роль «${roleName}»? Действие необратимо. Роль нельзя удалить, пока она кому-то назначена.`)) return;
  try {
    const res = await fetch(`/api/admin-roles/${roleId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка удаления роли');
    this.showUsersToast(`Роль «${roleName}» удалена`, 'success');
    await this.loadRolesCache();
    await this.renderRolesPanel();
  } catch (error) {
    this.showUsersToast(error.message, 'error');
  }
};

SPARouter.prototype.showUsersToast = function(message, type = 'success') {
  const container = document.getElementById('users-toast-container');
  if (!container) return;

  // Общий компонент тоста (.toast/.toast-success/.toast-error) — см. "TOAST
  // COMPONENT" в global-styles.css. Раньше цвет собирался через
  // style.cssText с зашитым hex (#28a745/#dc3545).
  const toast = document.createElement('div');
  toast.className = `toast toast-${type === 'error' ? 'error' : 'success'}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
};

// ========================================
// ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ (/profile/:id) — свой (из шапки, "Мой профиль") или
// чужой (клик по имени в списке пользователей / по автору статьи).
// this.profileUserId выставляется в resolveRouteKey() из URL; без него —
// профиль текущего пользователя.
// ========================================

SPARouter.prototype.loadProfile = async function() {
  this.showLoader();

  try {
    const html = await this.loadTemplate('/views/profile.html');
    const appContent = document.getElementById('app-content');
    if (appContent) appContent.innerHTML = html;

    const me = authManager.getUser() || {};
    const targetId = this.profileUserId || me.id;

    document.querySelectorAll('.profile-media-tab').forEach((btn) => {
      btn.addEventListener('click', () => this.switchProfileMediaTab(btn.dataset.tab));
    });

    await this.renderProfile(targetId);
  } catch (error) {
    console.error('Error loading profile:', error);
    showMessage('Ошибка при загрузке профиля', 'error');
  } finally {
    this.hideLoader();
  }
};

SPARouter.prototype.switchProfileMediaTab = function(tab) {
  document.querySelectorAll('.profile-media-tab').forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.style.color = active ? 'var(--text-normal, #dcddde)' : 'var(--text-muted, #b9bbbe)';
    btn.style.borderBottomColor = active ? '#5865f2' : 'transparent';
  });
  document.querySelectorAll('.profile-media-panel').forEach((panel) => {
    panel.style.display = panel.id === `profile-media-${tab}` ? '' : 'none';
  });
};

SPARouter.prototype.renderProfile = async function(targetId) {
  const loadingEl = document.getElementById('profile-loading');
  const errorEl = document.getElementById('profile-error');
  const contentEl = document.getElementById('profile-content');

  try {
    const res = await fetch(`/api/users/${targetId}/profile`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Профиль не найден');
    }
    const { profile } = await res.json();

    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';

    const displayName = profile.display_name || profile.username || '?';
    document.getElementById('profile-avatar').textContent = displayName.charAt(0).toUpperCase();
    document.getElementById('profile-display-name').textContent = displayName;

    // Логин приходит только самому пользователю и админам (см.
    // auth.getUserProfile) — у остальных блок просто не показывается.
    const loginEl = document.getElementById('profile-username');
    if (profile.username) {
      loginEl.textContent = `Логин: ${profile.username}`;
      loginEl.style.display = '';
    } else {
      loginEl.style.display = 'none';
    }

    const role = this.roleLabelForUser(profile);
    const roleBadge = document.getElementById('profile-role-badge');
    roleBadge.textContent = role.text;
    roleBadge.style.color = role.color;
    roleBadge.style.background = 'rgba(255,255,255,0.08)';

    // Статус (approved/pending/...) — деталь для админов, самому пользователю
    // и так очевидно, что он вошёл в систему.
    if (profile.can_edit_note) {
      const status = this.statusLabelForUser(profile);
      const statusBadge = document.getElementById('profile-status-badge');
      statusBadge.style.display = 'inline-block';
      statusBadge.textContent = status.text;
      statusBadge.style.color = status.color;
      statusBadge.style.background = 'rgba(255,255,255,0.08)';
    }

    document.getElementById('profile-created-at').textContent = profile.created_at
      ? `На платформе с ${new Date(profile.created_at).toLocaleDateString('ru-RU')}`
      : '';

    // Сервера
    const serversEl = document.getElementById('profile-servers');
    const serversEmptyEl = document.getElementById('profile-servers-empty');
    serversEl.innerHTML = '';
    if ((profile.servers || []).length === 0) {
      serversEmptyEl.style.display = 'block';
    } else {
      serversEmptyEl.style.display = 'none';
      profile.servers.forEach((server) => {
        const row = document.createElement('div');
        row.style.cssText = 'padding: 10px 14px; background: var(--background-secondary, #2f3136); border: 1px solid var(--background-accent, #4f545c); border-radius: 6px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;';
        const roles = server.roles.length ? server.roles.map((r) => this.escapeHtml(r)).join(', ') : 'без роли';
        row.innerHTML = `
          <span style="color: var(--text-normal, #dcddde); font-weight: 500;">${this.escapeHtml(server.name)}</span>
          <span style="color: var(--text-muted, #b9bbbe); font-size: 12px;">${roles}</span>
        `;
        serversEl.appendChild(row);
      });
    }

    this.setupProfileName(profile);
    this.setupProfileBio(targetId, profile);
    this.setupProfileNote(targetId, profile);
    await this.renderProfileArticles(targetId);
    await this.renderProfileStickers(targetId);

    const me = authManager.getUser() || {};
    this.setupProfileBookmarks(String(targetId) === String(me.id));
  } catch (error) {
    loadingEl.style.display = 'none';
    errorEl.style.display = 'block';
    document.getElementById('profile-error-text').textContent = error.message || '';
  }
};

// Смена своего имени (никнейма) в личном профиле. Логин не меняется — вход
// продолжает работать по нему; на сервере смена идёт через PUT /api/profile.
SPARouter.prototype.setupProfileName = function(profile) {
  const editBtn = document.getElementById('profile-name-edit-btn');
  const editBlock = document.getElementById('profile-name-edit');
  const nameEl = document.getElementById('profile-display-name');
  const input = document.getElementById('profile-name-input');
  if (!editBtn || !editBlock || !input) return;

  editBtn.style.display = 'none';
  editBlock.style.display = 'none';
  if (!profile.can_edit_name) return;
  editBtn.style.display = 'inline-block';

  const startEdit = () => {
    input.value = profile.display_name || '';
    editBtn.style.display = 'none';
    editBlock.style.display = 'flex';
    input.focus();
    input.select();
  };
  const stopEdit = () => {
    editBlock.style.display = 'none';
    editBtn.style.display = 'inline-block';
  };
  const save = async () => {
    const name = input.value.trim();
    if (!name) {
      showMessage('Имя не может быть пустым', 'error');
      return;
    }
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: name })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Не удалось сохранить имя');

      profile.display_name = data.display_name;
      nameEl.textContent = data.display_name;
      document.getElementById('profile-avatar').textContent = data.display_name.charAt(0).toUpperCase();

      // Имя закэшировано в браузере (шапка/аватар) — обновляем и там.
      const me = authManager.getUser();
      if (me) authManager.setUser({ ...me, display_name: data.display_name });
      if (typeof window.updateUserInfo === 'function') window.updateUserInfo();

      stopEdit();
      showMessage('Имя обновлено', 'success');
    } catch (error) {
      showMessage(error.message, 'error');
    }
  };

  editBtn.onclick = startEdit;
  document.getElementById('profile-name-cancel-btn').onclick = stopEdit;
  document.getElementById('profile-name-save-btn').onclick = save;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') stopEdit();
  };
};

SPARouter.prototype.setupProfileBio = function(targetId, profile) {
  const textEl = document.getElementById('profile-bio-text');
  const editBtn = document.getElementById('profile-bio-edit-btn');
  const editBlock = document.getElementById('profile-bio-edit');
  const input = document.getElementById('profile-bio-input');

  textEl.textContent = profile.bio || (profile.can_edit_bio ? 'Вы ещё ничего не написали о себе' : 'Пользователь ничего не написал о себе');

  if (!profile.can_edit_bio) return;
  editBtn.style.display = 'inline-block';

  const startEdit = () => {
    input.value = profile.bio || '';
    textEl.style.display = 'none';
    editBtn.style.display = 'none';
    editBlock.style.display = 'block';
    input.focus();
  };
  const stopEdit = () => {
    textEl.style.display = 'block';
    editBtn.style.display = 'inline-block';
    editBlock.style.display = 'none';
  };

  editBtn.onclick = startEdit;
  document.getElementById('profile-bio-cancel-btn').onclick = stopEdit;
  document.getElementById('profile-bio-save-btn').onclick = async () => {
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bio: input.value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Не удалось сохранить');
      profile.bio = data.bio;
      textEl.textContent = data.bio || 'Вы ещё ничего не написали о себе';
      stopEdit();
      showMessage('Профиль обновлён', 'success');
    } catch (error) {
      showMessage(error.message, 'error');
    }
  };
};

SPARouter.prototype.setupProfileNote = function(targetId, profile) {
  const block = document.getElementById('profile-note-block');
  if (!profile.can_edit_note) return;
  block.style.display = 'block';

  const textEl = document.getElementById('profile-note-text');
  const editBtn = document.getElementById('profile-note-edit-btn');
  const editBlock = document.getElementById('profile-note-edit');
  const input = document.getElementById('profile-note-input');

  textEl.textContent = profile.admin_note || 'Заметок пока нет';

  const startEdit = () => {
    input.value = profile.admin_note || '';
    textEl.style.display = 'none';
    editBtn.style.display = 'none';
    editBlock.style.display = 'block';
    input.focus();
  };
  const stopEdit = () => {
    textEl.style.display = 'block';
    editBtn.style.display = 'inline-block';
    editBlock.style.display = 'none';
  };

  editBtn.onclick = startEdit;
  document.getElementById('profile-note-cancel-btn').onclick = stopEdit;
  document.getElementById('profile-note-save-btn').onclick = async () => {
    try {
      const res = await fetch(`/api/users/${targetId}/note`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: input.value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Не удалось сохранить');
      profile.admin_note = data.admin_note;
      textEl.textContent = data.admin_note || 'Заметок пока нет';
      stopEdit();
      showMessage('Заметка сохранена', 'success');
    } catch (error) {
      showMessage(error.message, 'error');
    }
  };
};

// Статьи пользователя (авторство/соавторство уже есть в articles-store).
// "Арты" пока остаётся заготовкой под будущую фичу (см. profile.html);
// "Наборы стикеров" — см. renderProfileStickers ниже.
SPARouter.prototype.renderProfileArticles = async function(targetId) {
  const loadingEl = document.getElementById('profile-articles-loading');
  const emptyEl = document.getElementById('profile-articles-empty');
  const listEl = document.getElementById('profile-articles-list');

  try {
    const res = await fetch(`/api/articles?author=${encodeURIComponent(targetId)}`);
    if (!res.ok) throw new Error('Не удалось загрузить статьи');
    const articles = await res.json();

    loadingEl.style.display = 'none';

    if (!articles.length) {
      emptyEl.style.display = 'block';
      return;
    }

    articles.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));

    listEl.innerHTML = '';
    articles.forEach((article) => {
      const row = document.createElement('div');
      row.style.cssText = 'padding: 12px 14px; background: var(--background-secondary, #2f3136); border: 1px solid var(--background-accent, #4f545c); border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;';
      const date = article.created_at ? new Date(article.created_at).toLocaleDateString('ru-RU') : '';
      const isCoAuthor = String(article.author?.id) !== String(targetId);
      row.innerHTML = `
        <div style="min-width: 0;">
          <div style="color: var(--text-normal, #dcddde); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${this.escapeHtml(article.title || article.id)}${isCoAuthor ? ' <span style="color: var(--text-muted, #b9bbbe); font-weight: 400; font-size: 12px;">(соавтор)</span>' : ''}</div>
          <div style="color: var(--text-muted, #b9bbbe); font-size: 12px;">${this.escapeHtml(article.server || 'без сервера')}${date ? ' · ' + date : ''}</div>
        </div>
      `;
      row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.03)'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'var(--background-secondary, #2f3136)'; });
      row.addEventListener('click', () => { window.spaRouter.editArticle(article.id); });
      listEl.appendChild(row);
    });
  } catch (error) {
    loadingEl.style.display = 'none';
    showMessage(error.message || 'Ошибка загрузки статей профиля', 'error');
  }
};

// Наборы стикеров пользователя (см. src/routes/stickers.routes.js) — себе
// видны все статусы (включая "на модерации"/"отклонён", чтобы понимать, что
// происходит с заявкой), в чужом профиле — только одобренные (публичная
// витрина не должна светить чужие черновики). Клик по карточке открывает
// набор целиком в общей модалке просмотра — там же можно добавить набор
// себе или убрать (см. public/sticker-pack-view.js).
SPARouter.prototype.renderProfileStickers = async function(targetId) {
  const loadingEl = document.getElementById('profile-stickers-loading');
  const emptyEl = document.getElementById('profile-stickers-empty');
  const emptyHintEl = document.getElementById('profile-stickers-empty-hint');
  const gridEl = document.getElementById('profile-stickers-grid');
  if (!loadingEl || !gridEl) return;

  const me = authManager.getUser() || {};
  const isSelf = String(targetId) === String(me.id);
  const statusLabels = { draft: 'Черновик', pending: 'На модерации', approved: 'Подтверждён', rejected: 'Отклонён' };

  try {
    const result = await window.apiClient.getStickerPacksByUser(targetId);
    const packs = result.success ? (result.data || []) : [];

    loadingEl.style.display = 'none';

    // "Добавленные наборы" (чужого авторства, чтобы не дублировать "созданные
    // вами" выше) — только на своём профиле, с быстрым "Убрать" на карточке
    // (задача "нет возможности убрать набор" — см. renderProfileAddedStickers).
    if (isSelf) await this.renderProfileAddedStickers(targetId);

    if (!packs.length) {
      emptyEl.style.display = 'block';
      if (emptyHintEl) {
        emptyHintEl.textContent = isSelf
          ? 'Создать свой набор или добавить чужой можно во вкладке «Стикеры»'
          : 'Пользователь пока не создал и не подтвердил ни одного набора';
      }
      return;
    }

    gridEl.style.display = 'grid';
    gridEl.innerHTML = '';
    packs.forEach((pack) => {
      const preview = (pack.stickers || []).slice(0, 3);
      const count = pack.stickersCount ?? preview.length;
      const card = document.createElement('div');
      card.style.cssText = 'padding: 12px 14px; background: var(--background-secondary, #2f3136); border: 1px solid var(--background-accent, #4f545c); border-radius: 6px; cursor: pointer; display: flex; flex-direction: column; gap: 8px;';
      card.innerHTML = `
        <div style="display: flex; gap: 6px; height: 40px; align-items: center;">
          ${preview.length
            ? preview.map((s) => `<img src="${this.escapeHtml(s.fileUrl)}" alt="" style="width: 36px; height: 36px; object-fit: contain; background: var(--background-tertiary, #36393f); border-radius: 6px;">`).join('')
            : `<span style="color: var(--text-muted, #b9bbbe); font-size: 12px; font-style: italic;">Пусто</span>`}
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
          <span style="color: var(--text-normal, #dcddde); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${this.escapeHtml(pack.title)}</span>
          ${isSelf && pack.status !== 'approved'
            ? `<span style="flex-shrink: 0; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; color: ${pack.status === 'rejected' ? 'var(--red)' : pack.status === 'draft' ? 'var(--text-muted)' : 'var(--yellow)'}; background: rgba(255,255,255,0.06);">${statusLabels[pack.status] || pack.status}</span>`
            : ''}
        </div>
        <div style="color: var(--text-muted, #b9bbbe); font-size: 12px;">${count} шт.${pack.isCoAuthor ? ' · соавтор' : ''}</div>
      `;
      card.addEventListener('mouseenter', () => { card.style.background = 'rgba(255,255,255,0.03)'; });
      card.addEventListener('mouseleave', () => { card.style.background = 'var(--background-secondary, #2f3136)'; });
      card.addEventListener('click', () => { window.stickerPackView?.open(pack.id); });
      gridEl.appendChild(card);
    });
  } catch (error) {
    loadingEl.style.display = 'none';
    showMessage(error.message || 'Ошибка загрузки наборов стикеров', 'error');
  }
};

// Наборы, добавленные пользователем себе (см. GET /api/stickers/subscribed),
// ЗА ВЫЧЕТОМ собственных (те уже показаны в основной сетке выше — автор
// автоматически подписан на свой же набор, см. createPack в
// stickers-store.js). У каждой карточки — крестик "Убрать" прямо тут, без
// похода в модалку просмотра набора (там переключатель тоже есть, но раньше
// сюда попасть было нельзя — эти наборы вообще не отображались в профиле).
SPARouter.prototype.renderProfileAddedStickers = async function(targetId) {
  const sectionEl = document.getElementById('profile-stickers-added-section');
  const emptyEl = document.getElementById('profile-stickers-added-empty');
  const gridEl = document.getElementById('profile-stickers-added-grid');
  if (!sectionEl || !gridEl) return;

  sectionEl.style.display = 'block';
  try {
    const result = await window.apiClient.getSubscribedStickerPacks();
    const packs = (result.success ? (result.data || []) : []).filter((p) => String(p.authorId) !== String(targetId));

    if (!packs.length) {
      emptyEl.style.display = 'block';
      gridEl.style.display = 'none';
      gridEl.innerHTML = '';
      return;
    }

    emptyEl.style.display = 'none';
    gridEl.style.display = 'grid';
    gridEl.innerHTML = '';
    packs.forEach((pack) => {
      const preview = (pack.stickers || []).slice(0, 3);
      const card = document.createElement('div');
      card.style.cssText = 'position: relative; padding: 12px 14px; background: var(--background-secondary, #2f3136); border: 1px solid var(--background-accent, #4f545c); border-radius: 6px; cursor: pointer; display: flex; flex-direction: column; gap: 8px;';
      card.innerHTML = `
        <button type="button" title="Убрать набор" style="position: absolute; top: -6px; right: -6px; width: 20px; height: 20px; border-radius: 50%; background: var(--red); color: #fff; border: none; font-size: 12px; line-height: 20px; cursor: pointer;">&times;</button>
        <div style="display: flex; gap: 6px; height: 40px; align-items: center;">
          ${preview.length
            ? preview.map((s) => `<img src="${this.escapeHtml(s.fileUrl)}" alt="" style="width: 36px; height: 36px; object-fit: contain; background: var(--background-tertiary, #36393f); border-radius: 6px;">`).join('')
            : `<span style="color: var(--text-muted, #b9bbbe); font-size: 12px; font-style: italic;">Пусто</span>`}
        </div>
        <span style="color: var(--text-normal, #dcddde); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${this.escapeHtml(pack.title)}</span>
        <div style="color: var(--text-muted, #b9bbbe); font-size: 12px;">от ${this.escapeHtml(pack.authorName)} · ${pack.stickers.length} шт.</div>
      `;
      card.addEventListener('mouseenter', () => { card.style.background = 'rgba(255,255,255,0.03)'; });
      card.addEventListener('mouseleave', () => { card.style.background = 'var(--background-secondary, #2f3136)'; });
      card.querySelector('button').addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await window.apiClient.unsubscribeStickerPack(pack.id);
          await this.renderProfileAddedStickers(targetId);
        } catch (err) {
          showMessage('Не удалось убрать набор', 'error');
        }
      });
      card.addEventListener('click', () => { window.stickerPackView?.open(pack.id); });
      gridEl.appendChild(card);
    });
  } catch (error) {
    showMessage(error.message || 'Ошибка загрузки добавленных наборов', 'error');
  }
};

// Закладки Ibripedia (см. public/ibripedia.js) — личные, поэтому вкладка
// видна только на СВОЁМ профиле (isSelf), не в чужом просмотре.
SPARouter.prototype.setupProfileBookmarks = function(isSelf) {
  const tabBtn = document.getElementById('profile-bookmarks-tab-btn');
  if (!isSelf) {
    if (tabBtn) tabBtn.style.display = 'none';
    return;
  }
  if (tabBtn) tabBtn.style.display = '';
  this.renderProfileBookmarks();
};

// Список закладок текущего пользователя по ВСЕМ статьям, сгруппированный
// по статье — клик открывает статью в Ibripedia и скроллит к блоку
// закладки (см. ibripediaManager.openArticleView/scrollToBlock).
SPARouter.prototype.renderProfileBookmarks = async function() {
  const loadingEl = document.getElementById('profile-bookmarks-loading');
  const emptyEl = document.getElementById('profile-bookmarks-empty');
  const listEl = document.getElementById('profile-bookmarks-list');
  if (!loadingEl || !listEl) return;

  try {
    const result = await window.apiClient.getBookmarks();
    if (!result.success) throw new Error(result.data?.error || result.error || 'Не удалось загрузить закладки');
    const bookmarks = Array.isArray(result.data) ? result.data : [];

    loadingEl.style.display = 'none';

    if (!bookmarks.length) {
      emptyEl.style.display = 'block';
      return;
    }

    const bySlug = new Map();
    bookmarks.forEach((b) => {
      if (!bySlug.has(b.slug)) bySlug.set(b.slug, { title: b.title || b.slug, items: [] });
      bySlug.get(b.slug).items.push(b);
    });

    listEl.innerHTML = '';
    bySlug.forEach((group, slug) => {
      const groupEl = document.createElement('div');
      groupEl.style.cssText = 'background: var(--background-secondary, #2f3136); border: 1px solid var(--background-accent, #4f545c); border-radius: 6px; padding: 12px 14px;';
      groupEl.innerHTML = `
        <div class="profile-bookmark-open" data-slug="${this.escapeHtml(slug)}" style="color: var(--text-normal, #dcddde); font-weight: 600; margin-bottom: 8px; cursor: pointer;">
          <i class="fas fa-file-alt"></i> ${this.escapeHtml(group.title)}
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          ${group.items.map((b) => `
            <div class="profile-bookmark-open" data-slug="${this.escapeHtml(slug)}" data-block-id="${this.escapeHtml(b.blockId || '')}" style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; padding: 4px 6px; border-radius: 4px;">
              <span style="flex: 0 0 auto; width: 9px; height: 9px; margin-top: 4px; border-radius: 50%; background: ${this.escapeHtml(b.color)};"></span>
              <div style="min-width: 0;">
                <div style="color: var(--text-normal, #dcddde); font-size: 13px; font-weight: 500;">${this.escapeHtml(b.name)}</div>
                ${b.quote ? `<div style="color: var(--text-muted, #b9bbbe); font-size: 12px; font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${this.escapeHtml(b.quote)}</div>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      `;
      groupEl.querySelectorAll('.profile-bookmark-open').forEach((el) => {
        el.addEventListener('mouseenter', () => { el.style.background = 'rgba(255,255,255,0.04)'; });
        el.addEventListener('mouseleave', () => { el.style.background = 'transparent'; });
        el.addEventListener('click', () => this.openBookmarkedArticle(el.getAttribute('data-slug'), el.getAttribute('data-block-id')));
      });
      listEl.appendChild(groupEl);
    });
  } catch (error) {
    loadingEl.style.display = 'none';
    showMessage(error.message || 'Ошибка загрузки закладок', 'error');
  }
};

SPARouter.prototype.openBookmarkedArticle = async function(slug, blockId) {
  if (!slug) return;
  await this.navigateTo('/ibripedia');
  await window.ibripediaManager?.openArticleView(slug);
  if (blockId) {
    // Панель/контент статьи дорисовываются асинхронно (блоки, закладки,
    // оглавление) — небольшая задержка перед скроллом надёжнее, чем гонка
    // с ещё не отрисованными data-block-id.
    setTimeout(() => window.ibripediaManager?.scrollToBlock(blockId), 350);
  }
};
